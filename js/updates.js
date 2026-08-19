// ==================== UPDATES ====================
// The update list is stored in updates.txt so you can add/edit updates
// without changing this JavaScript file.
//
// updates.txt format:
// UPDATE
// version=v1.2.0
// date=August 19, 2026
// title=New features
// item=Added a new feature.
// item=Improved another feature.
// END
//
// Add the newest UPDATE block first.

let UPDATES = [];
let updatesLoaded = false;
let updatesLoading = null;

function parseUpdatesText(text) {
    const updates = [];
    let current = null;

    for (const rawLine of String(text || '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;

        if (line.toUpperCase() === 'UPDATE') {
            if (current) updates.push(current);
            current = { version: '', date: '', title: '', items: [] };
            continue;
        }

        if (line.toUpperCase() === 'END') {
            if (current) {
                updates.push(current);
                current = null;
            }
            continue;
        }

        if (!current) continue;

        const separator = line.indexOf('=');
        if (separator === -1) continue;

        const key = line.slice(0, separator).trim().toLowerCase();
        const value = line.slice(separator + 1).trim();

        if (key === 'item') current.items.push(value);
        else if (key === 'version') current.version = value;
        else if (key === 'date') current.date = value;
        else if (key === 'title') current.title = value;
    }

    if (current) updates.push(current);
    return updates;
}

async function loadUpdates(forceReload = false) {
    if (updatesLoading && !forceReload) return updatesLoading;
    if (updatesLoaded && !forceReload) return UPDATES;

    updatesLoading = fetch(`updates.txt?updates=${Date.now()}`, {
        cache: 'no-store'
    })
        .then(response => {
            if (!response.ok) throw new Error(`Could not load updates.txt (${response.status})`);
            return response.text();
        })
        .then(text => {
            UPDATES = parseUpdatesText(text);
            updatesLoaded = true;
            return UPDATES;
        })
        .catch(error => {
            console.error('[UPDATES] Failed to load updates.txt:', error);
            UPDATES = [];
            updatesLoaded = false;
            throw error;
        })
        .finally(() => {
            updatesLoading = null;
        });

    return updatesLoading;
}

function escapeUpdateHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function renderUpdates() {
    const body = document.getElementById('updates-modal-body');
    if (!body) return;

    if (!UPDATES.length) {
        body.innerHTML = `
            <div class="updates-empty-state">
                <i data-lucide="newspaper" aria-hidden="true"></i>
                <h4>No updates yet</h4>
                <p>There are no updates to show right now. Check back later!</p>
            </div>
        `;
        if (typeof lucide !== 'undefined') lucide.createIcons();
        return;
    }

    body.innerHTML = UPDATES.map((update, index) => `
        <article class="update-entry${index === 0 ? ' update-entry-latest' : ''}">
            <div class="update-entry-header">
                <div>
                    <div class="update-entry-kicker">${escapeUpdateHtml(update.version || '')}</div>
                    <h4>${escapeUpdateHtml(update.title || 'Update')}</h4>
                </div>
                <time>${escapeUpdateHtml(update.date || '')}</time>
            </div>
            ${Array.isArray(update.items) && update.items.length ? `
                <ul>${update.items.map(item => `<li>${escapeUpdateHtml(item)}</li>`).join('')}</ul>
            ` : ''}
        </article>
    `).join('');

    if (typeof lucide !== 'undefined') lucide.createIcons();
}

async function openUpdatesModal() {
    const modal = document.getElementById('updates-modal');
    if (!modal) return;

    modal.classList.add('active');
    document.body.classList.add('modal-open');

    const body = document.getElementById('updates-modal-body');
    if (body) {
        body.innerHTML = `
            <div class="updates-empty-state">
                <i data-lucide="loader-circle" aria-hidden="true"></i>
                <h4>Loading updates...</h4>
                <p>Fetching the latest Woogidex updates.</p>
            </div>
        `;
        if (typeof lucide !== 'undefined') lucide.createIcons();
    }

    try {
        await loadUpdates();
        renderUpdates();
    } catch (error) {
        if (body) {
            body.innerHTML = `
                <div class="updates-empty-state">
                    <i data-lucide="triangle-alert" aria-hidden="true"></i>
                    <h4>Updates could not be loaded</h4>
                    <p>Make sure <strong>updates.txt</strong> is in the same folder as index.html.</p>
                </div>
            `;
            if (typeof lucide !== 'undefined') lucide.createIcons();
        }
    }

    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function closeUpdatesModal() {
    const modal = document.getElementById('updates-modal');
    if (!modal) return;
    modal.classList.remove('active');
    document.body.classList.remove('modal-open');
}

window.openUpdatesModal = openUpdatesModal;
window.closeUpdatesModal = closeUpdatesModal;
window.renderUpdates = renderUpdates;
window.loadUpdates = loadUpdates;

