// Status bar item of a Cassandra console: "LOCAL_QUORUM · tracing" (the session's consistency and tracing), a button that
// opens the console settings tab. Lazy (StatusBar loads it only for Cassandra connections).
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { CqlSessionSettings } from '../../api/types.cassandra';
import { runCommand } from '../../commands/registry';

/** `sessionId` is the console's engine session; `version` changes whenever a statement finished (CONSISTENCY / TRACING typed in the console). */
export default function CassandraStatusItem({ sessionId, version }: { sessionId: string | null; version: string }) {
  const [state, setState] = useState<{ sid: string; settings: CqlSessionSettings } | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    let live = true;
    api.cassandra.sessionSettings(sessionId).then(
      (settings) => { if (live) setState({ sid: sessionId, settings }); },
      () => { if (live) setState(null); },
    );
    return () => { live = false; };
  }, [sessionId, version]);
  const settings = state && state.sid === sessionId ? state.settings : null;
  if (!settings) return null;
  return (
    <button
      className="sb-item sb-button"
      title="Consistency level and tracing of this console: open the console settings"
      onClick={() => runCommand('cassandra.consoleSettings')}
    >
      {settings.consistency}{settings.tracing ? ' · tracing' : ''}
    </button>
  );
}
