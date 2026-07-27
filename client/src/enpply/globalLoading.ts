type Listener = (count: number) => void;

let pendingWrites = 0;
const listeners = new Set<Listener>();

function emit() {
  for (const cb of listeners) cb(pendingWrites);
}

export function beginGlobalWrite(): void {
  pendingWrites += 1;
  emit();
}

export function endGlobalWrite(): void {
  pendingWrites = Math.max(0, pendingWrites - 1);
  emit();
}

export function subscribeGlobalWriteCount(listener: Listener): () => void {
  listeners.add(listener);
  listener(pendingWrites);
  return () => listeners.delete(listener);
}
