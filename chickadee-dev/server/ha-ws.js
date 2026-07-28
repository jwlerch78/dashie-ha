// SPDX-License-Identifier: AGPL-3.0-only
// ha-ws.js — thin Home Assistant WebSocket client for engine detection.
//
// Slimmed port of the dashie add-on's ha-registry.js: just the WS core
// (auth, request/response, reconnect) plus the commands voice-engines.js and
// lan-discovery.js need. HA exposes STT/TTS *engines* only over WS — there is
// no REST equivalent for tts/engine/list & co.
//
// Auth: SUPERVISOR_TOKEN via the Supervisor core proxy (homeassistant_api in
// config.yaml), or CHICKADEE_HA_URL + CHICKADEE_HA_TOKEN (long-lived token)
// for local dev. Not configured → isAvailable() false, callers degrade.

'use strict';

const WebSocket = require('ws');

const REQUEST_TIMEOUT_MS = 8000;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;

let ws = null;
let connectionPromise = null;
let nextMsgId = 1;
const pending = new Map();          // id → { resolve, reject, timer }
let reconnectAttempts = 0;
let reconnectTimer = null;
let stopped = false;

function getWsConfig() {
    if (process.env.SUPERVISOR_TOKEN) {
        return { url: 'ws://supervisor/core/api/websocket', token: process.env.SUPERVISOR_TOKEN, mode: 'supervisor' };
    }
    if (process.env.CHICKADEE_HA_URL && process.env.CHICKADEE_HA_TOKEN) {
        const wsUrl = process.env.CHICKADEE_HA_URL
            .replace(/\/$/, '')
            .replace(/^https?:/, m => (m === 'https:' ? 'wss:' : 'ws:'))
            + '/api/websocket';
        return { url: wsUrl, token: process.env.CHICKADEE_HA_TOKEN, mode: 'dev-llat' };
    }
    return null;
}

function isAvailable() {
    return getWsConfig() !== null;
}

function _connect() {
    if (connectionPromise) return connectionPromise;
    const config = getWsConfig();
    if (!config) return Promise.reject(new Error('HA WS not configured'));

    connectionPromise = new Promise((resolve, reject) => {
        let authResolved = false;
        const sock = new WebSocket(config.url);
        ws = sock;

        sock.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw.toString()); } catch { return; }

            if (msg.type === 'auth_required') {
                sock.send(JSON.stringify({ type: 'auth', access_token: config.token }));
                return;
            }
            if (msg.type === 'auth_ok') {
                authResolved = true;
                reconnectAttempts = 0;
                console.log(`[ha-ws] WebSocket authed (${config.mode})`);
                resolve();
                return;
            }
            if (msg.type === 'auth_invalid') {
                authResolved = true;
                reject(new Error('HA WS auth_invalid: ' + (msg.message || 'token rejected')));
                sock.close();
                return;
            }
            if (msg.id != null && pending.has(msg.id)) {
                const { resolve: r, reject: rj, timer } = pending.get(msg.id);
                clearTimeout(timer);
                pending.delete(msg.id);
                if (msg.type === 'result') {
                    if (msg.success) r(msg.result);
                    else rj(new Error(msg.error?.message || 'HA WS command failed'));
                } else {
                    r(msg);
                }
            }
        });

        sock.on('close', () => {
            ws = null;
            connectionPromise = null;
            for (const [, { reject: rj, timer }] of pending) {
                clearTimeout(timer);
                rj(new Error('HA WS closed'));
            }
            pending.clear();
            if (!authResolved) reject(new Error('HA WS closed before auth'));
            if (!stopped) _scheduleReconnect();
        });

        sock.on('error', (err) => {
            console.warn('[ha-ws] WS error:', err.message);
            if (!authResolved) reject(err);
        });
    }).catch(e => {
        connectionPromise = null;
        throw e;
    });

    return connectionPromise;
}

function _scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts), RECONNECT_MAX_MS);
    reconnectAttempts++;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        _connect().catch(() => { /* rescheduled via close */ });
    }, delay);
    if (reconnectTimer.unref) reconnectTimer.unref();
}

function _send(payload) {
    return _connect().then(() => new Promise((resolve, reject) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            return reject(new Error('HA WS not open'));
        }
        const id = nextMsgId++;
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`HA WS request ${id} timed out`));
        }, REQUEST_TIMEOUT_MS);
        if (timer.unref) timer.unref();
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, ...payload }));
    }));
}

/** List TTS engines. → { providers: [{ engine_id, supported_languages }] }. */
function listTtsEngines() { return _send({ type: 'tts/engine/list' }); }

/** Voices for one TTS engine in a language. → { voices: [{ voice_id, name }] }. */
function getTtsVoices(engineId, language) { return _send({ type: 'tts/engine/voices', engine_id: engineId, language }); }

/** List STT engines (stt/engine/get doesn't exist on current HA). */
function listSttEngines() { return _send({ type: 'stt/engine/list' }); }

/** In-progress config-flow list (WS-only — no REST equivalent). Used to detect a
 *  parked discovery flow (the "Configure" card) so the banner can absorb its click. */
function listConfigFlowsInProgress() { return _send({ type: 'config_entries/flow/progress' }); }

/** HA's own config → { language, country, internal_url, … }. */
function getHaConfig() { return _send({ type: 'get_config' }); }

/** Raw HA state list — LAN discovery reads devices' ip_address attributes. */
function getStates() { return _send({ type: 'get_states' }); }

function start() {
    if (!isAvailable()) {
        console.log('[ha-ws] Not configured (no SUPERVISOR_TOKEN or CHICKADEE_HA_URL+TOKEN); engine detection unavailable.');
        return;
    }
    stopped = false;
    _connect().catch(e => console.warn('[ha-ws] Initial connect failed:', e.message));
}

function stop() {
    stopped = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) { try { ws.close(); } catch { /* closing */ } }
    ws = null;
    connectionPromise = null;
}

module.exports = { isAvailable, start, stop, listTtsEngines, getTtsVoices, listSttEngines, listConfigFlowsInProgress, getHaConfig, getStates };
