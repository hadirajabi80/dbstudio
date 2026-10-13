import { Copy, Download, LoaderCircle, WrapText, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../../api/client';
import type { CellValue, ColumnInfo } from '../../api/types';
import { copyText } from '../../app/actions';
import { base64Length, base64ToHex, formatBytes, isBinary, isPartial, isTruncated, prettyPrint, rawText } from '../../lib/format';
import { getPlatform } from '../../platform';

interface Props {
  executionId: string | null;
  resultSetId: number;
  sourceRow: number;
  col: number;
  column: ColumnInfo;
  value: CellValue;
  onClose: () => void;
}

/** Side panel showing one cell's full value; JSON/XML pretty printed; fetches the full value when truncated. */
export function CellViewer({ executionId, resultSetId, sourceRow, col, column, value, onClose }: Props) {
  const [full, setFull] = useState<{ kind: 'string' | 'binary'; value: string; len: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wrap, setWrap] = useState(true);
  const [pretty, setPretty] = useState(true);
  const partial = isPartial(value);

  useEffect(() => {
    setFull(null);
    setError(null);
  }, [executionId, resultSetId, sourceRow, col]);

  const loadFull = async () => {
    if (!executionId) return;
    setLoading(true);
    setError(null);
    try {
      setFull(await api.cell(executionId, resultSetId, sourceRow, col));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  // Auto-fetch moderately sized truncated text.
  useEffect(() => {
    if (partial && executionId && isTruncated(value) && value.len <= 4 * 1024 * 1024) void loadFull();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partial, executionId, resultSetId, sourceRow, col]);

  const { text, language, info } = useMemo(() => {
    if (value === null) return { text: '', language: 'text', info: 'NULL' };
    if (full) {
      if (full.kind === 'binary') return { text: hexDump(full.value), language: 'hex', info: formatBytes(full.len) };
      const p = pretty ? prettyPrint(full.value, column.kind) : { text: full.value, language: 'text' };
      return { text: p.text, language: p.language, info: `${full.len.toLocaleString()} chars` };
    }
    if (isBinary(value)) {
      const have = base64Length(value.$bin);
      return { text: hexDump(value.$bin), language: 'hex', info: `${formatBytes(value.len)}${have < value.len ? ` (showing ${formatBytes(have)})` : ''}` };
    }
    const raw = rawText(value) ?? '';
    const p = pretty ? prettyPrint(raw, column.kind) : { text: raw, language: 'text' };
    const len = isTruncated(value) ? value.len : raw.length;
    return { text: p.text, language: p.language, info: `${len.toLocaleString()} chars${isTruncated(value) ? ' (truncated)' : ''}` };
  }, [value, full, pretty, column.kind]);

  return (
    <div className="cell-viewer" aria-label="Value viewer">
      <div className="panel-header">
        <span className="panel-title" title={column.dbType}>
          {column.name} <span className="muted">{column.dbType}</span>
        </span>
        <div className="panel-actions">
          <button className={`icon-btn${wrap ? ' on' : ''}`} title="Wrap lines" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
            <WrapText size={14} />
          </button>
          <button className="icon-btn" title="Copy value" onClick={() => void copyText(full?.kind === 'string' ? full.value : rawText(value) ?? '')}>
            <Copy size={14} />
          </button>
          {(full?.kind === 'binary' || isBinary(value)) && (
            <button
              className="icon-btn"
              title="Save binary value"
              onClick={() => {
                const b64 = full?.kind === 'binary' ? full.value : isBinary(value) ? value.$bin : '';
                const bin = atob(b64);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                void getPlatform().saveFile({ suggestedName: `${column.name || 'value'}.bin`, content: new Blob([bytes]), mime: 'application/octet-stream' });
              }}
            >
              <Download size={14} />
            </button>
          )}
          <button className="icon-btn" title="Close viewer" aria-label="Close viewer" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="cell-viewer-meta">
        <span>{info}</span>
        {language !== 'text' && language !== 'hex' && (
          <label className="check sm">
            <input type="checkbox" checked={pretty} onChange={(e) => setPretty(e.target.checked)} /> Pretty {language.toUpperCase()}
          </label>
        )}
        {partial && !full && executionId && (
          <button className="btn btn-xs" onClick={loadFull} disabled={loading}>
            {loading && <LoaderCircle size={12} className="spin" />} Load full value
          </button>
        )}
      </div>
      {error && <div className="cell-viewer-error">{error}</div>}
      {value === null ? (
        <div className="cell-viewer-null">NULL</div>
      ) : (
        <pre className={`cell-viewer-text${wrap ? ' wrap' : ''} lang-${language}`}>{text}</pre>
      )}
    </div>
  );
}

function hexDump(b64: string): string {
  const hex = base64ToHex(b64, 64 * 1024);
  const lines: string[] = [];
  for (let i = 0; i < hex.length; i += 32) {
    const chunk = hex.slice(i, i + 32);
    const bytes = chunk.match(/.{2}/g) ?? [];
    const ascii = bytes.map((h) => {
      const c = parseInt(h, 16);
      return c >= 32 && c < 127 ? String.fromCharCode(c) : '.';
    });
    lines.push(`${(i / 2).toString(16).padStart(8, '0')}  ${bytes.join(' ').padEnd(47)}  ${ascii.join('')}`);
  }
  return lines.join('\n');
}
