import { CircleAlert, Download, LoaderCircle, RefreshCw } from 'lucide-react';
import { describeUpdate, restartToUpdate } from '../../app/updates';
import { useUpdates } from '../../store/updates';
import { openSettings } from '../layout/settings/nav';
import './updateChip.css';

/**
 * The update state at the right of the status bar (the top bar stays free of it): checking (spinner), a new version
 * available, download progress with a small bar, "Restart to update" once it is ready, or a muted mark after a failed
 * check. Nothing when there is nothing to say. A click opens Settings › Updates; on "Restart to update" it restarts.
 */
export function UpdateChip() {
  const status = useUpdates((s) => s.status);
  const d = describeUpdate(status);
  if (!status || !d.chip) return null;
  const ready = status.state === 'ready' && status.mode === 'install';
  const error = status.state === 'error';
  const Icon = status.state === 'checking' ? LoaderCircle : ready ? RefreshCw : error ? CircleAlert : Download;
  return (
    <button
      type="button"
      className={`sb-item sb-button sb-update tone-${d.tone}${ready ? ' ready' : ''}`}
      onClick={() => (ready ? void restartToUpdate() : openSettings('updates'))}
      title={ready ? `${d.text} Click to restart now.` : `${d.text} Click for update settings.`}
      aria-label={error ? 'Update check failed — update settings' : ready ? `Restart to update to DbStudio ${status.version}` : d.chip}
    >
      <Icon size={12} className={status.state === 'checking' ? 'spin' : undefined} aria-hidden="true" />
      {/* a failed check is a quiet mark only: an offline machine should not carry a red label all day */}
      {!error && <span className="sb-update-label">{d.chip}</span>}
      {d.percent !== undefined && (
        <span className="sb-update-bar" role="progressbar" aria-label="Download progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={d.percent}>
          <span className="sb-update-fill" style={{ width: `${d.percent}%` }} />
        </span>
      )}
    </button>
  );
}
