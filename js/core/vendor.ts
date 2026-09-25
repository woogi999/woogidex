// Third-party libraries, pinned npm deps served from our own origin (no
// unreviewed @latest updates, render-blocking scripts, or third-party origins
// on the sign-in page). The export code imports them from here.

import html2canvas from 'html2canvas';
import JSZip from 'jszip';

export { html2canvas, JSZip };
