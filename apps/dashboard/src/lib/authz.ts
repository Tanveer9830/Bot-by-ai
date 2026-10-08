/**
 * Per-request authorization.
 *
 * There is intentionally ONE place that decides "may this request read/write
 * this guild" and ONE place that decides "is this the bot owner". Route handlers
 * call these helpers before touching the database; hiding UI is never treated as
 * authorization.
 */
import type { NextRequest } from 'next/server';
import { assertSameOrigin, getSession, getOwners, jsonError, type SessionUser } from './server';
import { checkGuildAccess } from './discord';

export type AuthorizedResult =
  { ok: true; session: SessionUser } | { ok: false; response: Response };

export async function requireSession(): Promise<AuthorizedResult> {
  const session = await getSession();
  if (!session) {
    return { ok: false, response: jsonError(401, 'Sign in with Discord to continue.') };
  }
  return { ok: true, session };
}

/** Owner-only guard used by every /api/owner route. */
export async function requireOwner(): Promise<AuthorizedResult> {
  const result = await requireSession();
  if (!result.ok) return result;
  if (!getOwners().isOwner(result.session.userId)) {
    // Deliberately identical message for "not signed in" vs "signed in but not
    // an owner" is NOT used here: the caller is authenticated, so a precise
    // message is more useful and leaks nothing (the owner list is not secret).
    return {
      ok: false,
      response: jsonError(403, 'This area is restricted to configured bot owners.'),
    };
  }
  return result;
}

export interface GuildAuthorization {
  session: SessionUser;
  guildName: string;
  verifiedFresh: boolean;
}

/**
 * Guild-level authorization for the dashboard.
 *
 * 1. the caller must have a session;
 * 2. the session must list the guild (captured at login via OAuth2 `guilds`);
 * 3. the bot must still be in the guild AND the user must still hold
 *    ManageGuild/Administrator there (checked live with the bot token).
 */
export async function requireGuildAccess(
  guildId: string,
  options: { forceFresh?: boolean } = {},
): Promise<{ ok: true; value: GuildAuthorization } | { ok: false; response: Response }> {
  const sessionResult = await requireSession();
  if (!sessionResult.ok) return sessionResult;
  const { session } = sessionResult;

  if (!session.guildIds.includes(guildId)) {
    return { ok: false, response: jsonError(403, 'You do not have access to that server.') };
  }

  if (options.forceFresh !== false) {
    const check = await checkGuildAccess(guildId, session.userId).catch((error: unknown) => ({
      ok: false as const,
      reason: error instanceof Error ? error.message : 'Discord authorization check failed.',
    }));
    if (!check.ok) {
      return { ok: false, response: jsonError(403, check.reason ?? 'Access denied by Discord.') };
    }
    return {
      ok: true,
      value: {
        session,
        guildName: check.guildName ?? guildId,
        verifiedFresh: !check.isOwnerOfGuild,
      },
    };
  }

  return { ok: true, value: { session, guildName: guildId, verifiedFresh: false } };
}

/** CSRF defence for mutating requests (POST/PATCH/DELETE). */
export function guardMutation(request: NextRequest): Response | null {
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method) && !assertSameOrigin(request)) {
    return jsonError(403, 'Cross-origin requests are not allowed.');
  }
  return null;
}
