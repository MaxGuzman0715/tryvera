import { useEffect, useState } from "react";
import { subscribeGlobalWriteCount } from "../globalLoading";

export default function GlobalSpinner() {
  const [count, setCount] = useState(0);

  useEffect(() => subscribeGlobalWriteCount(setCount), []);

  if (count <= 0) return null;

  return (
    <div className="global-spinner" role="status" aria-live="polite" aria-label="Saving changes">
      <span className="global-spinner-dot" />
      <span>Saving…</span>
    </div>
  );
}
