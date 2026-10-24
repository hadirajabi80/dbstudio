import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';
import { loadBrandLogos } from '../theme/brand/ProviderLogo';

// the logo artwork is a lazy chunk in the app; tests render it synchronously
await loadBrandLogos();

afterEach(() => cleanup());

// findBy*/waitFor wait up to 1 s by default. The suite runs ~135 jsdom files in parallel, and views that chain several
// mock-server requests (Mongo stats → schema sample, Redis server → scan → memory, Kafka group → offsets) can take
// longer than that on a loaded machine or CI runner, which failed tests whose UI was correct, only late. A missing
// element still fails, after 5 s (well inside the 15 s test timeout).
configure({ asyncUtilTimeout: 5000 });

// jsdom gaps
if (typeof window !== 'undefined') {
  if (!window.matchMedia) {
    window.matchMedia = (query: string) =>
      ({
        matches: false, media: query, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList;
  }
  if (!('ResizeObserver' in window)) {
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
}
