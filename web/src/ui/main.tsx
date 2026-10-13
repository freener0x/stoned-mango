// The app's entry point. Starts the analysis workers right away (they load the engine
// while the page renders), then the interface.
//
// window.stonedMango is a small hook for the browser tests (tests/browser.mjs, tests/ui.mjs).

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AnalysisPool, defaultWorkerCount, type Job } from '../engine/pool.ts';
import { App, applySkin } from './App.tsx';
import { offlineReady, registerServiceWorker } from './pwa.ts';
import { loadSettings } from './settings.ts';
import { Store } from './store.ts';
import './styles.css';

declare global {
  interface Window {
    stonedMango: { pool: AnalysisPool; store: Store; ready: Promise<void>; offline: () => Promise<void>; analyse(files: File[]): Promise<Job[]> };
  }
}

const settings = loadSettings();
applySkin(settings.skin);
const pool = new AnalysisPool({ workers: settings.workers || defaultWorkerCount() });
pool.options = { traditions: settings.traditions };
const store = new Store(pool);
window.stonedMango = { pool, store, ready: pool.ready(), offline: offlineReady, analyse: (files) => store.analyse(files) };
registerServiceWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App store={store} />
  </StrictMode>,
);
