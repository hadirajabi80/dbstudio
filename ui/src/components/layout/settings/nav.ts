// Which Settings section is shown, kept across openings of the dialog (this session), and a way to open the dialog
// on a given section (the status bar update chip opens Settings › Updates).
import { create } from 'zustand';
import { useUi } from '../../../store/ui';

export type SettingsSection = 'general' | 'appearance' | 'editor' | 'results' | 'format' | 'connections' | 'snippets' | 'updates';

interface SettingsNavState {
  section: SettingsSection;
  setSection(section: SettingsSection): void;
}

export const useSettingsNav = create<SettingsNavState>((set) => ({
  section: 'general',
  setSection: (section) => set({ section }),
}));

/** Opens the Settings dialog, optionally on a section. */
export function openSettings(section?: SettingsSection): void {
  if (section) useSettingsNav.getState().setSection(section);
  useUi.getState().setSettingsOpen(true);
}
