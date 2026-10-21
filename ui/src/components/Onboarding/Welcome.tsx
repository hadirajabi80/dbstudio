import { ArrowRight, File, FolderOpen, Sparkles, SquareTerminal } from 'lucide-react';
import type { ProviderId } from '../../api/types';
import { connectAndOpen, openSampleDatabase, openSqliteFile } from '../../app/actions';
import { useConnections } from '../../store/connections';
import { useUi } from '../../store/ui';
import { ColorDot } from '../common/ConnectionBadge';
import { PROVIDER_LABEL } from '../common/icons';
import { ProviderLogo } from '../../theme/brand/ProviderLogo';
import { Kbd } from '../Shortcuts/Kbd';

const PROVIDERS: { id: ProviderId; blurb: string }[] = [
  { id: 'sqlserver', blurb: 'SQL Server 2012+ and Azure SQL' },
  { id: 'oracle', blurb: 'Oracle 11g+ via service name, SID or TNS' },
  // M2 (docs/PLAN-M2.md 1.3)
  { id: 'postgresql', blurb: 'PostgreSQL 12+, Supabase, Neon, RDS' },
  { id: 'sqlite', blurb: 'A local database file' },
  { id: 'redis', blurb: 'Standalone, Cluster, Sentinel; Redis Stack' },
  { id: 'mongodb', blurb: 'mongodb:// and mongodb+srv://, Atlas' },
  { id: 'kafka', blurb: 'Brokers, topics, consumer groups; Schema Registry' },
];

/** First launch / no tabs: welcome screen in the centre area (no modal). */
export function Welcome({ ready }: { ready: boolean }) {
  const connections = useConnections((s) => s.connections);
  const loaded = useConnections((s) => s.loaded);
  const openDialog = useUi((s) => s.openConnectionDialog);
  const recent = [...connections].sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '') || a.name.localeCompare(b.name)).slice(0, 6);
  const first = loaded && connections.length === 0;

  return (
    <div className="welcome" role="region" aria-label="Welcome">
      <div className="welcome-inner">
        <header className="welcome-head">
          <h1>{first ? 'Connect to a database' : 'Welcome back'}</h1>
          <p>
            {first
              ? 'Pick a database type to add your first connection, open a SQLite file, or try the sample database.'
              : 'Open a console on a recent connection, or add a new one.'}
          </p>
        </header>

        {!first && recent.length > 0 && (
          <section className="welcome-section" aria-label="Recent connections">
            <h2>Recent</h2>
            <div className="welcome-recent">
              {recent.map((c) => (
                <button key={c.id} className="welcome-conn" onClick={() => connectAndOpen(c.id)} disabled={!ready}>
                  <ProviderLogo providerId={c.providerId} size={20} />
                  <span className="welcome-conn-text">
                    <span className="welcome-conn-name">
                      <ColorDot color={c.color} size={7} /> {c.name}
                    </span>
                    <span className="welcome-conn-meta">{[PROVIDER_LABEL[c.providerId], c.folder].filter(Boolean).join(' · ')}</span>
                  </span>
                  <SquareTerminal size={16} strokeWidth={1.5} className="welcome-conn-go" aria-hidden="true" />
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="welcome-section" aria-label="New connection">
          {!first && <h2>New connection</h2>}
          <div className="provider-cards">
            {PROVIDERS.map((p) => (
              <button key={p.id} className="provider-card" onClick={() => openDialog({ mode: 'new', providerId: p.id, connectAfter: true })} disabled={!ready && !loaded}>
                <ProviderLogo providerId={p.id} size={32} />
                <span className="provider-card-name">{PROVIDER_LABEL[p.id]}</span>
                <span className="provider-card-blurb">{p.blurb}</span>
                <ArrowRight size={16} className="provider-card-go" aria-hidden="true" />
              </button>
            ))}
          </div>
          <div className="welcome-actions">
            <button className="btn" onClick={() => void openSqliteFile()} disabled={!ready}>
              <FolderOpen size={16} strokeWidth={1.5} /> Open a SQLite file
            </button>
            <button className="btn" onClick={() => void openSampleDatabase()} disabled={!ready}>
              <Sparkles size={16} strokeWidth={1.5} /> Try the sample database
            </button>
            {!first && (
              <button className="btn btn-ghost" onClick={() => connectAndOpen(connections[0]?.id)} disabled={!ready || !connections.length}>
                <File size={16} strokeWidth={1.5} /> New console
              </button>
            )}
          </div>
        </section>

        <footer className="welcome-keys" aria-label="Keyboard shortcuts">
          <span><Kbd shortcut="Mod+Shift+P" /> commands</span>
          <span><Kbd shortcut="Mod+P" /> go to object</span>
          <span><Kbd shortcut="Mod+N" /> new console</span>
          <span><Kbd shortcut="Mod+Enter" /> run statement</span>
          <span><Kbd shortcut="F1" /> all shortcuts</span>
        </footer>
      </div>
    </div>
  );
}
