// Export to code dialog (docs/PLAN-M2.md 6.4): the query or pipeline in mongosh, Node.js, C#, Python or Java, with
// or without the client boilerplate; Copy puts it on the clipboard.
import { Copy } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { toast } from '../../store/ui';
import type { EffectiveTheme } from '../../theme/useTheme';
import { Dialog } from '../common/Dialog';
import { CODE_LANGUAGES, exportCode, type CodeLanguage, type ExportInput } from './exportCode';

const CodeView = lazy(() => import('../CodegenPanel/CodeView').then((m) => ({ default: m.CodeView })));
const IS_TEST = import.meta.env.MODE === 'test';

export function ExportCodeDialog({ input, theme, onClose }: { input: ExportInput; theme: EffectiveTheme; onClose: () => void }) {
  const [lang, setLang] = useState<CodeLanguage>('shell');
  const [boilerplate, setBoilerplate] = useState(true);
  const code = exportCode(lang, input, { boilerplate });
  const meta = CODE_LANGUAGES.find((l) => l.id === lang)!;
  return (
    <Dialog title={input.kind === 'aggregate' ? 'Export pipeline to code' : 'Export query to code'} onClose={onClose} width={820} className="mg-code-dialog"
      footer={
        <>
          <label className="check"><input type="checkbox" checked={boilerplate} onChange={(e) => setBoilerplate(e.target.checked)} /> Include imports and client</label>
          <span className="flex-1" />
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn btn-primary" onClick={() => void navigator.clipboard?.writeText(code).then(() => toast('success', `${meta.label} code copied`), () => undefined)}>
            <Copy size={14} aria-hidden /> Copy
          </button>
        </>
      }>
      <div className="segmented mg-langs" role="tablist" aria-label="Language">
        {CODE_LANGUAGES.map((l) => (
          <button key={l.id} role="tab" aria-selected={lang === l.id} className={lang === l.id ? 'on' : ''} onClick={() => setLang(l.id)}>{l.label}</button>
        ))}
      </div>
      <div className="mg-code">
        {IS_TEST ? <pre aria-label="Generated code">{code}</pre> : (
          <Suspense fallback={<pre>{code}</pre>}>
            <CodeView value={code} language={meta.monaco} theme={theme} label={`${meta.label} code`} />
          </Suspense>
        )}
      </div>
    </Dialog>
  );
}
