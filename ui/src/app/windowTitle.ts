// Window title: "<tab title> — <connection> — Rowlit". Many tab titles already name their connection
// ("Logs & activity — Prod SQL", "Cache · db0", "ER: Shop"), so the connection is only appended when the title does
// not contain it as one of its parts.

/** Parts of a tab title split on its separators (" — ", " · ", " | ", "ER: …"). */
function titleParts(title: string): string[] {
  return title.split(/\s+[—–·|]\s+|:\s+/).map((p) => p.trim()).filter(Boolean);
}

/** True when `title` already names the connection (a whole part, or a part qualified by it: "Shop.main"). */
export function titleNamesConnection(title: string, connection: string): boolean {
  const name = connection.trim();
  if (!name) return false;
  return titleParts(title).some((p) => p === name || p.startsWith(`${name}.`));
}

export function windowTitle(tabTitle: string | null | undefined, connection: string | null | undefined): string {
  const parts: string[] = [];
  if (tabTitle) parts.push(tabTitle);
  if (connection && !(tabTitle && titleNamesConnection(tabTitle, connection))) parts.push(connection);
  parts.push('Rowlit');
  return parts.join(' — ');
}
