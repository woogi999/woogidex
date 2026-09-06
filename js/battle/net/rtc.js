// WebRTC data channel between battlers, relayed through TURN. Supabase carries
// only the handshake (SDP + ICE via battle_signals); once open, messages go
// straight over the relay. `iceTransportPolicy: 'relay'` is deliberate: it hides
// both players' IP addresses from each other (public-lobby strangers).
// Side 0 (p1) always offers, side 1 (p2) always answers, even across reconnects.

import { api } from '../../core/app.js';
import { log } from '../../core/log.js';
import { isValidPeerMessage } from './protocol.js';

const SIGNAL_POLL_MS = 900;
const DISCONNECT_GRACE_MS = 45000;    // grace period before a dropped peer is given up on
const OFFERER_RETRY_MS = 2000;

export class BattleRTC {
    constructor({ battleId, mySide, onStatus, onMessage }) {
        this.battleId = battleId;
        this.mySide = mySide;         // 0 = offerer, 1 = answerer
        this.onStatus = onStatus || (() => {});
        this.onMessage = onMessage || (() => {});

        this.client = null;
        this.meId = null;
        this.pc = null;
        this.channel = null;
        this.generation = 0;          // bumped by the offerer on every fresh handshake
        this.lastSignalId = 0;
        this.pollTimer = null;
        this.disconnectTimer = null;
        this.destroyed = false;
        this.pendingCandidates = [];
        this.queuedSends = [];
        this.hasTurn = null;          // set once ICE servers are fetched; null = not asked yet
        this.lastError = '';          // why the transport gave up, for the status line
        this._polling = false;        // guards overlapping signal polls
    }

    async start() {
        this.client = await api.getClient();
        const { data } = await this.client.auth.getUser();
        this.meId = data?.user?.id || null;

        if (this.mySide === 0) {
            await this._openAsOfferer();
        } else {
            await this._openAsAnswerer();
        }
        this._pollSignals();
        this.pollTimer = setInterval(() => this._pollSignals(), SIGNAL_POLL_MS);
    }

