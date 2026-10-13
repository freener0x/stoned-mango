// Offline support: registers the service worker (production builds only) and reports when
// the app is saved on the device for offline use, or when a new version is waiting.

import { useSyncExternalStore } from 'react';

export interface PwaState {
  offlineReady: boolean;
  updateReady: boolean;
  applyUpdate(): void;
}

let state: PwaState = { offlineReady: false, updateReady: false, applyUpdate: () => undefined };
const listeners = new Set<() => void>();
const set = (patch: Partial<PwaState>) => {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
};

export function registerServiceWorker(url = `${import.meta.env.BASE_URL}sw.js`): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  let wantReload = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (wantReload) location.reload();
  });
  navigator.serviceWorker.register(url, { scope: import.meta.env.BASE_URL }).then((reg) => {
    const check = () => {
      // An active worker has finished caching every file of its version (install fails otherwise).
      if (reg.active) set({ offlineReady: true });
      if (reg.waiting && navigator.serviceWorker.controller) {
        set({ updateReady: true, applyUpdate: () => {
          wantReload = true;
          reg.waiting?.postMessage({ type: 'SKIP_WAITING' });
        } });
      }
    };
    const watch = (w: ServiceWorker | null) => w?.addEventListener('statechange', check);
    reg.addEventListener('updatefound', () => watch(reg.installing));
    watch(reg.installing);
    watch(reg.waiting);
    check();
  }, () => undefined); // no offline support (for example in a private window): the app still works online
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export function usePwa(): PwaState {
  return useSyncExternalStore(subscribe, () => state);
}

/** For the tests: resolves when the app is saved for offline use. */
export function offlineReady(): Promise<void> {
  return new Promise((resolve) => {
    if (state.offlineReady) return resolve();
    const fn = () => {
      if (state.offlineReady) {
        listeners.delete(fn);
        resolve();
      }
    };
    listeners.add(fn);
  });
}
