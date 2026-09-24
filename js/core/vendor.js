// These libraries were moved from CDN <script> tags to pinned npm deps served
// from our own origin (avoids unreviewed @latest updates, render-blocking
// scripts, and third-party origins on the sign-in page). Rest of the codebase
// still reaches for them as bare globals (html2canvas(...), new JSZip(), etc).
// Must be imported before any module that reads those globals.
//
// Icons are Heroicons (solid), drawn by js/core/icon-set.js. The global keeps
// the name `lucide` -- the icon set this replaced -- so the many existing
// lucide.createIcons() call sites keep working unchanged.

import html2canvas from 'html2canvas';
import JSZip from 'jszip';
import { createIcons } from './icon-set.js';

window.html2canvas = html2canvas;
window.JSZip = JSZip;
window.lucide = { createIcons };

export { html2canvas, JSZip, createIcons };
