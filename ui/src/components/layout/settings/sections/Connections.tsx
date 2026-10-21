import { useSettings, type FullSettings } from '../../../../store/settings';
import { Card, Num, Row } from '../controls';

export function ConnectionsSection() {
  const s = useSettings((x) => x.settings) as FullSettings;
  const up = useSettings.getState().update;
  return (
    <Card title="Sessions" description="Each console, data tab and object tab uses a session on its connection.">
      <Row label="Sessions per connection" htmlFor="set-sess" hint="The engine refuses more (SESSION_LIMIT)" keywords="session limit pool connection">
        <Num id="set-sess" value={s.connections.maxSessionsPerProfile} min={1} max={64} onChange={(v) => up({ connections: { maxSessionsPerProfile: v } })} />
      </Row>
    </Card>
  );
}
