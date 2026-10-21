// Persian/Arabic (RTL) and mixed user data in the DOM: value-bearing elements carry dir="auto" (each value picks its
// own direction) while the surrounding UI chrome stays LTR.
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ColumnInfo, ColumnKind } from '../api/types';
import type { LogEntry } from '../api/types.m2';
import { newCondition } from '../filter/model';
import type { BsonValue } from '../mongo/bson';
import { ConditionRow } from './FilterBar/ConditionRow';
import { DistinctValuesPopover } from './FilterBar/DistinctValues';
import { CellViewer } from './Grid/CellViewer';
import { LogList } from './Logs/LogList';
import { DocTree, ValueText } from './Mongo/BsonView';
import { RecordView } from './RecordView/RecordView';
import { KeyList } from './Redis/KeyList';

const col = (name: string, kind: ColumnKind, ordinal: number): ColumnInfo => ({
  name, ordinal, dbType: kind, kind, nullable: true, size: null, precision: null, scale: null, table: 't', schema: 'main', isKey: false,
});
const COLS = [col('Id', 'int', 0), col('نام', 'string', 1), col('Note', 'string', 2)];
const FA = 'سلام دنیا';
const MIXED = 'سفارش order #42';

describe('user data direction (dir="auto")', () => {
  it('cell viewer: the value block is dir=auto (lines get their own direction via CSS)', () => {
    render(<CellViewer executionId={null} resultSetId={0} sourceRow={0} col={1} column={COLS[1]} value={`${FA}\nhello`} onClose={() => {}} />);
    const pre = screen.getByLabelText('Value viewer').querySelector('pre.cell-viewer-text')!;
    expect(pre.textContent).toBe(`${FA}\nhello`);
    expect(pre.getAttribute('dir')).toBe('auto');
    // chrome stays untouched
    expect(screen.getByLabelText('Value viewer').hasAttribute('dir')).toBe(false);
  });

  it('record view: read-only text values and editors are dir=auto, numbers and the layout are not', () => {
    const { rerender } = render(
      <RecordView columns={COLS} values={[7, FA, MIXED]} rowLabel="Row 1" nullText="NULL" dialect="sqlite" onClose={() => {}} />,
    );
    expect(screen.getByText(FA).getAttribute('dir')).toBe('auto');
    expect(screen.getByText('7').hasAttribute('dir')).toBe(false);
    expect(screen.getByRole('table', { name: 'Columns of the selected row' }).hasAttribute('dir')).toBe(false);
    rerender(
      <RecordView columns={COLS} values={[7, FA, MIXED]} rowLabel="Row 1" nullText="NULL" dialect="sqlite" editableColumns={new Set([0, 1, 2])}
        onSet={() => {}} onClose={() => {}} />,
    );
    expect(screen.getByLabelText('نام').getAttribute('dir')).toBe('auto');
    expect(screen.getByLabelText('Note').getAttribute('dir')).toBe('auto');
    expect(screen.getByLabelText('Id').hasAttribute('dir')).toBe(false);
    // the "Find column" box is chrome
    expect(screen.getByLabelText('Find column').hasAttribute('dir')).toBe(false);
  });

  it('filter bar: the condition value input is dir=auto', () => {
    render(<ConditionRow cond={newCondition('نام', 'contains', [FA], 1)} columns={COLS} onChange={() => {}} onRemove={() => {}} />);
    const input = screen.getByLabelText('Value') as HTMLInputElement;
    expect(input.value).toBe(FA);
    expect(input.getAttribute('dir')).toBe('auto');
  });

  it('distinct values: each value and the search box are dir=auto', async () => {
    render(
      <DistinctValuesPopover column={COLS[1]} ordinal={1} at={{ x: 0, y: 0 }} nullText="NULL" onApply={() => {}} onClose={() => {}}
        load={() => Promise.resolve({ items: [{ value: FA, count: 2 }, { value: 'abc', count: 1 }], more: false })} />,
    );
    expect((await screen.findByText(FA)).getAttribute('dir')).toBe('auto');
    expect(screen.getByText('abc').getAttribute('dir')).toBe('auto');
    expect(screen.getByLabelText('Search values').getAttribute('dir')).toBe('auto');
  });

  it('mongo: string values and field names are dir=auto, numbers are not', () => {
    const doc: BsonValue = { t: 'object', v: [['نام', { t: 'string', v: FA }], ['n', { t: 'int', v: 3 }]] } as BsonValue;
    render(<DocTree doc={doc} />);
    expect(screen.getByText('نام').getAttribute('dir')).toBe('auto');
    expect(screen.getByText(`"${FA}"`).getAttribute('dir')).toBe('auto');
    expect(screen.getByText('3').hasAttribute('dir')).toBe(false);
    render(<ValueText v={{ t: 'string', v: MIXED } as BsonValue} />);
    expect(screen.getByText(`"${MIXED}"`).getAttribute('dir')).toBe('auto');
  });

  it('redis: key names in the key list are dir=auto', () => {
    render(
      <KeyList rows={[{ kind: 'key', id: 'k1', label: 'کاربر:۱', depth: 0, entry: { key: 'کاربر:۱', type: 'string', ttl: -1 } }]}
        selected={null} expiries={new Map()} sizes={new Map()} now={0} tree={false} onSelect={() => {}} onToggle={() => {}} onVisibleKeys={() => {}} />,
    );
    expect(screen.getByText('کاربر:۱').getAttribute('dir')).toBe('auto');
    expect(screen.getByRole('tree', { name: 'Keys' }).hasAttribute('dir')).toBe(false);
  });

  it('logs: the message is dir=auto, time/level/source are not', () => {
    const entries: LogEntry[] = [{ seq: 1, ts: '2026-01-01T00:00:00Z', level: 'info', source: 'app', message: MIXED }];
    render(
      <LogList entries={entries} selectedSeq={null} onSelect={() => {}} expanded={new Set()} onToggleExpand={() => {}} wrap={false} pattern={null}
        follow={false} onFollowChange={() => {}} tailing={false} onCopy={vi.fn()} onEscape={() => {}} label="Log entries" />,
    );
    const msg = document.querySelector('.log-msg')!;
    expect(msg.textContent).toContain(MIXED);
    expect(msg.getAttribute('dir')).toBe('auto');
    expect(document.querySelector('.log-source')!.hasAttribute('dir')).toBe(false);
  });
});
