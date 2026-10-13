import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './theme/tokens.css';
import './theme/app.css';

async function start() {
  // `npm run dev:mock`: in-browser fake engine (MSW for REST + a fake WebSocket), no .NET engine needed.
  if (import.meta.env.MODE === 'mock') {
    const { startBrowserMocks } = await import('./mocks/browser');
    await startBrowserMocks();
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
