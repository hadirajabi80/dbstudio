// Save query to schema… / New query… / Rename query… (lazy chunk, SavedQueryDialogHost): a name (unique in the schema,
// checked as you type), the schema it goes to (save only; the connection is the console's) and an optional
// description.
import { useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../../api/client';
import { isDuplicateNameError, type SavedQueryScope } from '../../api/savedQueries';
import { useCatalog } from '../../store/catalog';
import { hasDatabaseLevel, schemaIsDatabase, schemaLevelLabel, useConnection } from '../../store/connections';
import { nameTaken, scopeLabel, useSavedQueries } from '../../store/savedQueries';
import { ProviderLogo } from '../../theme/brand/ProviderLogo';
import { Dialog } from '../common/Dialog';
import { Select } from '../common/Select';
import { applyRename, createQuery, defaultName, saveConsoleAs } from './actions';
import { useSavedQueryDialog, type SavedQueryDialogRequest } from './dialogStore';
import { scopeKey as keyOf, scopeOptions } from './model';
import './savedQueries.css';

/** The schemas the catalog knows for the connection (scopeOptions), kept in step with it. */
function useScopeOptions(connectionId: string, extra: SavedQueryScope) {
  const dbs = useCatalog((s) => s.dbs);
  const conn = useConnection(connectionId);
  const multiDb = hasDatabaseLevel(conn?.providerId);
  return useMemo(() => scopeOptions(dbs, connectionId, multiDb, extra), [dbs, connectionId, multiDb, extra.database, extra.schema]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function SavedQueryDialog({ request }: { request: SavedQueryDialogRequest }) {
  const close = () => useSavedQueryDialog.getState().close();
  const initialScope: SavedQueryScope = request.mode === 'rename'
    ? { connectionId: request.query.connectionId, database: request.query.database, schema: request.query.schema }
    : request.scope;
  const [scopeKey, setScopeKey] = useState(() => keyOf(initialScope));
  const { options, byKey } = useScopeOptions(initialScope.connectionId, initialScope);
  const scope = byKey.get(scopeKey) ?? initialScope;
  const conn = useConnection(scope.connectionId);
  const items = useSavedQueries((s) => s.byConn[scope.connectionId]?.items);
  const [name, setName] = useState(() => (request.mode === 'rename' ? request.query.name : defaultName(initialScope, request.mode === 'save' ? request.name : undefined)));
  const [description, setDescription] = useState(request.mode === 'rename' ? request.query.description ?? '' : '');
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const touched = useRef(false);

  // The suggested name follows the list once it loads (unless the user typed one).
  useEffect(() => {
    if (request.mode !== 'rename' && !touched.current) setName(defaultName(scope, request.mode === 'save' ? request.name : undefined));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, scopeKey]);
  useEffect(() => {
    nameRef.current?.select();
  }, []);
  // A default that was not known yet (the console's catalog was still loading): the first schema once it is.
  useEffect(() => {
    if (request.mode === 'save' && !byKey.has(scopeKey) && options.length) setScopeKey(String(options[0].value));
  }, [request.mode, byKey, scopeKey, options]);

  const exceptId = request.mode === 'rename' ? request.query.id : undefined;
  const trimmed = name.trim();
  const duplicate = nameTaken(items, scope, trimmed, exceptId);
  const where = scopeLabel(scope);
  const liveError = !trimmed ? null : duplicate ? `A query named “${trimmed}” already exists in ${where}.` : trimmed.length > 200 ? 'Use at most 200 characters.' : null;
  const error = liveError ?? nameError;
  const unchanged = request.mode === 'rename' && trimmed === request.query.name && description.trim() === (request.query.description ?? '');
  const canSubmit = !!trimmed && !liveError && !busy && !unchanged;

  const submit = async () => {
    if (!trimmed) {
      setNameError('A name is required.');
      nameRef.current?.focus();
      return;
    }
    if (!canSubmit) return;
    setBusy(true);
    setServerError(null);
    try {
      const desc = description.trim() || null;
      if (request.mode === 'save') await saveConsoleAs(request.tabId, scope, trimmed, desc);
      else if (request.mode === 'new') await createQuery(scope, trimmed, desc);
      else {
        const q = await useSavedQueries.getState().update(request.query.connectionId, request.query.id, { name: trimmed, description: description.trim() });
        applyRename(request.query, q);
      }
      close();
    } catch (e) {
      if (isDuplicateNameError(e)) {
        setNameError(`A query named “${trimmed}” already exists in ${where}.`);
        void useSavedQueries.getState().load(scope.connectionId);
        nameRef.current?.focus();
      } else setServerError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const title = request.mode === 'save' ? 'Save query to schema' : request.mode === 'new' ? 'New query' : 'Rename query';
  const action = request.mode === 'rename' ? 'Rename' : request.mode === 'new' ? 'Create' : 'Save';
  const level = schemaLevelLabel(conn?.providerId);
  const dbLabel = schemaIsDatabase(conn?.providerId) ? level[0].toUpperCase() + level.slice(1) : hasDatabaseLevel(conn?.providerId) ? 'Database › schema' : 'Schema';

  return (
    <Dialog
      title={title}
      onClose={close}
      onSubmit={() => void submit()}
      width={480}
      className="sq-dialog"
      footer={
        <>
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn btn-primary" disabled={!canSubmit} onClick={() => void submit()} data-testid="sq-submit">{action}</button>
        </>
      }
    >
      <div className="form-grid sq-form">
        <span className="form-label">Connection</span>
        <span className="sq-conn" title={conn?.name}>
          {conn && <ProviderLogo providerId={conn.providerId} size={14} />}
          <span className="sq-conn-name">{conn?.name ?? scope.connectionId}</span>
        </span>

        {request.mode === 'save' ? (
          <>
            <span className="form-label" id="sq-scope-label">{dbLabel}</span>
            <Select
              aria-labelledby="sq-scope-label"
              value={scopeKey}
              options={options}
              onChange={(k) => {
                setScopeKey(k);
                setNameError(null);
              }}
              searchable="auto"
            />
          </>
        ) : (
          <>
            <span className="form-label">{dbLabel}</span>
            <span className="sq-scope">{where}</span>
          </>
        )}

        <label className="form-label" htmlFor="sq-name">Name<span className="req" aria-hidden="true">*</span></label>
        <div className="form-control">
          <input
            id="sq-name"
            ref={nameRef}
            className={`input${error ? ' invalid' : ''}`}
            value={name}
            maxLength={240}
            spellCheck={false}
            aria-invalid={!!error}
            aria-describedby={error ? 'sq-name-error' : undefined}
            aria-required
            onChange={(e) => {
              touched.current = true;
              setName(e.target.value);
              setNameError(null);
            }}
          />
          {error && <p className="form-error" id="sq-name-error" role="alert">{error}</p>}
        </div>

        <label className="form-label" htmlFor="sq-description">Description</label>
        <textarea
          id="sq-description"
          className="input sq-description"
          rows={3}
          placeholder="Optional"
          value={description}
          maxLength={2000}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      {serverError && <p className="form-error" role="alert">{serverError}</p>}
    </Dialog>
  );
}
