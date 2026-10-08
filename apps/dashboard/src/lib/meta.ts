/** Static build metadata surfaced in the UI (no secrets, no env leakage). */
export const APP_VERSION = process.env.APP_VERSION ?? '1.0.0';

export const NAV_LINKS = [
  { href: '/', label: 'Overview' },
  { href: '/owner', label: 'Owner panel' },
] as const;
