import type { Assignment, Control } from '../../../../packages/contracts/src/execution.js';
export type { Assignment, Control } from '../../../../packages/contracts/src/execution.js';
import { WorkerLogs } from './logs.js';
import { randomUUID } from 'node:crypto';
import { auditError } from '../../../../packages/runtime/src/audit.js';
import {
  executionAborted,
  executionOperation,
  throwIfExecutionAborted,
} from '../../../../packages/runtime/src/cancellation.js';
export class HttpController {
  private logs: WorkerLogs;
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
  get pendingLogs() {
    return this.logs.pending;
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
    if (assignment) await this.logs.enqueue(assignment.run.id, assignment.run.workerLease!, step);
    else await this.logs.enqueueNode(step);
  }
  async request(path: string, body: any = {}, signal?: AbortSignal) {
    throwIfExecutionAborted(signal);
    const r = await fetch(this.origin.replace(/\/$/, '') + '/api/worker/' + path, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000),
    });
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
    return value;
  }
  forRun(assignment: Assignment, cancellation = new AbortController()): Control {
    const signal = cancellation.signal;
    const request: Control['request'] = (action, body = {}) =>
      executionOperation(signal, async () => {
        if (action === 'step')
          return this.logs.enqueue(assignment.run.id, assignment.run.workerLease!, {
            ...body.step,
            traceId: body.step.traceId || randomUUID(),
          });
        try {
          return await this.request(
            `runs/${encodeURIComponent(assignment.run.id)}/${action}`,
            {
              ...body,
              lease: assignment.run.workerLease,
            },
            signal,
          );
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
      assertActive: async () => {
        await request('check');
      },
    };
  }
}
