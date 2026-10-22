// The Search tab: Find in database kept next to the other tabs ("Open in tab" from the Ctrl+Shift+F dialog). The
// panel is shared with the dialog (SearchPanel); the tab's state is persisted with the workspace, its results are not.
import { useCallback } from 'react';
import { useTabs } from '../../store/tabs';
import type { TabViewProps } from '../layout/tabViews';
import type { SearchTabState } from './model';
import { SearchPanel } from './SearchPanel';

export function SearchView({ tab, visible }: TabViewProps) {
  const update = useCallback((p: Partial<SearchTabState>) => {
    const tabs = useTabs.getState();
    const cur = tabs.tabs.find((t) => t.id === tab.id);
    if (cur?.kind === 'view') tabs.updateView(tab.id, { state: { ...(cur.state as SearchTabState), ...p } });
  }, [tab.id]);
  return <SearchPanel runId={tab.id} state={tab.state as SearchTabState} update={update} visible={visible} variant="tab" />;
}
