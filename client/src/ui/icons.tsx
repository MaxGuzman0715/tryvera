/**
 * Inline SVG icon set for the Tryvera dashboard.
 *
 * Drawn on one 24x24 grid at a single stroke weight so the set reads as a
 * family. Shipped as source rather than an icon font or a CDN sprite: no
 * network request, no flash of missing glyphs, and tree-shaking drops the ones
 * a page does not import.
 *
 * Every icon takes the current text colour, so placement decides emphasis and
 * the icons themselves stay theme-agnostic.
 */
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Svg({ children, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Tryvera brand mark — a case with a check, shared with the Tryvify extension. */
export function IconMark(props: IconProps) {
  return (
    <Svg strokeWidth={2.3} {...props}>
      <path d="M4 7.5h16M8.5 13.2 11 15.7l5-5.4" />
      <path d="M4 7.5v9a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-9" />
    </Svg>
  );
}

export function IconSend(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M21 3 10.5 13.5M21 3l-6.6 18-3.9-7.5L3 9.6z" />
    </Svg>
  );
}

export function IconList(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
    </Svg>
  );
}

export function IconIdCard(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2.8" y="4.8" width="18.4" height="14.4" rx="2.4" />
      <circle cx="8.5" cy="11" r="2" />
      <path d="M5.2 16.2a3.6 3.6 0 0 1 6.6 0M14.5 10h4M14.5 13.6h4" />
    </Svg>
  );
}

export function IconUsers(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M2.8 19.5a6.2 6.2 0 0 1 12.4 0M16.5 5.2a3.2 3.2 0 0 1 0 5.6M18 19.5a6 6 0 0 0-2-4.2" />
    </Svg>
  );
}

export function IconChart(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 20.5h17M7 17V10M12 17V4.5M17 17v-4" />
    </Svg>
  );
}

export function IconSliders(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 6h16M4 12h16M4 18h16" />
      <circle cx="9" cy="6" r="2" />
      <circle cx="15" cy="12" r="2" />
      <circle cx="7" cy="18" r="2" />
    </Svg>
  );
}

export function IconFlask(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9.5 3v6.2L4.3 18a2 2 0 0 0 1.7 3h12a2 2 0 0 0 1.7-3l-5.2-8.8V3M8 3h8M6.8 14.5h10.4" />
    </Svg>
  );
}

export function IconGear(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 14.7a1.6 1.6 0 0 0 .3 1.8l.1.1a1.9 1.9 0 1 1-2.7 2.7l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a1.9 1.9 0 1 1-3.8 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a1.9 1.9 0 1 1-2.7-2.7l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1h-.2a1.9 1.9 0 1 1 0-3.8h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a1.9 1.9 0 1 1 2.7-2.7l.1.1a1.6 1.6 0 0 0 1.8.3h.1a1.6 1.6 0 0 0 1-1.5v-.2a1.9 1.9 0 1 1 3.8 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a1.9 1.9 0 1 1 2.7 2.7l-.1.1a1.6 1.6 0 0 0-.3 1.8v.1a1.6 1.6 0 0 0 1.5 1h.2a1.9 1.9 0 1 1 0 3.8h-.1a1.6 1.6 0 0 0-1.5 1z" />
    </Svg>
  );
}

/** Browser-extension / connected-companion glyph. */
export function IconPlug(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 3v6M15 3v6M6.5 9h11v3.5a5.5 5.5 0 0 1-11 0zM12 18v3.5" />
    </Svg>
  );
}

export function IconSignOut(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M15.5 17.5 20 12l-4.5-5.5M20 12H9" />
      <path d="M13 3.5H6.5a3 3 0 0 0-3 3v11a3 3 0 0 0 3 3H13" />
    </Svg>
  );
}

export function IconDocument(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M13 2v7h7M8.5 13h7M8.5 17h5" />
    </Svg>
  );
}

export function IconDownload(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.8v11.7M8.2 11.7 12 15.5l3.8-3.8M4.5 15v3.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V15" />
    </Svg>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <Svg strokeWidth={1.9} {...props}>
      <circle cx="10.5" cy="10.5" r="6.7" />
      <path d="m20 20-4.7-4.7" />
    </Svg>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <Svg strokeWidth={2} {...props}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

export function IconClock(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.7" />
      <path d="M12 7v5.3l3.3 2" />
    </Svg>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <Svg strokeWidth={2} {...props}>
      <path d="m4.5 12.5 5 5 10-11" />
    </Svg>
  );
}

export function IconBolt(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13.5 2 4 13.5h6.5L10 22l9.5-11.5H13z" />
    </Svg>
  );
}

export function IconSparkle(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.2 13.9 9 19.7 10.9 13.9 12.8 12 18.6 10.1 12.8 4.3 10.9 10.1 9z" />
      <path d="M18.6 3v3.4M20.3 4.7h-3.4M5.6 16v2.6M6.9 17.3H4.3" />
    </Svg>
  );
}

export function IconInbox(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.2 13.5h4.3l1.4 2.6h6.2l1.4-2.6h4.3" />
      <path d="M5.6 4.6h12.8l2.4 8.9v4a2 2 0 0 1-2 2H5.2a2 2 0 0 1-2-2v-4z" />
    </Svg>
  );
}
