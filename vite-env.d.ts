/// <reference types="vite/client" />

// Globals the site still exposes for code that predates modules.
interface Window {
    [key: string]: any;
}

// public/emojis, listed at build time (vite.config.js, emojiManifest)
declare module 'virtual:emoji-manifest' {
    const emojis: Array<{ name: string; src: string; category: string; animated: boolean }>;
    export default emojis;
}
