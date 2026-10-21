// Colour themes (app) and code themes (Monaco). tokens.css stays the source of the two base themes (Light / Dark);
// every other theme is a set of overrides of its base block, applied as inline custom properties on <html>
// (theme/applyTheme.ts). Like tokens.css, this is one of the few files where colours are written down: the token
// lint (tokens.test.ts) skips src/theme/, and themes.test.ts checks every theme against the full contrast matrix.
//
// Settings: settings.theme stays the engine-validated mode (system | light | dark). The chosen themes live in the
// free-form settings.ui bag: one light and one dark slot (so "Follow system" switches between the user's two
// favourites) and the code theme ('match' = derived from the app theme).

export type ThemeBase = 'light' | 'dark';
export type ThemeVars = Readonly<Record<string, string>>;

export interface AppTheme {
  id: string;
  name: string;
  base: ThemeBase;
  /** One line under the name in the picker. */
  description: string;
  /** Overrides of the base block of tokens.css (raw declarations, resolved together with it). */
  vars: ThemeVars;
}

export interface EditorTheme {
  id: string;
  name: string;
  base: ThemeBase;
  /** Overrides of the base block for the editor surface, its widgets (suggest, hover, find, menus) and the syntax. */
  vars: ThemeVars;
}

/** settings.ui keys (free-form bag, no engine change; same pattern as AUTO_CHECK_UPDATES_KEY). */
export const APP_THEME_LIGHT_KEY = 'appThemeLight';
export const APP_THEME_DARK_KEY = 'appThemeDark';
export const EDITOR_THEME_KEY = 'editorTheme';
/** Code theme value: derive the editor colours from the app theme. */
export const MATCH_APP = 'match';

/** Translucent glass tints of a theme's panel colour (the top bar, shell.css). */
function glass(rgb: string, dark: boolean, material: string): Record<string, string> {
  return {
    '--glass-bg': `rgb(${rgb} / ${dark ? 70 : 62}%)`,
    '--glass-bg-native': `rgb(${rgb} / ${dark ? 50 : 45}%)`,
    '--glass-material': material,
  };
}

// ------------------------------------------------------------------ app themes

const MIDNIGHT: ThemeVars = {
  '--bg-app': '#0b0f17',
  '--bg-panel': '#111722',
  '--bg-elevated': '#171f2c',
  '--bg-hover': '#1b2433',
  '--bg-selected': '#1d3354',
  '--bg-grid-alt': '#0f141e',
  '--bg-sunken': '#0d121b',
  '--bg-active': '#243045',
  '--bg-input': '#0d121b',
  '--bg-selected-inactive': '#1c2534',
  '--bg-hover-elevated': '#222c3d',
  '--border': '#2e3a50',
  '--border-strong': '#5d6d86',
  '--border-subtle': '#1b2433',
  '--fg': '#e2e8f0',
  '--fg-muted': '#94a3b8',
  '--fg-disabled': '#4f5b6e',
  '--fg-muted-on-selected': '#b6c3d6',
  '--accent': '#60a5fa',
  '--accent-fg': '#0b1220',
  '--accent-hover': '#93c5fd',
  '--accent-soft': '#142640',
  '--accent-soft-strong': '#1c3558',
  '--accent-on-selected': '#a9cdfd',
  '--focus-ring': '#93c5fd',
  '--brand': '#60a5fa',
  '--brand-fg': '#0b1220',
  '--success-soft': '#10261b',
  '--warning-soft': '#2a2413',
  '--danger-soft': '#2e191c',
  '--info-soft': '#0f262c',
  '--num': '#7dcfff',
  '--string': '#9ece6a',
  '--date': '#c0a6f7',
  '--bool': '#ff9e64',
  '--syn-keyword': '#7aa2f7',
  '--syn-string': '#9ece6a',
  '--syn-comment': '#7f8ca3',
  '--syn-number': '#ff9e64',
  '--syn-function': '#bb9af7',
  '--syn-variable': '#e0af68',
  '--syn-operator': '#a9b1d6',
  '--syn-type': '#7dcfff',
  ...glass('17 23 34', true, '#1c2230'),
};

