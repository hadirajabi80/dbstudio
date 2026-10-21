// "Compare with server" for a console opened by F4 (Edit): Monaco DiffEditor of the object's current server
// definition (with the same re-runnable header) against the tab's text.
import { LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api/client';
import { Dialog } from '../components/common/Dialog';
import * as monaco from '../editor/monaco';
import { ensureMonacoSetup, LANGUAGE_IDS, THEME_IDS } from '../editor/monaco-setup';
import { remeasureAfterFonts } from '../editor/monacoOptions';
import { bindEditorFontSize } from '../editor/fontZoom';
import { useTabs } from '../store/tabs';
import { currentTheme } from '../theme/useTheme';
import { rewriteForEdit } from './rewrite';
import { diffEditorOptions, plainBrackets } from './compareOptions';
import { useDesignerUi } from './store';

export function CompareDialog({ tabId }: { tabId: string }) {
  const close = useDesignerUi((s) => s.closeCompare);
  const session = useDesignerUi((s) => s.edits[tabId]);
  const tab = useTabs((s) => s.tabs.find((t) => t.id === tabId));
  const host = useRef<HTMLDivElement>(null);
  const [server, setServer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    let live = true;
    api
      .ddl(session.connectionId, session.database, session.ref)
      .then((r) => live && setServer(rewriteForEdit(r.ddl, { dialect: session.dialect, type: session.ref.type, name: session.ref.name, schema: session.ref.schema }).text))
      .catch((e) => {
        if (!live) return;
        if (session.serverDdl === undefined) {
          setError(`Could not load the server definition (${errorMessage(e)}).`);
          setServer('');
          return;
        }
        setError(`Could not reload the server definition (${errorMessage(e)}); showing the one loaded when the tab opened.`);
        setServer(rewriteForEdit(session.serverDdl, { dialect: session.dialect, type: session.ref.type, name: session.ref.name, schema: session.ref.schema }).text);
      });
    return () => {
      live = false;
    };
  }, [session]);

  useEffect(() => {
    if (server === null || !host.current || !session || tab?.kind !== 'console') return;
    ensureMonacoSetup();
    const lang = LANGUAGE_IDS[session.dialect];
    const original = monaco.editor.createModel(server, lang);
    const modified = monaco.editor.createModel(tab.text, lang);
    const diff = monaco.editor.createDiffEditor(host.current, diffEditorOptions(THEME_IDS[currentTheme()]));
    diff.setModel({ original, modified });
    // after setModel: attaching a model to an editor re-applies the configured model options
    plainBrackets(original, modified);
    // both sides on Settings.editor.fontSize, live; Ctrl + wheel over the diff changes it
    const unbindFont = bindEditorFontSize(diff, { suggest: false });
    remeasureAfterFonts();
    return () => {
      unbindFont();
      diff.dispose();
      original.dispose();
      modified.dispose();
    };
  }, [server, session, tab]);

  return (
    <Dialog
      title={`Compare with server — ${session?.ref.name ?? ''}`}
      onClose={close}
      width={1100}
      footer={
        <>
          <span className="flex-1 muted">Left: the definition on the server · Right: this tab. Run the tab (F5) to apply.</span>
          <button type="button" className="btn btn-primary" onClick={close}>
            Close
          </button>
        </>
      }
    >
      {!session || tab?.kind !== 'console' ? (
        <p className="muted">This tab was not opened with “Edit” (F4), so there is no server definition to compare with.</p>
      ) : (
        <>
          {error && <p className="muted">{error}</p>}
          <div className="dz-diff" ref={host} aria-label="Differences between the server definition and this tab">
            {server === null && <LoaderCircle size={16} className="spin" aria-label="Loading" />}
          </div>
        </>
      )}
    </Dialog>
  );
}
