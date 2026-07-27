/** Live HTML preview of the résumé template for the selected theme (same shells as PDF). */
export default function ThemePreview({ themeId }: { themeId: string }) {
  const src = `/api/preview/resume/${encodeURIComponent(themeId)}`;
  return (
    <div className="theme-preview">
      <p className="hint theme-preview-label">Sample résumé preview (same layout as generated PDF)</p>
      <iframe
        title="Resume theme preview"
        className="theme-preview-frame"
        src={src}
        loading="lazy"
      />
    </div>
  );
}
