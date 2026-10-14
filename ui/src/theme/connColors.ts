// Connection colour palette (section 3). Profiles store the light hex; the UI renders the theme-aware token so a
// connection's colour gets lighter in the dark theme. Unknown (M1 / custom) colours are shown as stored.

export interface ConnColor {
  id: string;
  name: string;
  /** Stored in ConnectionProfile.color. */
  hex: string;
  token: string;
}

export const CONNECTION_PALETTE: ConnColor[] = [
  { id: 'red', name: 'Red (production)', hex: '#dc2626', token: '--conn-red' },
  { id: 'orange', name: 'Orange', hex: '#ea580c', token: '--conn-orange' },
  { id: 'yellow', name: 'Yellow', hex: '#ca8a04', token: '--conn-yellow' },
  { id: 'green', name: 'Green', hex: '#16a34a', token: '--conn-green' },
  { id: 'blue', name: 'Blue', hex: '#2563eb', token: '--conn-blue' },
  { id: 'purple', name: 'Purple', hex: '#7c3aed', token: '--conn-purple' },
  { id: 'grey', name: 'Grey', hex: '#6b7280', token: '--conn-grey' },
];

/** M1 palette values, mapped to the nearest M1.5 hue. */
const LEGACY: Record<string, string> = {
  '#e5484d': 'red', '#f76b15': 'orange', '#ffc53d': 'yellow', '#46a758': 'green', '#12a594': 'green', '#0090ff': 'blue',
  '#8e4ec6': 'purple', '#d6409f': 'purple', '#8d8d8d': 'grey',
};

export function paletteEntry(color: string | null | undefined): ConnColor | undefined {
  if (!color) return undefined;
  const c = color.toLowerCase();
  return CONNECTION_PALETTE.find((p) => p.hex === c) ?? CONNECTION_PALETTE.find((p) => p.id === LEGACY[c]);
}

/** CSS value for a connection colour (a token reference for palette colours). */
export function connColorCss(color: string | null | undefined): string | undefined {
  if (!color) return undefined;
  const p = paletteEntry(color);
  return p ? `var(${p.token})` : color;
}

/** Human name for tooltips ("no information by colour alone"). */
export function connColorName(color: string | null | undefined): string | null {
  if (!color) return null;
  return paletteEntry(color)?.name ?? color;
}

/** Red marks production: tints the Run button border. */
export function isProductionColor(color: string | null | undefined): boolean {
  return paletteEntry(color)?.id === 'red';
}
