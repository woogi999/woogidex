/// <reference types="vite/client" />

// Globals the site still exposes for code that predates modules.
interface Window {
    lucide: { createIcons: (opts?: { root?: ParentNode }) => void };
    html2canvas: (el: HTMLElement, opts?: Record<string, unknown>) => Promise<HTMLCanvasElement>;
    JSZip: any;
    [key: string]: any;
}
declare const lucide: Window['lucide'];