const NORD: ThemeVars = {
  '--bg-app': '#272c36',
  '--bg-panel': '#2e3440',
  '--bg-elevated': '#353c4a',
  '--bg-hover': '#3a4150',
  '--bg-selected': '#3c4f66',
  '--bg-grid-alt': '#2b313c',
  '--bg-sunken': '#2a2f3a',
  '--bg-active': '#434c5e',
  '--bg-input': '#2a2f3a',
  '--bg-selected-inactive': '#3b4252',
  '--bg-hover-elevated': '#414a5b',
  '--border': '#485164',
  '--border-strong': '#7b879c',
  '--border-subtle': '#3a4150',
  '--fg': '#eceff4',
  '--fg-muted': '#aab4c4',
  '--fg-disabled': '#646f85',
  '--fg-muted-on-selected': '#c5cdda',
  '--accent': '#88c0d0',
  '--accent-fg': '#1f242d',
  '--accent-hover': '#a3d0dd',
  '--accent-soft': '#36475a',
  '--accent-soft-strong': '#3f5569',
  '--accent-on-selected': '#b4dbe6',
  '--focus-ring': '#8fbcbb',
  '--brand': '#88c0d0',
  '--brand-fg': '#1f242d',
  '--success': '#a3be8c',
  '--warning': '#ebcb8b',
  '--danger': '#e3949b',
  '--info': '#8fbcbb',
  '--danger-text': '#efb1b6',
  '--success-soft': '#38443d',
  '--warning-soft': '#45433f',
  '--danger-soft': '#463a43',
  '--info-soft': '#344548',
  '--num': '#88c0d0',
  '--string': '#a3be8c',
  '--date': '#c6a4c2',
  '--bool': '#d99a80',
  '--syn-keyword': '#81a1c1',
  '--syn-string': '#a3be8c',
  '--syn-comment': '#929db1',
  '--syn-number': '#c6a4c2',
  '--syn-function': '#88c0d0',
  '--syn-variable': '#ebcb8b',
  '--syn-operator': '#d8dee9',
  '--syn-type': '#8fbcbb',
  '--obj-table': '#88c0d0',
  '--obj-db': '#81a1c1',
  '--obj-view': '#c6a4c2',
  '--obj-routine': '#8fbcbb',
  '--obj-package': '#ebcb8b',
  '--obj-trigger': '#ebcb8b',
  '--obj-key': '#ebcb8b',
  '--obj-fk': '#88c0d0',
  '--obj-other': '#aab4c4',
  ...glass('46 52 64', true, '#30353f'),
};

const VIOLET: ThemeVars = {
  '--bg-app': '#21222c',
  '--bg-panel': '#282a36',
  '--bg-elevated': '#2f3241',
  '--bg-hover': '#343746',
  '--bg-selected': '#44475a',
  '--bg-grid-alt': '#252733',
  '--bg-sunken': '#23242f',
  '--bg-active': '#4a4d62',
  '--bg-input': '#23242f',
  '--bg-selected-inactive': '#393b4b',
  '--bg-hover-elevated': '#3b3e50',
  '--border': '#44475a',
  '--border-strong': '#7a7fa3',
  '--border-subtle': '#343746',
  '--fg': '#f8f8f2',
  '--fg-muted': '#acb0c8',
  '--fg-disabled': '#636781',
  '--fg-muted-on-selected': '#c9cce0',
  '--accent': '#bd93f9',
  '--accent-fg': '#1e1f29',
  '--accent-hover': '#cfaefb',
  '--accent-soft': '#3a3352',
  '--accent-soft-strong': '#4a3f6b',
  '--accent-on-selected': '#dcc4fd',
  '--focus-ring': '#d2b4fc',
  '--brand': '#bd93f9',
  '--brand-fg': '#1e1f29',
  '--success': '#50fa7b',
  '--warning': '#ffb86c',
  '--danger': '#ff6e6e',
  '--info': '#8be9fd',
  '--danger-text': '#ff9a9a',
  '--success-soft': '#24392f',
  '--warning-soft': '#3e3430',
  '--danger-soft': '#422a32',
  '--info-soft': '#263c47',
  '--num': '#bd93f9',
  '--string': '#f1fa8c',
  '--date': '#ff79c6',
  '--bool': '#ffb86c',
  '--syn-keyword': '#ff79c6',
  '--syn-string': '#f1fa8c',
  '--syn-comment': '#8e98c9',
  '--syn-number': '#bd93f9',
  '--syn-function': '#50fa7b',
  '--syn-variable': '#ffb86c',
  '--syn-operator': '#ff79c6',
  '--syn-type': '#8be9fd',
  '--obj-table': '#8be9fd',
  '--obj-db': '#bd93f9',
  '--obj-view': '#bd93f9',
  '--obj-routine': '#50fa7b',
  '--kind-database': '#c6a8fb',
  ...glass('40 42 54', true, '#2c2e3a'),
};

