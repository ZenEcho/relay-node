import type { Assignment, Control } from '../../../../packages/contracts/src/execution.js';
export type { Assignment, Control } from '../../../../packages/contracts/src/execution.js';
import { WorkerLogs } from './logs.js';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { auditError } from '../../../../packages/runtime/src/audit.js';
import {
  executionAborted,
  executionOperation,
  throwIfExecutionAborted,
} from '../../../../packages/runtime/src/cancellation.js';
import { WorkerPerformance, workerOperation, type WorkerRequestOutcome } from './performance.js';

export class HttpController {
  private logs: WorkerLogs;
  private diagnostics = process.env.RELAY_PERFORMANCE_DIAGNOSTICS === '1' ? new WorkerPerformance() : undefined;
  private receipts = new WeakMap<Assignment, { requestId: string; receivedAt: number }>();

  constructor(
    readonly origin: string,
    private token: string,
  ) {
    this.logs = new WorkerLogs(
      process.env.WORKER_LOG_DIR || '.data/worker-audit',
      origin,
      token,
      async (record) => {
        if (record.runId) return this.request('logs', record);
        try {
          return await this.request('node-logs', { step: record.step });
        } catch (error) {
          // Older consoles lack runtime logging; never let that block order receipts.
          if (![404, 405].includes((error as any).status)) throw error;
        }
      },
    );
  }
  async initializeLogs() {
    await this.logs.initialize();
  }
  async flushLogs() {
    await this.logs.flush();
  }
  async persistLogs() {
    await this.logs.persistPending();
  }
  flushDiagnostics() {
    this.diagnostics?.flush();
  }
  get pendingLogs() {
    return this.logs.pending;
  }
  deferRunLogs(assignment: Assignment) {
    const { id, workerLease } = assignment.run;
    this.logs.hold(id, workerLease!);
    return () => this.logs.release(id, workerLease!);
  }
  async logEvent(
    name: string,
    detail: {
      status?: 'succeeded' | 'failed' | 'pending' | 'skipped';
      request?: unknown;
      error?: unknown;
    } = {},
    assignment?: Assignment,
  ) {
    const at = new Date().toISOString();
    const step = {
      traceId: randomUUID(),
      name,
      category: 'event',
      status: detail.status || (detail.error ? 'failed' : 'succeeded'),
      request: detail.request,
      startedAt: at,
      completedAt: at,
      ...(detail.error
        ? {
            error: (detail.error as Error).message || String(detail.error),
            errorDetail: auditError(detail.error),
          }
        : {}),
    };
    if (assignment) this.logs.enqueueDeferred(assignment.run.id, assignment.run.workerLease!, step);
    else await this.logs.enqueueNode(step);
  }
  async request(path: string, body: any = {}, signal?: AbortSignal, pollRequestId?: string) {
    throwIfExecutionAborted(signal);
    const requestId = randomUUID();
    const operation = this.diagnostics ? workerOperation(path) : undefined;
    const startedAt = operation ? performance.now() : 0;
    let outcome: WorkerRequestOutcome = 'transport';
    let status: number | undefined;
    let headersAt: number | undefined;
    let bodyAt: number | undefined;
    // Card preparation can include opening and verifying a card. It is a single
    // non-replayed request and must not inherit the short control RPC deadline.
    const timeout = AbortSignal.timeout(/^runs\/[^/]+\/card$/.test(path) ? 180000 : 45000);
    try {
      const r = await fetch(this.origin.replace(/\/$/, '') + '/api/worker/' + path, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
          'x-relay-worker-request-id': requestId,
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      status = r.status;
      if (operation) headersAt = performance.now();
      outcome = 'body';
      let text: string;
      try {
        text = await r.text();
      } catch (error) {
        throw Object.assign(error as Error, {
          httpResponse: {
            status: r.status,
            headers: Object.fromEntries(r.headers),
            body: '[响应读取中断]',
            partial: true,
          },
        });
      }
      if (operation) bodyAt = performance.now();
      outcome = 'json';
      let value: any;
      try {
        value = JSON.parse(text);
      } catch {
        throw Object.assign(new Error(`控制台返回非 JSON（HTTP ${r.status}）`), {
          status: r.status,
          httpResponse: {
            status: r.status,
            headers: Object.fromEntries(r.headers),
            body: text,
          },
        });
      }
      outcome = 'http';
      if (!r.ok)
        throw Object.assign(new Error(value.message || `控制台 HTTP ${r.status}`), {
          code: value.error,
          status: r.status,
          httpResponse: {
            status: r.status,
            headers: Object.fromEntries(r.headers),
            body: value,
          },
        });
      throwIfExecutionAborted(signal);
      outcome = 'ok';
      if (operation === 'poll' && value && typeof value === 'object')
        this.receipts.set(value, { requestId, receivedAt: performance.now() });
      return value;
    } finally {
      if (operation) {
        if (outcome !== 'ok') {
          if (signal?.aborted) outcome = 'cancelled';
          else if (timeout.aborted) outcome = 'timeout';
        }
        this.diagnostics!.record(operation, {
          requestId,
          pollRequestId,
          elapsedMs: performance.now() - startedAt,
          headersMs: headersAt === undefined ? undefined : headersAt - startedAt,
          bodyMs: headersAt === undefined || bodyAt === undefined ? undefined : bodyAt - headersAt,
          status,
          outcome,
        });
      }
    }
  }
  forRun(assignment: Assignment, cancellation = new AbortController()): Control {
    const signal = cancellation.signal;
    let receipt = this.receipts.get(assignment);
    if (receipt) {
      this.receipts.delete(assignment);
      this.diagnostics!.record('assignmentStart', {
        requestId: receipt.requestId,
        elapsedMs: performance.now() - receipt.receivedAt,
        outcome: 'ok',
      });
    }
    const request: Control['request'] = (action, body = {}) =>
      executionOperation(signal, async () => {
        if (action === 'step')
          return this.logs.enqueueDeferred(assignment.run.id, assignment.run.workerLease!, {
            ...body.step,
            traceId: body.step.traceId || randomUUID(),
          });
        try {
          const value = await this.request(
            `runs/${encodeURIComponent(assignment.run.id)}/${action}`,
            {
              ...body,
              lease: assignment.run.workerLease,
            },
            signal,
            action === 'check' ? receipt?.requestId : undefined,
          );
          if (action === 'check' && receipt) {
            this.diagnostics!.record('assignmentReceipt', {
              requestId: receipt.requestId,
              elapsedMs: performance.now() - receipt.receivedAt,
              outcome: 'ok',
            });
            receipt = undefined;
          }
          return value;
        } catch (error) {
          const e = error as { status?: number; code?: string; httpResponse?: { status?: number } };
          if (
            [401, 403, 404].includes(e.status || e.httpResponse?.status || 0) ||
            e.code === 'RUN_MANUAL_TAKEOVER'
          ) {
            cancellation.abort();
            throw executionAborted();
          }
          throw error;
        }
      });
    return {
      signal,
      request,
      assertActive: async (stage) => {
        await request('check', { stage });
      },
    };
  }
}
