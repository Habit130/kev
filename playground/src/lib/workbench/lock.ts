type LockState = { tail: Promise<void> };

const lockKey = Symbol.for("kev.workbench.operation-lock");

function lockState(): LockState {
  const root = globalThis as typeof globalThis & { [lockKey]?: LockState };
  root[lockKey] ??= { tail: Promise.resolve() };
  return root[lockKey];
}

export async function withWorkbenchLock<T>(operation: () => Promise<T>): Promise<T> {
  const state = lockState();
  const previous = state.tail;
  let release = () => {};
  state.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}