const PAPER: ThemeVars = {
  '--bg-app': '#f2eee5',
  '--bg-panel': '#fbf9f4',
  '--bg-elevated': '#fffdf9',
  '--bg-hover': '#ede8dd',
  '--bg-selected': '#d9ebe6',
  '--bg-grid-alt': '#f7f4ed',
  '--bg-sunken': '#efebe1',
  '--bg-active': '#e5dfd2',
  '--bg-input': '#fffdf9',
  '--bg-selected-inactive': '#ebe6da',
  '--bg-hover-elevated': '#f1ece2',
  '--border': '#cfc7b6',
  '--border-strong': '#8c8474',
  '--border-subtle': '#e8e2d6',
  '--fg': '#2a251f',
  '--fg-muted': '#655d52',
  '--fg-disabled': '#a59d8f',
  '--fg-muted-on-selected': '#575046',
  '--accent': '#0f766e',
  '--accent-fg': '#ffffff',
  '--accent-hover': '#115e59',
  '--accent-soft': '#e2f0ec',
  '--accent-soft-strong': '#c6e2db',
  '--accent-on-selected': '#0b5550',
  '--focus-ring': '#0f766e',
  '--brand': '#0f766e',
  '--brand-fg': '#ffffff',
  '--success-soft': '#edf6eb',
  '--warning-soft': '#fbf3e6',
  '--danger-soft': '#f8e6e2',
  '--info-soft': '#e2f0f1',
  '--num': '#1d4ed8',
  '--string': '#4d7c0f',
  '--date': '#7e22ce',
  '--bool': '#9a3412',
  '--syn-keyword': '#9a3412',
  '--syn-string': '#4d6b0f',
  '--syn-comment': '#736a5d',
  '--syn-number': '#a14a07',
  '--syn-function': '#6d28d9',
  '--syn-variable': '#8a5a00',
  '--syn-operator': '#4a453e',
  '--syn-type': '#0e6a7d',
  '--obj-table': '#0f766e',
  '--obj-db': '#0f766e',
  '--kind-column': '#0e6a7d',
  '--conn-green': '#15803d',
  ...glass('251 249 244', false, '#e9e5db'),
};

