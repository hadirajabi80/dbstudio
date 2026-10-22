// Section of an object tab asked for by a command ("Show dependencies" opens the tab on its Dependencies section).
// The object tab consumes the request; `seq` makes a repeated request for the same section distinct.
import { create } from 'zustand';

export type ObjectSectionId = 'ddl' | 'columns' | 'indexes' | 'fks' | 'refs' | 'params' | 'deps';

interface SectionRequests {
  requests: Record<string, { section: ObjectSectionId; seq: number }>;
}

let seq = 0;

export const useObjectSectionRequests = create<SectionRequests>(() => ({ requests: {} }));

export function requestObjectSection(tabId: string, section: ObjectSectionId): void {
  useObjectSectionRequests.setState((s) => ({ requests: { ...s.requests, [tabId]: { section, seq: ++seq } } }));
}
