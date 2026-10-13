// Shared React state: the settings, the batch store, the current view (in the URL hash,
// so the phone's back button closes a song) and media queries.

import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';
import type { Settings } from './settings.ts';
import type { Store, StoreState } from './store.ts';

export interface SettingsApi {
  settings: Settings;
  update(patch: Partial<Settings>): void;
  reset(): void;
}

export const SettingsContext = createContext<SettingsApi | null>(null);
export const StoreContext = createContext<Store | null>(null);

export function useSettings(): SettingsApi {
  const api = useContext(SettingsContext);
  if (!api) throw new Error('useSettings outside SettingsContext');
  return api;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore outside StoreContext');
  return store;
}

export function useStoreState(): StoreState {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.getState);
}

export interface Route {
  view: 'main' | 'settings' | 'about' | 'privacy' | 'accuracy' | 'donate';
  song?: number;
}

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  for (const view of ['settings', 'about', 'privacy', 'accuracy', 'donate'] as const) if (path === view) return { view };
  const song = /^song\/(\d+)$/.exec(path);
  return song ? { view: 'main', song: Number(song[1]) } : { view: 'main' };
}

const onHash = (fn: () => void) => {
  window.addEventListener('hashchange', fn);
  return () => window.removeEventListener('hashchange', fn);
};

export function useRoute(): Route {
  const hash = useSyncExternalStore(onHash, () => location.hash);
  return parseRoute(hash);
}

/** Go to a view; ``replace`` swaps the current history entry (moving between songs). */
export function go(path: string, replace = false): void {
  const hash = `#/${path}`;
  if (replace) location.replace(hash);
  else location.hash = hash;
}

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((fn: () => void) => {
    const mq = matchMedia(query);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, [query]);
  return useSyncExternalStore(subscribe, () => matchMedia(query).matches);
}
