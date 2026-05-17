const path = require('path');
const { getSessionsDir } = require('./storage-paths');

function canUseNodeSqlite() {
    const m = process.version.match(/^v(\d+)\.(\d+)/);
    const major = m ? parseInt(m[1], 10) : 0;
    const minor = m ? parseInt(m[2], 10) : 0;
    if (major < 22 || (major === 22 && minor < 5)) {
        return false;
    }
    try {
        require('node:sqlite');
        return true;
    } catch {
        return false;
    }
}

/**
 * SQLite sessions when node:sqlite is available; otherwise JSON files (cPanel-friendly).
 */
function createSessionStore(options) {
    const opts = {
        db: 'sessions.db',
        dir: getSessionsDir(),
        concurrentDB: true,
        ...(options || {})
    };

    if (canUseNodeSqlite()) {
        try {
            const SqliteSessionStore = require('./sqlite-session-store');
            console.log('ClassClimb: session store = SQLite (' + path.join(opts.dir, opts.db) + ')');
            return new SqliteSessionStore(opts);
        } catch (err) {
            console.warn(
                'ClassClimb: SQLite session store failed, using files:',
                err && err.message ? err.message : err
            );
        }
    } else {
        console.log(
            'ClassClimb: session store = files (Node ' +
                process.version +
                '; use Node 22.5+ for SQLite sessions)'
        );
    }

    const FileSessionStore = require('./file-session-store');
    return new FileSessionStore({ dir: opts.dir });
}

module.exports = { createSessionStore, canUseNodeSqlite };
