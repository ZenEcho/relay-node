import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Vault, digest } from '../../../../packages/runtime/src/security.js';
import { auditRedact } from '../../../../packages/runtime/src/audit.js';
import { logExpired } from '../../../../packages/rules/src/retention.js';

type Record = { runId: string; lease: string; step: any; queuedAt?: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function restoreTraceId(runId: string, traceId: unknown, key?: string): unknown {
  if (typeof traceId !== 'string' || !traceId.includes('[CARD]')) return traceId;
  const original = key?.startsWith(runId + ':') ? key.slice(runId.length + 1) : '';
  if (original && uuid.test(original)) return original;
  // Some old trace() callers redacted before enqueueing, losing the original UUID.
  // A UUIDv5 keeps their start/completion receipts and repeated recovery idempotent.
  const bytes = createHash('sha1')
    .update(Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex'))
    .update('relay-audit:' + runId + ':' + traceId)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

/** Encrypted, durable outbox; retries only logs, never payment requests. */
export class WorkerLogs {
  private records = new Map<string, Record>();
  private writing = Promise.resolve();
  private sending?: Promise<void>;
  private vault: Vault;
  private file: string;
  constructor(
    private directory: string,
    scope: string,
    token: string,
    private send: (record: Record) => Promise<unknown>,
  ) {
    this.vault = new Vault(digest(token));
    this.file = join(directory, digest(scope + ':' + token).slice(0, 24) + '.sealed');
  }
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      for (const [key, value] of this.vault.open<[string, Record][]>(await readFile(this.file, 'utf8'))) {
        const traceId = restoreTraceId(value.runId, value.step.traceId, key);
        const nextKey = value.runId + ':' + traceId;
        const old = this.records.get(nextKey);
        if (!old?.step.completedAt || value.step.completedAt)
          this.records.set(nextKey, {
            ...value,
            step: { ...value.step, traceId },
          });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('节点日志队列无法读取，停止领取任务以保留原日志');
    }
    for (const record of this.records.values())
      record.queuedAt ||=
        record.step.startedAt || record.step.at || record.step.completedAt || new Date().toISOString();
    if (this.records.size) {
      this.prune();
      await this.persist();
    }
  }
  private expired(record: Record) {
    return logExpired(record.step.startedAt || record.step.at || record.queuedAt!);
  }
  private prune() {
    for (const [key, record] of this.records) if (this.expired(record)) this.records.delete(key);
  }
  private async persist() {
    const temporary = this.file + '.tmp';
    await writeFile(temporary, this.vault.seal([...this.records]), {
      mode: 0o600,
      flush: true,
    });
    await rename(temporary, this.file);
  }
  private serialized(action: () => Promise<void>) {
    const next = this.writing.then(action);
    this.writing = next.catch(() => {});
    return next;
  }
  async enqueue(runId: string, lease: string, step: any) {
    step = { ...step, traceId: restoreTraceId(runId, step.traceId) };
    const key = runId + ':' + step.traceId;
    await this.serialized(async () => {
      const old = this.records.get(key);
      if (old?.step.completedAt && !step.completedAt) return;
      this.records.set(key, {
        runId,
        lease,
        step: auditRedact(step),
        queuedAt: old?.queuedAt || new Date().toISOString(),
      });
      this.prune();
      await this.persist();
    });
    void this.flush();
  }
  async enqueueNode(step: any) {
    await this.enqueue('', '', step);
  }
  flush() {
    if (this.sending) return this.sending;
    this.sending = (async () => {
      const rejected = new Set<Record>();
      for (let count = 0; count < 100; count++) {
        if ([...this.records.values()].some((record) => this.expired(record)))
          await this.serialized(async () => {
            this.prune();
            await this.persist();
          });
        let entry: [string, Record] | undefined;
        for (const candidate of this.records)
          if (!rejected.has(candidate[1])) {
            entry = candidate;
            break;
          }
        if (!entry) break;
        const [key, record] = entry;
        try {
          await this.send(record);
        } catch (error) {
          const e = error as {
            status?: number;
            httpResponse?: { status?: number };
          };
          if (![400, 403, 404, 409, 410, 413, 422].includes(e?.status || e?.httpResponse?.status || 0)) break;
          rejected.add(record);
          // Retain rejected receipts, but rotate them so one record cannot block the outbox.
          await this.serialized(async () => {
            if (this.records.get(key) === record) {
              this.records.delete(key);
              this.records.set(key, record);
              await this.persist();
            }
          });
          continue;
        }
        await this.serialized(async () => {
          if (this.records.get(key) === record) this.records.delete(key);
          await this.persist();
        });
      }
    })()
      .catch(() => {
        process.stderr.write('节点日志暂未同步，已保留本地加密队列\n');
      })
      .finally(() => {
        this.sending = undefined;
      });
    return this.sending;
  }
  get pending() {
    return this.records.size;
  }
}
