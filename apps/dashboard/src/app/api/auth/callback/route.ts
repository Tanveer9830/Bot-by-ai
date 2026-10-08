/**
 * Discord OAuth2 callback.
 *
 * Exchanges the code, reads identity + guild list ONCE, and discards the access
 * token. Only a session id (opaque cookie) survives, and the database stores an
 * HMAC of it.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { canManage, exchangeCode, fetchIdentity, fetchUserGuilds } from '@/lib/discord';
import {
  SESSION_COOKIE,
  STATE_COOKIE,
  clientIp,
  createSession,
  getConfig,
  hashIp,
  verifySignedValue,
} from '@/lib/server';

export const dynamic = 'force-dynamic';

function failure(origin: string, reason: string): Response {
  const url = new URL('/', origin);
  url.searchParams.set('error', reason);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest): Promise<Response> {
  const url = new URL(request.url);
  const origin = url.origin;
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expected = verifySignedValue(request.cookies.get(STATE_COOKIE)?.value, 'oauth-state');

  if (!code || !state || !expected || state !== expected) {
    return failure(origin, 'Invalid or expired OAuth2 state. Start the sign-in again.');
  }
  if (url.searchParams.get('error')) {
    return failure(origin, `Discord returned: ${url.searchParams.get('error')}`);
  }

  try {
    const tokens = await exchangeCode(code);
    const [identity, guilds] = await Promise.all([
      fetchIdentity(tokens.access_token),
      fetchUserGuilds(tokens.access_token),
    ]);
    const manageable = guilds.filter((guild) => guild.owner || canManage(guild.permissions)).map((guild) => guild.id);

    const { token } = await createSession({
      userId: identity.id,
      username: identity.username,
      globalName: identity.global_name,
      avatar: identity.avatar,
      guildIds: manageable,
      userAgent: request.headers.get('user-agent'),
      ipHash: hashIp(clientIp(request)),
    });

    const response = NextResponse.redirect(new URL('/', origin));
    response.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: getConfig().isProduction,
      path: '/',
      expires: new Date(Date.now() + getConfig().dashboard.sessionTtlMs),
    });
    response.cookies.delete(STATE_COOKIE);
    return response;
  } catch (error) {
    return failure(origin, error instanceof Error ? error.message : 'OAuth2 exchange failed.');
  }
}
