// Editable DDL preview shared by the table and view designers. The text is what Apply runs: generated from the
// engine script, or the user's hand-edited version (then the designer above is locked until "Regenerate").
// With nothing to show it collapses to a one-line bar (expand on demand; it opens by itself when changes appear);
// open, it sits under a resizable splitter whose height is remembered per user.
import { AlertTriangle, ChevronDown, ChevronRight, CircleAlert, Info, LoaderCircle, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
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
  /** Nothing to show (no changes, or the design is incomplete): the preview collapses to its bar. */
  empty?: boolean;
  onChange(text: string): void;
  onRegenerate(): void;
}

const noop = () => {};

const HEIGHT_KEY = 'dbstudio.designer.ddlPreviewHeight';
export const PREVIEW_MIN_HEIGHT = 96;
export const PREVIEW_DEFAULT_HEIGHT = 240;
/** Room the designer above the splitter keeps at least. */
const TOP_MIN_HEIGHT = 140;

/** Remembered preview height (px). Browser storage may be blocked or empty; then the default applies. */
export function readPreviewHeight(): number {
  try {
    const raw = globalThis.localStorage?.getItem(HEIGHT_KEY);
    const v = raw ? Number(raw) : NaN;
    return Number.isFinite(v) && v >= PREVIEW_MIN_HEIGHT ? v : PREVIEW_DEFAULT_HEIGHT;
  } catch {
    return PREVIEW_DEFAULT_HEIGHT;
  }
}

function savePreviewHeight(h: number): void {
  try {
    globalThis.localStorage?.setItem(HEIGHT_KEY, String(Math.round(h)));
  } catch {
    /* storage blocked: the height is just not remembered */
  }
}

export function DdlPreview(p: Props) {
  const editor = useSettings((s) => s.settings.editor);
  const empty = !!p.empty && !p.handEdited && !p.error && !p.failure;
  /** null = automatic (open when there is something to show); otherwise the user's own choice. */
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const [height, setHeight] = useState(readPreviewHeight);
  const section = useRef<HTMLElement>(null);
  const drag = useRef<{ y: number; h: number } | null>(null);
  const wasEmpty = useRef(empty);
  // Changes appearing (nothing to apply → something to apply) open the preview again, even after a manual collapse.
  useEffect(() => {
    if (wasEmpty.current && !empty) setUserOpen(null);
    wasEmpty.current = empty;
  }, [empty]);
  const open = userOpen ?? !empty;

  const clamp = (h: number) => {
    const room = (section.current?.parentElement?.clientHeight ?? 0) - TOP_MIN_HEIGHT;
    return Math.round(Math.max(PREVIEW_MIN_HEIGHT, room > PREVIEW_MIN_HEIGHT ? Math.min(h, room) : h));
  };
  const resize = (h: number, persist: boolean) => {
    const v = clamp(h);
    setHeight(v);
    if (persist) savePreviewHeight(v);
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { y: e.clientY, h: section.current?.getBoundingClientRect().height || height };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) resize(drag.current.h - (e.clientY - drag.current.y), false);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    resize(drag.current.h - (e.clientY - drag.current.y), true);
    drag.current = null;
  };
  const onSplitterKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === 'ArrowUp') resize(height + step, true);
    else if (e.key === 'ArrowDown') resize(height - step, true);
    else return;
    e.preventDefault();
  };

  const diagnostics: ServerDiagnostic[] = p.failure?.line
    ? [{ line: p.failure.line, col: 1, endLine: p.failure.line, endCol: 400, severity: 'error', code: 'DDL_FAILED', message: p.failure.message }]
    : [];
  const toggle = (
    <button
      type="button"
      className="dz-preview-toggle"
      aria-expanded={open}
      onClick={() => setUserOpen(!open)}
      title={open ? 'Collapse the DDL preview' : 'Show the DDL preview'}
    >
      {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
      <strong>DDL preview</strong>
    </button>
  );

  if (!open) {
    return (
      <section ref={section} className="dz-preview collapsed" aria-label="DDL preview">
        <div className="dz-preview-bar">
          {toggle}
          <span>{p.summary || 'No changes'}</span>
          {p.loading && <LoaderCircle size={13} className="spin" aria-label="Updating preview" />}
          {p.warnings.length > 0 && (
            <span className="dz-preview-note" title={p.warnings.join('\n')}>
              <Info size={12} aria-hidden="true" /> {p.warnings.length} note{p.warnings.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </section>
    );
  }

  return (
    <>
      <div
        className="dz-splitter"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the DDL preview"
        aria-valuenow={height}
        aria-valuemin={PREVIEW_MIN_HEIGHT}
        tabIndex={0}
        title="Drag (or Up/Down) to resize the DDL preview"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onKeyDown={onSplitterKey}
      />
      <section ref={section} className="dz-preview" aria-label="DDL preview" style={{ height }}>
        <div className="dz-preview-bar">
          {toggle}
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
            <ul className="dz-issues">
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
    </>
  );
}
