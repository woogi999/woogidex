// Dialogs anything can open: openDialog('community-rules', {...}) shows it,
// closeDialog('community-rules') hides it. One host renders every open dialog,
// so opening one needs no markup of its own anywhere in index.html.

import { useSyncExternalStore, type ComponentType } from 'react';
import { mountIsland } from './island.tsx';

/** Every dialog receives its props plus a close() that removes it. */
export type DialogProps<P = object> = P & { close: () => void };

const registry = new Map<string, ComponentType<any>>();
let open: Array<{ name: string; props: object; key: number }> = [];
let nextKey = 1;
const listeners = new Set<() => void>();

function emit() { listeners.forEach(fn => fn()); }

/** Makes a dialog openable by name. Called once per dialog, at import. */
export function registerDialog(name: string, Component: ComponentType<any>): void {
    registry.set(name, Component);
}

/** Shows a dialog (replacing one of the same name that is already open). */
export function openDialog(name: string, props: object = {}): void {
    open = [...open.filter(d => d.name !== name), { name, props, key: nextKey++ }];
    emit();
}

export function closeDialog(name: string): void {
    const next = open.filter(d => d.name !== name);
    if (next.length === open.length) return;
    open = next;
    emit();
}

export function isDialogOpen(name: string): boolean {
    return open.some(d => d.name === name);
}

function DialogHost() {
    const current = useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => open);
    return (
        <>
            {current.map(({ name, props, key }) => {
                const Component = registry.get(name);
                return Component ? <Component key={key} {...props} close={() => closeDialog(name)} /> : null;
            })}
        </>
    );
}

/** Puts the host on the page. Runs once at boot. */
export function mountDialogHost(): void {
    let host = document.getElementById('react-dialogs');
    if (!host) {
        host = document.createElement('div');
        host.id = 'react-dialogs';
        document.body.appendChild(host);
    }
    mountIsland(host, DialogHost);
}
