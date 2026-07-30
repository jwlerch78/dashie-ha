/* ============================================================
   Dashie Console — Settings Sync (vanilla JS twin)

   Mirrors js/data/sync/settings-sync.js in the dashboard repo.
   Same API surface, same coalesce/reconnect/kill-switch semantics,
   adapted to Console's no-modules world.

   Usage:
     SettingsSync.register('calendar_color_overrides', async () => {
       // re-fetch + re-render
     });
     await SettingsSync.connect();      // call after DashieAuth resolves

   Self-echo filter: SettingsSync.getClientId() returns a per-origin
   stable UUID (localStorage). console-auth.dbRequest injects it as
   source_client_id on every settings write, so broadcasts originated
   by this tab are filtered out of its own subscription handler.

   Kill switch: set window.__DISABLE_SETTINGS_SYNC = true before
   connect() to disable all realtime refreshes. Useful for emergency
   rollback without redeploy.
   ============================================================ */

window.SettingsSync = (function () {
  'use strict';

  var CLIENT_ID_KEY = 'dashie-client-id';
  var COALESCE_WINDOW_MS = 200;
  var RECONNECT_RATE_LIMIT_MS = 30000;

  // ── State ─────────────────────────────────────────────────
  var _clientId = null;
  var _supabase = null;
  var _userId = null;
  var _channel = null;
  var _registry = new Map();   // kind -> refreshFn
  var _coalesce = new Map();   // kind -> timer id
  var _lastSyntheticAll = 0;
  var _connected = false;
  var _wasConnectedBefore = false;
  var _resubTimer = null;
  var _resubAttempts = 0;
  var _intentionalDisconnect = false;

  // ── Client ID ─────────────────────────────────────────────
  function generateUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function getClientId() {
    if (_clientId) return _clientId;
    try {
      _clientId = localStorage.getItem(CLIENT_ID_KEY);
      if (!_clientId) {
        _clientId = generateUUID();
        localStorage.setItem(CLIENT_ID_KEY, _clientId);
      }
    } catch (_) {
      // localStorage unavailable — session-lifetime fallback so the
      // self-echo filter still works within this page lifetime.
      _clientId = generateUUID();
    }
    return _clientId;
  }

  // ── Registration ──────────────────────────────────────────
  function register(kind, refreshFn) {
    if (typeof kind !== 'string' || !kind) {
      console.warn('[SettingsSync] register() ignored — kind must be a non-empty string');
      return;
    }
    if (typeof refreshFn !== 'function') {
      console.warn('[SettingsSync] register(' + kind + ') ignored — refreshFn is not a function');
      return;
    }
    _registry.set(kind, refreshFn);
    console.debug('[SettingsSync] Registered consumer for kind=' + kind);
  }

  // ── Connection ────────────────────────────────────────────
  function configure(supabase, userId) {
    if (_channel) {
      throw new Error('SettingsSync.configure called after connect — disconnect first');
    }
    if (!supabase || !userId) {
      console.warn('[SettingsSync] configure() called with missing supabase or userId');
      return;
    }
    _supabase = supabase;
    _userId = userId;
  }

  async function connect() {
    if (typeof window !== 'undefined' && window.__DISABLE_SETTINGS_SYNC) {
      console.warn('[SettingsSync] Kill switch active — connect aborted');
      return;
    }
    if (!_supabase || !_userId) {
      console.warn('[SettingsSync] connect() called before configure() — aborting');
      return;
    }
    if (_channel) {
      console.debug('[SettingsSync] connect() called while already connected — no-op');
      return;
    }

    var channelName = 'user_settings_' + _userId;
    console.debug('[SettingsSync] Connecting to ' + channelName + ' as client ' + getClientId().substring(0, 8) + '…');

    var ch = _supabase.channel(channelName);
    _channel = ch;
    ch.on('broadcast', { event: 'settings-changed' }, function (msg) {
      if (_channel !== ch) return;  // stale channel after a resubscribe
      _handleBroadcast(msg.payload);
    });
    _intentionalDisconnect = false;
    ch.subscribe(function (status) {
      // Generation guard: the OLD channel's teardown fires CLOSED into this
      // callback after a resubscribe — without the guard it re-scheduled
      // forever (teardown cycle; see dashboard twin, 2026-07-06).
      if (_channel !== ch) return;
      if (status === 'SUBSCRIBED') {
        var wasReconnect = _wasConnectedBefore;
        _wasConnectedBefore = true;
        _connected = true;
        _resubAttempts = 0;
        if (wasReconnect) {
          _maybeFireSyntheticAll();
        } else {
          console.log('[SettingsSync] Connected', { kinds: _registry.size });
        }
      } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        _connected = false;
        console.warn('[SettingsSync] Channel ' + status + ' — scheduling resubscribe');
        // A dead channel used to stay dead for the whole session: broadcast()
        // silently no-oped and no kinded refreshes arrived (2026-07-06
        // temperatureUnit fan-out incident on the dashboard twin). Rebuild
        // with backoff; synthetic-all on re-SUBSCRIBE catches up.
        _scheduleResubscribe();
      }
    });
  }

  function _scheduleResubscribe() {
    if (_intentionalDisconnect || _resubTimer) return;
    var delay = Math.min(30000, 2000 * Math.pow(2, _resubAttempts++));
    _resubTimer = setTimeout(function () {
      _resubTimer = null;
      if (_intentionalDisconnect || !_supabase || !_userId) return;
      console.log('[SettingsSync] Resubscribing (attempt ' + _resubAttempts + ')');
      // Null the ref BEFORE teardown so the old channel's CLOSED hits the
      // generation guard instead of re-scheduling (teardown-cycle bug).
      var old = _channel;
      _channel = null;
      try { if (old) old.unsubscribe(); } catch (_) {}
      try { if (old && _supabase.removeChannel) _supabase.removeChannel(old); } catch (_) {}
      connect();
    }, delay);
  }

  function disconnect() {
    _intentionalDisconnect = true;
    if (_resubTimer) { clearTimeout(_resubTimer); _resubTimer = null; }
    if (_channel) {
      try { _channel.unsubscribe(); } catch (_) {}
      _channel = null;
    }
    _coalesce.forEach(function (t) { clearTimeout(t); });
    _coalesce.clear();
    _connected = false;
    _wasConnectedBefore = false;
  }

  function isConnected() { return _connected; }

  /**
   * Send a kinded settings-changed broadcast on the LIVE subscribed channel.
   *
   * Writers (saveUserSettings) must NOT open their own channel on the same
   * topic to broadcast: supabase-js keys channels by topic per client, and a
   * second channel.subscribe() on an already-subscribed topic never reaches
   * 'SUBSCRIBED' (it hangs), so the send is silently dropped — which is
   * exactly why console settings changes stopped reaching the tablet live.
   * Reuse this one persistent channel instead (mirrors the dashboard's
   * broadcastChange, which reuses its single subscribed channel).
   *
   * @param {string} kind            e.g. 'account_settings'
   * @param {string} [sourceClientId] self-filter id for the receiver; defaults
   *                                  to this client's id.
   * @returns {boolean} true if the send was issued, false if not connected.
   */
  function broadcast(kind, sourceClientId) {
    if (!_channel || !_connected) {
      console.debug('[SettingsSync] broadcast skipped — not connected: kind=' + kind);
      return false;
    }
    try {
      _channel.send({
        type: 'broadcast',
        event: 'settings-changed',
        payload: { kind: kind, source_client_id: sourceClientId || getClientId() }
      });
      return true;
    } catch (e) {
      console.warn('[SettingsSync] broadcast failed: ' + (e && e.message));
      return false;
    }
  }

  // ── Dispatch ──────────────────────────────────────────────
  function _handleBroadcast(payload) {
    if (!payload || typeof payload.kind !== 'string') {
      console.debug('[SettingsSync] Ignoring malformed broadcast', payload);
      return;
    }
    if (payload.source_client_id && payload.source_client_id === getClientId()) {
      console.debug('[SettingsSync] Self-echo filtered: kind=' + payload.kind);
      return;
    }
    _scheduleRefresh(payload.kind, payload);
  }

  function _scheduleRefresh(kind, payload) {
    if (_coalesce.has(kind)) {
      clearTimeout(_coalesce.get(kind));
    }
    var timer = setTimeout(function () {
      _coalesce.delete(kind);
      _invokeRefresh(kind, payload);
    }, COALESCE_WINDOW_MS);
    _coalesce.set(kind, timer);
  }

  async function _invokeRefresh(kind, payload) {
    var fn = _registry.get(kind);
    if (!fn) {
      console.debug('[SettingsSync] No consumer registered for kind=' + kind);
      return;
    }
    try {
      console.debug('[SettingsSync] Refreshing kind=' + kind + (payload && payload.synthetic ? ' (synthetic)' : ''));
      await fn(payload);
    } catch (e) {
      console.warn('[SettingsSync] refreshFn(' + kind + ') threw', e && e.message);
    }
  }

  function _maybeFireSyntheticAll() {
    var now = Date.now();
    if (now - _lastSyntheticAll < RECONNECT_RATE_LIMIT_MS) {
      console.debug('[SettingsSync] Synthetic-all rate-limited');
      return;
    }
    _lastSyntheticAll = now;
    console.log('[SettingsSync] Reconnected — firing synthetic refresh for ' + _registry.size + ' kinds');
    _registry.forEach(function (_fn, kind) {
      _scheduleRefresh(kind, { kind: kind, source_client_id: null, ts: now, synthetic: true });
    });
  }

  return {
    getClientId: getClientId,
    register: register,
    configure: configure,
    connect: connect,
    disconnect: disconnect,
    isConnected: isConnected,
    broadcast: broadcast
  };
})();
