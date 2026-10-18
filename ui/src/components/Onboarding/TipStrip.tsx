import { Lightbulb, X } from 'lucide-react';
import { useSettings } from '../../store/settings';
import { Kbd } from '../Shortcuts/Kbd';

/** One-time 3-tip strip under the toolbar after the first successful run (section 3, onboarding). */
export function TipStrip() {
  const firstRunAt = useSettings((s) => s.settings.ui.firstRunAt as string | undefined);
  const dismissed = useSettings((s) => !!s.settings.ui.tipsDismissed);
  const loaded = useSettings((s) => s.loaded);
  if (!loaded || !firstRunAt || dismissed) return null;
  const dismiss = () => useSettings.getState().update({ ui: { tipsDismissed: true } });
  return (
    <div className="tip-strip" role="note" aria-label="Tips">
      <Lightbulb size={16} strokeWidth={1.5} className="tip-icon" aria-hidden="true" />
      {/* Tips that do not fit wrap onto a hidden second line, so Got it / × always stay visible (narrow or zoomed). */}
      <div className="tip-list">
        <span><Kbd shortcut="Mod+Enter" /> runs the statement under the cursor</span>
        <span><Kbd shortcut="Mod+P" /> jumps to any table or procedure</span>
        <span><Kbd shortcut="Mod+Shift+P" /> finds every command</span>
      </div>
      <button className="btn btn-xs" onClick={dismiss}>Got it</button>
      <button className="icon-btn xs" aria-label="Dismiss tips" onClick={dismiss}>
        <X size={13} />
      </button>
    </div>
  );
}
