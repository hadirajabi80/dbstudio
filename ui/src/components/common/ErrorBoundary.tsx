// Render-error containment: a crash in one area (a tab, a dock panel, a dialog, the results) shows a compact panel in
// that area instead of unmounting the whole React tree, which in Electron leaves a white window.
import { Bug, Check, ClipboardCopy, FileText, RefreshCw, RotateCcw, X } from 'lucide-react';
import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { hasCommand, runCommand } from '../../commands/registry';
import { getPlatform } from '../../platform';
import './ErrorBoundary.css';

/**
 * Where the boundary sits, which sets the panel's size and its extra actions:
 * root (whole window, "Reload window"), tab (fills the workspace), panel (dock panels, results), dialog (an overlay
 * with "Close"), inline (inside a settings section), strip (one line, for bars).
 */
export type ErrorBoundaryVariant = 'root' | 'tab' | 'panel' | 'dialog' | 'inline' | 'strip';

export interface ErrorBoundaryProps {
  /** Shown as "Something went wrong in <area>", e.g. "the Explorer", "Settings › Snippets", "“Console 1”". */
  area: string;
  variant?: ErrorBoundaryVariant;
  children?: ReactNode;
  /** The boundary resets (renders its children again) when this value changes, e.g. the open dialog or section. */
  resetKey?: unknown;
  /** Called by "Try again" before the children render again (clear the state that crashed them). */
  onReset?: () => void;
  /** dialog: closes the crashed dialog (its store flag); the boundary resets afterwards. */
  onClose?: () => void;
  /** Render nothing while crashed (hidden tabs keep their error until shown). */
  hidden?: boolean;
}

interface State {
  error: unknown;
  componentStack: string;
  resetKey: unknown;
}

const ENGINE_LOG_COMMAND = 'logs.openEngineLog';

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || 'Unknown error';
  if (typeof error === 'string') return error || 'Unknown error';
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/** Plain-text report for "Copy details": area, message, component stack and the JS stack. */
function errorDetails(area: string, error: unknown, componentStack: string): string {
  let version = '';
  try {
    version = getPlatform().appVersion;
  } catch {
    /* no platform in some tests */
  }
  const lines = [
    `Rowlit ${version}`.trim(),
    `Area: ${area}`,
    `Error: ${errorMessage(error)}`,
    '',
    'Component stack:',
    componentStack.replace(/^\n+/, '') || '(none)',
  ];
  if (error instanceof Error && error.stack) lines.push('', 'Stack:', error.stack);
  return lines.join('\n');
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  state: State = { error: null, componentStack: '', resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    // `null`/`undefined` throws still count as a crash
    return { error: error ?? new Error('Unknown error') };
  }

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: State): Partial<State> | null {
    if (Object.is(props.resetKey, state.resetKey)) return null;
    return { resetKey: props.resetKey, error: null, componentStack: '' };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`[Rowlit] Render error in ${this.props.area}:`, error, info.componentStack ?? '');
    this.setState({ componentStack: info.componentStack ?? '' });
  }

  reset = (): void => {
    try {
      this.props.onReset?.();
    } finally {
      this.setState({ error: null, componentStack: '' });
    }
  };

  close = (): void => {
    try {
      this.props.onClose?.();
    } finally {
      this.setState({ error: null, componentStack: '' });
    }
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children ?? null;
    if (this.props.hidden) return null;
    return (
      <ErrorPanel
        area={this.props.area}
        variant={this.props.variant ?? 'panel'}
        error={this.state.error}
        componentStack={this.state.componentStack}
        onRetry={this.reset}
        onClose={this.props.onClose ? this.close : undefined}
      />
    );
  }
}

interface ErrorPanelProps {
  area: string;
  variant: ErrorBoundaryVariant;
  error: unknown;
  componentStack: string;
  onRetry: () => void;
  onClose?: () => void;
}

function canOpenEngineLog(): boolean {
  try {
    return getPlatform().kind === 'electron' && hasCommand(ENGINE_LOG_COMMAND);
  } catch {
    return false;
  }
}

/** The fallback: icon, "Something went wrong in <area>", the message and the recovery actions. */
export function ErrorPanel({ area, variant, error, componentStack, onRetry, onClose }: ErrorPanelProps) {
  const [copied, setCopied] = useState(false);
  const retryRef = useRef<HTMLButtonElement>(null);
  // Modal and whole-window panels take the focus (it was inside what crashed); in-place panels leave it alone.
  useEffect(() => {
    if (variant === 'dialog' || variant === 'root') retryRef.current?.focus();
  }, [variant]);
  const message = errorMessage(error);
  const title = `Something went wrong in ${area}`;
  const copy = () => {
    const text = errorDetails(area, error, componentStack);
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    };
    try {
      const p = navigator.clipboard?.writeText(text);
      if (p) p.then(done, (e) => console.warn('[Rowlit] copy failed', e));
    } catch (e) {
      console.warn('[Rowlit] copy failed', e);
    }
  };
  const engineLog = canOpenEngineLog();
  const openLog = () => {
    runCommand(ENGINE_LOG_COMMAND);
    // The whole window crashed: the log opens as a tab, so render the shell again to show it.
    if (variant === 'root') onRetry();
  };

  if (variant === 'strip') {
    return (
      <div className="error-boundary error-boundary-strip" role="alert">
        <Bug size={14} strokeWidth={1.5} className="error-boundary-icon" aria-hidden />
        <span className="error-boundary-strip-text" title={message}>{title}: {message}</span>
        <button type="button" className="btn btn-xs" onClick={onRetry}><RotateCcw size={14} strokeWidth={1.5} aria-hidden /> Try again</button>
      </div>
    );
  }

  const body = (
    <div
      className={`error-boundary error-boundary-${variant}`}
      role="alert"
      onKeyDown={variant === 'dialog' && onClose ? (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } } : undefined}
    >
      <div className="error-boundary-card">
        <div className="error-boundary-head">
          <span className="error-boundary-badge" aria-hidden>
            <Bug size={16} strokeWidth={1.5} />
          </span>
          <div className="error-boundary-title">{title}</div>
          {onClose && (
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)">
              <X size={16} />
            </button>
          )}
        </div>
        <p className="error-boundary-message">{message}</p>
        <p className="error-boundary-hint">
          {variant === 'root' ? 'The window could not be drawn. Your tabs and connections are kept.' : 'The rest of Rowlit keeps working.'}
        </p>
        <div className="error-boundary-actions">
          <button type="button" className="btn btn-primary btn-xs" onClick={onRetry} ref={retryRef}>
            <RotateCcw size={14} strokeWidth={1.5} aria-hidden /> Try again
          </button>
          {variant === 'root' && (
            <button type="button" className="btn btn-xs" onClick={() => window.location.reload()}>
              <RefreshCw size={14} strokeWidth={1.5} aria-hidden /> Reload window
            </button>
          )}
          <button type="button" className="btn btn-xs" onClick={copy} aria-live="polite">
            {copied ? <Check size={14} strokeWidth={1.5} aria-hidden /> : <ClipboardCopy size={14} strokeWidth={1.5} aria-hidden />}
            {copied ? 'Copied' : 'Copy details'}
          </button>
          {engineLog && (
            <button type="button" className="btn btn-xs" onClick={openLog}>
              <FileText size={14} strokeWidth={1.5} aria-hidden /> Open engine log
            </button>
          )}
        </div>
      </div>
    </div>
  );

  if (variant === 'dialog') {
    return (
      <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
        <div className="dialog error-boundary-dialog" role="dialog" aria-modal="true" aria-label={title}>
          {body}
        </div>
      </div>
    );
  }
  return body;
}
