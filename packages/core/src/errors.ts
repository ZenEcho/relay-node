export function errorMessage(value: unknown, fallback = '请求失败', depth = 0): string {
  if (depth > 6 || value == null) return fallback;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text || text === '[object Object]') return fallback;
    if (/^[\[{]/.test(text)) {
      try {
        return errorMessage(JSON.parse(text), fallback, depth + 1);
      } catch {}
    }
    return text.slice(0, 2400);
  }
  if (Array.isArray(value)) {
    const messages = value
      .slice(0, 5)
      .map((item) => errorMessage(item, '', depth + 1))
      .filter(Boolean);
    return messages.length ? [...new Set(messages)].join('；') : fallback;
  }
  if (typeof value === 'object') {
    const item = value as Record<string, unknown>;
    for (const key of ['issues', 'message', 'msg', 'detail', 'error', 'errors']) {
      if (item[key] != null) {
        const text = errorMessage(item[key], '', depth + 1);
        if (text) return text;
      }
    }
  }
  return fallback;
}
