import { Download, RefreshCw, X } from 'lucide-react';
import { openReleasePage, restartToUpdate } from '../../app/updates';
import { updateNotice, useUpdates } from '../../store/updates';

/**
 * Unobtrusive, persistent card in the toast stack (bottom right): "Rowlit X.Y.Z is ready — Restart now / Later"
 * once an update is downloaded (Windows, signed macOS; Later installs on quit), or "Rowlit X.Y.Z is available —
 * Download / Later" on an ad-hoc signed macOS build, where Download opens the release page.
 */
export function UpdateNotice() {
  const status = useUpdates((s) => s.status);
  const dismissed = useUpdates((s) => s.dismissed);
  const notice = updateNotice(status, dismissed);
  if (!notice) return null;
  const ready = notice.kind === 'ready';
  const later = () => useUpdates.getState().dismiss(notice.version);
  return (
    <div className="toast toast-info update-notice" role="group" aria-label="Update">
      {ready ? <RefreshCw size={16} className="toast-icon" /> : <Download size={16} className="toast-icon" />}
      <div className="toast-body">
        <div className="toast-text">
          Rowlit {notice.version} is {ready ? 'ready' : 'available'}
        </div>
        <div className="toast-detail">
          {ready ? 'Restart to finish updating, or it installs when you quit.' : 'Download the new version from GitHub.'}
        </div>
        <div className="update-notice-actions">
          {ready ? (
            <button type="button" className="btn btn-xs btn-primary" onClick={() => void restartToUpdate()}>
              Restart now
            </button>
          ) : (
            <button type="button" className="btn btn-xs btn-primary" onClick={() => void openReleasePage(notice.releaseUrl)}>
              Download
            </button>
          )}
          <button type="button" className="btn btn-xs" onClick={later}>
            Later
          </button>
        </div>
      </div>
      <button type="button" className="icon-btn sm" onClick={later} aria-label="Dismiss update notice">
        <X size={14} />
      </button>
    </div>
  );
}
