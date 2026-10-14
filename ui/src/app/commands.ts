// M1 entry points kept for callers; the command system lives in ui/src/commands (registry, dispatcher, core).
import type { MenuCommand } from '../platform/bridge';
import { runCommand } from '../commands/registry';

export { onGlobalKeyDown } from '../commands/dispatcher';
export { eventStroke as keyId } from '../commands/keys';
export { runCommand };

/** Native menu → command. The menu sends registry ids (M1.5) or the M1 MenuCommand names (aliased). */
export function handleMenuCommand(cmd: MenuCommand | string): void {
  runCommand(cmd);
}
