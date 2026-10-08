/**
 * Template rendering and custom-command validation.
 *
 * These are the two places where user-supplied text reaches Discord, so the
 * tests focus on the safety guarantees: no code execution, no mention injection,
 * and unknown placeholders left untouched rather than silently dropped.
 */
import { describe, expect, it } from 'vitest';
import {
  customCommandSchema,
  renderTemplate,
  sanitizeMentions,
  validateTemplate,
} from '@bot-by-ai/shared';

const context = {
  user: { id: '42', username: 'tester', tag: 'tester#0001', mention: '<@42>' },
  server: { name: 'Test Guild', id: '1', memberCount: 7 },
  channel: { name: 'general', mention: '<#9>' },
  command: { name: 'hello', args: 'a b' },
  date: new Date('2024-01-02T03:04:05.000Z'),
};

describe('renderTemplate', () => {
  it('substitutes allow-listed variables', () => {
    const result = renderTemplate('Hi {user}, welcome to {server} ({membercount})', context);
    expect(result.output).toBe('Hi tester, welcome to Test Guild (7)');
    expect(result.unknownVariables).toEqual([]);
  });

  it('reports unknown variables and keeps them verbatim', () => {
    const result = renderTemplate('{user} {definitelyNotAllowed}', context);
    expect(result.output).toBe('tester {definitelyNotAllowed}');
    expect(result.unknownVariables).toEqual(['definitelyNotAllowed']);
  });

  it('escapes markdown in usernames', () => {
    const result = renderTemplate('{user}', {
      ...context,
      user: { id: '1', username: '**bold**', tag: 'bold#0001' },
    });
    expect(result.output).not.toContain('**bold**');
  });

  it('sanitises mentions in command arguments', () => {
    const result = renderTemplate('{args}', {
      ...context,
      command: { name: 'x', args: '@everyone' },
    });
    expect(result.output).not.toBe('@everyone');
  });

  it('never evaluates javascript — it is inert text', () => {
    const payload = '${process.exit(1)} `rm -rf /` <script>alert(1)</script>';
    const result = renderTemplate(payload, context);
    expect(result.output).toContain('process.exit(1)');
    expect(result.output).toContain('rm -rf /');
  });

  it('support single-brace and double-brace syntax', () => {
    expect(renderTemplate('{{user}}', context).output).toBe('tester');
    expect(renderTemplate('{user}', context).output).toBe('tester');
  });
});

describe('validateTemplate', () => {
  it('rejects templates longer than the limit', () => {
    const result = validateTemplate('x'.repeat(10), 5);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/exceeds/i);
  });

  it('accepts a normal template and lists its variables', () => {
    const result = validateTemplate('Hi {user} from {server}');
    expect(result.valid).toBe(true);
    expect(result.unknown).toEqual([]);
  });
});

describe('sanitizeMentions', () => {
  it('neutralises user, role and everyone mentions', () => {
    const cleaned = sanitizeMentions('<@123> <@&456> @everyone @here');
    expect(cleaned).not.toContain('<@123>');
    expect(cleaned).not.toContain('<@&456>');
    expect(cleaned).not.toContain('@everyone');
    expect(cleaned).not.toContain('@here');
  });
});

describe('customCommandSchema', () => {
  const valid = {
    name: 'hello',
    description: 'Says hello',
    response: 'Hi {user}',
    actions: [],
    enabled: true,
    ephemeral: false,
    requiredRoleIds: [],
    allowedChannelIds: [],
    allowedUserIds: [],
    cooldownSeconds: 3,
    deleteTrigger: false,
  };

  it('accepts a well-formed command and applies defaults', () => {
    const parsed = customCommandSchema.parse({
      name: 'hello',
      description: 'Says hello',
      response: 'Hi',
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.ephemeral).toBe(false);
    expect(parsed.cooldownSeconds).toBe(3);
    expect(parsed.actions).toEqual([]);
  });

  it('rejects unsafe names (spaces, uppercase, slashes)', () => {
    for (const name of ['Hello World', 'HELLO', 'a/b', '']) {
      expect(customCommandSchema.safeParse({ ...valid, name }).success).toBe(false);
    }
  });

  it('rejects oversized payloads', () => {
    expect(customCommandSchema.safeParse({ ...valid, description: 'x'.repeat(101) }).success).toBe(
      false,
    );
    expect(customCommandSchema.safeParse({ ...valid, response: 'x'.repeat(4001) }).success).toBe(
      false,
    );
    expect(customCommandSchema.safeParse({ ...valid, cooldownSeconds: 86_401 }).success).toBe(
      false,
    );
  });

  it('only allows the four reviewed action types', () => {
    const bad = customCommandSchema.safeParse({ ...valid, actions: [{ type: 'run_shell' }] });
    expect(bad.success).toBe(false);
    const good = customCommandSchema.safeParse({
      ...valid,
      actions: [{ type: 'add_role', roleId: '123456789012345678' }],
    });
    expect(good.success).toBe(true);
  });
});
