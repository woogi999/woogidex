// Offline support: registers the service worker (sw/service-worker.js, built
// into dist/sw.js by vite.config.js) and tells the visitor when they lose or
// regain their connection, so a community page that won't load reads as
// "you're offline" rather than "the site is broken".

import { log } from './log.ts';
import { api } from './app.ts';
import { whenIdle } from './device.ts';

export function registerOfflineSupport() {
    watchConnection();
    // dev builds have no sw.js, and a worker left over from a production build
    // would serve stale chunks to the dev server
    if (!import.meta.env.PROD || !('serviceWorker' in navigator) || location.protocol === 'file:') return;
    // after the first render settles: installing copies a few MB into the cache
    whenIdle(async () => {
        try {
            // relative to <base href>, so it also works from a GitHub Pages subfolder
            const reg = await navigator.serviceWorker.register('sw.js', { scope: './' });
            log.info('OFFLINE', 'Service worker registered', { scope: reg.scope });
        } catch (e: any) {
            log.warn('OFFLINE', 'Service worker registration failed; the site still works, just not offline', e);
        }
    }, 5000);
}

function watchConnection() {
    window.addEventListener('offline', () => {
        api.showToast?.("You're offline. Your collection and the editor still work; community features will be back when you reconnect.", 'warning');
    });
    window.addEventListener('online', () => {
        api.showToast?.("You're back online.", 'success');
    });
}
