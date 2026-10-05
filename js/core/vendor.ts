// Third-party libraries, pinned npm deps served from our own origin (no
// unreviewed @latest updates, render-blocking scripts, or third-party origins
// on the sign-in page). The export code imports them from here.
//
// html2canvas is only needed for Export as PNG, and is ~200 KB every visitor
// used to parse on load (a real cost on a cheap phone), so it loads on first
// use instead; the service worker keeps a copy for offline exports.
// (ZIP files are written by js/export/zip.ts; JSZip is gone.)

export async function loadHtml2canvas() {
    return (await import('html2canvas')).default;
}
