import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initCommands } from './commands';
import { isMac } from './commands/keys';
import { applyThemeAttribute, systemTheme } from './theme/useTheme';
import './theme/tokens.css';
import './theme/app.css';
import './theme/shell.css';

async function start() {
  // First paint follows the OS theme (settings may override it once loaded).
  applyThemeAttribute(systemTheme());
  if (isMac()) document.documentElement.classList.add('os-mac');
  // `npm run dev:mock`: in-browser fake engine (MSW for REST + a fake WebSocket), no .NET engine needed.
  if (import.meta.env.MODE === 'mock') {
    const { startBrowserMocks } = await import('./mocks/browser');
    await startBrowserMocks();
  }
  await initCommands();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
