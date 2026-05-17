const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const util = require('util');
const Store = require('express-session').Store;

const oneDay = 86400000;

function packSession(sess) {
    try {
        return JSON.parse(JSON.stringify(sess));
    } catch {
        const out = {};
        for (const key of Object.keys(sess || {})) {
            const val = sess[key];
            if (typeof val !== 'function') {
                out[key] = val;
            }
        }
        return out;
    }
}

function sidFileName(sid) {
    return crypto.createHash('sha256').update(String(sid)).digest('hex') + '.json';
}

/**
 * File-based express-session store (no native modules, works on Node 18+).
 */
function FileSessionStore(options) {
    Store.call(this);
    options = options || {};
    this.dir = options.dir || require('./storage-paths').getSessionsDir();
    fs.mkdirSync(this.dir, { recursive: true });

    this._cleanup = this._cleanup.bind(this);
    this._interval = setInterval(this._cleanup, oneDay);
    if (this._interval.unref) {
        this._interval.unref();
    }
    this._cleanup();
}

util.inherits(FileSessionStore, Store);

FileSessionStore.prototype._path = function (sid) {
    return path.join(this.dir, sidFileName(sid));
};

FileSessionStore.prototype._cleanup = function () {
    const now = Date.now();
    let names;
    try {
        names = fs.readdirSync(this.dir);
    } catch {
        return;
    }
    for (const name of names) {
        if (!name.endsWith('.json')) {
            continue;
        }
        const fp = path.join(this.dir, name);
        try {
            const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
            if (raw && raw.expired != null && now > Number(raw.expired)) {
                fs.unlinkSync(fp);
            }
        } catch {
            try {
                fs.unlinkSync(fp);
            } catch {
                /* ignore */
            }
        }
    }
};

FileSessionStore.prototype.get = function (sid, callback) {
    const fp = this._path(sid);
    const now = Date.now();
    try {
        if (!fs.existsSync(fp)) {
            callback();
            return;
        }
        const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
        if (!raw || raw.expired == null || now > Number(raw.expired) || raw.sess == null) {
            try {
                fs.unlinkSync(fp);
            } catch {
                /* ignore */
            }
            callback();
            return;
        }
        callback(null, typeof raw.sess === 'string' ? JSON.parse(raw.sess) : raw.sess);
    } catch (err) {
        callback(err);
    }
};

FileSessionStore.prototype.set = function (sid, sess, callback) {
    const fp = this._path(sid);
    try {
        const maxAge = sess.cookie && sess.cookie.maxAge;
        const now = Date.now();
        const expired = maxAge != null ? now + maxAge : now + oneDay;
        const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ expired, sess: packSession(sess) }), 'utf8');
        fs.renameSync(tmp, fp);
        if (callback) {
            callback();
        }
    } catch (err) {
        if (callback) {
            callback(err);
        }
    }
};

FileSessionStore.prototype.destroy = function (sid, callback) {
    const fp = this._path(sid);
    try {
        if (fs.existsSync(fp)) {
            fs.unlinkSync(fp);
        }
        if (callback) {
            callback();
        }
    } catch (err) {
        if (callback) {
            callback(err);
        }
    }
};

FileSessionStore.prototype.touch = function (sid, session, callback) {
    if (session && session.cookie && session.cookie.expires) {
        const fp = this._path(sid);
        const cookieExpires = new Date(session.cookie.expires).getTime();
        try {
            if (fs.existsSync(fp)) {
                const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
                if (raw && raw.sess != null) {
                    raw.expired = cookieExpires;
                    const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
                    fs.writeFileSync(tmp, JSON.stringify(raw), 'utf8');
                    fs.renameSync(tmp, fp);
                }
            }
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

module.exports = FileSessionStore;
