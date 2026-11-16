export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly data: any,
  ) {
    super(message);
  }
}
export const form = (values: Record<string, any>) =>
  new URLSearchParams(
    Object.fromEntries(
      Object.entries(values)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => [k, String(v)]),
    ),
  ).toString();
