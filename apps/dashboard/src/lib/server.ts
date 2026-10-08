/**
 * Server-side building blocks for the dashboard.
 *
 * Everything in this file runs on the server only. The browser never receives
 * the bot token, the session secret, or another user's data.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';
import {
  loadConfig,
  createOwnerRegistry,
  type AppConfig,
  type OwnerRegistry,
} from '@bot-by-ai/shared';
import { openDatabase, type Database, type Repositories } from '@bot-by-ai/database';

export const SESSION_COOKIE = 'bbai_session';
export const STATE_COOKIE = 'bbai_oauth_state';
const SESSION_BYTES = 32;

/** Lazily-created singletons (Next may evaluate modules in several contexts). */
interface Globals {
  config?: AppConfig;
  db?: Database;
  repos?: Repositories;
  owners?: OwnerRegistry;
}

const globalRef = globalThis as typeof globalThis & { __bbai?: Globals };
const store: Globals = (globalRef.__bbai ??= {});

export function getConfig(): AppConfig {
  if (!store.config) store.config = loadConfig();
  return store.config;
}

export function getOwners(): OwnerRegistry {
  if (!store.owners) store.owners = createOwnerRegistry(getConfig().owners.ids);
  return store.owners;
}

export function getDatabase(): { db: Database; repos: Repositories } {
  if (!store.db || !store.repos) {
    const config = getConfig();
    const opened = openDatabase({
      url: config.database.url,
      ssl: config.database.ssl,
      max: config.database.poolMax,
      applicationName: 'bot-by-ai-dashboard',
    });
    store.db = opened.db;
    store.repos = opened.repositories;
  }
  return { db: store.db, repos: store.repos as Repositories };
}

/* ------------------------------------------------------------------ secrets */

/**
 * The session secret is mandatory for the dashboard. When it is missing we fail
 * loudly instead of falling back to a weak default.
 */
export function sessionSecret(): string {
  const secret = getConfig().dashboard.sessionSecret;
  if (!secret || secret.length < 32) {
    throw new Error(
      'SESSION_SECRET is required (>= 32 characters) for the dashboard. Generate one with: openssl rand -hex 32',
    );
  }
  return secret;
}

export function hashToken(token: string): string {
  return createHmac('sha256', sessionSecret()).update(token).digest('hex');
}

export function newSessionToken(): string {
  return randomBytes(SESSION_BYTES).toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Purposes are mixed into the HMAC so a state token can never be a session id. */
export function signValue(value: string, purpose: string): string {
  const mac = createHmac('sha256', sessionSecret())
    .update(`${purpose}:${value}`)
    .digest('base64url');
  return `${value}.${mac}`;
}

export function verifySignedValue(signed: string | undefined, purpose: string): string | null {
  if (!signed) return null;
  const index = signed.lastIndexOf('.');
  if (index <= 0) return null;
  const value = signed.slice(0, index);
  const expected = signValue(value, purpose);
  return safeEqual(signed, expected) ? value : null;
}

export function hashIp(value: string | null): string | null {
  if (!value) return null;
  return createHash('sha256').update(`ip:${value}`).digest('hex').slice(0, 32);
}

/* ----------------------------------------------------------------- sessions */

export interface SessionUser {
  sessionId: string;
  userId: string;
  username: string | null;
  globalName: string | null;
  avatar: string | null;
  guildIds: string[];
  expiresAt: Date;
  isOwner: boolean;
}

/**
 * Creates a session row and returns the signed cookie value.
 * Only the HMAC of the token is persisted, so a leaked database dump cannot be
 * replayed as a session cookie.
 */
export async function createSession(input: {
  userId: string;
  username: string | null;
  globalName: string | null;
  avatar: string | null;
  guildIds: string[];
  userAgent: string | null;
  ipHash: string | null;
}): Promise<{ token: string; expiresAt: Date }> {
  const { repos } = getDatabase();
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + getConfig().dashboard.sessionTtlMs);
  await repos.sessions.create({
    userId: input.userId,
    tokenHash: hashToken(token),
    expiresAt,
    userAgent: input.userAgent,
    ipHash: input.ipHash,
    username: input.username,
    globalName: input.globalName,
    avatar: input.avatar,
    userGuildIds: input.guildIds,
  });
  return { token, expiresAt };
}

/** Reads the session cookie and resolves it against the database. */
export async function getSession(): Promise<SessionUser | null> {
  const jar = await cookies();
  const raw = jar.get(SESSION_COOKIE)?.value;
  return resolveSessionToken(raw);
}

export async function resolveSessionToken(
  raw: string | undefined | null,
): Promise<SessionUser | null> {
  if (!raw) return null;
  const { repos } = getDatabase();
  const row = await repos.sessions.findActiveByTokenHash(hashToken(raw));
  if (!row) return null;
  await repos.sessions.touch(row.id);
  return {
    sessionId: row.id,
    userId: row.user_id,
    username: row.username ?? null,
    globalName: row.global_name ?? null,
    avatar: row.avatar ?? null,
    guildIds: Array.isArray(row.user_guild_ids) ? (row.user_guild_ids as string[]) : [],
    expiresAt: new Date(row.expires_at),
    isOwner: getOwners().isOwner(row.user_id),
  };
}

export async function revokeCurrentSession(): Promise<void> {
  const jar = await cookies();
  const raw = jar.get(SESSION_COOKIE)?.value;
  if (!raw) return;
  const { repos } = getDatabase();
  await repos.sessions.revokeByTokenHash(hashToken(raw));
}

/* ---------------------------------------------------------------- responses */

export function jsonError(status: number, message: string): Response {
  return Response.json({ ok: false, error: message }, { status });
}

/** Requests that mutate state must come from the dashboard origin. */
export function assertSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true; // same-origin fetches from the App Router omit it
  const allowed = [getConfig().dashboard.url, new URL(request.url).origin];
  return allowed.filter(Boolean).some((candidate) => candidate === origin);
}

export function clientIp(request: NextRequest): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim() ?? null;
  return request.headers.get('x-real-ip');
}
