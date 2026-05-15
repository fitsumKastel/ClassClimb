const fs = require('fs');
const path = require('path');

/**
 * Load `.env` from the application root (next to `server.js`).
 * Does not override variables already present in `process.env` (same default as dotenv).
 */
function loadEnvFromRoot() {
    const envPath = path.join(__dirname, '..', '.env');
    let raw;
    try {
        raw = fs.readFileSync(envPath, 'utf8');
    } catch {
        return;
    }

    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }
        const eq = trimmed.indexOf('=');
        if (eq <= 0) {
            continue;
        }
        let key = trimmed.slice(0, eq).trim();
        if (key.startsWith('export ')) {
            key = key.slice(7).trim();
        }
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            continue;
        }
        let val = trimmed.slice(eq + 1).trim();
        if (
            (val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))
        ) {
            val = val.slice(1, -1);
            val = val.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
        }
        if (process.env[key] === undefined) {
            process.env[key] = val;
        }
    }
}

module.exports = { loadEnvFromRoot };
