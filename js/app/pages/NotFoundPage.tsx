// The 404 page: any path no route owns (router NOT_FOUND). The address bar is
// left alone so the bad link stays visible and copyable.

import { api } from '../../core/app.ts';
import { Icon } from '../components/Icon.tsx';
import { useRoute } from '../hooks.ts';

export function NotFoundPage() {
    const route = useRoute();
    const path = route.name === 'not-found' ? `/${route.param}` : '';
    return (
        <section className="not-found-panel" aria-labelledby="not-found-title">
            {/* the page has no header, so the logo is how you know where you are */}
            <button className="not-found-logo" type="button" onClick={() => api.showCollection()} aria-label="Woogidex home">
                <img src="assets/woogidex_icon.png" alt="Woogidex" />
            </button>
            <div className="not-found-code" aria-hidden="true">
                <span>4</span>
                <span className="not-found-ball"><span className="not-found-ball-band" /><span className="not-found-ball-button" /></span>
                <span>4</span>
            </div>
            <p className="not-found-eyebrow">Wild page not found</p>
            <h2 className="not-found-title" id="not-found-title">This page fled!</h2>
            <p className="not-found-text">
                Nothing lives at <code className="not-found-path">{path}</code>. The link may be mistyped, or whatever was here has moved on.
            </p>
            <div className="not-found-actions">
                <button className="btn btn-primary" type="button" onClick={() => api.showCollection()}>
                    <Icon name="layout-grid" size={16} /> My collection
                </button>
                <button className="btn btn-secondary" type="button" onClick={() => api.openCommunityHub()}>
                    <Icon name="users" size={16} /> Community Hub
                </button>
            </div>
        </section>
    );
}
