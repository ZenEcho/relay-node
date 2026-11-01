import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { Vault, digest } from '../../../packages/core/src/security.js';
import { auditRedact } from '../../../packages/core/src/audit.js';
import { logExpired } from '../../../packages/core/src/retention.js';

type Record = { runId: string; lease: string; step: any; queuedAt?: string };
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
      for (const [key, value] of this.vault.open<[string, Record][]>(await readFile(this.file, 'utf8')))
        this.records.set(key, value);
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
    await writeFile(temporary, this.vault.seal([...this.records]), { mode: 0o600, flush: true });
    await rename(temporary, this.file);
  }
  private serialized(action: () => Promise<void>) {
    const next = this.writing.then(action);
    this.writing = next.catch(() => {});
    return next;
  }
  async enqueue(runId: string, lease: string, step: any) {
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
  flush() {
    if (this.sending) return this.sending;
    this.sending = (async () => {
      for (let count = 0; count < 100; count++) {
        if ([...this.records.values()].some((record) => this.expired(record)))
          await this.serialized(async () => {
            this.prune();
            await this.persist();
          });
        const entry = this.records.entries().next().value;
        if (!entry) break;
        const [key, record] = entry;
        try {
          await this.send(record);
        } catch {
          break;
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
