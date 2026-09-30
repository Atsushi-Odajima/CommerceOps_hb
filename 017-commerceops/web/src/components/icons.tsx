import type { SVGProps } from 'react';

const base = (d: string) =>
  function Icon(props: SVGProps<SVGSVGElement>) {
    return (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d={d} />
      </svg>
    );
  };

export const IconHome = base('M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z');
export const IconOrders = base('M8 4h8l1 3h3v13H4V7h3zM8 11h8M8 15h5');
export const IconImport = base('M12 3v12m0 0l-4-4m4 4l4-4M4 17v3h16v-3');
export const IconAlloc = base('M4 7h16M4 12h10M4 17h6M17 14l3 3-3 3');
export const IconBox = base('M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10');
export const IconWave = base('M3 12c2-4 4-4 6 0s4 4 6 0 4-4 6 0');
export const IconPack = base('M4 8h16v12H4zM4 8l2-4h12l2 4M10 12h4');
export const IconTruck = base('M3 6h11v10H3zM14 10h4l3 3v3h-7M7 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM17 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z');
export const IconReturn = base('M9 14l-5-5 5-5M4 9h11a5 5 0 0 1 0 10h-3');
export const IconAlert = base('M12 3l10 18H2zM12 10v5M12 18h.01');
export const IconChart = base('M4 20V10M10 20V4M16 20v-7M22 20H2');
export const IconSettings = base('M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z');
export const IconSearch = base('M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.3-4.3');
export const IconScan = base('M4 7V4h3M17 4h3v3M20 17v3h-3M7 20H4v-3M7 8v8M10 8v8M13 8v8M16 8v8');
export const IconList = base('M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01');
export const IconMenu = base('M3 6h18M3 12h18M3 18h18');
export const IconUser = base('M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z');
export const IconAudit = base('M9 12l2 2 4-4M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z');
export const IconCamera = base('M3 8h4l2-3h6l2 3h4v12H3zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z');
export const IconKeyboard = base('M2 6h20v12H2zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10');
export const IconLogout = base('M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9');
export const IconInventory = base('M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z');
