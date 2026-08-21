// SPDX-License-Identifier: AGPL-3.0-only
// server/account-config.js — read the account's voice/AI config from user_settings.
//
// Account-level config for the on-prem brain. The add-on is the
// single reader of user_settings for voice routing: it already holds the account JWT, so it queries
// its own row via PostgREST (RLS-scoped to the user). Both consumers use this one function:
//   - /api/voice/converse-local → endpoint + model for the LAN inference call (M6)
//   - /api/internal/voice-config → the route the integration should take (M7)
//
// The "is this account on a local model?" decision lives here: ai.model === 'local' (the generic
// "My own AI" endpoint row) or 'hermes' (the dedicated Hermes Agent row, WS-I) → route 'local';
// anything else → 'cloud'. Both are local-family sentinels: the model runs on the user's own
// hardware and the cloud edge fn can't reach it.

const fs = require('fs');
const path = require('path');
const auth = require('./auth');
const { CLOUD: SUPABASE, DATA_DIR } = require('./config');
const { resolveBrainRoute } = require('./brain/providers');

const TTL_MS = 30_000; // user_settings changes rarely; a short cache keeps converse latency low.
let _cache = null; // { at, value }

// ── Last-known-good config, persisted to the box ────────────────────────────────
// WHY (2026-07-14): every ingredient of a fully-local voice turn already lives on this
// box — the brain bundle (vendored), the BYO keys (/data/api-keys.json), Hermes/Ollama,
// Piper/Whisper. The ONLY cloud-resident piece was this config. So a Supabase outage used
// to hand back SAFE_DEFAULT (route:'cloud') and the add-on would dutifully route voice to
// a cloud edge fn it couldn't reach — bricking a household whose entire stack was local
// and healthy, and making the perpetual voice license a lie the moment Dashie had a bad day.
//
// Now: every SUCCESSFUL read is persisted here, and a failed read falls back to the last
// known good instead of SAFE_DEFAULT. That's not just outage insurance — it's strictly MORE
// correct in the normal case: on a transient blip we replay the user's actual last choice
// rather than guessing 'cloud'. SAFE_DEFAULT is now only for a box that has never once
// read its config (never configured / never signed in).
//
// 0600: the blob carries localLlmKey (a BYO bearer), same trust boundary as key-store.js.
const CONFIG_CACHE_FILE = path.join(DATA_DIR, 'account-config.cache.json');

function _writeCachedConfig(value) {
  try {
    const tmp = CONFIG_CACHE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, CONFIG_CACHE_FILE);
    try { fs.chmodSync(CONFIG_CACHE_FILE, 0o600); } catch (e) { /* best effort */ }
  } catch (e) {
    console.warn('[account-config] could not persist last-known-good config:', e?.message || e);
  }
}

function _readCachedConfig() {
  try {
    if (!fs.existsSync(CONFIG_CACHE_FILE)) return null;
    const v = JSON.parse(fs.readFileSync(CONFIG_CACHE_FILE, 'utf8'));
    return (v && typeof v === 'object') ? v : null;
  } catch (e) {
    console.warn('[account-config] last-known-good config unreadable:', e?.message || e);
    return null;
  }
}

// pipeline: null on the degraded path — NOT an empty pipeline. The kiosk applier
// hard-applies any boolean the block CONTAINS (it gates on key presence, and only
// strings get an is-empty guard), so serving a zeroed pipeline after a transient
// user_settings read failure would write customizePipeline=false + alwaysOpenDialog=false
// onto every kiosk in the house. Null → /voice-config omits `pipeline` → the integration
// forwards nothing → the applier leaves the kiosk alone. (Audit 2026-07-13, #4.)
const SAFE_DEFAULT = { model: null, route: 'cloud', localLlmUrl: '', localLlmModel: '', localLlmKey: '', hermesUrl: '', retainTranscripts: false, agentMode: '', retrievePictures: null, webSearchEnabled: null, zipCode: '', defaultPersonalityId: '', defaultVoiceKey: '', defaultWakeWord: '', householdSharing: false, pipeline: null };

/** Coerce a settings value to a string, '' when absent/non-string. */
function str(v) { return typeof v === 'string' ? v : ''; }

/**
 * Resolve the account's voice routing config.
 * @returns {Promise<{model: string|null, route: 'local'|'cloud', localLlmUrl: string, localLlmModel: string}>}
 *          Never throws — falls back to SAFE_DEFAULT (cloud) on any error / not-signed-in.
 */
