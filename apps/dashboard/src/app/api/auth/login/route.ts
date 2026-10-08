/**
 * Starts the Discord OAuth2 flow.
 *
 * A signed state value is stored in an HttpOnly cookie and echoed back by
 * Discord, which protects the callback against CSRF.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { authorizeUrl } from '@/lib/discord';
import { STATE_COOKIE, getConfig, newSessionToken, signValue } from '@/lib/server';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  const config = getConfig();
  if (!config.discord.clientSecret || !config.discord.redirectUri) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'Discord OAuth2 is not configured. Set DISCORD_CLIENT_SECRET and DISCORD_REDIRECT_URI (see docs/DASHBOARD.md).',
      },
      { status: 503 },
    );
  }

  const state = newSessionToken();
  const signed = signValue(state, 'oauth-state');
  const response = NextResponse.redirect(authorizeUrl(state));
  response.cookies.set(STATE_COOKIE, signed, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    path: '/',
    maxAge: 600,
  });
  void request;
  return response;
}
