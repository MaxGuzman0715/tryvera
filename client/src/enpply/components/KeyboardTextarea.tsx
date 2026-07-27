import { useCallback, type KeyboardEvent, type TextareaHTMLAttributes } from "react";

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & {
  value: string;
  onValueChange: (next: string) => void;
  onSaveShortcut?: () => void;
  tabString?: string;
};

export default function KeyboardTextarea({
  value,
  onValueChange,
  onSaveShortcut,
  tabString = "  ",
  ...rest
}: Props) {
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Keep editor key events local; do not let parent/global handlers interfere.
      e.stopPropagation();

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        if (!onSaveShortcut) return;
        e.preventDefault();
        onSaveShortcut();
        return;
      }

      if (e.key !== "Tab" || rest.readOnly) return;
      e.preventDefault();
      const el = e.currentTarget;
      const start = el.selectionStart ?? 0;
      const end = el.selectionEnd ?? start;
      const next = `${value.slice(0, start)}${tabString}${value.slice(end)}`;
      onValueChange(next);
      queueMicrotask(() => el.setSelectionRange(start + tabString.length, start + tabString.length));
    },
    [onSaveShortcut, onValueChange, rest.readOnly, tabString, value]
  );

  return (
    <textarea
      {...rest}
      value={value}
      spellCheck={rest.spellCheck ?? false}
      onChange={(e) => onValueChange(e.target.value)}
      onKeyDown={onKeyDown}
    />
  );
}
