// Test harness for the Mongo workspace: MSW mock engine (mocks/m2/mongo.ts shop fixture), FakeSocket for jobs and
// streams, and a host that renders the collection tab like the shell does.
import { render, waitFor } from '@testing-library/react';
import { expect } from 'vitest';
import { engineSocket } from '../../../api/ws';
import { FakeSocket } from '../../../mocks/fakeSocket';
import { useConnections } from '../../../store/connections';
import { useTabs, type ViewTab } from '../../../store/tabs';
import { installMockEngine, TEST_ENGINE_URL } from '../../../test/mockServer';
import CollectionView from '../CollectionView';
import { closeMongoDialog } from '../dialogHost';
import { openCollection, type CollectionTabState, type MongoSub } from '../open';
import { useMongo } from '../store';

export const CID = 'c_mongo';

export function setupMongo() {
  const mock = installMockEngine();
  const reset = async () => {
    mock.reset();
    closeMongoDialog();
    useMongo.setState({ conns: {} });
    useTabs.setState({ tabs: [], activeId: null, seq: 0 });
    useConnections.setState({ providers: [], connections: [], loaded: false, error: null });
    await useConnections.getState().load();
    engineSocket.disconnect();
    engineSocket.setSocketFactory(() => new FakeSocket(mock.ctx.engine, 'test-token'));
    engineSocket.connect({ baseUrl: TEST_ENGINE_URL, token: 'test-token' });
    await waitFor(() => expect(engineSocket.status).toBe('open'));
  };
  return { mock, reset };
}

function Host({ id }: { id: string }) {
  const tab = useTabs((s) => s.tabs.find((t) => t.id === id)) as ViewTab | undefined;
  return tab ? <div data-tab-host={id}><CollectionView tab={tab} theme="light" visible /></div> : null;
}

export function renderCollection(coll = 'orders', sub: MongoSub = 'documents', patch: Partial<CollectionTabState> = {}, db = 'shop') {
  const id = openCollection(CID, db, coll, sub, patch);
  return { id, ...render(<Host id={id} />) };
}

export function tabStateOf(id: string): CollectionTabState {
  return (useTabs.getState().tabs.find((t) => t.id === id) as ViewTab).state as CollectionTabState;
}
