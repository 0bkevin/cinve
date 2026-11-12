// Serializes work per provider account, for provider pages that keep state
// in the account's server-side session (Cinex's selected function).
const exclusiveTails = new Map<string, Promise<void>>();
/** Runs fn once every earlier holder of key has finished, one at a time, in call order. */
export async function exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = exclusiveTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const tail = previous.then(() => new Promise<void>(resolve => { release = resolve; }));
  exclusiveTails.set(key, tail);
  await previous;
  try { return await fn(); }
  finally { release(); if (exclusiveTails.get(key) === tail) exclusiveTails.delete(key); }
}
