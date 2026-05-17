const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');

/** Human-readable default folder next to the app (not synced with the repo). */
const DEFAULT_STORAGE_FOLDER_NAME = 'ClassClimb Storage';
const IN_APP_STORAGE_DIR = path.join(projectRoot, '.classclimb-data');

function canWriteDir(dir) {
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.accessSync(dir, fs.constants.W_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * Durable files: data/ (JSON store) and sessions/ (express-session).
 * Override with CLASSCLIMB_STORAGE_ROOT. If the parent folder is not writable
 * (common on cPanel), falls back to .classclimb-data inside the app tree.
 */
function getStorageRoot() {
    const raw = (process.env.CLASSCLIMB_STORAGE_ROOT || '').trim();
    if (raw) {
        return path.resolve(raw);
    }
    const outside = path.resolve(projectRoot, '..', DEFAULT_STORAGE_FOLDER_NAME);
    if (canWriteDir(outside)) {
        return outside;
    }
    if (canWriteDir(IN_APP_STORAGE_DIR)) {
        console.warn(
            'ClassClimb: using in-app storage at',
            IN_APP_STORAGE_DIR,
            '(set CLASSCLIMB_STORAGE_ROOT for a custom path)'
        );
        return IN_APP_STORAGE_DIR;
    }
    return outside;
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
