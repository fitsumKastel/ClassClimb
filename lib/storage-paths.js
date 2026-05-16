const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');

/** Human-readable default folder next to the app (not synced with the repo). */
const DEFAULT_STORAGE_FOLDER_NAME = 'ClassClimb Storage';

/**
 * All durable app files live outside the synced app tree by default:
 *   <parent-of-app>/ClassClimb Storage/data/       — JSON document store
 *   <parent-of-app>/ClassClimb Storage/sessions/   — express-session SQLite
 *
 * Override with absolute path: CLASSCLIMB_STORAGE_ROOT=/path/to/private-root
 */
function getStorageRoot() {
    const raw = (process.env.CLASSCLIMB_STORAGE_ROOT || '').trim();
    if (raw) {
        return path.resolve(raw);
    }
    return path.resolve(projectRoot, '..', DEFAULT_STORAGE_FOLDER_NAME);
}

function getDataDir() {
    return path.join(getStorageRoot(), 'data');
}

function getSessionsDir() {
    return path.join(getStorageRoot(), 'sessions');
}

/** Create storage layout on startup. */
function initStorage() {
    fs.mkdirSync(getDataDir(), { recursive: true });
    fs.mkdirSync(getSessionsDir(), { recursive: true });
}

module.exports = {
    getStorageRoot,
    getDataDir,
    getSessionsDir,
    initStorage
};
