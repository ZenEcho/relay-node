import { createHistogram, performance, type RecordableHistogram } from 'node:perf_hooks';

const WINDOW_MS = 60_000;
const SLOW_MS = 500;
const MAX_DETAILS = 24;

export type WorkerOperation = 'heartbeat' | 'poll' | 'check' | 'checkpoint' | 'assignmentStart' | 'assignmentReceipt';
export type WorkerRequestOutcome = 'ok' | 'transport' | 'body' | 'json' | 'http' | 'timeout' | 'cancelled';

type Timing = {
  requestId: string;
  pollRequestId?: string;
  elapsedMs: number;
  headersMs?: number;
  bodyMs?: number;
  status?: number;
  outcome: WorkerRequestOutcome;
};

type Series = {
  elapsed: RecordableHistogram;
  headers: RecordableHistogram;
  body: RecordableHistogram;
  failures: number;
};

function record(histogram: RecordableHistogram, ms: number | undefined) {
  if (ms !== undefined) histogram.record(Math.max(1, Math.round(ms * 1000)));
}

function summarize(histogram: RecordableHistogram) {
  if (!histogram.count) return undefined;
  return {
    samples: histogram.count,
    p50Ms: histogram.percentile(50) / 1000,
    p95Ms: histogram.percentile(95) / 1000,
    p99Ms: histogram.percentile(99) / 1000,
    maxMs: histogram.max / 1000,
  };
}

export function workerOperation(path: string) {
  if (path === 'heartbeat' || path === 'poll') return path;
  const action = /^runs\/[^/]+\/(check|checkpoint)$/.exec(path)?.[1];
  if (action === 'check' || action === 'checkpoint') return action;
}

export class WorkerPerformance {
  private window = new Map<WorkerOperation, Series>();
  private windowStart = 0;
  private timer?: NodeJS.Timeout;
  private details = 0;
  private suppressedDetails = 0;

  record(operation: WorkerOperation, timing: Timing) {
    if (!this.timer) {
      this.windowStart = performance.now();
      this.timer = setTimeout(() => this.flush(), WINDOW_MS).unref();
    }
    let series = this.window.get(operation);
    if (!series) {
      series = { elapsed: createHistogram(), headers: createHistogram(), body: createHistogram(), failures: 0 };
      this.window.set(operation, series);
    }
    record(series.elapsed, timing.elapsedMs);
    record(series.headers, timing.headersMs);
    record(series.body, timing.bodyMs);
    if (timing.outcome !== 'ok') series.failures++;
    if (timing.elapsedMs >= SLOW_MS || timing.outcome !== 'ok') {
      if (this.details < MAX_DETAILS) {
        this.details++;
        console.info(JSON.stringify({ event: 'relay.worker.performance.request', operation, ...timing }));
      } else this.suppressedDetails++;
    }
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.window.size) return;
    const operations = Object.fromEntries([...this.window].map(([operation, series]) => [operation, {
      elapsed: summarize(series.elapsed),
      headers: summarize(series.headers),
      body: summarize(series.body),
      failures: series.failures,
    }]));
    console.info(JSON.stringify({
      event: 'relay.worker.performance.window',
      windowMs: Math.round(performance.now() - this.windowStart),
      operations,
      suppressedDetails: this.suppressedDetails,
    }));
    this.window.clear();
    this.details = 0;
    this.suppressedDetails = 0;
  }
}
