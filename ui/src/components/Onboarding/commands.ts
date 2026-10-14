// Auto-loaded by commands/index.ts: the welcome screen can also be opened as a tab (Help > Show welcome screen).
import { createElement } from 'react';
import { registerTabView, type TabViewProps } from '../layout/tabViews';
import { Welcome } from './Welcome';

function WelcomeTab({ visible }: TabViewProps) {
  return createElement('div', { className: 'welcome-tab', style: { display: visible ? undefined : 'none' } }, createElement(Welcome, { ready: true }));
}

export function registerOnboardingCommands(): void {
  registerTabView('welcome', { component: WelcomeTab, icon: 'House' });
}
