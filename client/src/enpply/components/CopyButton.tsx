import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Copy-to-clipboard button with a brief "✓ Copied" confirmation.
 *
 * Best practices baked in:
 *  - Primary path: async `navigator.clipboard.writeText`. Falls back to a
 *    hidden `<textarea>` + `document.execCommand("copy")` for older browsers
 *    or insecure contexts where the async API is blocked.
 *  - Visual affordance: the label swaps to `✓ Copied` for 1.5 s after a
 *    successful write; re-clicks restart the timer so rapid clicks behave.
 *  - `aria-live="polite"` + dynamic `aria-label` so screen readers announce
 *    the state change without stealing focus.
 *  - The timer is cleared on unmount to avoid setting state on an unmounted
 *    component when the user navigates away mid-animation.
 *  - The rendered width is padded with an invisible `✓ ` placeholder in the
 *    idle state so the button doesn't jump when the check mark appears.
 */

type Props = {
  text: string;
  /** Idle-state label. Default: `Copy`. */
  label?: ReactNode;
  /** Label while the ✓ is showing. Default: `Copied`. */
  copiedLabel?: ReactNode;
  /** Extra button classes (existing classes like `btn primary` still work). */
  className?: string;
  /** Hover title. Defaults to the idle label. */
  title?: string;
  /** How long to keep the ✓ visible, in ms. Default: 1500. */
  durationMs?: number;
  /** Inline styles forwarded to the `<button>`. */
  style?: React.CSSProperties;
  /** Called with the text after a successful copy. */
  onCopied?: (text: string) => void;
  /** Disable the button (e.g. while there is nothing to copy). */
  disabled?: boolean;
};

async function writeClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export default function CopyButton({
  text,
  label = "Copy",
  copiedLabel = "Copied",
  className = "btn small",
  title,
  durationMs = 1500,
  style,
  onCopied,
  disabled,
}: Props) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    };
  }, []);

  async function handleClick() {
    const ok = await writeClipboard(text);
    if (!ok) return;
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    setCopied(true);
    onCopied?.(text);
    timerRef.current = window.setTimeout(() => {
      setCopied(false);
      timerRef.current = null;
    }, durationMs);
  }

  const effectiveTitle =
    title ?? (typeof label === "string" ? label : undefined);

  return (
    <button
      type="button"
      className={className}
      style={style}
      onClick={() => void handleClick()}
      aria-live="polite"
      aria-label={copied ? "Copied to clipboard" : effectiveTitle ?? "Copy to clipboard"}
      title={effectiveTitle}
      disabled={disabled || !text}
    >
      {copied ? (
        <>
          <span aria-hidden="true">✓ </span>
          {copiedLabel}
        </>
      ) : (
        // Pad the idle label with an invisible check mark so the button
        // width doesn't change when the state flips.
        <>
          <span aria-hidden="true" style={{ visibility: "hidden" }}>
            ✓{" "}
          </span>
          {label}
        </>
      )}
    </button>
  );
}
