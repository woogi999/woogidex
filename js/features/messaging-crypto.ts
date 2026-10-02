// ==================== end-to-end encryption for messages ====================
// Everything here runs in the browser with WebCrypto. The server (Supabase)
// only ever receives the outputs: public keys, keys wrapped so only their
// owner can open them, and ciphertext. See the header of
// supabase/migrations/20261002000100_encrypted_messaging.sql for the scheme;
// in short:
//
//   identity      an ECDH P-256 key pair per person. The private key is kept
//                 on this device (IndexedDB, as a non-exportable key) and
//                 backed up to the server encrypted with the person's chat
//                 PIN (PBKDF2-SHA256 -> AES-GCM), so a new device can restore
//                 it. The PIN itself never leaves the browser.
//   chat key      a random AES-256 key per conversation per version, handed
//                 to each member wrapped with ECDH(wrapper, member) -> HKDF.
//   message key   a random AES-256 key per message, wrapped with the chat
//                 key. A report hands staff only these, so it opens the
//                 reported messages and nothing else.
//   file key      a random AES-256 key per attachment, inside the message.
//
// Every AES-GCM call is bound to the conversation id as additional data, so a
// ciphertext copied into another chat fails to open instead of being shown.

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = () => {
    if (!globalThis.crypto?.subtle) throw new Error('This browser can’t do encryption (it needs a secure https page).');
    return crypto.subtle;
};

// ---------- encoding ----------
export function toB64(buf: ArrayBuffer | Uint8Array): string {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
}

export function fromB64(text: string): Uint8Array<ArrayBuffer> {
    const s = atob(String(text || ''));
    const out = new Uint8Array(new ArrayBuffer(s.length));
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
}

const random = (n: number) => crypto.getRandomValues(new Uint8Array(new ArrayBuffer(n)));
const aad = (conversationId: string) => enc.encode(`woogidex:${conversationId}`);

// ---------- identity keys ----------
export interface Identity { privateKey: CryptoKey; publicJwk: JsonWebKey; keyId: string; }

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;

export async function keyIdFor(publicJwk: JsonWebKey): Promise<string> {
    const raw = enc.encode(`${publicJwk.x}.${publicJwk.y}`);
    const hash = new Uint8Array(await subtle().digest('SHA-256', raw)).slice(0, 12);
    return toB64(hash).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A brand new key pair; the private half comes back exportable once, for the backup. */
export async function generateIdentity(): Promise<{ identity: Identity; pkcs8: ArrayBuffer }> {
    const pair = await subtle().generateKey(ECDH, true, ['deriveBits']) as CryptoKeyPair;
    const publicJwk = await subtle().exportKey('jwk', pair.publicKey);
    const pkcs8 = await subtle().exportKey('pkcs8', pair.privateKey);
    // the copy kept for use can never be exported again
    const privateKey = await subtle().importKey('pkcs8', pkcs8, ECDH, false, ['deriveBits']);
    const cleanJwk: JsonWebKey = { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y, ext: true };
    return { identity: { privateKey, publicJwk: cleanJwk, keyId: await keyIdFor(cleanJwk) }, pkcs8 };
}

export async function importPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
    return subtle().importKey('jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true }, ECDH, false, []);
}

// ---------- the PIN-protected backup ----------
export const PIN_ITERATIONS = 310000;

async function pinKey(pin: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
    const base = await subtle().importKey('raw', enc.encode(pin.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
    return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export interface KeyBackup { key_id: string; wrapped_key: string; iv: string; salt: string; iterations: number; }

export async function sealBackup(pkcs8: ArrayBuffer, pin: string, keyId: string): Promise<KeyBackup> {
    const salt = random(16);
    const iv = random(12);
    const key = await pinKey(pin, salt, PIN_ITERATIONS);
    const sealed = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`woogidex-key:${keyId}`) }, key, pkcs8);
    return { key_id: keyId, wrapped_key: toB64(sealed), iv: toB64(iv), salt: toB64(salt), iterations: PIN_ITERATIONS };
}

/** Opens a backup with the PIN. Throws a friendly error on a wrong PIN. */
export async function unlockBackup(backup: KeyBackup, publicJwk: JsonWebKey, pin: string): Promise<Identity> {
    let pkcs8: ArrayBuffer;
    try {
        const key = await pinKey(pin, fromB64(backup.salt), backup.iterations);
        pkcs8 = await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(backup.iv), additionalData: enc.encode(`woogidex-key:${backup.key_id}`) }, key, fromB64(backup.wrapped_key));
    } catch {
        throw new Error('That PIN doesn’t match.');
    }
    const privateKey = await subtle().importKey('pkcs8', pkcs8, ECDH, false, ['deriveBits']);
    return { privateKey, publicJwk, keyId: backup.key_id };
}

// ---------- chat keys ----------
async function pairKey(myPrivate: CryptoKey, theirPublicJwk: JsonWebKey, conversationId: string, version: number): Promise<CryptoKey> {
    const theirs = await importPublicKey(theirPublicJwk);
    const bits = await subtle().deriveBits({ name: 'ECDH', public: theirs }, myPrivate, 256);
    const hkdf = await subtle().importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    return subtle().deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(conversationId), info: enc.encode(`woogidex-chat-key-v1:${version}`) },
        hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export function newChatKeyBytes(): Uint8Array<ArrayBuffer> { return random(32); }

