// SPDX-License-Identifier: AGPL-3.0-only
// ⛔ GENERATED, DO NOT EDIT. Source: dashieapp_staging supabase/functions/_shared/gemini-tts-stream.ts
// source sha256/16: bfdc443a96f75e62. Regenerate: node scripts/gen-addon-shared.mjs (in dashieapp_staging).
// The edge gemini-tts function streams with the SAME code, so tablet audio is converted identically whether the household key (this add-on) or Dashie credits (the edge) pays.
'use strict';
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var stdin_exports = {};
__export(stdin_exports, {
  GEMINI_TTS_DEFAULT_VOICE: () => GEMINI_TTS_DEFAULT_VOICE,
  GEMINI_TTS_MODEL: () => GEMINI_TTS_MODEL,
  GEMINI_TTS_STREAM_URL: () => GEMINI_TTS_STREAM_URL,
  geminiTtsBody: () => geminiTtsBody,
  geminiVoiceName: () => geminiVoiceName,
  sseToPcm: () => sseToPcm
});
module.exports = __toCommonJS(stdin_exports);
const GEMINI_TTS_MODEL = "gemini-3.8-flash-tts";
const GEMINI_TTS_DEFAULT_VOICE = "Aoede";
const GEMINI_TTS_STREAM_URL = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;
const PCM_24K = /^audio\/l16;\s*(codec=pcm;\s*)?rate=24000(;\s*channels=1)?$/i;
function geminiVoiceName(v) {
  const s = typeof v === "string" ? v.trim() : "";
  return /^[A-Z][a-z]{1,20}$/.test(s) ? { name: s, substituted: false } : { name: GEMINI_TTS_DEFAULT_VOICE, substituted: s !== "" };
}
function geminiTtsBody(text, voiceName) {
  return {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } }
    }
  };
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function sseToPcm(hooks = {}) {
  const decoder = new TextDecoder();
  let buf = "";
  let first = true;
  let usage = null;
  const droppedMimes = /* @__PURE__ */ new Set();
  function line(raw, controller) {
    const s = raw.trim();
    if (!s.startsWith("data:")) return;
    let ev;
    try {
      ev = JSON.parse(s.slice(5));
    } catch {
      hooks.onDrop?.("unparseable SSE event");
      return;
    }
    const um = ev?.usageMetadata;
    if (um) usage = { inputTokens: Number(um.promptTokenCount) || 0, outputTokens: Number(um.candidatesTokenCount) || 0 };
    for (const c of ev?.candidates ?? []) {
      for (const p of c?.content?.parts ?? []) {
        const d = p?.inlineData;
        if (!d?.data) continue;
        const mime = String(d.mimeType ?? "");
        if (!PCM_24K.test(mime)) {
          if (!droppedMimes.has(mime)) {
            droppedMimes.add(mime);
            hooks.onDrop?.(`non-PCM24k audio part '${mime}'`);
          }
          continue;
        }
        const bytes = base64ToBytes(d.data);
        if (!bytes.length) continue;
        if (first) {
          first = false;
          hooks.onFirstAudio?.();
        }
        controller.enqueue(bytes);
      }
    }
  }
  return new TransformStream({
    transform(chunk, controller) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        line(buf.slice(0, nl), controller);
        buf = buf.slice(nl + 1);
      }
    },
    flush(controller) {
      buf += decoder.decode();
      if (buf.trim()) line(buf, controller);
      if (usage) hooks.onUsage?.(usage);
      else hooks.onDrop?.("stream ended with no usageMetadata (cannot bill tokens)");
    }
  });
}
