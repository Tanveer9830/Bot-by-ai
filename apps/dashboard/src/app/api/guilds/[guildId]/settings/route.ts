/**
 * Read + write one settings module for one guild.
 *
 * Authorization: session → guild membership from OAuth2 → live bot-token
 * permission check (see lib/authz.ts). Validation: the shared zod schema for
 * that module runs before anything is written, and the repository validates a
 * second time. Every change is recorded in `audit_logs` and
 * `guild_settings_history` with the dashboard actor id.
 */
import { MODULE_NAMES, validateModuleSettings, type ModuleName } from '@bot-by-ai/shared';
import { guardMutation, requireGuildAccess } from '@/lib/authz';
import { getDatabase, jsonError } from '@/lib/server';
import type { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

function isModuleName(value: string): value is ModuleName {
  return (MODULE_NAMES as string[]).includes(value);
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ guildId: string }> },
): Promise<Response> {
  const { guildId } = await context.params;
  const module = new URL(request.url).searchParams.get('module') ?? '';
  if (!isModuleName(module)) {
    return jsonError(400, `Unknown settings module. Valid modules: ${MODULE_NAMES.join(', ')}`);
  }
  const auth = await requireGuildAccess(guildId);
  if (!auth.ok) return auth.response;

  const { repos } = getDatabase();
  const values = await repos.guilds.getModuleSettings(guildId, module);
  return Response.json({ ok: true, module, values });
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ guildId: string }> },
): Promise<Response> {
  const { guildId } = await context.params;
  const guard = guardMutation(request);
  if (guard) return guard;
  const auth = await requireGuildAccess(guildId);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'Expected a JSON body.');
  }
  if (typeof body !== 'object' || body === null) return jsonError(400, 'Expected a JSON object.');

  const { module, values } = body as { module?: unknown; values?: unknown };
  if (typeof module !== 'string' || !isModuleName(module)) {
    return jsonError(400, `Unknown settings module. Valid modules: ${MODULE_NAMES.join(', ')}`);
  }
  if (typeof values !== 'object' || values === null || Array.isArray(values)) {
    return jsonError(400, '`values` must be an object of module fields.');
  }

  const validated = validateModuleSettings(module, values as Record<string, unknown>);
  if (!validated.ok) {
    return Response.json(
      { ok: false, error: 'Validation failed.', issues: validated.errors },
      { status: 422 },
    );
  }

  const { repos } = getDatabase();
  try {
    const updated = await repos.guilds.patchModuleSettings(guildId, module, validated.data, {
      actorId: auth.value.session.userId,
      source: 'dashboard',
    });
    await repos.audit.log({
      guildId,
      actorId: auth.value.session.userId,
      actorType: 'dashboard',
      action: `settings.update.${module}`,
      targetType: 'guild_settings',
      targetId: guildId,
      metadata: { module, fields: Object.keys(validated.data) },
    });
    return Response.json({ ok: true, module, values: updated });
  } catch (error) {
    return jsonError(500, error instanceof Error ? error.message : 'Failed to save settings.');
  }
}
