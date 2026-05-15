const { DatabaseSync } = require('node:sqlite');
const { getDatabasePath, initStorage } = require('./storage-paths');

initStorage();
const dbPath = getDatabasePath();
const rawDb = new DatabaseSync(dbPath);

rawDb.exec(`
CREATE TABLE IF NOT EXISTS classes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id TEXT,
    class_name TEXT,
    school_name TEXT,
    view_id TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    class_id INTEGER,
    name TEXT,
    xp INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT,
    class_id INTEGER,
    link_id TEXT
);
CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`);

try {
    const cols = rawDb.prepare('PRAGMA table_info(subscriptions)').all();
    const hasLinkId = Array.isArray(cols) && cols.some((c) => c.name === 'link_id');
    if (!hasLinkId) {
        rawDb.exec('ALTER TABLE subscriptions ADD COLUMN link_id TEXT');
    }
} catch {
    /* ignore migration errors */
}

try {
    rawDb.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_class_link ON subscriptions(class_id, link_id)'
    );
} catch {
    /* ignore */
}

(function migrateClassPdfColumns() {
    try {
        const cols = rawDb.prepare('PRAGMA table_info(classes)').all();
        const names = new Set((cols || []).map((c) => c.name));
        const add = (sql) => rawDb.exec(sql);
        if (!names.has('class_pdf_num_pages')) {
            add('ALTER TABLE classes ADD COLUMN class_pdf_num_pages INTEGER');
        }
        if (!names.has('class_pdf_rev')) {
            add('ALTER TABLE classes ADD COLUMN class_pdf_rev INTEGER NOT NULL DEFAULT 0');
        }
        if (!names.has('pdf_follow_active')) {
            add('ALTER TABLE classes ADD COLUMN pdf_follow_active INTEGER NOT NULL DEFAULT 0');
        }
        if (!names.has('pdf_follow_page')) {
            add('ALTER TABLE classes ADD COLUMN pdf_follow_page INTEGER NOT NULL DEFAULT 1');
        }
    } catch {
        /* ignore */
    }
})();

const db = {};

function getSetting(key) {
    return new Promise((resolve, reject) => {
        try {
            const row = rawDb.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
            resolve(row ? String(row.value) : '');
        } catch (err) {
            reject(err);
        }
    });
}

function setSetting(key, value) {
    return new Promise((resolve, reject) => {
        try {
            rawDb
                .prepare(
                    `INSERT INTO app_settings (key, value) VALUES (?, ?)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
                )
                .run(key, value);
            resolve();
        } catch (err) {
            reject(err);
        }
    });
}

db.get = function (sql, params, callback) {
    if (typeof params === 'function') {
        callback = params;
        params = [];
    }
    try {
        const row = rawDb.prepare(sql).get(...params);
        callback(null, row);
    } catch (err) {
        callback(err);
    }
};

db.all = function (sql, params, callback) {
    if (typeof params === 'function') {
        callback = params;
        params = [];
    }
    try {
        const rows = rawDb.prepare(sql).all(...params);
        callback(null, rows);
    } catch (err) {
        callback(err);
    }
};

db.run = function (sql, params, callback) {
    if (typeof params === 'function') {
        callback = params;
        params = [];
    }
    try {
        const result = rawDb.prepare(sql).run(...params);
        const lastID = Number(result.lastInsertRowid);
        const context = { lastID, changes: result.changes };
        if (typeof callback === 'function') {
            callback.call(context, null);
        }
    } catch (err) {
        if (typeof callback === 'function') {
            callback.call({}, err);
        }
    }
};

db.prepare = function (sql) {
    const stmt = rawDb.prepare(sql);
    return {
        run(...args) {
            return stmt.run(...args);
        },
        finalize(cb) {
            if (typeof cb === 'function') {
                setImmediate(() => cb(null));
            }
        }
    };
};

db.getSetting = getSetting;
db.setSetting = setSetting;

module.exports = db;
