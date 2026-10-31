// From the theme package (components/SquareIcons.tsx): square "sticker" icons, a lime-filled
// shape ("f") plus detail strokes ("d") that stay inside it. Colors come from .icon-sq in index.css.
// "flow" and "phone" were added for this app, drawn by the same rules (miter joins, details inside).
import type { SVGProps } from 'react';

const SHAPES = {
  home: { f: <path d="M3 10l9-7 9 7v11H3z" />, d: <path d="M9.5 21v-6h5v6" /> },
  board: { f: <rect x="3" y="3" width="18" height="18" />, d: <path d="M9 3v18M15 3v12" /> },
  calendar: {
    f: <rect x="3" y="4" width="18" height="17" />,
    d: <path d="M3 9h18M8 4v3M16 4v3M7.5 13h3v3h-3z" />,
  },
  inbox: {
    f: <rect x="3" y="5" width="18" height="15" />,
    d: <path d="M3 13h5l1.5 3h5l1.5-3h5" />,
  },
  invoice: {
    f: <path d="M5 2.5h14v19l-3.5-2-3.5 2-3.5-2-3.5 2z" />,
    d: <path d="M9 7.5h6M9 11h6M9 14.5h4" />,
  },
  kit: {
    f: <rect x="3" y="3" width="18" height="18" />,
    d: (
      <>
        <circle cx="12" cy="10" r="3" />
        <path d="M6.5 18c1-2.6 3-4 5.5-4s4.5 1.4 5.5 4" />
      </>
    ),
  },
  sliders: {
    f: <rect x="3" y="3" width="18" height="18" />,
    d: (
      <>
        <path d="M7 8h10M7 12h10M7 16h10" />
        <rect x="12" y="6.5" width="3" height="3" />
        <rect x="8" y="10.5" width="3" height="3" />
        <rect x="13" y="14.5" width="3" height="3" />
      </>
    ),
  },
  chat: { f: <path d="M3 4h18v12H10l-5 4v-4H3z" />, d: <path d="M7 8.5h10M7 11.5h6" /> },
  sparkle: { f: <path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z" />, d: null },
  bag: { f: <path d="M4 7h16l-1.2 14H5.2z" />, d: <path d="M9 10.5a3 3 0 0 0 6 0" /> },
  check: { f: <rect x="3" y="3" width="18" height="18" />, d: <path d="M7.5 12l3 3 6-6.5" /> },
  flow: {
    f: <rect x="3" y="3" width="18" height="18" />,
    d: (
      <>
        <rect x="6" y="6" width="4.5" height="4.5" />
        <rect x="13.5" y="13.5" width="4.5" height="4.5" />
        <path d="M10.5 8.25h3.75v5.25" />
      </>
    ),
  },
  phone: {
    f: <rect x="6" y="2.5" width="12" height="19" />,
    d: <path d="M9 7h6M9 10.5h4M10.5 18h3" />,
  },
} as const;

export type SquareIconName = keyof typeof SHAPES;

type Props = Omit<SVGProps<SVGSVGElement>, 'children'> & {
  name: SquareIconName;
  /** 20 inline, 24 nav, 40 feature cards. */
  size?: number;
  /** Only when the icon stands alone without text. */
  label?: string;
};

export function SquareIcon({ name, size = 24, label, className = '', ...rest }: Props) {
  const s = SHAPES[name];
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      strokeWidth={2}
      strokeLinejoin="miter"
      strokeLinecap="square"
      className={`icon-sq ${className}`}
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
      {...rest}
    >
      <g className="f">{s.f}</g>
      {s.d && <g className="d">{s.d}</g>}
    </svg>
  );
}
