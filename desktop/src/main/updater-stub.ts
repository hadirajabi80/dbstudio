// Auto-update is out of scope for M1 (unsigned installer, R10). This stub keeps the call site in
// main.ts stable so electron-updater can be dropped in later without touching startup code.
export interface UpdateCheckResult { available: false; reason: string }

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  return { available: false, reason: 'Auto-update is not enabled in this build.' };
}
