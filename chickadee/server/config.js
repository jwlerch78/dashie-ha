// SPDX-License-Identifier: AGPL-3.0-only
// config.js — runtime configuration: data paths + Chickadee Cloud environment.
//
// Chickadee Cloud accounts are hosted on the same backend that powers Dashie
// (one shared account system, by design — the relationship is documented in
// PROVENANCE.md and disclosed on the console's sign-in footer). The anon keys
// below are public-by-design (the browser-shipped Supabase anon role; RLS and
// edge-function auth enforce access, not key secrecy).

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = fs.existsSync('/data') && fs.statSync('/data').isDirectory()
    ? '/data'
    : path.resolve(__dirname, '..', 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* exists */ }

// `beta` is the environment Chickadee Cloud beta accounts run on (disclosed in
// DOCS.md); `stable` is the production backend, which Chickadee accounts will
// move to when the beta ends. `development`/`production` are accepted as
// legacy aliases from pre-0.9 installs.
const ENVIRONMENTS = {
    // verificationBase is now Chickadee's own first-party origin for BOTH
    // channels (single origin per the getchickadee site plan). The auth pages
    // there select their Supabase env from ?env= on the URL — auth.js appends
    // `&env=${CLOUD_ENV}` (beta→staging, stable→prod), so one origin serves
    // both channels. Old add-ons still point at dashieapp.com and keep working.
    beta: {
        url: 'https://cwglbtosingboqepsmjk.supabase.co',
        anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN3Z2xidG9zaW5nYm9xZXBzbWprIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc2NDY4NjYsImV4cCI6MjA3MzIyMjg2Nn0.VCP5DSfAwwZMjtPl33bhsixSiu_lHsM6n42FMJRP3YA',
        verificationBase: 'https://getchickadee.org',
    },
    stable: {
        url: 'https://cseaywxcvnxcsypaqaid.supabase.co',
        anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNzZWF5d3hjdm54Y3N5cGFxYWlkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc2MDIxOTEsImV4cCI6MjA3MzE3ODE5MX0.Wnd7XELrtPIDKeTcHVw7dl3awn3BlI0z9ADKPgSfHhA',
        verificationBase: 'https://getchickadee.org',
    },
};
const ENV_ALIASES = { development: 'beta', production: 'stable' };

// Environment comes from the add-on option (Configuration tab), read once at
// process start — changing it requires an add-on restart, which is the natural
// moment anyway (credentials are per-environment).
let envName = 'beta';
try {
    const opts = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'options.json'), 'utf8'));
    const requested = ENV_ALIASES[opts.cloud_env] || opts.cloud_env;
    if (ENVIRONMENTS[requested]) envName = requested;
} catch { /* defaults */ }

// Add-on version — single source is package.json (bumped by scripts/release.sh
// together with config.yaml, so /api/ping can't go stale again).
let version = '0.0.0';
try { version = require('../package.json').version; } catch { /* dev tree */ }

module.exports = {
    DATA_DIR,
    CLOUD_ENV: envName,
    CLOUD: ENVIRONMENTS[envName],
    JWT_FILE: path.join(DATA_DIR, 'chickadee_auth.json'),
    // The vendored Chickadee console SPA (scripts/sync-console.sh).
    FRONTEND_DIR: path.resolve(__dirname, '..', 'frontend', 'console'),
    PORT: parseInt(process.env.INGRESS_PORT || process.env.PORT || '8099', 10),
    VERSION: version,
};
