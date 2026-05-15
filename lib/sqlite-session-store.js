const fs = require('fs');
const path = require('path');
const util = require('util');
const { DatabaseSync } = require('node:sqlite');
const Store = require('express-session').Store;

const oneDay = 86400000;

/**
 * express-session store compatible with connect-sqlite3 schema (sessions.db):
 * table (sid PRIMARY KEY, expired, sess) — JSON session blob + expiry ms.
 * Uses node:sqlite (no native sqlite3 addon).
 */
function SqliteSessionStore(options) {
    Store.call(this);
    options = options || {};
    this.table = options.table || 'sessions';
    const dir = options.dir || require('./storage-paths').getSessionsDir();
    fs.mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dir, options.db || 'sessions.db');
    this.db = new DatabaseSync(dbPath);
    if (options.concurrentDB) {
        try {
            this.db.exec('PRAGMA journal_mode = WAL');
        } catch {
            /* ignore */
        }
    }
    this.db.exec(
        `CREATE TABLE IF NOT EXISTS ${this.table} (sid TEXT PRIMARY KEY, expired INTEGER NOT NULL, sess TEXT NOT NULL)`
    );

    this._cleanup = this._cleanup.bind(this);
    this._interval = setInterval(this._cleanup, oneDay);
    if (this._interval.unref) {
        this._interval.unref();
    }
    this._cleanup();
}

util.inherits(SqliteSessionStore, Store);

SqliteSessionStore.prototype._cleanup = function () {
    const now = Date.now();
    try {
        this.db.prepare(`DELETE FROM ${this.table} WHERE ? > expired`).run(now);
    } catch {
        /* ignore */
    }
};

SqliteSessionStore.prototype.get = function (sid, callback) {
    const now = Date.now();
    try {
        const row = this.db
            .prepare(`SELECT sess FROM ${this.table} WHERE sid = ? AND ? <= expired`)
            .get(sid, now);
        if (!row || row.sess == null) {
            callback();
            return;
        }
        callback(null, JSON.parse(row.sess));
    } catch (err) {
        callback(err);
    }
};

SqliteSessionStore.prototype.set = function (sid, sess, callback) {
    try {
        const maxAge = sess.cookie && sess.cookie.maxAge;
        const now = Date.now();
        const expired = maxAge != null ? now + maxAge : now + oneDay;
        const json = JSON.stringify(sess);
        this.db
            .prepare(`INSERT OR REPLACE INTO ${this.table} (sid, expired, sess) VALUES (?, ?, ?)`)
            .run(sid, expired, json);
        if (callback) {
            callback();
        }
    } catch (err) {
        if (callback) {
            callback(err);
        }
    }
};

SqliteSessionStore.prototype.destroy = function (sid, callback) {
    try {
        this.db.prepare(`DELETE FROM ${this.table} WHERE sid = ?`).run(sid);
        if (callback) {
            callback();
        }
    } catch (err) {
        if (callback) {
            callback(err);
        }
    }
};

SqliteSessionStore.prototype.touch = function (sid, session, callback) {
    if (session && session.cookie && session.cookie.expires) {
        const now = Date.now();
        const cookieExpires = new Date(session.cookie.expires).getTime();
        try {
            this.db
                .prepare(`UPDATE ${this.table} SET expired = ? WHERE sid = ? AND ? <= expired`)
                .run(cookieExpires, sid, now);
        } catch (err) {
            if (callback) {
                callback(err);
                return;
            }
        }
    }
    if (callback) {
        callback();
    }
};

module.exports = SqliteSessionStore;
