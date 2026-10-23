import { CircleAlert, CircleCheck, FolderOpen, LoaderCircle, Plug } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { errorMessage } from '../../api/client';
import type { ConnectionInput, ConnectionProfile, FormField, ProviderId, ProviderInfo, TestConnectionResult } from '../../api/types';
import { getPlatform } from '../../platform';
import { useConnections } from '../../store/connections';
import { toast, useUi, type ConnectionDialogState } from '../../store/ui';
import { connectAndOpen } from '../../app/actions';
import { isMac } from '../../commands/keys';
import { CONNECTION_PALETTE, connColorCss } from '../../theme/connColors';
import { Dialog } from '../common/Dialog';
import { Select } from '../common/Select';
import { PROVIDER_LABEL } from '../common/icons';
import { ProviderLogo } from '../../theme/brand/ProviderLogo';

type Values = Record<string, unknown>;

/**
 * Client-side wording of provider fields: one naming set across the app, and the two SQLite read-only concepts kept
 * apart (the file opened read-only vs. the engine refusing statements that change data).
 */
const FIELD_TEXT: Record<string, Record<string, { label?: string; help?: string }>> = {
  sqlite: {
    readOnly: { label: 'Open file read-only', help: 'SQLite opens the file with Mode=ReadOnly: nothing can write to it, not even Rowlit.' },
  },
};

function fieldText(providerId: string | undefined, f: FormField): FormField {
  const o = providerId ? FIELD_TEXT[providerId]?.[f.key] : undefined;
  return o ? { ...f, label: o.label ?? f.label, help: o.help ?? f.help } : f;
}

export function isFieldVisible(f: FormField, values: Values): boolean {
  if (!f.visibleWhen) return true;
  return Object.entries(f.visibleWhen).every(([k, v]) => String(values[k] ?? '') === String(v));
}

function defaults(p: ProviderInfo): Values {
  const v: Values = {};
  for (const f of p.formSpec.fields) {
    if (f.type === 'password') continue;
    if (f.default !== undefined && f.default !== null) v[f.key] = f.default;
    else if (f.type === 'bool') v[f.key] = false;
    else if (f.type === 'select' && f.options?.length) v[f.key] = f.options[0].value;
  }
  return v;
}

