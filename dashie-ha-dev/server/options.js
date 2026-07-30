// SPDX-License-Identifier: AGPL-3.0-only
// Add-on options — HAOS writes the Configuration tab values to /data/options.json.
// Read fresh on each use (cheap) so config changes only need an add-on restart,
// never an image rebuild.

'use strict';

const fs = require('fs');

const OPTIONS_FILE = '/data/options.json';

function readOptions() {
    try {
        return JSON.parse(fs.readFileSync(OPTIONS_FILE, 'utf8')) || {};
    } catch {
        return {};
    }
}

module.exports = { readOptions };