const SOLARIZED_LIGHT: ThemeVars = {
  '--bg-app': '#f1ead6',
  '--bg-panel': '#fdf6e3',
  '--bg-elevated': '#fffaee',
  '--bg-hover': '#efe8d2',
  '--bg-selected': '#dfe6dc',
  '--bg-grid-alt': '#f9f2de',
  '--bg-sunken': '#f3ecd8',
  '--bg-active': '#e8e0c8',
  '--bg-input': '#fffaee',
  '--bg-selected-inactive': '#ede5cf',
  '--bg-hover-elevated': '#f3ecd8',
  '--border': '#d4c9a8',
  '--border-strong': '#8a8f84',
  '--border-subtle': '#ece4cc',
  '--fg': '#073642',
  '--fg-muted': '#4b6168',
  '--fg-disabled': '#a3a99c',
  '--fg-muted-on-selected': '#435960',
  '--accent': '#1f6aa5',
  '--accent-fg': '#ffffff',
  '--accent-hover': '#18578a',
  '--accent-soft': '#e3ebe6',
  '--accent-soft-strong': '#cddcdd',
  '--accent-on-selected': '#154f7d',
  '--focus-ring': '#1f6aa5',
  '--brand': '#1f6aa5',
  '--brand-fg': '#ffffff',
  '--success': '#5c6b00',
  '--warning': '#9c4a12',
  '--danger': '#bb2420',
  '--info': '#1c706b',
  '--success-soft': '#ecefd5',
  '--warning-soft': '#f8e8d2',
  '--danger-soft': '#f9e2d6',
  '--info-soft': '#e4efe8',
  '--num': '#1f6aa5',
  '--string': '#227a72',
  '--date': '#5a5fb0',
  '--bool': '#ad3f12',
  '--syn-keyword': '#5e6b00',
  '--syn-string': '#1d7a72',
  '--syn-comment': '#5f6f73',
  '--syn-number': '#b33275',
  '--syn-function': '#1f6aa5',
  '--syn-variable': '#8a6400',
  '--syn-operator': '#4b6168',
  '--syn-type': '#9c4a12',
  '--obj-table': '#1f6aa5',
  '--obj-db': '#1f6aa5',
  '--obj-view': '#5a5fb0',
  '--obj-routine': '#1f7a74',
  '--obj-trigger': '#8a6400',
  '--obj-key': '#8a6400',
  '--obj-fk': '#1f7a74',
  '--obj-package': '#9c4a12',
  '--obj-other': '#4b6168',
  '--kind-column': '#1f7a74',
  '--kind-function': '#5c6b00',
  '--kind-schema': '#8a6400',
  '--kind-snippet': '#ad3f12',
  '--kind-alias': '#b33275',
  '--conn-green': '#15803d',
  '--conn-orange': '#c2410c',
  ...glass('253 246 227', false, '#e9e3d1'),
};

/** The app themes, light ones first (the picker groups them by base). */
export const APP_THEMES: readonly AppTheme[] = [
  { id: 'light', name: 'Light', base: 'light', description: 'Crisp and neutral', vars: {} },
  { id: 'paper', name: 'Paper', base: 'light', description: 'Warm paper, teal accent', vars: PAPER },
  { id: 'solarized-light', name: 'Solarized Light', base: 'light', description: 'Low-glare cream', vars: SOLARIZED_LIGHT },
  { id: 'dark', name: 'Dark', base: 'dark', description: 'Soft graphite', vars: {} },
  { id: 'midnight', name: 'Midnight', base: 'dark', description: 'Deep blue-black', vars: MIDNIGHT },
  { id: 'nord', name: 'Nord', base: 'dark', description: 'Arctic slate, frost blue', vars: NORD },
  { id: 'violet', name: 'Violet', base: 'dark', description: 'Dracula-style purple', vars: VIOLET },
];

export const DEFAULT_APP_THEME: Record<ThemeBase, string> = { light: 'light', dark: 'dark' };

// ----------------------------------------------------------------- code themes
// Standalone code themes define the whole editor surface (background, widgets, selection) over their base block.

const GITHUB_LIGHT: ThemeVars = {
  '--bg-panel': '#ffffff',
  '--bg-elevated': '#ffffff',
  '--bg-hover': '#eef1f4',
  '--bg-hover-elevated': '#eef1f4',
  '--bg-selected': '#ddf4ff',
  '--bg-selected-inactive': '#eaeef2',
  '--bg-sunken': '#f6f8fa',
  '--bg-input': '#ffffff',
  '--border': '#d0d7de',
  '--border-strong': '#8c959f',
  '--border-subtle': '#eaeef2',
  '--fg': '#1f2328',
  '--fg-muted': '#59636e',
  '--fg-disabled': '#8c959f',
  '--fg-muted-on-selected': '#4b5560',
  '--accent': '#0969da',
  '--accent-hover': '#0550ae',
  '--accent-on-selected': '#0550ae',
  '--accent-soft': '#ddf4ff',
  '--focus-ring': '#0969da',
  '--syn-keyword': '#cf222e',
  '--syn-string': '#0a3069',
  '--syn-comment': '#59636e',
  '--syn-number': '#0550ae',
  '--syn-function': '#8250df',
  '--syn-variable': '#953800',
  '--syn-operator': '#1f2328',
  '--syn-type': '#116329',
  '--kind-table': '#0969da',
  '--kind-view': '#8250df',
  '--kind-column': '#0a6e7c',
  '--kind-function': '#116329',
  '--kind-schema': '#9a6700',
  '--kind-database': '#4338ca',
  '--kind-snippet': '#bc4c00',
  '--kind-alias': '#bf3989',
};

