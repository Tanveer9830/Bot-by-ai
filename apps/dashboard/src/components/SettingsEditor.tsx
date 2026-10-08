'use client';

import { useEffect, useMemo, useState } from 'react';

interface Props {
  guildId: string;
  modules: readonly string[];
}

interface FieldNote {
  path: string;
  message: string;
}

/**
 * Module settings editor.
 *
 * The form is generated from the live JSON of each module, so it always matches
 * what the bot actually stores. Values are validated again server-side with the
 * shared zod schema; this component only performs light client checks to keep
 * the round trip fast.
 */
export function SettingsEditor({ guildId, modules }: Props) {
  const [module, setModule] = useState<string>(modules[0] ?? 'general');
  const [raw, setRaw] = useState('{}');
  const [original, setOriginal] = useState('{}');
  const [issues, setIssues] = useState<FieldNote[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setMessage(null);
    setIssues([]);
    fetch(`/api/guilds/${guildId}/settings?module=${encodeURIComponent(module)}`, { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json();
        if (cancelled) return;
        if (!response.ok) {
          setMessage(body.error ?? 'Failed to load settings.');
          return;
        }
        const text = JSON.stringify(body.values ?? {}, null, 2);
        setRaw(text);
        setOriginal(text);
      })
      .catch((error: unknown) => {
        if (!cancelled) setMessage(error instanceof Error ? error.message : 'Network error.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [guildId, module]);

  const dirty = useMemo(() => raw !== original, [raw, original]);

  async function save() {
    setSaving(true);
    setMessage(null);
    setIssues([]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      setMessage(`That is not valid JSON: ${error instanceof Error ? error.message : 'parse error'}`);
      setSaving(false);
      return;
    }
    const response = await fetch(`/api/guilds/${guildId}/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ module, values: parsed }),
    }).catch(() => null);
    if (!response) {
      setMessage('Network error while saving.');
      setSaving(false);
      return;
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setMessage(body.error ?? 'The server rejected the update.');
      if (Array.isArray(body.issues)) setIssues(body.issues as FieldNote[]);
      setSaving(false);
      return;
    }
    const text = JSON.stringify(body.values ?? parsed, null, 2);
    setRaw(text);
    setOriginal(text);
    setMessage('Saved. The bot picks this up within its settings cache TTL (30s) or immediately on the next command.');
    setSaving(false);
  }

  return (
    <div className="card">
      <h2>Configuration</h2>
      <div className="row">
        <select value={module} onChange={(event) => setModule(event.target.value)} style={{ maxWidth: 260 }}>
          {modules.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <span className="muted">
          {loading ? 'Loading…' : dirty ? 'Unsaved changes' : 'In sync with the database'}
        </span>
      </div>

      <label htmlFor="settings-json">Stored JSON (validated by the shared zod schema on save)</label>
      <textarea
        id="settings-json"
        rows={18}
        spellCheck={false}
        value={raw}
        onChange={(event) => setRaw(event.target.value)}
        style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '0.82rem' }}
      />

      <div className="row" style={{ marginTop: 12 }}>
        <button onClick={() => void save()} disabled={saving || loading || !dirty}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        <button className="secondary" onClick={() => setRaw(original)} disabled={!dirty || saving}>
          Revert
        </button>
      </div>

      {message ? <p className={issues.length ? 'error' : 'muted'}>{message}</p> : null}
      {issues.length > 0 ? (
        <ul className="error">
          {issues.map((issue) => (
            <li key={`${issue.path}-${issue.message}`}>
              <code>{issue.path}</code>: {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
