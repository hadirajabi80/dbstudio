import type { EngineInfo, FileFilter, Platform } from './types';

const WORKSPACE_KEY = 'dbstudio.workspace.v1';

/** Engine endpoint in browser mode: VITE_ENGINE_URL / VITE_ENGINE_TOKEN, or the in-page mock in `--mode mock`. */
export function browserEngineInfo(): EngineInfo {
  if (import.meta.env.MODE === 'mock') return { baseUrl: `${location.origin}/__mock`, token: 'mock-token' };
  const env = import.meta.env as Record<string, string | undefined>;
  return {
    baseUrl: env.VITE_ENGINE_URL || 'http://127.0.0.1:5121',
    token: env.VITE_ENGINE_TOKEN || 'dev-token',
  };
}

function download(name: string, content: Blob | string, mime = 'text/plain;charset=utf-8'): void {
  const blob = typeof content === 'string' ? new Blob([content], { type: mime }) : content;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function accept(filters?: FileFilter[]): string {
  return (filters ?? []).flatMap((f) => f.extensions.filter((e) => e !== '*').map((e) => `.${e}`)).join(',');
}

export function createBrowserPlatform(): Platform {
  return {
    kind: 'browser',
    appVersion: 'dev',
    hasFileSystem: false,
    getEngineInfo: async () => browserEngineInfo(),
    showSaveDialog: async () => null,
    showOpenDialog: async () => null,
    async saveFile({ suggestedName, content, mime }) {
      download(suggestedName, content, mime);
      return suggestedName;
    },
    openTextFile({ filters }) {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = accept(filters);
        input.onchange = async () => {
          const f = input.files?.[0];
          if (!f) return resolve(null);
          resolve({ name: f.name, path: null, content: await f.text() });
        };
        input.click();
      });
    },
    writeTextFile: async () => {
      throw new Error('Writing files by path is not available in the browser');
    },
    openExternal: async (url) => {
      window.open(url, '_blank', 'noopener');
    },
    onMenuCommand: () => () => {},
    onEngineRestarted: () => () => {},
    async loadWorkspace() {
      try {
        const raw = localStorage.getItem(WORKSPACE_KEY);
        return raw ? (JSON.parse(raw) as unknown) : null;
      } catch {
        return null;
      }
    },
    async saveWorkspace(data) {
      try {
        localStorage.setItem(WORKSPACE_KEY, JSON.stringify(data));
      } catch {
        /* quota or privacy mode: session restore is best effort */
      }
    },
    setTitle(title) {
      document.title = title;
    },
  };
}
