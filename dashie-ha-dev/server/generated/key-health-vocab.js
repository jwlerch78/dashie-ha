// SPDX-License-Identifier: AGPL-3.0-only
// ⛔ GENERATED, DO NOT EDIT. Source: dashieapp_staging supabase/functions/_shared/key-health-vocab.ts
// source sha256/16: a19dae63bdd88e32. Regenerate: node scripts/gen-addon-shared.mjs (in dashieapp_staging).
// The add-on's 409 {reason:'key_failed', status} and the edge's byok_key_health.last_status are ONE list; the tablet reads both.
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
  KEY_FAILURE_STATUSES: () => KEY_FAILURE_STATUSES,
  KEY_HEALTH_PROVIDER_RE: () => KEY_HEALTH_PROVIDER_RE,
  PILL_STATUSES: () => PILL_STATUSES,
  classifyKeyFailure: () => classifyKeyFailure,
  isKeyFailureStatus: () => isKeyFailureStatus
});
module.exports = __toCommonJS(stdin_exports);
const KEY_FAILURE_STATUSES = [
  "invalid_key",
  // 401, or Gemini's 400 API_KEY_INVALID
  "forbidden",
  // 403: billing off / API not enabled / key restricted
  "rate_limited",
  // 429: quota or rate limit on the household's key
  "upstream_error",
  // 5xx: the provider is down, not the key
  "timeout",
  // no answer in time
  "mint_failed",
  // a Live token could not be minted and no status was available
  "other"
  // anything else (including a 400 that is OUR malformed request)
];
const PILL_STATUSES = /* @__PURE__ */ new Set(["invalid_key", "forbidden", "rate_limited", "mint_failed"]);
function classifyKeyFailure(status, bodyText = "") {
  if (status === null) return "timeout";
  if (status === 401) return "invalid_key";
  if (status === 400) return /API_KEY_INVALID|API key not valid|pass a valid API key/i.test(bodyText) ? "invalid_key" : "other";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  if (status >= 500 && status <= 599) return "upstream_error";
  return "other";
}
const KEY_HEALTH_PROVIDER_RE = /^[a-z0-9_]{1,32}$/;
function isKeyFailureStatus(s) {
  return typeof s === "string" && KEY_FAILURE_STATUSES.includes(s);
}
