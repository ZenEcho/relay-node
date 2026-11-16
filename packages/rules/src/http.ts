export function retryAfterMs(value: string | null | undefined, current = Date.now()): number {
  if (!value) return 0;
  const raw = value.trim();
  const delay = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - current;
  return Number.isFinite(delay) && delay > 0 ? Math.min(delay, 8.64e15 - current) : 0;
}
