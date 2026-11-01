/** Normalize a CDK site root without accepting embedded credentials or API paths. */
export function normalizeCdkOrigin(value: string): string | null {
  const input = value.trim();
  if (!input) return null;
  try {
    const explicitProtocol = input.includes('://');
    let url = new URL(explicitProtocol ? input : 'https://' + input);
    if (
      !explicitProtocol &&
      (url.hostname === 'localhost' ||
        url.hostname.endsWith('.localhost') ||
        /^127\./.test(url.hostname) ||
        url.hostname === '[::1]')
    )
      url = new URL('http://' + input);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}
