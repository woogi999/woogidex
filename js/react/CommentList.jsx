// Comment bodies are the one place here that goes in as raw HTML.
// renderCommentMarkdown() (js/core/data.js) escapes the source text first, then
// builds a closed set of tags from it, so the result is markup this app
// generated, not markup the commenter wrote directly.

import { Icon } from './Icon.jsx';
import { Avatar } from './Avatar.jsx';
import { BadgeRow } from './Badge.jsx';
import { renderCommentMarkdown } from '../core/data.js';

const call = (name, ...args) => window[name]?.(...args);

function SkeletonComment() {
    return (
        <div className="mon-comment skel-card">
            <div className="mon-comment-header">
                <span className="skel skel-circle" />
                <span className="skel skel-text" />
            </div>
            <div className="mon-comment-body">
                <span className="skel skel-text" />
                <span className="skel skel-text" />
            </div>
        </div>
    );
}

function Comment({ comment, monId, canDelete, isMine }) {
    return (
        <div className="mon-comment">
            <div className="mon-comment-header">
                <Avatar userId={comment.user_id} url={comment.author_avatar_url} name={comment.author_name} />
                <span
                    className="mon-comment-author community-author-link"
                    onClick={e => { e.stopPropagation(); call('showUserProfile', comment.user_id); }}
                >
                    {comment.author_name}
                </span>
                <BadgeRow badgeKeys={comment.author_badges} size={12} />
                <span className="mon-comment-time">{new Date(comment.created_at).toLocaleString()}</span>
                {canDelete && (
                    <button
                        className="mon-comment-delete"
                        title={isMine ? 'Delete' : 'Remove (staff)'}
                        onClick={() => call('deleteComment', comment.id, monId)}
                    >
                        <Icon name="trash-2" style={{ width: 12, height: 12 }} />
                    </button>
                )}
            </div>
            {/* see note at top of file on why this is raw HTML */}
            <div
                className="mon-comment-body"
                dangerouslySetInnerHTML={{ __html: renderCommentMarkdown(comment.body) }}
            />
        </div>
    );
}

/**
 * @param {object} props
 * @param {Array}  props.comments
 * @param {boolean} props.loading
 * @param {string} props.monId       which post these belong to, for deletion
 * @param {string|null} props.viewerId
 * @param {boolean} props.viewerIsStaff
 */
export function CommentList({ comments = [], loading = false, monId = '', viewerId = null, viewerIsStaff = false }) {
    if (loading) {
        return <>{Array.from({ length: 3 }, (_, i) => <SkeletonComment key={i} />)}</>;
    }
    if (!comments.length) {
        return <div className="community-empty">No comments yet.</div>;
    }
    return (
        <>
            {comments.map(c => {
                const isMine = !!viewerId && c.user_id === viewerId;
                return (
                    <Comment
                        key={c.id}
                        comment={c}
                        monId={monId}
                        isMine={isMine}
                        canDelete={isMine || viewerIsStaff}
                    />
                );
            })}
        </>
    );
}