    // ---------------------------------------------------------- connection setup
    async _newPeerConnection() {
        const iceServers = await fetchIceServers(this.client);
        // whether a TURN relay is actually available; now a hard precondition, not just advisory
        this.hasTurn = iceServers.some(srv =>
            [].concat(srv?.urls || []).some(u => String(u).startsWith('turn:') || String(u).startsWith('turns:')));
        log.info('RTC', 'ICE servers resolved', { count: iceServers.length, turn: this.hasTurn });

        // relay-only: a default connection also gathers host/reflexive candidates,
        // which leak both players' real IPs to each other. No-TURN is a hard failure
        // rather than a STUN fallback, since a leaked address can't be taken back.
        if (!this.hasTurn) {
            throw new Error(
                'Battles need the TURN relay, which is not reachable right now. Playing without it ' +
                "would expose both players' IP addresses to each other, so this battle cannot start.");
        }
        const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'relay' });
        pc.onicecandidate = (e) => { if (e.candidate) this._sendSignal('ice', { candidate: e.candidate.toJSON() }); };
        pc.onconnectionstatechange = () => this._handleConnState(pc.connectionState);
        return pc;
    }

    async _openAsOfferer() {
        this.generation++;
        this.pendingCandidates = [];
        this._teardownPeer();
        this.onStatus('connecting');

        const pc = await this._newPeerConnection();
        this.pc = pc;
        const channel = pc.createDataChannel('battle', { ordered: true });
        this._bindChannel(channel);

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await this._sendSignal('offer', { sdp: offer });
    }

    async _openAsAnswerer() {
        this.pendingCandidates = [];
        this._teardownPeer();
        this.onStatus('connecting');

        const pc = await this._newPeerConnection();
        this.pc = pc;
        pc.ondatachannel = (e) => this._bindChannel(e.channel);
    }

    _teardownPeer() {
        if (this.channel) { try { this.channel.close(); } catch { /* already gone */ } }
        if (this.pc) { try { this.pc.close(); } catch { /* already gone */ } }
        this.channel = null;
        this.pc = null;
    }

    _bindChannel(channel) {
        this.channel = channel;
        channel.onopen = () => {
            this.onStatus('connected');
            clearTimeout(this.disconnectTimer); this.disconnectTimer = null;
            const queued = this.queuedSends; this.queuedSends = [];
            queued.forEach(m => this.send(m));
        };
        channel.onclose = () => this._handleDrop();
        channel.onerror = () => { /* onconnectionstatechange drives recovery */ };
        channel.onmessage = (e) => {
            let msg;
            try { msg = JSON.parse(e.data); } catch { return; }
            if (!isValidPeerMessage(msg)) return;
            this.onMessage(msg);
        };
    }

    _handleConnState(state) {
        if (state === 'failed') this._handleDrop();
        else if (state === 'disconnected') this._scheduleDropCheck();
        else if (state === 'connected') { clearTimeout(this.disconnectTimer); this.disconnectTimer = null; }
    }

    _scheduleDropCheck() {
        if (this.disconnectTimer) return;
        this.onStatus('reconnecting');
        this.disconnectTimer = setTimeout(() => this._handleDrop(), DISCONNECT_GRACE_MS);
    }

    _handleDrop() {
        if (this.destroyed) return;
        clearTimeout(this.disconnectTimer); this.disconnectTimer = null;
        this.onStatus('lost');
        // offerer self-heals; answerer just waits for a new offer (only offerer leads)
        if (this.mySide === 0) setTimeout(() => this.reconnect(), OFFERER_RETRY_MS);
    }

    // exposed for a manual "try again" button as well as auto-retry; catches
    // _newPeerConnection's no-relay rejection so it doesn't surface unhandled from the setTimeout
    async reconnect() {
        if (this.destroyed) return;
        if (this.mySide === 0) {
            try {
                await this._openAsOfferer();
            } catch (err) {
                this.lastError = err?.message || String(err);
                log.warn('RTC', 'Could not reopen the connection', err);
                this.onStatus('lost');
            }
        }
        else this.onStatus('reconnecting');
    }

    // ---------------------------------------------------------- signaling (Supabase)
    async _sendSignal(kind, payload) {
        try {
            await this.client.from('battle_signals').insert({
                battle_id: this.battleId, sender_id: this.meId, kind,
                payload: { generation: this.generation, ...payload }
            });
        } catch { /* the poll loop will re-observe state and retry naturally */ }
    }

    async _pollSignals() {
        if (this.destroyed || this._polling) return;
        // guards against overlapping polls double-answering the same offer on a slow link
        this._polling = true;
        try {
            const { data, error } = await this.client
                .from('battle_signals')
                .select('id, sender_id, kind, payload')
                .eq('battle_id', this.battleId)
                .neq('sender_id', this.meId)
                .gt('id', this.lastSignalId)
                .order('id', { ascending: true });
            if (error) throw error;
            for (const row of (data || [])) {
                this.lastSignalId = Math.max(this.lastSignalId, row.id);
                await this._handleSignal(row);
            }
        } catch (err) {
            // transient errors just retry next poll; a relay refusal is not transient, so surface it
            if (this.hasTurn === false) {
                this.lastError = err?.message || String(err);
                this.onStatus('lost');
            }
        }
        finally { this._polling = false; }
    }

    async _handleSignal(row) {
        const gen = row.payload?.generation;
        if (this.mySide === 1 && row.kind === 'offer') {
            // new generation means the offerer reconnected -- start fresh
            if (this.generation !== 0 && gen !== this.generation) await this._openAsAnswerer();
            this.generation = gen;
            await this.pc.setRemoteDescription(row.payload.sdp);
            await this._flushCandidates();
            const answer = await this.pc.createAnswer();
            await this.pc.setLocalDescription(answer);
            await this._sendSignal('answer', { sdp: answer });
        } else if (this.mySide === 0 && row.kind === 'answer' && gen === this.generation) {
            if (this.pc.signalingState === 'have-local-offer') {
                await this.pc.setRemoteDescription(row.payload.sdp);
                await this._flushCandidates();
            }
        } else if (row.kind === 'ice' && gen === this.generation) {
            if (this.pc.remoteDescription) {
                try { await this.pc.addIceCandidate(row.payload.candidate); } catch { /* stale candidate, ignore */ }
            } else {
                this.pendingCandidates.push(row.payload.candidate);
            }
        }
    }

    async _flushCandidates() {
        const queued = this.pendingCandidates; this.pendingCandidates = [];
        for (const c of queued) { try { await this.pc.addIceCandidate(c); } catch { /* stale, ignore */ } }
    }

    // ---------------------------------------------------------- messaging
    send(msg) {
        if (this.channel && this.channel.readyState === 'open') {
            this.channel.send(JSON.stringify(msg));
        } else {
            // held until reconnect rather than dropped, so a move chosen mid-reconnect still lands
            this.queuedSends.push(msg);
        }
    }

    destroy() {
        this.destroyed = true;
        clearInterval(this.pollTimer); this.pollTimer = null;
        clearTimeout(this.disconnectTimer); this.disconnectTimer = null;
        this._teardownPeer();
    }
}

// TURN credentials fetched server-side via the `metered-ice` function; a
// `warning` in the response means it fell back to STUN-only, surfaced via log.warn
// so misconfiguration doesn't silently fail until two players behind NAT can't connect.
async function fetchIceServers(client) {
    try {
        const { data, error } = await client.functions.invoke('metered-ice');
        if (error) throw error;
        if (data?.warning) log.warn('RTC', 'metered-ice fell back to STUN', { warning: data.warning });
        if (Array.isArray(data?.iceServers) && data.iceServers.length) return data.iceServers;
    } catch (err) {
        log.warn('RTC', 'metered-ice unreachable', err);
    }
    // empty, not a STUN fallback -- _newPeerConnection refuses to build without a relay
    return [];
}