async function getAccountVoiceConfig() {
  if (_cache && Date.now() - _cache.at < TTL_MS) return withRoute(_cache.value);

  let value = SAFE_DEFAULT;
  let readOk = false;   // did we actually get a live answer out of Supabase?
  try {
    const { jwt, userId } = await auth.getValidJwt();
    if (jwt && userId) {
      // retain_transcripts is a dedicated column (not in the settings blob) — same source
      // retention.ts reads. Governs whether the brain keeps the turn's transcript.
      const url = `${SUPABASE.url}/rest/v1/user_settings`
        + `?auth_user_id=eq.${encodeURIComponent(userId)}&select=settings,retain_transcripts`;
      const resp = await fetch(url, {
        headers: { apikey: SUPABASE.anonKey, Authorization: `Bearer ${jwt}` },
      });
      if (resp.ok) {
        const rows = await resp.json().catch(() => []);
        const row = (Array.isArray(rows) && rows[0]) || {};
        const settings = row.settings || {};
        const model = settings?.ai?.model || null;
        // 🔴 ONE FACT, THREE STORAGE HOMES — resolved here so consumers see one answer.
        //
        // "my LLM is qwen3 on my box" can live in: (1) voice.localEngines — the engines
        // store the ADD-ON console renders and the STT/TTS legs already honour; (2)
        // voice.localLlmUrl/localLlmModel — the WEB console's inline "My own AI" row; (3)
        // the add-on's Configuration tab, the only one converse.js used to read. Measured
        // 2026-08-21 on prod: (1) populated, (2) EMPTY estate-wide (the aliasing bug had
        // deleted that row from the web console), (3) empty. So the console displayed a
        // local model, the STT/TTS legs used it, and the brain answered from the cloud —
        // display and behaviour disagreeing because they read different homes.
        //
        // Precedence: an engine the user SELECTED by name wins (ai.model = 'engine:<id>');
        // then the explicitly-typed inline fields; then any usable stored LLM engine.
        const engines = Array.isArray(settings?.voice?.localEngines) ? settings.voice.localEngines : [];
        const usableEngine = (e) => e && e.kind === 'llm' && str(e.url) && str(e.model);
        const selectedId = typeof model === 'string' && model.startsWith('engine:')
          ? model.slice('engine:'.length) : null;
        const llmEngine =
          (selectedId && engines.find((e) => usableEngine(e) && e.id === selectedId)) ||
          engines.find(usableEngine) || null;
        value = {
          model,
          localLlmUrl: str(settings?.voice?.localLlmUrl) || str(llmEngine?.url),
          localLlmModel: str(settings?.voice?.localLlmModel) || str(llmEngine?.model),
          // BYO-model API key (WS-I) — bearer for a remote OpenAI-compatible
          // endpoint. Console-only key (user_settings.voice.localLlmKey); passed to
          // node-io.js. Blank for keyless local Ollama/llama.cpp.
          localLlmKey: str(settings?.voice?.localLlmKey) || str(llmEngine?.key),
          // Hermes Agent endpoint (dedicated row, ai.model='hermes'). Its API key is
          // NOT in user_settings — it lives in the on-box key store ('hermes' provider).
          hermesUrl: settings?.voice?.hermesUrl || '',
          retainTranscripts: row.retain_transcripts === true,
          // Household conversation agent mode (live|dialog|single) — the console's Voice & AI
          // page writes user_settings.voice.agentMode (ACCOUNT_VOICE_KEYS). Carried to
          // anonymous kiosks via the integration's /api/dashie/voice/status so they behave
          // like the account chose (Live-on-kiosk, 2026-07-09). '' = unset → kiosk default.
          agentMode: typeof settings?.voice?.agentMode === 'string' ? settings.voice.agentMode : '',
          // Household Dashie Intelligence sharing — ACCOUNT-scoped (2026-07-13). Previously
          // lived per-add-on-instance in /data (settings-store), so a new/wiped account
          // inherited the previous account's sharing state. It's a property of the ACCOUNT
          // ("share THIS account house-wide"), so it's read from user_settings: a fresh
          // account is off by default, and nothing is shared without an explicit opt-in.
          // Gates /api/internal/sharing-status + /api/internal/account-credential.
          householdSharing: settings?.voice?.householdSharing === true,
          // ai.retrievePicturesEnabled — same anon-kiosk carry as agentMode (the relay
          // omits the image_search tool when false/unset). null = unset.
          retrievePictures: typeof settings?.ai?.retrievePicturesEnabled === 'boolean'
            ? settings.ai.retrievePicturesEnabled : null,
          // ai.webSearchEnabled + the ZIP SSOT (family.zipCode canon → general mirror) —
          // consumed by node-io.readAccountAiConfig so the add-on brain honors the same
          // account tool toggles the cloud brain does (BYOK tool parity, 2026-07-13).
          webSearchEnabled: typeof settings?.ai?.webSearchEnabled === 'boolean'
            ? settings.ai.webSearchEnabled : null,
          zipCode: str(settings?.family?.zipCode) || str(settings?.general?.zipCode),
          // WS-G §13.2: household account defaults — anon kiosks resolve the
          // household-sharing account's defaults (locked decision), still
          // overridable on-device. '' = unset → kiosk/app defaults
          // (Dashie personality / Hey Dashie).
          defaultPersonalityId: typeof settings?.ai?.defaultPersonalityId === 'string' ? settings.ai.defaultPersonalityId : '',
          defaultVoiceKey: typeof settings?.ai?.defaultVoiceKey === 'string' ? settings.ai.defaultVoiceKey : '',
          defaultWakeWord: typeof settings?.ai?.defaultWakeWord === 'string' ? settings.ai.defaultWakeWord : '',
          // Kiosk voice-config mirror (Phase 1, 2026-07-13): the full account voice
          // pipeline so a share-account anon kiosk reflects the household's Voice & AI
          // setup (Cloud/Hybrid/Local providers + HA engine ids + voice + model),
          // not just agentMode. '' = unset → the kiosk keeps its own default for that
          // key. Consumed by DashieCloudCapabilityClient on the anon-kiosk path.
          pipeline: {
            sttProvider: str(settings?.voice?.sttProvider),
            ttsProvider: str(settings?.voice?.ttsProvider),
            haSttEngineId: str(settings?.voice?.haSttEngineId),
            haTtsEngineId: str(settings?.voice?.haTtsEngineId),
            haTtsVoiceId: str(settings?.voice?.haTtsVoiceId),
            // controlMethod — served raw from user_settings. The console now persists
            // it UNCONDITIONALLY on preset select (voice-ai.js selectPreset), so it's
            // no longer blank for default-preset accounts and the add-on no longer
            // derives it (the 2026-07-13 derivation workaround was retired once the
            // console became the single source of truth — kiosk-voice-mirror Option A).
            controlMethod: str(settings?.voice?.controlMethod),
            searchSource: str(settings?.voice?.searchSource),
            // Which HA entities voice can control (dashboard | assist). Rides the pipeline block so
            // the integration forwards it wholesale; the applier writes VoicePreferences.entitySource,
            // which DashieNative.getVoiceEntitySource() exposes to the kiosk's buildHaVoiceContext so
            // a shared-account kiosk honors the account's pick instead of always using the exposed
            // list (webapp/kiosk divergence, 20260717). Blank → kiosk default 'assist' (exposed).
            entitySource: str(settings?.voice?.entitySource),
            pipelinePreset: str(settings?.voice?.pipelinePreset),
            // Own-box STT/TTS endpoints. MUST ride along with sttProvider/ttsProvider:
            // the applier hard-applies the providers, so serving `local_stt_url` /
            // `local_url` WITHOUT the URL left a Local-preset kiosk with dead STT and a
            // silent fallback to device TTS (audit 2026-07-13, #1).
            localSttUrl: str(settings?.voice?.localSttUrl),
            localTtsUrl: str(settings?.voice?.localTtsUrl),
            localTtsVoiceId: str(settings?.voice?.localTtsVoiceId),
            // Live (realtime S2S) model + always-on flag. Without these a kiosk's Live
            // session always fell back to RealtimeConfig.DEFAULT_MODEL, and the on-demand
            // "conversation mode" trigger could never fire (conversationModeEnabled was
            // false because conversationModel was blank). Audit 2026-07-13, #3.
            conversationModel: str(settings?.voice?.conversationModel),
            conversationAlways: settings?.voice?.conversationAlways === true,
            customizePipeline: settings?.voice?.customizePipeline === true,
            // DLG-6 "keep dialog open" (user_settings.voice.alwaysOpenDialog) — rides the
            // pipeline block rather than a new top-level field so the integration forwards
            // it as-is (it passes `pipeline` through wholesale), no integration release
            // needed. The applier writes VoicePreferences.alwaysOpenDialog.
            alwaysOpenDialog: settings?.voice?.alwaysOpenDialog === true,
          },
        };
        readOk = true;
      }
    }
  } catch (e) {
    console.warn('[account-config] user_settings read failed:', e?.message || e);
  }

  if (readOk) {
    // Live answer — this becomes the last-known-good for any future outage.
    value = { ...value, configSource: 'live' };
    _writeCachedConfig(value);
  } else {
    // Supabase unreachable / signed out. Replay the user's LAST ACTUAL CHOICE rather than
    // guessing 'cloud' — a local-first household keeps working even if Dashie is gone for
    // good. Only a box that has never successfully read its config falls to SAFE_DEFAULT.
    const cached = _readCachedConfig();
    if (cached) {
      value = { ...cached, configSource: 'cache' };
      console.warn('[account-config] using last-known-good config from /data'
        + ` (model=${cached.model || 'none'}) — Dashie Cloud unreachable, local setup unaffected.`);
    } else {
      value = { ...SAFE_DEFAULT, configSource: 'default' };
      console.warn('[account-config] no cached config on this box — defaulting to cloud route.');
    }
  }

  _cache = { at: Date.now(), value };
  return withRoute(value);
}

/** Stamp `route`/`routeReason` FRESH on every read (outside the settings cache): the route
 *  depends on the box's key store too (Open Brain §5 BYOK), and a key add/remove must flip
 *  routing immediately, not after the settings TTL. resolveBrainRoute reads the key file —
 *  cheap. `route`: 'local' = run the brain in this add-on; 'cloud' = the metered edge fn. */
function withRoute(value) {
  const { route, reason } = resolveBrainRoute(value);
  return { ...value, route, routeReason: reason };
}

/** Drop the cache (e.g. after a known settings change). */
function invalidate() { _cache = null; }

module.exports = { getAccountVoiceConfig, invalidate };
