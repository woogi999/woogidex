// These libraries were moved from CDN <script> tags to pinned npm deps served
// from our own origin (avoids unreviewed @latest updates, render-blocking
// scripts, and third-party origins on the sign-in page). Rest of the codebase
// still reaches for them as bare globals (html2canvas(...), new JSZip(), etc).
// Must be imported before any module that reads those globals.
//
// lucide ships the whole icon set since icon names are picked at runtime from
// data, so there's no static list to narrow it to.

import html2canvas from 'html2canvas';
import JSZip from 'jszip';
import { createIcons, icons } from 'lucide';

window.html2canvas = html2canvas;
window.JSZip = JSZip;

// module build needs the icon set passed in explicitly; wrap so existing
// lucide.createIcons() call sites keep working unchanged
window.lucide = {
    icons,
    createIcons: (options = {}) => createIcons({ icons, ...options })
};

export { html2canvas, JSZip, createIcons, icons };
