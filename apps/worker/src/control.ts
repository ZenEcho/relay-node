import type {
  Billing,
  Run,
  RuntimeContext,
} from "../../../packages/core/src/domain.js";
import { WorkerLogs } from "./logs.js";
import { randomUUID } from "node:crypto";
export type Assignment = {
  run: Run;
  context: RuntimeContext;
  mode: "execute" | "reconcile" | "cleanup";
  billing?: Billing;
  paymentEnabled: boolean;
  demo: boolean;
};
export interface Control {
  request(action: string, body?: any): Promise<any>;
}
export class HttpController {
  private logs: WorkerLogs;
  constructor(
    readonly origin: string,
    private token: string,
  ) {
    this.logs = new WorkerLogs(
      process.env.WORKER_LOG_DIR || ".data/worker-audit",
      origin,
      token,
      (record) => this.request("logs", record),
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
  async request(path: string, body: any = {}) {
    const r = await fetch(
      this.origin.replace(/\/$/, "") + "/api/worker/" + path,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(45000),
      },
    );
    let text: string;
    try {
      text = await r.text();
    } catch (error) {
      throw Object.assign(error as Error, {
        httpResponse: {
          status: r.status,
          headers: Object.fromEntries(r.headers),
          body: "[响应读取中断]",
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
      throw Object.assign(
        new Error(value.message || `控制台 HTTP ${r.status}`),
        {
          code: value.error,
          status: r.status,
          httpResponse: {
            status: r.status,
            headers: Object.fromEntries(r.headers),
            body: value,
          },
        },
      );
    return value;
  }
  forRun(assignment: Assignment): Control {
    return {
      request: (action, body = {}) =>
        action === "step"
          ? this.logs.enqueue(assignment.run.id, assignment.run.workerLease!, {
              ...body.step,
              traceId: body.step.traceId || randomUUID(),
            })
          : this.request(
              `runs/${encodeURIComponent(assignment.run.id)}/${action}`,
              {
                ...body,
                lease: assignment.run.workerLease,
              },
            ),
    };
  }
}
