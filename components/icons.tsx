import type { SVGProps } from 'react';

const paths: Record<string, React.ReactNode> = {
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  nexus: <><path d="M4 5.5h5.5v5.5H4zM14.5 5.5H20v5.5h-5.5zM4 16h5.5v5.5H4zM14.5 16H20v5.5h-5.5z" /><path d="M9.5 8.25h5M6.75 11v5M17.25 11v5M9.5 18.75h5" /></>,
  grid: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.4" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.4" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.4" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.4" /></>,
  chart: <><path d="M4 19V5M4 19h16" /><path d="m7 15 3.5-4 3 2 5-6" /><path d="M16.5 7H19v2.5" /></>,
  inbox: <><path d="M4.5 4.5h15v15h-15z" /><path d="M4.5 13h4l1.5 2h4l1.5-2h4" /></>,
  shield: <><path d="M12 3.5 19 6v5.1c0 4.3-2.6 7.6-7 9.4-4.4-1.8-7-5.1-7-9.4V6z" /><path d="m9 12 2 2 4-4" /></>,
  book: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v17H6.5A2.5 2.5 0 0 0 4 22z" /><path d="M4 5.5v14M8 7h8M8 10h7" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3.2 2" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  send: <><path d="m21 3-7.4 18-3.4-7.2L3 10.4z" /><path d="M10.2 13.8 21 3" /></>,
  chevron: <path d="m9 18 6-6-6-6" />,
  external: <><path d="M13 5h6v6M19 5l-9 9" /><path d="M18 13.5v5H5.5v-13h5" /></>,
  close: <><path d="m6 6 12 12M18 6 6 18" /></>,
  check: <path d="m5 12 4.2 4.2L19.5 6" />,
  alert: <><path d="M12 3 2.8 19h18.4z" /><path d="M12 9v4.4M12 16.4v.1" /></>,
  logout: <><path d="M10 5H5v14h5M14 8l4 4-4 4M18 12H9" /></>,
  database: <><ellipse cx="12" cy="5.5" rx="7.5" ry="3" /><path d="M4.5 5.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6M4.5 11.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6" /></>,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 9a6.5 6.5 0 0 1 10.8-2L20 12M4 12l3.1 5a6.5 6.5 0 0 0 10.8-2" /></>,
  arrow: <><path d="M5 12h14M13 6l6 6-6 6" /></>,
  spark: <><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /><path d="m19 16 .8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" /></>,
  message: <><path d="M4 5h16v12H9l-5 4z" /><path d="M8 9h8M8 13h5" /></>,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></>,
  eye: <><path d="M2.5 12s3.2-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.2 6.5-9.5 6.5S2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="2.6" /></>,
  clockCheck: <><circle cx="10" cy="12" r="7.5" /><path d="M10 8v4l2.3 1.4M17 17l2 2 3-4" /></>,
  alertCircle: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5M12 16.5v.1" /></>,
  branch: <><circle cx="6" cy="6" r="2.2" /><circle cx="18" cy="6" r="2.2" /><circle cx="12" cy="18" r="2.2" /><path d="M8.2 6h7.6M6 8.3v2.5c0 2.2 1.7 4 4 4h4c2.2 0 4 1.8 4 4" /></>,
};

export type IconName = keyof typeof paths;

export function Icon({ name, size = 17, strokeWidth = 1.8, ...props }: SVGProps<SVGSVGElement> & { name: IconName; size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>
      {paths[name]}
    </svg>
  );
}
