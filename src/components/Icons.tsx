// Shared inline SVG icons (stroke-based, currentColor) so the whole app uses
// one consistent icon set without pulling in an icon library.

import type { ReactNode } from "react";

interface IconProps {
  size?: number;
  className?: string;
}

function makeIcon(children: ReactNode) {
  return function Icon({ size = 20, className }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
      >
        {children}
      </svg>
    );
  };
}

export const IconUtensils = makeIcon(
  <>
    <path d="M3 2v7a2 2 0 0 0 2 2h0a2 2 0 0 0 2-2V2" />
    <path d="M5 2v20" />
    <path d="M15 2c-1.5 1-2 4-2 5s.5 4 2 5c1.5-1 2-4 2-5s-.5-4-2-5Z" />
    <path d="M15 12v10" />
  </>,
);

export const IconList = makeIcon(
  <>
    <path d="M8 6h13M8 12h13M8 18h13" />
    <path d="M3 6h.01M3 12h.01M3 18h.01" />
  </>,
);

export const IconAlert = makeIcon(
  <>
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9v4M12 17h.01" />
  </>,
);

export const IconSettings = makeIcon(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 13a7.97 7.97 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a8 8 0 0 0-1.7-1L14.9 3h-4l-.4 2.9a8 8 0 0 0-1.7 1l-2.5-1-2 3.5L6.4 11a7.97 7.97 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a8 8 0 0 0 1.7 1l.4 2.9h4l.4-2.9a8 8 0 0 0 1.7-1l2.5 1 2-3.5-2.1-1.6Z" />
  </>,
);

export const IconSearch = makeIcon(
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </>,
);

export const IconUser = makeIcon(
  <>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c0-3.3 2.7-6 6-6h4c3.3 0 6 2.7 6 6" />
  </>,
);

export const IconPrint = makeIcon(
  <>
    <path d="M6 9V2h12v7" />
    <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
    <rect x="6" y="14" width="12" height="8" />
  </>,
);

export const IconCheck = makeIcon(
  <>
    <path d="m20 6-11 11-5-5" />
  </>,
);

export const IconX = makeIcon(
  <>
    <path d="M18 6 6 18M6 6l12 12" />
  </>,
);

export const IconBackspace = makeIcon(
  <>
    <path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2Z" />
    <path d="m12 8 6 8M18 8l-6 8" />
  </>,
);

export const IconWifiOff = makeIcon(
  <>
    <path d="m1 1 22 22" />
    <path d="M5 10a15 15 0 0 1 4.7-2.7M10 5a16 16 0 0 1 9 2.7" />
    <path d="M8.5 14a9 9 0 0 1 1.6-1.3M15 12.5a9 9 0 0 1 1.5 1.5" />
    <path d="M12 18h.01" />
  </>,
);

export const IconRefresh = makeIcon(
  <>
    <path d="M21 12a9 9 0 1 1-2.6-6.3" />
    <path d="M21 3v6h-6" />
  </>,
);

export const IconLock = makeIcon(
  <>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </>,
);

export const IconCamera = makeIcon(
  <>
    <path d="M4 8h3l2-2h6l2 2h3v11H4z" />
    <circle cx="12" cy="14" r="3.2" />
  </>,
);

export const IconShield = makeIcon(
  <>
    <path d="M12 3 5 6v5c0 4.4 3 8.4 7 10 4-1.6 7-5.6 7-10V6l-7-3Z" />
    <path d="m9 12 2 2 4-4" />
  </>,
);

export const IconPlus = makeIcon(
  <>
    <path d="M12 5v14M5 12h14" />
  </>,
);

export const IconBack = makeIcon(
  <>
    <path d="m15 18-6-6 6-6" />
  </>,
);
