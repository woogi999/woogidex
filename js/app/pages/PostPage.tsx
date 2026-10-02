// One Community Hub post (/post/<id>): the whole post, its reactions, and its
// comments. js/features/social.ts loads it (openPost) and does the actions.

import { api } from '../../core/app.ts';
import { CommentComposer, PostComments, PostFeedCard } from '../components/feed.tsx';
import { Icon } from '../components/Icon.tsx';
import { useStore } from '../store.ts';

export function PostPage() {
    useStore();
    const p = api.socialState().post;
    return (
        <div className="post-page">
            <div className="post-page-top">
                <button className="btn btn-secondary btn-sm" type="button" onClick={() => history.length > 1 ? history.back() : api.openCommunityHub()}>
                    <Icon name="arrow-left" size={14} /> Back
                </button>
            </div>
            {p.error ? (
                <div className="feed-empty"><Icon name="exclamation-triangle" size={24} /><p>{p.error}</p>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => api.openCommunityHub()}>Go to the Community Hub</button></div>
            ) : !p.row ? (
                <div className="feed-card skel-card" style={{ minHeight: 220 }} />
            ) : (
                <>
                    <PostFeedCard item={p.row} full />
                    <section className="post-page-comments">
                        <h3>Comments <span className="post-page-count">{Number(p.row.comment_count || 0)}</span></h3>
                        <CommentComposer onSubmit={text => api.commentOnPost(p.row.id, text)} />
                        <PostComments postId={p.row.id} postOwner={p.row.user_id} comments={p.loading && !p.comments ? null : (p.comments || [])} />
                    </section>
                </>
            )}
        </div>
    );
}
