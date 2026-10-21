// M1 entry points kept for callers; the command system lives in ui/src/commands (registry, dispatcher, core).
import type { MenuCommand } from '../platform/bridge';
import { routeMenuCommand } from '../commands/dispatcher';
import { runCommand } from '../commands/registry';

export { onGlobalKeyDown } from '../commands/dispatcher';
export { eventStroke as keyId } from '../commands/keys';
export { runCommand };

/**
 * Native menu → command. The menu sends registry ids (M1.5) or the M1 MenuCommand names (aliased); a key the
 * focused view binds itself (F4 on an ER card or in a Data tab) runs that view's command (routeMenuCommand).
 */
export function handleMenuCommand(cmd: MenuCommand | string): void {
  runCommand(routeMenuCommand(cmd));
}
