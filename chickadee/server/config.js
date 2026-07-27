// config.js — runtime configuration: data paths + Chickadee Cloud environment.
//
// ONE account system (by design — see the open-core plan): Chickadee Cloud IS
// the same Supabase backend Dashie uses; a Chickadee-cloud account is a sparse
// Dashie account (profile + credits, no family rows). The anon keys below are
// public-by-design (browser-shipped).

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = fs.existsSync('/data') && fs.statSync('/data').isDirectory()
    ? '/data'
    : path.resolve(__dirname, '..', 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* exists */ }

const ENVIRONMENTS = {
    development: {
        url: 'https://cwglbtosingboqepsmjk.supabase.co',
        anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN3Z2xidG9zaW5nYm9xZXBzbWprIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc2NDY4NjYsImV4cCI6MjA3MzIyMjg2Nn0.VCP5DSfAwwZMjtPl33bhsixSiu_lHsM6n42FMJRP3YA',
        verificationBase: 'https://dev.dashieapp.com',
    },
    production: {
        url: 'https://cseaywxcvnxcsypaqaid.supabase.co',
        anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNzZWF5d3hjdm54Y3N5cGFxYWlkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc2MDIxOTEsImV4cCI6MjA3MzE3ODE5MX0.Wnd7XELrtPIDKeTcHVw7dl3awn3BlI0z9ADKPgSfHhA',
        verificationBase: 'https://app.dashieapp.com',
    },
};

// Environment comes from the add-on option (Configuration tab), read once at
// process start — changing it requires an add-on restart, which is the natural
// moment anyway (credentials are per-environment).
let envName = 'development';
try {
    const opts = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'options.json'), 'utf8'));
    if (opts.cloud_env === 'production') envName = 'production';
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
