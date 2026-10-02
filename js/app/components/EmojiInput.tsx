// Text boxes that know about the custom emojis (js/core/emoji.ts): typing
// ":ta" offers matching emojis like Discord does, and the smiley button opens
// the full picker. Whatever is picked goes in as its ":name:" code; the
// picture only appears when the text is shown (renderCommentMarkdown).

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { emojiCategories, searchEmojis, type Emoji } from '../../core/emoji.ts';
import { renderCommentMarkdown } from '../../core/data.ts';
import { Icon } from './Icon.tsx';
import { useClickAway } from './editor/fields.tsx';

const RECENT_KEY = 'woogidex.emoji.recent.v1';

function recentEmojis(): string[] {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').slice(0, 24); } catch { return []; }
}

function rememberEmoji(name: string) {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify([name, ...recentEmojis().filter(n => n !== name)].slice(0, 24))); } catch {}
}

export function EmojiImg({ emoji, size = 22 }: { emoji: Emoji; size?: number }) {
    return <img className="emoji" src={emoji.src} alt={`:${emoji.name}:`} title={`:${emoji.name}:`} width={size} height={size} loading="lazy" decoding="async" draggable={false} />;
}

/** Text with markdown and emojis, the way comments and posts read. */
export function RichText({ text, className = '' }: { text: string; className?: string }) {
    // renderCommentMarkdown escapes the text first, then builds a closed set of tags
    const html = useMemo(() => renderCommentMarkdown(text), [text]);
    return <div className={`rich-text ${className}`.trim()} dangerouslySetInnerHTML={{ __html: html }} />;
}

// ==================== the picker ====================

export function EmojiPicker({ onPick, onClose }: { onPick: (name: string) => void; onClose?: () => void }) {
    const [query, setQuery] = useState('');
    const categories = useMemo(() => emojiCategories(), []);
    const [tab, setTab] = useState<string>(() => (recentEmojis().length ? 'recent' : categories[0]?.key || ''));
    const pick = (e: Emoji) => { rememberEmoji(e.name); onPick(e.name); };
    const recent = recentEmojis().map(n => searchEmojis(n, 1).find(e => e.name === n)).filter(Boolean) as Emoji[];
    const shown: Emoji[] = query
        ? searchEmojis(query, 120)
        : tab === 'recent' ? recent : (categories.find(c => c.key === tab)?.emojis || []);
    return (
        <div className="emoji-picker" role="dialog" aria-label="Emoji picker" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); } }}>
            <input className="emoji-picker-search" type="search" placeholder="Find an emoji" value={query} autoFocus
                onChange={e => setQuery(e.target.value)} aria-label="Search emojis" />
            {!query && (
                <div className="emoji-picker-tabs" role="tablist">
                    {recent.length > 0 && <button type="button" className={tab === 'recent' ? 'active' : ''} onClick={() => setTab('recent')} title="Recently used"><Icon name="clock" size={16} /></button>}
                    {categories.map(c => (
                        <button key={c.key} type="button" className={tab === c.key ? 'active' : ''} onClick={() => setTab(c.key)} title={c.label}>
                            <EmojiImg emoji={c.emojis[0]} size={18} />
                        </button>
                    ))}
                </div>
            )}
            <div className="emoji-picker-grid">
                {shown.length ? shown.map(e => (
                    <button key={e.name} type="button" className="emoji-picker-cell" title={`:${e.name}:`} onClick={() => pick(e)}>
                        <EmojiImg emoji={e} size={28} />
                    </button>
                )) : <div className="emoji-picker-empty">No emoji called that.</div>}
            </div>
        </div>
    );
}

/** A smiley button that opens the picker in a little popover. */
export function EmojiButton({ onPick, title = 'Emoji', className = '', children }: { onPick: (name: string) => void; title?: string; className?: string; children?: ReactNode }) {
    const [open, setOpen] = useState(false);
    const ref = useClickAway(open, () => setOpen(false));
    return (
        <div className={`emoji-button-wrap ${className}`.trim()} ref={ref}>
            <button type="button" className="emoji-button" title={title} aria-label={title} aria-expanded={open} onClick={() => setOpen(v => !v)}>
                {children || <Icon name="face-smile" size={20} />}
            </button>
            {open && <div className="emoji-popover"><EmojiPicker onPick={name => { setOpen(false); onPick(name); }} onClose={() => setOpen(false)} /></div>}
        </div>
    );
}