const ONE_DARK: ThemeVars = {
  '--bg-panel': '#282c34',
  '--bg-elevated': '#21252b',
  '--bg-hover': '#2c313a',
  '--bg-hover-elevated': '#2c313c',
  '--bg-selected': '#3a4150',
  '--bg-selected-inactive': '#323844',
  '--bg-sunken': '#21252b',
  '--bg-input': '#1d2026',
  '--border': '#3e4451',
  '--border-strong': '#717a8c',
  '--border-subtle': '#2c313a',
  '--fg': '#d7dae0',
  '--fg-muted': '#9da5b4',
  '--fg-disabled': '#5c6370',
  '--fg-muted-on-selected': '#b8bfcc',
  '--accent': '#61afef',
  '--accent-hover': '#8cc3f3',
  '--accent-on-selected': '#9ccdf6',
  '--accent-soft': '#2b3a4d',
  '--accent-fg': '#1d2026',
  '--focus-ring': '#61afef',
  '--syn-keyword': '#c678dd',
  '--syn-string': '#98c379',
  '--syn-comment': '#8f95a0',
  '--syn-number': '#d19a66',
  '--syn-function': '#61afef',
  '--syn-variable': '#e8767e',
  '--syn-operator': '#56b6c2',
  '--syn-type': '#e5c07b',
  '--kind-table': '#61afef',
  '--kind-view': '#c678dd',
  '--kind-column': '#56b6c2',
  '--kind-function': '#98c379',
  '--kind-schema': '#e5c07b',
  '--kind-database': '#a3b5f5',
  '--kind-snippet': '#d19a66',
  '--kind-alias': '#e8767e',
};

const MONOKAI: ThemeVars = {
  '--bg-panel': '#272822',
  '--bg-elevated': '#2f302a',
  '--bg-hover': '#34352f',
  '--bg-hover-elevated': '#393a33',
  '--bg-selected': '#49483e',
  '--bg-selected-inactive': '#3e3d36',
  '--bg-sunken': '#22231e',
  '--bg-input': '#22231e',
  '--border': '#49483e',
  '--border-strong': '#7d7b6c',
  '--border-subtle': '#34352f',
  '--fg': '#f8f8f2',
  '--fg-muted': '#b1ae9c',
  '--fg-disabled': '#75715e',
  '--fg-muted-on-selected': '#cdcab8',
  '--accent': '#a6e22e',
  '--accent-hover': '#bdee5c',
  '--accent-on-selected': '#c4f06c',
  '--accent-soft': '#3a4422',
  '--accent-fg': '#1e1f1a',
  '--focus-ring': '#a6e22e',
  '--syn-keyword': '#ff4f8b',
  '--syn-string': '#e6db74',
  '--syn-comment': '#9a9580',
  '--syn-number': '#ae81ff',
  '--syn-function': '#a6e22e',
  '--syn-variable': '#fd971f',
  '--syn-operator': '#ff4f8b',
  '--syn-type': '#66d9ef',
  '--kind-table': '#66d9ef',
  '--kind-view': '#ae81ff',
  '--kind-column': '#8fe3d0',
  '--kind-function': '#a6e22e',
  '--kind-schema': '#e6db74',
  '--kind-database': '#b8a3ff',
  '--kind-snippet': '#fd971f',
  '--kind-alias': '#ff6f9f',
};

