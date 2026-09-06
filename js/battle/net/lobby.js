// Battle lobby: deliberately not a random queue -- you see who's around and
// challenge a specific person, who accepts or declines (like Showdown's user list).
// Supabase carries presence heartbeats, directed challenges, and battles
// (created atomically by accept_battle_challenge()). Teams stay on-device
// (see ../teams.js); only a snapshot entering one specific battle is sent.

import { api } from '../../core/app.js';
import { nextBattleToAnnounce } from './protocol.js';

const HEARTBEAT_MS = 25000;   // server treats a >90s gap as gone
const POLL_MS = 4000;

export class BattleLobby {
    constructor({ onLobby, onChallenges, onBattleStart, onError } = {}) {
        this.onLobby = onLobby || (() => {});
        this.onChallenges = onChallenges || (() => {});
        this.onBattleStart = onBattleStart || (() => {});
        this.onError = onError || (() => {});
        this.heartbeatTimer = null;
        this.pollTimer = null;
        this.joined = false;
        this.status = 'open';
        this._busy = false;
        // battles already handed to onBattleStart -- avoids re-announcing the same
        // accepted challenge on every poll tick before it's cleared server-side
        this._announced = new Set();
    }

    async join(status = 'open') {
        this.status = status;
        this.joined = true;
        await this._heartbeat();
        await this.refresh();
        this.heartbeatTimer = setInterval(() => this._heartbeat(), HEARTBEAT_MS);
        this.pollTimer = setInterval(() => this.refresh(), POLL_MS);
    }

    async leave() {
        this.joined = false;
        clearInterval(this.heartbeatTimer); this.heartbeatTimer = null;
        clearInterval(this.pollTimer); this.pollTimer = null;
        try {
            const client = await api.getClient();
            await client.rpc('leave_battle_lobby');
        } catch { /* best-effort; row expires on its own */ }
    }

    async setStatus(status) {
        this.status = status;
        await this._heartbeat();
    }

    async _heartbeat() {
        if (!this.joined) return;
        try {
            const client = await api.getClient();
            await client.rpc('battle_heartbeat', { p_status: this.status });
        } catch (e) { this.onError(e); }
    }

    // guarded so a slow response can't overlap the next tick and deliver results out of order
    async refresh() {
        if (!this.joined || this._busy) return;
        this._busy = true;
        try {
            const client = await api.getClient();
            const [{ data: lobby, error: le }, { data: challenges, error: ce }] = await Promise.all([
                client.rpc('list_battle_lobby'),
                client.from('battle_challenges')
                    .select('id, from_id, to_id, from_name, format, status, battle_id, created_at')
                    .in('status', ['pending', 'accepted'])
                    .order('created_at', { ascending: false })
                    .limit(30)
            ]);
            if (le) throw le;
            if (ce) throw ce;

            this.onLobby(lobby || []);
            this.onChallenges(challenges || []);

            // if a challenge we sent was accepted, the battle exists now
            const accepted = nextBattleToAnnounce(challenges, this._announced);
            if (accepted) {
                const { data: battle } = await client.from('battles').select('*').eq('id', accepted.battle_id).maybeSingle();
                if (battle && battle.status === 'active') {
                    // claimed before the handler runs, so a slow handler can't double-announce
                    this._announced.add(accepted.battle_id);
                    this.onBattleStart(battle, accepted);
                }
            }
        } catch (e) {
            this.onError(e);
        } finally {
            this._busy = false;
        }
    }

    // ---------------------------------------------------------- challenges
    async challenge(toUserId, teamPackage, myName, format = 'singles') {
        const client = await api.getClient();
        // replace any previous open challenge to the same person rather than
        // colliding with the partial unique index
        await client.from('battle_challenges')
            .update({ status: 'cancelled' })
            .eq('from_id', (await client.auth.getUser()).data.user.id)
            .eq('to_id', toUserId)
            .eq('status', 'pending');

        const { data, error } = await client.from('battle_challenges').insert({
            from_id: (await client.auth.getUser()).data.user.id,
            to_id: toUserId,
            from_name: myName || 'A challenger',
            format,
            from_team: teamPackage
        }).select().single();
        if (error) throw error;
        return data;
    }

    async cancelChallenge(id) {
        const client = await api.getClient();
        const { error } = await client.from('battle_challenges').update({ status: 'cancelled' }).eq('id', id);
        if (error) throw error;
    }

    async decline(id) {
        const client = await api.getClient();
        const { error } = await client.from('battle_challenges').update({ status: 'declined' }).eq('id', id);
        if (error) throw error;
    }

    // creates the battle row inside a locked transaction, so two rapid taps can't spawn two battles
    async accept(challengeId, myTeamPackage) {
        const client = await api.getClient();
        const { data, error } = await client.rpc('accept_battle_challenge', {
            p_challenge_id: challengeId,
            p_my_team: myTeamPackage
        });
        if (error) throw error;
        return data;
    }

    // accepting takes the accepter straight to the battle; prevents the poll re-announcing it
    markAnnounced(battleId) { if (battleId) this._announced.add(battleId); }

    // the accepter's team only exists on the battle row once accepted
    async getBattle(battleId) {
        const client = await api.getClient();
        const { data, error } = await client.from('battles').select('*').eq('id', battleId).maybeSingle();
        if (error) throw error;
        return data;
    }

    async finish(battleId, winnerId, reason, actions) {
        const client = await api.getClient();
        const { error } = await client.rpc('finish_battle', {
            p_battle_id: battleId, p_winner_id: winnerId || null,
            p_reason: reason || '', p_actions: actions || []
        });
        if (error) throw error;
    }
}
