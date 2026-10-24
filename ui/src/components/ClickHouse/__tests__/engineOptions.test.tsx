// The ClickHouse Engine row of the table designer (TableOptions.extra) and the panel registry.
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TableModel } from '../../../api/types';
import { designerOptionsPanel, registerDesignerOptionsPanel } from '../../../designer/table/optionsPanels';
import EngineOptions from '../EngineOptions';

const table = (extra?: Record<string, string>): TableModel => ({
  schema: 'shop', name: 'events', comment: null, options: { withoutRowid: false, strict: false, tablespace: null, extra },
  columns: [], primaryKey: null, uniques: [], indexes: [], foreignKeys: [], checks: [],
});

describe('ClickHouse engine options panel', () => {
  it('edits the options of a new table', () => {
    const onChange = vi.fn();
    render(<EngineOptions table={table({ engine: 'MergeTree' })} existing={false} disabled={false} onChange={onChange} />);
    fireEvent.change(screen.getByPlaceholderText('toYYYYMM(date)'), { target: { value: 'toYYYYMM(d)' } });
    expect(onChange).toHaveBeenLastCalledWith({ engine: 'MergeTree', partitionBy: 'toYYYYMM(d)' });
    fireEvent.change(screen.getByDisplayValue('MergeTree'), { target: { value: 'Memory' } });
    expect(onChange).toHaveBeenLastCalledWith({ engine: 'Memory' });
  });

  it('on an existing table only TTL and SETTINGS are editable; clearing a field drops the key', () => {
    const onChange = vi.fn();
    render(<EngineOptions table={table({ engine: 'MergeTree', orderBy: 'id', ttl: 'd + INTERVAL 1 DAY' })} existing disabled={false} onChange={onChange} />);
    expect(screen.getByDisplayValue('MergeTree')).toBeDisabled();
    expect(screen.getByDisplayValue('id')).toBeDisabled();
    fireEvent.change(screen.getByDisplayValue('d + INTERVAL 1 DAY'), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ engine: 'MergeTree', orderBy: 'id' });
  });

  it('shows no MergeTree clauses for other engines', () => {
    render(<EngineOptions table={table({ engine: 'Memory' })} existing={false} disabled={false} onChange={() => {}} />);
    expect(screen.queryByPlaceholderText('toYYYYMM(date)')).toBeNull();
  });

  it('the registry answers per provider', () => {
    const off = registerDesignerOptionsPanel('test-provider', EngineOptions);
    expect(designerOptionsPanel('test-provider')).toBe(EngineOptions);
    expect(designerOptionsPanel('sqlite')).toBeUndefined();
    off();
    expect(designerOptionsPanel('test-provider')).toBeUndefined();
  });
});
