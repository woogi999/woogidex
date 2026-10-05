// Text boxes that know about the custom emojis (js/core/emoji.ts): typing
// ":ta" offers matching emojis like Discord does, and the smiley button opens
// the full picker. Ours go in as their ":name:" code (the picture only appears
// when the text is shown, renderCommentMarkdown); standard emojis go in as
// the character itself.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { emojiByName, emojiCategories, isUnicodeKey, loadUnicodeEmoji, searchEmojis, unicodeChar, type Emoji, type UnicodeEmoji } from '../../core/emoji.ts';
import { renderCommentMarkdown } from '../../core/data.ts';
import { Icon } from './Icon.tsx';

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

/** One emoji, ours (a picture) or standard (a character), drawn at a size. */
export function EmojiGlyph({ code, size = 22 }: { code: string; size?: number }) {
    // the site's own heart: what a like became
    if (code === 'heart') return <Icon name="heart" size={Math.round(size * 0.85)} className="reaction-heart" />;
    if (isUnicodeKey(code)) return <span className="emoji-char" style={{ fontSize: Math.round(size * 0.92) }} role="img" aria-label={unicodeChar(code)}>{unicodeChar(code)}</span>;
    const e = emojiByName(code);
    return e ? <EmojiImg emoji={e} size={size} /> : null;
}

/**
 * Our emojis first (Woogidex, Pokémon, ...), then the standard ones by group.
 * onPick gets a custom emoji's name, or a standard one's "u_..." key.
 */
/** The quick row reaction pickers open with, Facebook style. */
export const QUICK_REACTIONS = ['heart', 'u_1f602', 'u_1f62e', 'u_1f622', 'u_1f525', 'u_1f44d', 'u_1f389'];

export function EmojiPicker({ onPick, onClose, quick }: { onPick: (code: string) => void; onClose?: () => void; quick?: string[] }) {
    const [query, setQuery] = useState('');
    const categories = useMemo(() => emojiCategories(), []);
    const [standard, setStandard] = useState<Array<{ label: string; emojis: UnicodeEmoji[] }>>([]);
    useEffect(() => {
        let live = true;
        loadUnicodeEmoji().then(g => { if (live) setStandard(g); }).catch(() => {});
        return () => { live = false; };
    }, []);
    const [tab, setTab] = useState<string>(() => (recentEmojis().length ? 'recent' : categories[0]?.key || ''));
    const pick = (code: string) => { rememberEmoji(code); onPick(code); };

    type Cell = { code: string; title: string };
    const ours = (list: Emoji[]): Cell[] => list.map(e => ({ code: e.name, title: `:${e.name}:` }));
    const theirs = (list: UnicodeEmoji[]): Cell[] => list.map(e => ({ code: e.key, title: e.name }));
    const q = query.trim().toLowerCase();
    let shown: Cell[];
    if (q) {
        const all = standard.flatMap(g => g.emojis);
        const starts = all.filter(e => e.name.startsWith(q) || e.name.includes(' ' + q));
        const contains = all.filter(e => !starts.includes(e) && e.name.includes(q));
        shown = [...ours(searchEmojis(q, 80)), ...theirs([...starts, ...contains].slice(0, 120))];
    } else if (tab === 'recent') {
        shown = recentEmojis().filter(c => isUnicodeKey(c) || emojiByName(c)).map(c => ({ code: c, title: isUnicodeKey(c) ? unicodeChar(c) : `:${c}:` }));
    } else if (tab.startsWith('std:')) {
        shown = theirs(standard.find(g => g.label === tab.slice(4))?.emojis || []);
    } else {
        shown = ours(categories.find(c => c.key === tab)?.emojis || []);
    }
    return (
        <div className="emoji-picker" role="dialog" aria-label="Emoji picker" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); } }}>
            {quick && quick.length > 0 && (
                <div className="emoji-picker-quick" aria-label="Quick reactions">
                    {quick.map(code => (
                        <button key={code} type="button" className="emoji-picker-quick-cell" title={code === 'heart' ? 'Heart' : unicodeChar(code)} onClick={() => onPick(code)}>
                            <EmojiGlyph code={code} size={26} />
                        </button>
                    ))}
                </div>
            )}
            <input className="emoji-picker-search" type="search" placeholder="Find an emoji" value={query} autoFocus
                onChange={e => setQuery(e.target.value)} aria-label="Search emojis" />
            {!q && (
                <div className="emoji-picker-tabs" role="tablist">
                    {recentEmojis().length > 0 && <button type="button" className={tab === 'recent' ? 'active' : ''} onClick={() => setTab('recent')} title="Recently used"><Icon name="clock" size={16} /></button>}
                    {categories.map(c => (
                        <button key={c.key} type="button" className={tab === c.key ? 'active' : ''} onClick={() => setTab(c.key)} title={c.label}>
                            <EmojiImg emoji={c.emojis[0]} size={18} />
                        </button>
                    ))}
                    {standard.length > 0 && <span className="emoji-picker-tabs-gap" aria-hidden="true" />}
                    {standard.map(g => (
                        <button key={g.label} type="button" className={tab === `std:${g.label}` ? 'active' : ''} onClick={() => setTab(`std:${g.label}`)} title={g.label}>
                            <span className="emoji-char" style={{ fontSize: 16 }}>{g.emojis[0]?.char}</span>
                        </button>
                    ))}
                </div>
            )}
            <div className="emoji-picker-grid">
                {shown.length ? shown.map(c => (
                    <button key={c.code} type="button" className="emoji-picker-cell" title={c.title} onClick={() => pick(c.code)}>
                        <EmojiGlyph code={c.code} size={28} />
                    </button>
                )) : <div className="emoji-picker-empty">{tab.startsWith('std:') && !standard.length ? 'Loading…' : 'No emoji called that.'}</div>}
            </div>
        </div>
    );
}