const SOLARIZED_DARK: ThemeVars = {
  '--bg-panel': '#002b36',
  '--bg-elevated': '#06333f',
  '--bg-hover': '#0a3743',
  '--bg-hover-elevated': '#0d3e4b',
  '--bg-selected': '#174652',
  '--bg-selected-inactive': '#0f3c48',
  '--bg-sunken': '#00252f',
  '--bg-input': '#00252f',
  '--border': '#1b4a56',
  '--border-strong': '#5e7f86',
  '--border-subtle': '#0a3743',
  '--fg': '#d2d9d6',
  '--fg-muted': '#93a1a1',
  '--fg-disabled': '#4f6c73',
  '--fg-muted-on-selected': '#adbaba',
  '--accent': '#4aa3df',
  '--accent-hover': '#72b8e7',
  '--accent-on-selected': '#86c3ec',
  '--accent-soft': '#0a3446',
  '--accent-fg': '#00212a',
  '--focus-ring': '#4aa3df',
  '--syn-keyword': '#a3b51a',
  '--syn-string': '#35b5aa',
  '--syn-comment': '#839496',
  '--syn-number': '#e0609a',
  '--syn-function': '#4aa3df',
  '--syn-variable': '#cc9a06',
  '--syn-operator': '#93a1a1',
  '--syn-type': '#e0743e',
  '--kind-table': '#4aa3df',
  '--kind-view': '#8f93db',
  '--kind-column': '#35b5aa',
  '--kind-function': '#a3b51a',
  '--kind-schema': '#cc9a06',
  '--kind-database': '#c0a3e8',
  '--kind-snippet': '#e0743e',
  '--kind-alias': '#e0609a',
};

/** The code themes besides "Match app theme" (themes of the app list reuse their colours). */
export const EDITOR_THEMES: readonly EditorTheme[] = [
  { id: 'light', name: 'DbStudio Light', base: 'light', vars: {} },
  { id: 'github-light', name: 'GitHub Light', base: 'light', vars: GITHUB_LIGHT },
  { id: 'paper', name: 'Paper', base: 'light', vars: PAPER },
  { id: 'solarized-light', name: 'Solarized Light', base: 'light', vars: SOLARIZED_LIGHT },
  { id: 'dark', name: 'DbStudio Dark', base: 'dark', vars: {} },
  { id: 'midnight', name: 'Midnight', base: 'dark', vars: MIDNIGHT },
  { id: 'nord', name: 'Nord', base: 'dark', vars: NORD },
  { id: 'dracula', name: 'Dracula', base: 'dark', vars: VIOLET },
  { id: 'one-dark', name: 'One Dark', base: 'dark', vars: ONE_DARK },
  { id: 'monokai', name: 'Monokai', base: 'dark', vars: MONOKAI },
  { id: 'solarized-dark', name: 'Solarized Dark', base: 'dark', vars: SOLARIZED_DARK },
];

// --------------------------------------------------------------------- lookup

export function appThemeById(id: unknown): AppTheme | undefined {
  return APP_THEMES.find((t) => t.id === id);
}

export function editorThemeById(id: unknown): EditorTheme | undefined {
  return EDITOR_THEMES.find((t) => t.id === id);
}

/** settings.ui key of a mode's slot. */
export function appThemeKey(base: ThemeBase): string {
  return base === 'dark' ? APP_THEME_DARK_KEY : APP_THEME_LIGHT_KEY;
}

/** The app theme the user picked for a mode (unknown ids and ids of the other base fall back to the default). */
export function appThemeFor(ui: Readonly<Record<string, unknown>> | undefined, base: ThemeBase): AppTheme {
  const t = appThemeById(ui?.[appThemeKey(base)]);
  return t && t.base === base ? t : appThemeById(DEFAULT_APP_THEME[base])!;
}

/** The code theme setting ('match' unless a known code theme is chosen). */
export function editorThemeIdFor(ui: Readonly<Record<string, unknown>> | undefined): string {
  return editorThemeById(ui?.[EDITOR_THEME_KEY]) ? (ui![EDITOR_THEME_KEY] as string) : MATCH_APP;
}
