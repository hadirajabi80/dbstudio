// Opens Settings → Snippets as a tab (tab view 'snippets'), registering the view on first use.
import { registerTabView } from '../layout/tabViews';
import { useTabs } from '../../store/tabs';
import { SnippetsSettingsConnected } from './SnippetsSettings';

export const SNIPPETS_VIEW = 'snippets';
let registered = false;

export function registerSnippetsView(): void {
  if (registered) return;
  registered = true;
  registerTabView(SNIPPETS_VIEW, { component: SnippetsSettingsConnected, icon: 'Braces' });
}

export function openSnippetsSettings(): string {
  registerSnippetsView();
  return useTabs.getState().openView({ view: SNIPPETS_VIEW, title: 'Snippets', key: SNIPPETS_VIEW });
}