const PICKER_W = 340;
const PICKER_H = 400;

/**
 * A button that opens the picker. The picker is drawn on top of the whole
 * page (a portal on <body>, placed from the button), so nothing it sits in
 * (a feed card, a comment thread, a modal) can clip it or cover it.
 */
export function EmojiButton({ onPick, title = 'Emoji', className = '', children, quick, buttonClassName = '' }: {
    onPick: (code: string) => void; title?: string; className?: string; children?: ReactNode;
    /** reaction pickers: a row of one-tap favourites on top */
    quick?: string[];
    buttonClassName?: string;
}) {
    const [open, setOpen] = useState(false);
    const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
    const wrap = useRef<HTMLDivElement>(null);
    const pop = useRef<HTMLDivElement>(null);

    const place = () => {
        const r = wrap.current?.getBoundingClientRect();
        if (!r) return;
        const vw = window.innerWidth, vh = window.innerHeight;
        const w = Math.min(PICKER_W, vw - 16);
        const h = Math.min(PICKER_H, vh - 16);
        // above the button when there's room, otherwise below it
        const top = r.top - h - 6 >= 8 ? r.top - h - 6 : Math.min(r.bottom + 6, vh - h - 8);
        const left = Math.max(8, Math.min(r.left, vw - w - 8));
        setPos({ left, top: Math.max(8, top) });
    };

    useEffect(() => {
        if (!open) { setPos(null); return; }
        place();
        const away = (e: MouseEvent) => {
            const path = e.composedPath();
            if (wrap.current && path.includes(wrap.current)) return;
            if (pop.current && path.includes(pop.current)) return;
            setOpen(false);
        };
        document.addEventListener('mousedown', away);
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        return () => {
            document.removeEventListener('mousedown', away);
            window.removeEventListener('resize', place);
            window.removeEventListener('scroll', place, true);
        };
    }, [open]);

    return (
        <div className={`emoji-button-wrap ${className}`.trim()} ref={wrap}>
            <button type="button" className={`emoji-button ${buttonClassName}`.trim()} title={title} aria-label={title} aria-expanded={open} onClick={() => setOpen(v => !v)}>
                {children || <Icon name="face-smile" size={20} />}
            </button>
            {open && pos && createPortal(
                <div className="emoji-popover" ref={pop} style={{ left: pos.left, top: pos.top }}>
                    <EmojiPicker quick={quick} onPick={code => { setOpen(false); onPick(code); }} onClose={() => setOpen(false)} />
                </div>,
                document.body
            )}
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
        // a standard emoji is just its character; ours are their :name: code
        if (isUnicodeKey(name)) { insertAt(start, end, unicodeChar(name)); return; }
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
