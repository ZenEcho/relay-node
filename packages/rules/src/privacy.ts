const privateKey =
  /authorization|cookie|secret|cvv|cvc|password|signature|nonce|access.?token|session.?token|api.?key|^key$|^token$|^credential$|sessionjson|^session$|sentinel|attestation|client.?secret|confirm.*token|rqdata|responsekey|pageaccess|card.?number|^number$|captcha.*url|cipher|keyhash|tokenhash|claimtoken|workerlease|verification.*access/i;
export function cleanText(value: string, maxLength = 12000): string {
  return (
    value
      .replace(/\bctoken_[A-Za-z0-9_]+\b/g, '[REDACTED]')
      .replace(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_]+\b/g, '[REDACTED]')
      .replace(
        /((?:access|session)[_-]?token|api[_-]?key|cvv|cvc|password|client_secret)\s*[:=]\s*[^\s,;&]+/gi,
        '$1=[REDACTED]',
      )
      .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
      .replace(/(?:sk|pk|pi)_(?:live|test|[A-Za-z0-9]+)_?[A-Za-z0-9_]*secret[A-Za-z0-9_]*/g, '[REDACTED]')
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED]')
      // Match complete UUIDs first so numeric UUID segments are not mistaken for PANs.
      .replace(
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b|\b(?:\d[ -]?){13,19}\b/gi,
        (match) =>
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(match)
            ? match
            : '[CARD]',
      )
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[REDACTED]@')
      .replace(/([?#&](?:access|token|client_secret|key)=)[^\s&#]+/gi, '$1[REDACTED]')
      .slice(0, maxLength)
  );
}
export function redact(value: unknown, depth = 0): any {
  if (depth > 10) return '[TRUNCATED]';
  if (typeof value === 'string') {
    try {
      if (/^[\[{]/.test(value.trim())) return redact(JSON.parse(value), depth + 1);
    } catch {}
    return cleanText(value);
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((x) => redact(x, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([k, v]) => [k, privateKey.test(k) ? '[REDACTED]' : redact(v, depth + 1)]),
    );
  return value;
}
