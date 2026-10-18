// Change state of the view designer (pure): whether the edited view differs from the server's, so an unchanged view
// shows "No changes" and Apply stays disabled, as in the table designer (an unchanged view would otherwise be
// dropped and re-created, or re-run as CREATE OR ALTER, for nothing).
import type { ViewModel, ViewOptions } from '../../api/types';

export const NO_VIEW_OPTIONS: ViewOptions = { schemaBinding: false, checkOption: false, force: false };

export function sameViewOptions(a: ViewOptions | null | undefined, b: ViewOptions | null | undefined): boolean {
  const x = a ?? NO_VIEW_OPTIONS, y = b ?? NO_VIEW_OPTIONS;
  return !!x.schemaBinding === !!y.schemaBinding && !!x.checkOption === !!y.checkOption && !!x.force === !!y.force;
}

export interface ViewEditState {
  loaded: boolean;
  /** The view as stored on the server; null while designing a new view (or when it could not be loaded). */
  server: Pick<ViewModel, 'name' | 'body' | 'options'> | null;
  name: string;
  body: string;
  options: ViewOptions;
  handEdited: boolean;
}

/** True when the design differs from the server (or, for a new view, from the empty template). */
export function viewDirty(s: ViewEditState): boolean {
  if (!s.loaded) return false;
  if (s.server) return s.body !== s.server.body || s.name.trim() !== s.server.name || !sameViewOptions(s.options, s.server.options);
  return s.body.replace(/\s+/g, ' ').trim() !== 'SELECT FROM' && s.body.trim() !== '';
}

/** An existing view, loaded, not edited (neither in the designer nor in the DDL preview): nothing to apply. */
export function viewUnchanged(s: ViewEditState): boolean {
  return s.loaded && !!s.server && !s.handEdited && !viewDirty(s);
}
