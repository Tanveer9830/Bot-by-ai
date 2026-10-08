'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

export function LogoutButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  return (
    <button
      className="secondary"
      disabled={busy || pending}
      onClick={async () => {
        setBusy(true);
        await fetch('/api/auth/logout', { method: 'POST' });
        startTransition(() => {
          router.replace('/');
          router.refresh();
        });
        setBusy(false);
      }}
    >
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
