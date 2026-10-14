// Editable DDL preview shared by the table and view designers. The text is what Apply runs: generated from the
// engine script, or the user's hand-edited version (then the designer above is locked until "Regenerate").
import { AlertTriangle, CircleAlert, Info, LoaderCircle, RotateCcw } from 'lucide-react';
import type { DdlFailedDetail, Dialect, ServerDiagnostic } from '../api/types';
import { SqlEditor } from '../editor/SqlEditor';
import { useSettings } from '../store/settings';
import type { EffectiveTheme } from '../theme/useTheme';

export interface ApplyFailure {
  message: string;
  detail: DdlFailedDetail | null;
  /** 1-based document line of the failing statement. */
  line: number | null;
  /** Statements that already ran (non-transactional dialects). */
  executed: string[];
}

interface Props {
  tabId: string;
  dialect: Dialect;
  theme: EffectiveTheme;
  text: string;
  handEdited: boolean;
  loading: boolean;
  summary: string;
  warnings: string[];
  error: string | null;
  failure: ApplyFailure | null;
  onChange(text: string): void;
  onRegenerate(): void;
}

const noop = () => {};

export function DdlPreview(p: Props) {
  const editor = useSettings((s) => s.settings.editor);
  const diagnostics: ServerDiagnostic[] = p.failure?.line
    ? [{ line: p.failure.line, col: 1, endLine: p.failure.line, endCol: 400, severity: 'error', code: 'DDL_FAILED', message: p.failure.message }]
    : [];
  return (
    <section className="dz-preview" aria-label="DDL preview">
      <div className="dz-preview-bar">
        <strong>DDL preview</strong>
        <span>{p.summary}</span>
        {p.loading && <LoaderCircle size={13} className="spin" aria-label="Updating preview" />}
        <span className="dz-spacer" />
        {p.handEdited && (
          <button type="button" className="btn btn-xs" onClick={p.onRegenerate} title="Discard your edits and regenerate the script from the designer">
            <RotateCcw size={12} /> Regenerate
          </button>
        )}
      </div>
      {p.handEdited && (
        <div className="dz-banner warning" role="status">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>Preview edited by hand — Apply runs your text. The designer above is locked until you regenerate.</span>
        </div>
      )}
      {p.error && (
        <div className="dz-banner error" role="alert">
          <CircleAlert size={14} aria-hidden="true" />
          <span>{p.error}</span>
        </div>
      )}
      {p.failure && (
        <div className="dz-banner error" role="alert">
          <CircleAlert size={14} aria-hidden="true" />
          <div>
            <div>
              {p.failure.detail ? `Statement ${p.failure.detail.failedIndex + 1} failed: ` : ''}
              {p.failure.message}
            </div>
            {p.failure.detail && (
              <div className="dz-sub">
                {p.failure.detail.rolledBack
                  ? 'Everything was rolled back; nothing changed.'
                  : `${p.failure.detail.executed} statement${p.failure.detail.executed === 1 ? '' : 's'} ran before the error and stay applied:`}
              </div>
            )}
            {p.failure.executed.length > 0 && !p.failure.detail?.rolledBack && (
              <ul>
                {p.failure.executed.map((s, i) => (
                  <li key={i} className="mono">
                    {s.split('\n')[0].slice(0, 140)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
      {p.warnings.length > 0 && (
        <div className="dz-banner info" role="note">
          <Info size={14} aria-hidden="true" />
          <ul style={{ margin: 0 }}>
            {p.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="dz-preview-editor">
        <SqlEditor
          tabId={`${p.tabId}-ddl`}
          dialect={p.dialect}
          catalog={null}
          value={p.text}
          onChange={p.onChange}
          onRun={noop}
          theme={p.theme}
          settings={editor}
          externalDiagnostics={diagnostics}
        />
      </div>
    </section>
  );
}
