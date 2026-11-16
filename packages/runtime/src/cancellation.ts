export function executionAborted(): Error {
  return Object.assign(new Error('本单执行已中止'), { code: 'EXECUTION_ABORTED' });
}

export function throwIfExecutionAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw executionAborted();
}

/** Stop awaiting an operation even when an older adapter ignores cancellation. */
export async function executionOperation<T>(
  signal: AbortSignal | undefined,
  action: () => Promise<T>,
): Promise<T> {
  throwIfExecutionAborted(signal);
  let aborted: (() => void) | undefined;
  const pending = Promise.resolve().then(() => {
    throwIfExecutionAborted(signal);
    return action();
  });
  try {
    const result = signal
      ? await Promise.race([
          pending,
          new Promise<never>((_resolve, reject) => {
            aborted = () => reject(executionAborted());
            signal.addEventListener('abort', aborted, { once: true });
            if (signal.aborted) aborted();
          }),
        ])
      : await pending;
    throwIfExecutionAborted(signal);
    return result;
  } finally {
    if (signal && aborted) signal.removeEventListener('abort', aborted);
  }
}