function suggestName(p: ProviderInfo | undefined, v: Values): string {
  if (!p) return '';
  const str = (k: string) => (typeof v[k] === 'string' ? (v[k] as string).trim() : '');
  if (p.id === 'sqlite') {
    const path = str('path');
    return path ? path.split(/[\\/]/).pop()!.replace(/\.(db|sqlite3?|db3)$/i, '') : '';
  }
  // M2 (docs/PLAN-M2.md 1.3)
  if (p.id === 'redis') {
    const mode = str('mode') || 'standalone';
    const list = (k: string) => (Array.isArray(v[k]) ? (v[k] as unknown[]).map(String) : str(k).split(',')).map((s) => s.trim()).filter(Boolean);
    if (mode === 'cluster') return list('nodes')[0] ?? '';
    if (mode === 'sentinel') return str('serviceName') ? `${str('serviceName')}@${list('sentinels')[0] ?? ''}` : list('sentinels')[0] ?? '';
    const host = str('host');
    if (!host) return '';
    const port = v.port === undefined || v.port === null || v.port === '' ? '6379' : String(v.port);
    const db = v.db === undefined || v.db === null || v.db === '' ? '0' : String(v.db);
    return `${host}:${port}/${db}`;
  }
  if (p.id === 'mongodb') {
    const uri = str('uri');
    const m = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?,]+)/i.exec(uri);
    const host = m ? m[1] : '';
    if (!host) return '';
    const user = str('user');
    return user ? `${user}@${host}` : host;
  }
  if (p.id === 'kafka') return str('bootstrapServers').split(',').map((s) => s.trim()).filter(Boolean)[0] ?? '';
  // Batch 3: Elasticsearch the host of the first URL; Snowflake user@account/database; Cassandra contactPoints[0]/keyspace
  const first = (k: string) => String(v[k] ?? '').split(',')[0].trim();
  if (p.id === 'elasticsearch') return first('url').replace(/^\w+:\/\/([^@/]*@)?|[/?#].*$/g, '');
  const host = str('server') || str('host') || str('tnsAlias') || str('account') || first('contactPoints');
  const db = str('database') || str('serviceName') || str('sid') || str('keyspace');
  const user = p.id === 'cassandra' ? '' : str('user');
  if (!host) return '';
  return [user && `${user}@`, host, db && `/${db}`].filter(Boolean).join('');
}

interface Props {
  state: ConnectionDialogState;
  onClose: () => void;
}

export function ConnectionDialog({ state, onClose }: Props) {
  const providers = useConnections((s) => s.providers);
  const connections = useConnections((s) => s.connections);
  const save = useConnections((s) => s.save);
  const test = useConnections((s) => s.test);

  const editing: ConnectionProfile | undefined = state.mode !== 'new' ? connections.find((c) => c.id === state.id) : undefined;
  const isEdit = state.mode === 'edit' && !!editing;

  const initialProvider: ProviderId | undefined =
    editing?.providerId ?? (state.mode === 'new' ? state.providerId : undefined) ?? providers[0]?.id;
  const [providerId, setProviderId] = useState<ProviderId | undefined>(initialProvider);
  const provider = providers.find((p) => p.id === providerId);

  const [values, setValues] = useState<Values>(() => {
    if (editing) return { ...editing.props };
    const p = providers.find((x) => x.id === initialProvider);
    return p ? defaults(p) : {};
  });
  const [name, setName] = useState(editing ? (state.mode === 'duplicate' ? `${editing.name} (copy)` : editing.name) : '');
  const [nameTouched, setNameTouched] = useState(!!editing);
  const [color, setColor] = useState<string | null>(editing?.color ?? null);
  const [folder, setFolder] = useState<string>(editing?.folder ?? (state.mode === 'new' ? state.folder ?? '' : ''));
  const [readOnly, setReadOnly] = useState(editing?.readOnly ?? false);
  const [savePassword, setSavePassword] = useState(editing?.savePassword ?? true);
  /** null = keep the stored password (edit) / none. */
  const [password, setPassword] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const folders = useMemo(() => [...new Set(connections.map((c) => c.folder).filter((f): f is string => !!f))].sort(), [connections]);
  const fields = (provider?.formSpec.fields ?? []).map((f) => fieldText(provider?.id, f));
  const visible = fields.filter((f) => isFieldVisible(f, values));
  const effectiveName = nameTouched ? name : name || suggestName(provider, values);
  const hasStored = !!editing?.hasPassword && state.mode === 'edit';

  const pickProvider = (id: ProviderId) => {
    if (id === providerId) return;
    const p = providers.find((x) => x.id === id);
    setProviderId(id);
    setValues(p ? defaults(p) : {});
    setTestResult(null);
    setErrors({});
  };

  const setValue = (key: string, v: unknown) => {
    setValues((prev) => ({ ...prev, [key]: v }));
    setTestResult(null);
  };

  /** Required fields (and the name, except for Test). Marks the fields and focuses the first invalid one. */
  const validate = (forTest = false): boolean => {
    const e: Record<string, string> = {};
    for (const f of visible) {
      if (!f.required) continue;
      if (f.type === 'password') {
        if (!password && !hasStored) e[f.key] = `${f.label} is required`;
        continue;
      }
      const v = values[f.key];
      if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) e[f.key] = `${f.label} is required`;
    }
    if (!forTest && !effectiveName.trim()) e.__name = 'Name is required';
    setErrors(e);
    const first = Object.keys(e)[0];
    if (first) setTimeout(() => document.getElementById(first === '__name' ? 'conn-name' : `conn-f-${first}`)?.focus(), 0);
    return Object.keys(e).length === 0;
  };

  /** Props sent to the engine: only visible fields, passwords excluded. */
  const cleanProps = (): Values => {
    const out: Values = {};
    for (const f of fields) {
      if (f.type === 'password' || !isFieldVisible(f, values)) continue;
      if (values[f.key] !== undefined) out[f.key] = values[f.key];
    }
    return out;
  };

  const runTest = async () => {
    // Empty required fields are marked here; the engine is not asked to test an incomplete profile.
    if (!provider || !validate(true)) return;
    setTesting(true);
    setTestResult(null);
    try {
      const r = await test({
        profile: { id: isEdit ? editing!.id : undefined, name: effectiveName, providerId: provider.id, props: cleanProps(), readOnly },
        password,
        useStoredPassword: password === null && !!editing?.hasPassword,
      });
      setTestResult(r);
    } catch (e) {
      setTestResult({ ok: false, serverInfo: null, elapsedMs: 0, error: { code: 'ERROR', message: errorMessage(e) } });
    } finally {
      setTesting(false);
    }
  };

  const onSave = async (connect = false) => {
    if (!provider || !validate()) return;
    setSaving(true);
    const input: ConnectionInput = {
      name: effectiveName.trim(),
      providerId: provider.id,
      color,
      folder: folder.trim() || null,
      readOnly,
      props: cleanProps(),
      savePassword,
      password: isEdit ? password : password ?? null,
    };
    try {
      const saved = await save(input, isEdit ? editing!.id : undefined);
      onClose();
      if (connect) {
        connectAndOpen(saved.id);
        toast('success', `Connected to “${saved.name}”`);
      } else toast('success', isEdit ? `Saved “${saved.name}”` : `Added “${saved.name}”`);
    } catch (e) {
      toast('error', 'Could not save the connection', errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const title = isEdit ? `Edit connection — ${editing!.name}` : 'New connection';
  // "Connect" (new connections, default action) saves and opens a console in one step.
  const connectFirst = !isEdit && (state.mode !== 'new' || state.connectAfter !== false);

  return (
    <Dialog
      title={title}
      ariaLabel="Connection"
      onClose={onClose}
      width={760}
      className="conn-dialog"
      onSubmit={() => void onSave(connectFirst)}
      footer={
        <>
          <button className="btn" onClick={runTest} disabled={!provider || testing}>
            {testing ? <LoaderCircle size={14} className="spin" /> : <Plug size={14} />}
            Test connection
          </button>
          <div className="flex-1" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          {connectFirst ? (
            <>
              <button className="btn" onClick={() => void onSave(false)} disabled={!provider || saving}>
                Save
              </button>
              <button className="btn btn-primary" onClick={() => void onSave(true)} disabled={!provider || saving}>
                {saving ? <LoaderCircle size={14} className="spin" /> : null}
                Connect
              </button>
            </>
          ) : (
            <button className="btn btn-primary" onClick={() => void onSave(false)} disabled={!provider || saving}>
              {isEdit ? 'Save' : 'Create'}
            </button>
          )}
        </>
      }
    >
      <div className="conn-dialog-layout">
        <div className="conn-providers" role="listbox" aria-label="Database type">
          {providers.map((p) => (
            <button
              key={p.id}
              role="option"
              aria-selected={p.id === providerId}
              className={`conn-provider${p.id === providerId ? ' selected' : ''}`}
              onClick={() => pickProvider(p.id)}
              disabled={isEdit && p.id !== providerId}
            >
              <ProviderLogo providerId={p.id} size={22} />
              <span>{PROVIDER_LABEL[p.id] ?? p.displayName}</span>
            </button>
          ))}
        </div>
        <div className="conn-form">
          <div className="form-grid">
            <label className="form-label" htmlFor="conn-name">
              Name
            </label>
            <div className="form-control">
              <input
                id="conn-name"
                className={`input${errors.__name ? ' invalid' : ''}`}
                aria-invalid={errors.__name ? true : undefined}
                aria-describedby={errors.__name ? 'conn-name-error' : undefined}
                value={effectiveName}
                placeholder="Connection name"
                onChange={(e) => {
                  setName(e.target.value);
                  setNameTouched(true);
                }}
              />
              {errors.__name && <div className="form-error" id="conn-name-error" role="alert">{errors.__name}</div>}
            </div>

            {visible.map((f) => (
              <FieldRow
                key={f.key}
                field={f}
                value={values[f.key]}
                error={errors[f.key]}
                password={password}
                hasStoredPassword={hasStored}
                onChange={(v) => setValue(f.key, v)}
                onPassword={(v) => {
                  setPassword(v);
                  setTestResult(null);
                }}
              />
            ))}

            <div className="form-section">General</div>
            <span className="form-label">Color</span>
            <div className="form-control color-swatches" role="radiogroup" aria-label="Color tag">
              <button
                className={`swatch none${color === null ? ' selected' : ''}`}
                role="radio"
                aria-checked={color === null}
                title="No color"
                onClick={() => setColor(null)}
              />
              {CONNECTION_PALETTE.map((c) => (
                <button
                  key={c.id}
                  className={`swatch${color?.toLowerCase() === c.hex ? ' selected' : ''}`}
                  role="radio"
                  aria-checked={color?.toLowerCase() === c.hex}
                  aria-label={c.name}
                  title={c.name}
                  style={{ background: connColorCss(c.hex) }}
                  onClick={() => setColor(c.hex)}
                />
              ))}
              {color && !CONNECTION_PALETTE.some((c) => c.hex === color.toLowerCase()) && (
                <button className="swatch selected" role="radio" aria-checked aria-label="Current colour" title="Current colour" style={{ background: connColorCss(color) }} onClick={() => {}} />
              )}
            </div>
            <label className="form-label" htmlFor="conn-folder">
              Folder
            </label>
            <div className="form-control">
              <input id="conn-folder" className="input" list="conn-folders" value={folder} placeholder="None" onChange={(e) => setFolder(e.target.value)} />
              <datalist id="conn-folders">
                {folders.map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
            </div>
            <span className="form-label" />
            <div className="form-control checks">
              <label className="check">
                <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
                {/* One label on every provider (design-r1-05); SQLite's "Open file read-only" is its own field above. */}
                Read-only <span className="muted">(Rowlit blocks statements that change data)</span>
              </label>
              {fields.some((f) => f.type === 'password') && (
                <label className="check">
                  <input type="checkbox" checked={savePassword} onChange={(e) => setSavePassword(e.target.checked)} />
                  Save password <span className="muted">({isMac() ? 'encrypted for your macOS user account' : 'encrypted with Windows DPAPI for your user account'})</span>
                </label>
              )}
            </div>
          </div>
          {testResult && <TestResultPanel r={testResult} />}
        </div>
      </div>
    </Dialog>
  );
}

function TestResultPanel({ r }: { r: TestConnectionResult }) {
  if (!r.ok) {
    return (
      <div className="test-result error" role="alert">
        <CircleAlert size={16} />
        <div>
          <div className="test-title">Connection failed</div>
          <div className="test-detail">{r.error?.message ?? 'Unknown error'}</div>
        </div>
      </div>
    );
  }
  const s = r.serverInfo;
  return (
    <div className="test-result ok" role="status">
      <CircleCheck size={16} />
      <div>
        <div className="test-title">Connected in {r.elapsedMs} ms</div>
        {s && (
          <dl className="test-info">
            <dt>Server</dt>
            <dd>{s.version}</dd>
            {s.productVersion && (
              <>
                <dt>Version</dt>
                <dd>{s.productVersion}</dd>
              </>
            )}
            {s.serverName && (
              <>
                <dt>Host</dt>
                <dd>{s.serverName}</dd>
              </>
            )}
            {s.user && (
              <>
                <dt>User</dt>
                <dd>{s.user}</dd>
              </>
            )}
            {s.database && (
              <>
                <dt>Database</dt>
                <dd>{s.database}</dd>
              </>
            )}
          </dl>
        )}
      </div>
    </div>
  );
}

interface FieldRowProps {
  field: FormField;
  value: unknown;
  error?: string;
  password: string | null;
  hasStoredPassword: boolean;
  onChange: (v: unknown) => void;
  onPassword: (v: string | null) => void;
}

function FieldRow({ field: f, value, error, password, hasStoredPassword, onChange, onPassword }: FieldRowProps) {
  const id = `conn-f-${f.key}`;
  const cls = `input${error ? ' invalid' : ''}`;
  // Accessible error state: the message under the field describes the invalid control.
  const aria = error ? { 'aria-invalid': true as const, 'aria-describedby': `${id}-error` } : {};
  let control: ReactNode;
  switch (f.type) {
    case 'password':
      control = (
        <input
          id={id}
          {...aria}
          type="password"
          className={cls}
          autoComplete="new-password"
          value={password ?? ''}
          placeholder={hasStoredPassword ? '•••••••• (stored, leave empty to keep)' : f.placeholder ?? ''}
          onChange={(e) => onPassword(e.target.value === '' && hasStoredPassword ? null : e.target.value)}
        />
      );
      break;
    case 'number':
      control = (
        <input
          id={id}
          {...aria}
          type="number"
          className={`${cls} narrow`}
          value={value === undefined || value === null ? '' : String(value)}
          placeholder={f.placeholder ?? ''}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        />
      );
      break;
    case 'bool':
      control = (
        <label className="check">
          <input id={id} type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
          {f.label}
        </label>
      );
      break;
    case 'select':
      control = (
        <Select
          id={id}
          {...aria}
          className={error ? 'invalid' : undefined}
          value={String(value ?? '')}
          options={(f.options ?? []).map((o) => ({ value: o.value, label: o.label }))}
          onChange={(v) => onChange(v)}
        />
      );
      break;
    case 'file':
      control = <FileInput id={id} aria={aria} className={cls} field={f} value={typeof value === 'string' ? value : ''} onChange={onChange} />;
      break;
    case 'list':
      control = (
        <input
          id={id}
          {...aria}
          className={cls}
          value={Array.isArray(value) ? value.join(', ') : typeof value === 'string' ? value : ''}
          placeholder={f.placeholder ?? 'Comma-separated'}
          onChange={(e) => onChange(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))}
        />
      );
      break;
    default:
      control = (
        <input
          id={id}
          {...aria}
          className={cls}
          value={typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)}
          placeholder={f.placeholder ?? ''}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
  return (
    <>
      {f.type === 'bool' ? (
        <span className="form-label" />
      ) : (
        <label className="form-label" htmlFor={id}>
          {f.label}
          {f.required && <span className="req">*</span>}
        </label>
      )}
      <div className="form-control">
        {control}
        {error && <div className="form-error" id={`${id}-error`} role="alert">{error}</div>}
        {f.help && !error && <div className="form-help">{f.help}</div>}
      </div>
    </>
  );
}

function FileInput({ id, aria, className, field, value, onChange }: { id: string; aria: Record<string, unknown>; className: string; field: FormField; value: string; onChange: (v: string) => void }) {
  const platform = getPlatform();
  const exts = (field.fileFilter ?? '').split(';').map((s) => s.trim().replace(/^\*\./, '')).filter(Boolean);
  return (
    <div className="file-input">
      <input id={id} {...aria} className={className} value={value} placeholder={field.placeholder ?? 'C:\\data\\database.db'} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
      {platform.hasFileSystem && (
        <button
          className="btn"
          type="button"
          title="Browse"
          onClick={async () => {
            const p = await platform.showOpenDialog({ title: field.label, filters: exts.length ? [{ name: field.label, extensions: exts }, { name: 'All files', extensions: ['*'] }] : undefined });
            if (p) onChange(p);
          }}
        >
          <FolderOpen size={14} />
        </button>
      )}
    </div>
  );
}

/** Mounted once in the App; reads its state from the ui store. */
export function ConnectionDialogHost() {
  const state = useUi((s) => s.connectionDialog);
  const close = useUi((s) => s.closeConnectionDialog);
  const loaded = useConnections((s) => s.providers.length > 0);
  if (!state || !loaded) return null;
  return <ConnectionDialog key={JSON.stringify(state)} state={state} onClose={close} />;
}
