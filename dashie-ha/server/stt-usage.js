// SPDX-License-Identifier: AGPL-3.0-only
// server/stt-usage.js — the STT lane's usage capture point.
//
// D's contract §8c, specced directly against `engines.handleStt`. One more
// caller of the sink in `usage-store.js`; nothing about the sink, the store
// shape, the two no-lying rules or the 400-day prune changes.
//
// ── WHY A MODULE AND NOT TWO INLINE CALLS ────────────────────────────────────
//
// `handleStt` has TWO success paths (local engine, hosted fallback) with
// OPPOSITE billing, and the unit needs parsing that must be able to fail safely.
// Putting that inline would put the risk-carrying part — the header parse — in a
// place no control can reach without an HTTP request. Here it is a pure function
// the gate drives directly, and each call site is one line.
//
// ── 🔴 THE TWO LANES MUST NOT MERGE ──────────────────────────────────────────
//
//   stt_url set    → the household's own engine.  billing: 'byok' or 'free'
//   stt_url empty  → hosted fallback under the account JWT.  billing: 'metered'
//
// `billing` is part of the store key, so recording both as one row would merge
// metered and BYOK spend — which §5a forbids outright. And the metered branch is
// SERVER-AUTHORITATIVE: keep the local row for the at-a-glance view, but never
// display a cost for it from this store.
//
// 🔴 BYOK vs FREE is decided by THE KEY, NOT THE ROUTE. Same discriminator
// `capability.js` uses for the brain, and for the same reason: an empty
// `stt_api_key` is Whisper on the household's own hardware, where no money
// moves; a non-empty one is a paid endpoint. Same route, opposite answers, and
// only the key tells them apart.
//
// ── 🔴 BYTES ALWAYS, SECONDS ONLY WHEN DERIVED ───────────────────────────────
//
// Providers bill STT in seconds, but what this lane holds is `audio.length` —
// raw bytes — and it never parses the audio. So bytes is recorded
// unconditionally and seconds ONLY when a real WAV header yields it.
//
// ⚠️ A WRONG `seconds` IS WORSE THAN A MISSING ONE. It silently becomes a wrong
// cost, in an unknown direction, and looks entirely healthy — the `charge_rates`
// failure mode exactly. Everything below fails toward omission.

'use strict';

const { recordLocalUsage } = require('./usage-store');

/** Canonical PCM WAV layout, per D's §8c.2. */
const OFF = { channels: 22, sampleRate: 24, bitsPerSample: 34, dataTag: 36, dataBytes: 40 };
const MIN_HEADER = 44;

/**
 * Seconds of audio from a WAV header, or `null` when anything is off.
 *
 * Verifies RIFF@0 and WAVE@8 as D specified — and ALSO that the chunk at 36 is
 * literally `data`. That third check is not in the spec and is deliberate: the
 * @40 length field is only the data size in a canonical 44-byte header, and a
 * WAV carrying an extra chunk (LIST/fact, which some encoders emit) puts
 * something else there. Reading it anyway would produce a plausible number from
 * the wrong field — a value that is wrong rather than absent, which is the one
 * outcome the rule above forbids. Checking the tag is the difference between
 * verifying the PROPERTY and trusting a proxy for it.
 */
function wavSeconds(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < MIN_HEADER) return null;
    if (buf.toString('ascii', 0, 4) !== 'RIFF') return null;
    if (buf.toString('ascii', 8, 12) !== 'WAVE') return null;
    if (buf.toString('ascii', OFF.dataTag, OFF.dataTag + 4) !== 'data') return null;

    const channels = buf.readUInt16LE(OFF.channels);
    const sampleRate = buf.readUInt32LE(OFF.sampleRate);
    const bits = buf.readUInt16LE(OFF.bitsPerSample);
    const dataBytes = buf.readUInt32LE(OFF.dataBytes);

    const bytesPerSecond = sampleRate * channels * (bits / 8);
    if (!bytesPerSecond || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return null;
    // A declared data size larger than the buffer means the header is lying or
    // the body is truncated; either way the number would be wrong.
    if (!Number.isFinite(dataBytes) || dataBytes <= 0 || dataBytes > buf.length) return null;

    const seconds = dataBytes / bytesPerSecond;
    return Number.isFinite(seconds) && seconds > 0 ? +seconds.toFixed(3) : null;
}

/**
 * The HOST of an engine URL — never the full URL.
 *
 * 🔴 §6 forbids storing credentials, and a URL can carry a key in its query
 * string. The host is the provider identity; everything after it is either
 * routing or secret.
 */
function hostOf(url) {
    const s = String(url || '').trim();
    if (!s) return null;
    try { return new URL(s).host || null; } catch { return null; }
}

/**
 * Record ONE successful STT call. Never throws.
 *
 * 🔴 SUCCESS PATH ONLY. `stt_engine_error` and `stt_unreachable` made no
 * successful provider call, so there is no usage — record NOTHING rather than a
 * zero row. A zero row is indistinguishable from a real call that transcribed
 * silence, and it inflates the call count the view reports.
 *
 * @param {Buffer} audio  the exact bytes sent to the engine
 * @param {object} opts   add-on options (readOptions())
 * @param {'local'|'cloud'} route  which branch of handleStt ran
 */
function recordSttCall(audio, opts, route) {
    try {
        const bytes = Buffer.isBuffer(audio) ? audio.length : 0;
        if (!bytes) return;   // nothing was sent; nothing to record

        const units = { bytes };
        const seconds = wavSeconds(audio);
        if (seconds !== null) {
            units.seconds = seconds;
        } else {
            // Loud, because a lane that quietly stops emitting seconds looks
            // exactly like a lane nobody used, and the Usage view would show
            // bytes forever without anyone asking why.
            console.warn(`DROP: stt-usage no-seconds — audio is not a parseable canonical WAV (bytes=${bytes})`);
        }

        if (route === 'cloud') {
            // 🔴 `dashie_cloud`, with an UNDERSCORE — a deliberate deviation
            // from D's §8c.3, which wrote the same name HYPHENATED.
            //
            // ⚠️ The hyphenated form is not written out anywhere in this file,
            // deliberately: the brand-residue gate scans text, so quoting it
            // even in a comment re-breaks the regeneration. (It did, once —
            // this comment was the second offender after the code was fixed.)
            //
            // That hyphenated form would have been a SECOND SPELLING of an
            // identity this codebase already has: `dashie_cloud` is the engine
            // id, a wire value on the account contract, and it is already on the
            // brand table's annotated keep-list for exactly that reason. The
            // usage view joins to the provider surface ON PROVIDER IDENTITY
            // (D §7), so two spellings of one provider would split a household's
            // own history across two store keys — invisibly, because both rows
            // look correct.
            //
            // ⭐ The brand-residue gate is what found it: the hyphenated token
            // is not on the keep-list, so the regeneration REFUSED. A gate
            // written for brand leakage caught a hand-mirror instead, which is
            // the second time this week a check has been more useful than the
            // property it was written for.
            recordLocalUsage({
                lane: 'stt', provider: 'dashie_cloud', model: null,
                billing: 'metered', success: true, units,
            });
            return;
        }

        const provider = hostOf(opts?.stt_url) || 'unknown';
        const model = String(opts?.stt_model || 'whisper-1');
        const billing = String(opts?.stt_api_key || '').trim() ? 'byok' : 'free';
        recordLocalUsage({ lane: 'stt', provider, model, billing, success: true, units });
    } catch (e) {
        console.warn(`DROP: stt-usage record threw — ${e?.message || e}`);
    }
}

module.exports = { recordSttCall, wavSeconds, hostOf };
