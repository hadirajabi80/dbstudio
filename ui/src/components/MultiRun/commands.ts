// Auto-loaded by commands/index.ts: registers the multi-run result tab view (the command itself, run.multi, is core).
import { disposeMulti, MULTIRUN_VIEW } from '../../app/multiRun';
import { registerTabView } from '../layout/tabViews';
import { MultiRunView } from './MultiRunView';

export function registerMultiRunCommands(): void {
  registerTabView(MULTIRUN_VIEW, { component: MultiRunView, icon: 'Layers', onClosed: disposeMulti });
}