export async function chatKeyFromBytes(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
    return subtle().importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** The chat key, wrapped so only `memberPublicJwk`'s owner (and the wrapper) can open it. */
export async function wrapChatKey(raw: Uint8Array<ArrayBuffer>, me: Identity, memberPublicJwk: JsonWebKey, conversationId: string, version: number) {
    const key = await pairKey(me.privateKey, memberPublicJwk, conversationId, version);
    const iv = random(12);
    const wrapped = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad(conversationId) }, key, raw);
    return { wrapped_key: toB64(wrapped), iv: toB64(iv) };
}

/** Opens a wrapped chat key; returns its raw bytes (needed to hand it on) and the usable key. */
export async function unwrapChatKey(row: { wrapped_key: string; iv: string }, me: Identity, wrapperPublicJwk: JsonWebKey, conversationId: string, version: number) {
    const key = await pairKey(me.privateKey, wrapperPublicJwk, conversationId, version);
    const raw = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(row.iv), additionalData: aad(conversationId) }, key, fromB64(row.wrapped_key)));
    return { raw, key: await chatKeyFromBytes(raw) };
}

// ---------- messages ----------
export interface SealedMessage { ciphertext: string; iv: string; msg_key: string; msg_key_iv: string; }

export async function sealMessage(payload: unknown, chatKey: CryptoKey, conversationId: string): Promise<SealedMessage> {
    const msgRaw = random(32);
    const msgKey = await subtle().importKey('raw', msgRaw, 'AES-GCM', false, ['encrypt']);
    const iv = random(12);
    const ciphertext = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad(conversationId) }, msgKey, enc.encode(JSON.stringify(payload)));
    const keyIv = random(12);
    const wrapped = await subtle().encrypt({ name: 'AES-GCM', iv: keyIv, additionalData: aad(conversationId) }, chatKey, msgRaw);
    return { ciphertext: toB64(ciphertext), iv: toB64(iv), msg_key: toB64(wrapped), msg_key_iv: toB64(keyIv) };
}

/** The message key on its own, as base64: what a report hands to staff. */
export async function messageKeyOf(row: SealedMessage, chatKey: CryptoKey, conversationId: string): Promise<string> {
    const raw = await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(row.msg_key_iv), additionalData: aad(conversationId) }, chatKey, fromB64(row.msg_key));
    return toB64(raw);
}

/** Opens a message with its own key (base64) -- the reader's path and the staff report path both end here. */
export async function openMessageWithKey(row: { ciphertext: string; iv: string }, msgKeyB64: string, conversationId: string): Promise<any> {
    const key = await subtle().importKey('raw', fromB64(msgKeyB64), 'AES-GCM', false, ['decrypt']);
    const plain = await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(row.iv), additionalData: aad(conversationId) }, key, fromB64(row.ciphertext));
    return JSON.parse(dec.decode(plain));
}

export async function openMessage(row: SealedMessage, chatKey: CryptoKey, conversationId: string): Promise<{ payload: any; msgKey: string }> {
    const msgKey = await messageKeyOf(row, chatKey, conversationId);
    return { payload: await openMessageWithKey(row, msgKey, conversationId), msgKey };
}

// ---------- files ----------
export async function sealFile(data: ArrayBuffer, conversationId: string): Promise<{ body: Uint8Array<ArrayBuffer>; key: string; iv: string }> {
    const raw = random(32);
    const key = await subtle().importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
    const iv = random(12);
    const body = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad(conversationId) }, key, data));
    return { body, key: toB64(raw), iv: toB64(iv) };
}

export async function openFile(body: ArrayBuffer, keyB64: string, ivB64: string, conversationId: string): Promise<ArrayBuffer> {
    const key = await subtle().importKey('raw', fromB64(keyB64), 'AES-GCM', false, ['decrypt']);
    return subtle().decrypt({ name: 'AES-GCM', iv: fromB64(ivB64), additionalData: aad(conversationId) }, key, body);
}

// ---------- this device's key store (IndexedDB) ----------
// CryptoKey objects can be stored as they are, non-exportable flag and all:
// the private key stays usable here without ever being readable as bytes.
const DB_NAME = 'woogidex-messages';
const STORE = 'keys';

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export async function idbGet<T = any>(key: string): Promise<T | undefined> {
    try {
        const db = await openDb();
        return await new Promise((resolve, reject) => {
            const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
            req.onsuccess = () => resolve(req.result as T);
            req.onerror = () => reject(req.error);
        });
    } catch {
        return undefined;
    }
}

export async function idbSet(key: string, value: unknown): Promise<void> {
    try {
        const db = await openDb();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put(value, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch { /* private window: keys just aren't remembered on this device */ }
}

export async function idbDeletePrefix(prefix: string): Promise<void> {
    try {
        const db = await openDb();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            const store = tx.objectStore(STORE);
            const req = store.openCursor();
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) return;
                if (String(cursor.key).startsWith(prefix)) cursor.delete();
                cursor.continue();
            };
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch { /* nothing stored */ }
}
