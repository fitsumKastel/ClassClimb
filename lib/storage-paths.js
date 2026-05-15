const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');

/** Human-readable default folder next to the app (not synced with the repo). */
const DEFAULT_STORAGE_FOLDER_NAME = 'ClassClimb Storage';

/** Previous default name; still migrated from if present. */
const LEGACY_DEFAULT_STORAGE_FOLDER = 'class-climb-private';

/**
 * All durable app files live outside the synced app tree by default:
 *   <parent-of-app>/ClassClimb Storage/database/classclimb.db
 *   <parent-of-app>/ClassClimb Storage/sessions/sessions.db
 *   <parent-of-app>/ClassClimb Storage/class-materials/*.pdf
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

function getDatabaseDir() {
    return path.join(getStorageRoot(), 'database');
}

function getDatabasePath() {
    return path.join(getDatabaseDir(), 'classclimb.db');
}

function getSessionsDir() {
    return path.join(getStorageRoot(), 'sessions');
}

function getClassMaterialsDir() {
    return path.join(getStorageRoot(), 'class-materials');
}

function copyFileIfMissing(src, dest) {
    if (!fs.existsSync(src) || fs.existsSync(dest)) {
        return;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
}

function migrateFromOldDefaultFolderName() {
    const oldRoot = path.resolve(projectRoot, '..', LEGACY_DEFAULT_STORAGE_FOLDER);
    if (!fs.existsSync(oldRoot)) {
        return;
    }
    copyFileIfMissing(path.join(oldRoot, 'database', 'classclimb.db'), getDatabasePath());
    copyFileIfMissing(path.join(oldRoot, 'sessions', 'sessions.db'), path.join(getSessionsDir(), 'sessions.db'));

    const oldMat = path.join(oldRoot, 'class-materials');
    const destMat = getClassMaterialsDir();
    if (!fs.existsSync(oldMat)) {
        return;
    }
    fs.mkdirSync(destMat, { recursive: true });
    let names;
    try {
        names = fs.readdirSync(oldMat);
    } catch {
        return;
    }
    for (const name of names) {
        const from = path.join(oldMat, name);
        const to = path.join(destMat, name);
        try {
            if (!fs.existsSync(to) && fs.statSync(from).isFile()) {
                fs.copyFileSync(from, to);
            }
        } catch {
            /* ignore per-file */
        }
    }
}

/** Create storage layout; copy from old default folder name if present and new files are missing. */
function initStorage() {
    fs.mkdirSync(getDatabaseDir(), { recursive: true });
    fs.mkdirSync(getSessionsDir(), { recursive: true });
    fs.mkdirSync(getClassMaterialsDir(), { recursive: true });
    migrateFromOldDefaultFolderName();
}

module.exports = {
    getStorageRoot,
    getDatabaseDir,
    getDatabasePath,
    getSessionsDir,
    getClassMaterialsDir,
    initStorage
};
