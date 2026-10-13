// The app shell: top bar, the current page, and the shared settings and batch state.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { defaultWorkerCount } from '../engine/pool.ts';
import { AboutPage } from './AboutPage.tsx';
import { AccuracyPage } from './AccuracyPage.tsx';
import { DonatePage } from './DonatePage.tsx';
import { PrivacyPage } from './PrivacyPage.tsx';
import { SettingsContext, StoreContext, useRoute, useStoreState, type Route, type SettingsApi } from './context.ts';
import { usePwa } from './pwa.ts';
import { DEFAULTS, loadSettings, saveSettings, type Settings, type Skin } from './settings.ts';
import { SettingsPage } from './SettingsPage.tsx';
import type { Store } from './store.ts';
import { Workspace } from './Workspace.tsx';

const THEME_COLOURS: Record<Skin, [string, string]> = {
  studio: ['#0f1114', '#0f1114'],
  mango: ['#fff4e0', '#fff4e0'],
  minimal: ['#ffffff', '#0d0e10'],
};

export function applySkin(skin: Skin): void {
  document.documentElement.dataset.skin = skin;
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOURS[skin][dark ? 1 : 0]);
}

export function Logo() {
  return (
    <svg className="logo" viewBox="0 0 32 32" aria-hidden="true">
      <path className="logo-fruit" d="M12.2 7.1c5.6-2.4 12.6.4 14.6 6.6 1.9 5.8-.9 12.2-7.2 14.1-5.2 1.6-9.6-.6-12.3-4.4-1.6-2.3-1.6-4.3-.4-6 1.6-2.3 4.3-2.6 5.2-5.3.7-2-.9-3.7.1-5z" />
      <path className="logo-leaf" d="M15.6 6.3c.9-3 3.6-4.6 7.2-4.2-1 3.1-3.7 4.7-7.2 4.2z" />
      <path className="logo-mark" d="M17.5 12.5v9.2a2.3 2 0 1 1-1.4-1.8v-8.6l5.4-1.3v1.5z" />
    </svg>
  );
}

function TopBar({ route, offline }: { route: Route; offline: boolean }) {
  const state = useStoreState();
  const link = (path: string, view: Route['view'], label: string) => (
    <a href={`#/${path}`} aria-current={route.view === view ? 'page' : undefined}>{label}</a>
  );
  return (
    <header className="topbar">
      <a className="brand" href="#/" aria-label="stoned-mango, home">
        <Logo />
        <span className="brand-name">stoned-mango</span>
      </a>
      <nav aria-label="Main">
        {link('', 'main', 'Analyse')}
        {link('settings', 'settings', 'Settings')}
        {link('about', 'about', 'About')}
      </nav>
      <div className="topbar-status">
        <span className={`pill engine-${state.engine}`} title={state.engineError}>
          <span className="led" aria-hidden="true" />
          {state.engine === 'ready' ? 'Engine ready' : state.engine === 'loading' ? 'Loading engine' : 'Engine failed'}
        </span>
        {offline && <span className="pill" title="Saved on this device: works without internet">Offline ready</span>}
      </div>
    </header>
  );
}

export function App({ store }: { store: Store }) {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const update = useCallback((patch: Partial<Settings>) => setSettings((s) => {
    const next = { ...s, ...patch };
    saveSettings(next);
    return next;
  }), []);
  const reset = useCallback(() => {
    saveSettings(DEFAULTS);
    setSettings({ ...DEFAULTS });
  }, []);
  const api: SettingsApi = useMemo(() => ({ settings, update, reset }), [settings, update, reset]);
  const route = useRoute();
  const pwa = usePwa();

  // Effects use block bodies: React calls whatever an effect returns as its cleanup, and newer
  // browsers return promises from methods such as scrollTo().
  useEffect(() => {
    applySkin(settings.skin);
  }, [settings.skin]);
  useEffect(() => {
    store.pool.resize(settings.workers || defaultWorkerCount());
  }, [store, settings.workers]);
  useEffect(() => {
    store.pool.options = { traditions: settings.traditions };
  }, [store, settings.traditions]);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route.view]);

  return (
    <SettingsContext.Provider value={api}>
      <StoreContext.Provider value={store}>
        <div className="app">
          <a className="skip-link" href="#content">Skip to content</a>
          <TopBar route={route} offline={pwa.offlineReady} />
          {pwa.updateReady && (
            <div className="update-banner" role="status">
              A new version is ready. <button onClick={pwa.applyUpdate}>Reload to update</button>
            </div>
          )}
          <div id="content" className="content">
            <div hidden={route.view !== 'main'}><Workspace songId={route.song} active={route.view === 'main'} /></div>
            {route.view === 'settings' && <SettingsPage />}
            {route.view === 'about' && <AboutPage offline={pwa.offlineReady} />}
            {route.view === 'privacy' && <PrivacyPage />}
            {route.view === 'accuracy' && <AccuracyPage />}
            {route.view === 'donate' && <DonatePage />}
          </div>
          <footer className="footer">
            <span>Your music never leaves this device.</span>
            <nav aria-label="More" className="footer-links">
              <a href="#/privacy">Privacy</a>
              <a href="#/accuracy">Accuracy</a>
              <a href="#/donate">Donate</a>
              <a href="https://github.com/freener0x/stoned-mango" rel="noreferrer">Source code (AGPL-3.0)</a>
            </nav>
          </footer>
        </div>
      </StoreContext.Provider>
    </SettingsContext.Provider>
  );
}
