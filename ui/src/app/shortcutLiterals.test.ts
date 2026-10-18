// design-14 / design-r1-08: shortcut text in the UI is generated from the command registry (commandView(id).tooltip,
// <Kbd>, displayShortcut()), so macOS shows ⌘ and remapped keys stay correct. A literal "Ctrl+…" in a string is almost
// always a hand-written label that bypasses that ("(Ctrl+S)" tooltips, "Ctrl+click" hints, "Ctrl+Shift" placeholders);
// this test lists them. Covered: every .tsx, and the .ts files of src/editor and src/components that build user-visible
// strings (object documents, menus, toolbars). Shortcut specs handed to displayShortcut() and `shortcut` fields are
// the registry's input, not labels, and are allowed.
import { describe, expect, it } from 'vitest';

// Component sources and editor / component .ts modules (tests, __tests__ and dev playgrounds excluded), as text.
const SOURCES = import.meta.glob<string>(
  ['../**/*.tsx', '../editor/**/*.ts', '../components/**/*.ts', '!../**/*.test.tsx', '!../**/*.test.ts', '!../**/__tests__/**', '!../**/dev/**'],
  { query: '?raw', import: 'default', eager: true },
);

/** Removes block comments (incl. JSX {/* … *\/}) and line comments, keeping line numbers. */
export function stripComments(src: string): string {
  const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlocks
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
    .join('\n');
}

/** Registry input on a line: displayShortcut('Ctrl+J'), shortcutKeys(…), withShortcut(…, 'Mod+S'), shortcut: '…', shortcut="…". */
const SPEC_USES = [
  /\b(?:displayShortcut|shortcutKeys|ariaKeyShortcuts|toAccelerator|normalizeShortcut|withShortcut)\([^)]*\)/g,
  /\b(?:shortcut|altShortcuts|extraShortcuts|keybinding)s?\s*[:=]\s*\{?\s*(?:\[[^\]]*\]|'[^']*'|"[^"]*"|`[^`]*`)/g,
];

/** A hand-written shortcut label: "Ctrl+…" / "Cmd+…" (any case), "Ctrl-click". `MacCtrl+` specs are not labels. */
const LITERAL = /(?<![A-Za-z])(?:ctrl|cmd)[+-]/i;

export function literalShortcuts(src: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  stripComments(src).split('\n').forEach((l, i) => {
    const rest = SPEC_USES.reduce((s, re) => s.replace(re, ''), l);
    if (LITERAL.test(rest)) out.push({ line: i + 1, text: l.trim() });
  });
  return out;
}

describe('no hard-coded "Ctrl+…" shortcut text in components and editor strings', () => {
  it('ignores comments and registry input; finds labels', () => {
    expect(literalShortcuts('// Apply (Ctrl+S)\n/* (Ctrl+L) */\nconst a = 1; // (Ctrl+K)')).toEqual([]);
    expect(literalShortcuts("title='Apply (Ctrl+S)'")).toHaveLength(1);
    expect(literalShortcuts('return `-- F12 / Ctrl+click opens the object tab`;')).toHaveLength(1);
    expect(literalShortcuts('placeholder="Search by key (e.g. “Ctrl+Shift”)"')).toHaveLength(1);
    expect(literalShortcuts("const k = displayShortcut('Ctrl+Alt+P');")).toEqual([]);
    expect(literalShortcuts("{ id: 'x', shortcut: 'Ctrl+M', run }")).toEqual([]);
    expect(literalShortcuts("shortcut: isMac() ? 'MacCtrl+Shift+M' : 'MacCtrl+M',")).toEqual([]);
  });

  it('every .tsx and editor/component .ts builds shortcut labels from the registry', () => {
    const offenders: string[] = [];
    const files = Object.keys(SOURCES);
    expect(files.filter((f) => f.endsWith('.tsx')).length).toBeGreaterThan(50);
    expect(files).toEqual(expect.arrayContaining(['../editor/object-uri.ts', '../components/PlanView/commands.ts']));
    for (const [f, src] of Object.entries(SOURCES)) {
      for (const hit of literalShortcuts(src)) offenders.push(`${f.replace(/^\.\.\//, '')}:${hit.line}: ${hit.text}`);
    }
    expect(offenders).toEqual([]);
  });
});
