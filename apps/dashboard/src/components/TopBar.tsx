import Link from 'next/link';
import type { ReactNode } from 'react';

/** Small header used by every page; server-rendered so it can show session state. */
export function TopBar({ right }: { right?: ReactNode }) {
  return (
    <header className="topbar">
      <div className="brand">Bot-by-ai</div>
      <nav>
        <Link href="/">Overview</Link>
        <Link href="/owner">Owner panel</Link>
        {right}
      </nav>
    </header>
  );
}
