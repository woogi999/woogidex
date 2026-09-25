// A text/number field that keeps what's being typed to itself and hands the
// value over on blur or Enter, like an input's native change event. For
// values that are clamped or normalised when saved (a level, an item name),
// committing every keystroke would fight the person typing.

import { useEffect, useState, type InputHTMLAttributes } from 'react';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'defaultValue'> & {
    value: string | number;
    onCommit: (value: string) => void;
};

export function CommitInput({ value, onCommit, onBlur, onKeyDown, ...rest }: Props) {
    const [draft, setDraft] = useState(String(value ?? ''));
    // a new value from outside (another slot selected, an import) replaces the draft
    useEffect(() => { setDraft(String(value ?? '')); }, [value]);
    const commit = () => { if (draft !== String(value ?? '')) onCommit(draft); };
    return (
        <input {...rest} value={draft} onChange={e => setDraft(e.target.value)}
            onBlur={e => { commit(); onBlur?.(e); }}
            onKeyDown={e => { if (e.key === 'Enter') commit(); onKeyDown?.(e); }} />
    );
}
