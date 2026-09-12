export type SerialExecutor = <T>(operation: () => Promise<T>) => Promise<T>;

/**
 * Serialize asynchronous operations without letting one rejection wedge the
 * queue. Each caller still receives its own result or error.
 */
export function createSerialExecutor(): SerialExecutor {
  let tail: Promise<unknown> = Promise.resolve();

  return <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.catch(() => undefined);
    return result;
  };
}
