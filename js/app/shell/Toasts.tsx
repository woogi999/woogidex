// The little notes in the corner ("Saved!", "Could not load ..."). Each shows
// for three seconds, then slides out. Messages are plain text.

import { useSyncExternalStore } from 'react';
import { Icon } from '../components/Icon.tsx';

type Kind = 'success' | 'error' | 'info' | 'warning';
interface Toast { id: number; message: string; kind: Kind; leaving: boolean; }

const ICONS: Record<Kind, string> = { success: 'check-circle-2', error: 'circle-x', info: 'info', warning: 'triangle-alert' };
const SHOW_MS = 3000;
const LEAVE_MS = 300;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(fn => fn());

export function pushToast(message: string, kind: string = 'info'): void {
    const id = nextId++;
    const k = (kind in ICONS ? kind : 'info') as Kind;
    toasts = [...toasts, { id, message: String(message ?? ''), kind: k, leaving: false }];
    emit();
    setTimeout(() => {
        toasts = toasts.map(t => (t.id === id ? { ...t, leaving: true } : t));
        emit();
        setTimeout(() => { toasts = toasts.filter(t => t.id !== id); emit(); }, LEAVE_MS);
    }, SHOW_MS);
}

export function Toasts() {
    const list = useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => toasts);
    return (
        <>
            {list.map(t => (
                <div key={t.id} className={`toast ${t.kind}`} role="status" style={t.leaving ? { animation: 'slideOut 0.3s ease forwards' } : undefined}>
                    <Icon name={ICONS[t.kind]} className="toast-icon" /><span>{t.message}</span>
                </div>
            ))}
        </>
    );
}
