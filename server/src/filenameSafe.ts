const INVALID_FILE_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

/** Sanitize profile full name for use as a PDF basename (no extension). */
export function sanitizePersonNameForFile(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (!trimmed) return "Resume";
  const s = trimmed.replace(INVALID_FILE_CHARS, "_").replace(/^\.+/, "");
  const out = s.slice(0, 120).trim();
  return out || "Resume";
}

/** Basenames only; blocks path traversal. Allows dynamic names like `Jane Doe.pdf`. */
export function isSafeArtifactBasename(name: string): boolean {
  if (!name || name.length > 512) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (name.includes("..")) return false;
  if (name !== name.trim()) return false;
  return /\.(pdf|json|md|txt)$/i.test(name);
}