// ==================== the text box ====================

interface EmojiInputProps {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    maxLength?: number;
    rows?: number;
    className?: string;
    autoFocus?: boolean;
    disabled?: boolean;
    /** Enter sends (Shift+Enter is a new line), as in a chat */
    onSubmit?: () => void;
    /** extra buttons drawn beside the smiley */
    tools?: ReactNode;
    ariaLabel?: string;
    onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
}

/** The ":name" being typed right before the caret, if any. */
function pendingCode(text: string, caret: number): { start: number; query: string } | null {
    const before = text.slice(0, caret);
    const m = before.match(/(^|[\s(]):([a-z0-9_]{2,32})$/i);
    if (!m) return null;
    return { start: caret - m[2].length - 1, query: m[2].toLowerCase() };
}

export function EmojiInput({ value, onChange, placeholder, maxLength, rows = 3, className = '', autoFocus, disabled, onSubmit, tools, ariaLabel, onPaste }: EmojiInputProps) {
    const box = useRef<HTMLTextAreaElement>(null);
    const [caret, setCaret] = useState(0);
    const [active, setActive] = useState(0);
    const [dismissed, setDismissed] = useState(false);
    const pending = !dismissed && box.current === document.activeElement ? pendingCode(value, caret) : null;
    const matches = pending ? searchEmojis(pending.query, 8) : [];

    useEffect(() => { setActive(0); }, [pending?.query]);

    function insertAt(start: number, end: number, text: string) {
        const next = value.slice(0, start) + text + value.slice(end);
        if (maxLength && next.length > maxLength) return;
        onChange(next);
        const pos = start + text.length;
        requestAnimationFrame(() => {
            box.current?.focus();
            box.current?.setSelectionRange(pos, pos);
            setCaret(pos);
        });
    }

    function complete(e: Emoji) {
        if (!pending) return;
        rememberEmoji(e.name);
        insertAt(pending.start, caret, `:${e.name}: `);
    }

    function insertFromPicker(name: string) {
        const el = box.current;
        const start = el ? el.selectionStart : value.length;
        const end = el ? el.selectionEnd : value.length;
        const pad = start > 0 && !/\s$/.test(value.slice(0, start)) ? ' ' : '';
        insertAt(start, end, `${pad}:${name}: `);
    }

    function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
        if (matches.length) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => (i + 1) % matches.length); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => (i - 1 + matches.length) % matches.length); return; }
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); complete(matches[active] || matches[0]); return; }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDismissed(true); return; }
        }
        if (onSubmit && e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onSubmit();
        }
    }

    const track = () => setCaret(box.current?.selectionStart ?? 0);

    return (
        <div className={`emoji-input ${className}`.trim()}>
            {matches.length > 0 && (
                <div className="emoji-autocomplete" role="listbox" aria-label="Matching emojis">
                    <div className="emoji-autocomplete-head">Emojis matching <strong>:{pending!.query}</strong></div>
                    {matches.map((m, i) => (
                        <button key={m.name} type="button" role="option" aria-selected={i === active} className={i === active ? 'active' : ''}
                            onMouseDown={e => e.preventDefault()} onClick={() => complete(m)} onMouseEnter={() => setActive(i)}>
                            <EmojiImg emoji={m} size={22} /><span>:{m.name}:</span>
                        </button>
                    ))}
                </div>
            )}
            <textarea ref={box} value={value} rows={rows} placeholder={placeholder} maxLength={maxLength} autoFocus={autoFocus} disabled={disabled}
                aria-label={ariaLabel || placeholder}
                onChange={e => { setDismissed(false); onChange(e.target.value); setCaret(e.target.selectionStart); }}
                onKeyDown={onKeyDown} onKeyUp={track} onClick={track} onSelect={track} onPaste={onPaste}
                onBlur={() => setTimeout(() => setDismissed(true), 120)} onFocus={() => setDismissed(false)} />
            <div className="emoji-input-tools">
                {tools}
                <EmojiButton onPick={insertFromPicker} />
            </div>
        </div>
    );
}
