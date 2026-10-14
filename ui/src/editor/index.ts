// Public surface of the editor package (WP-D).
export { SqlEditor } from './SqlEditor';
export { intelOptionsFromSettings } from './settings';
export type { SqlEditorHandle, SqlEditorProps } from './SqlEditor.types';
export { LANGUAGE_IDS, THEME_IDS, ensureMonacoSetup } from './monaco-setup';
/** Dev page for `/#/playground` (lazy-load it: it bundles the fixture catalogs). */
export const loadEditorPlayground = () => import('./dev/EditorPlayground');
