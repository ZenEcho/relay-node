export const ORDER_RECORD_LIMIT = 1000;
export const LOG_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

export function logExpired(at: string, currentTime = Date.now()) {
  return Date.parse(at) < currentTime - LOG_RETENTION_MS;
}
