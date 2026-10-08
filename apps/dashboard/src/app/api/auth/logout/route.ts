import { NextResponse } from 'next/server';
import { SESSION_COOKIE, revokeCurrentSession } from '@/lib/server';

export const dynamic = 'force-dynamic';

export async function POST(): Promise<Response> {
  await revokeCurrentSession().catch(() => undefined);
  const response = NextResponse.json({ ok: true });
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
