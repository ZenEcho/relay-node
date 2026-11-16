import { digest, equalHash } from '../../../../packages/runtime/src/security.js';

/** In-memory execution leases; cancellation notices never contain a raw lease. */
export class ExecutionCancellations {
  private active = new Map<string, { id: string; leaseDigest: string; controller: AbortController }>();
  private cancelled = new Map<string, true>();

  register(id: string, lease: string) {
    const leaseDigest = digest(lease),
      key = id + '/' + leaseDigest;
    if (this.active.has(key)) return;
    const controller = new AbortController();
    const entry = { id, leaseDigest, controller };
    this.active.set(key, entry);
    if (this.cancelled.has(key)) controller.abort();
    return {
      controller,
      dispose: () => {
        if (this.active.get(key) === entry) this.active.delete(key);
      },
    };
  }

  apply(notices: unknown) {
    if (!Array.isArray(notices)) return;
    for (const notice of notices.slice(0, 1000)) {
      if (
        !notice ||
        typeof notice.id !== 'string' ||
        !notice.id ||
        notice.id.length > 128 ||
        typeof notice.leaseDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(notice.leaseDigest)
      )
        continue;
      const key = notice.id + '/' + notice.leaseDigest;
      this.cancelled.set(key, true);
      while (this.cancelled.size > 1000) this.cancelled.delete(this.cancelled.keys().next().value!);
      for (const entry of this.active.values())
        if (entry.id === notice.id && equalHash(entry.leaseDigest, notice.leaseDigest))
          entry.controller.abort();
    }
  }
}
