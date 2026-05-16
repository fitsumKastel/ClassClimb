const { JsonStore } = require('./json-store');

function normSql(sql) {
    return String(sql || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toUpperCase();
}

/**
 * SQLite-compatible callback API backed by JsonStore.
 */
function createJsonDbAdapter(store) {
    const db = {};

    db.get = function (sql, params, callback) {
        if (typeof params === 'function') {
            callback = params;
            params = [];
        }
        try {
            const row = executeGet(store, normSql(sql), params || []);
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
            const rows = executeAll(store, normSql(sql), params || []);
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
            const result = executeRun(store, normSql(sql), params || []);
            const ctx = { lastID: result.lastID, changes: result.changes };
            if (typeof callback === 'function') {
                callback.call(ctx, null);
            }
        } catch (err) {
            if (typeof callback === 'function') {
                callback.call({}, err);
            }
        }
    };

    db.prepare = function (sql) {
        const n = normSql(sql);
        return {
            run(...args) {
                executeRun(store, n, args);
            },
            finalize(cb) {
                if (typeof cb === 'function') {
                    setImmediate(() => cb(null));
                }
            }
        };
    };

    db.getSetting = function (key) {
        return Promise.resolve(store.getSetting(key));
    };

    db.setSetting = function (key, value) {
        return Promise.resolve(store.setSetting(key, value));
    };

    return db;
}

function executeGet(store, sql, params) {
    if (sql.startsWith('SELECT COUNT(*) AS N FROM CLASSES WHERE TEACHER_ID = ?')) {
        return { n: store.countClassesByTeacher(params[0]) };
    }
    if (sql.startsWith('SELECT COUNT(*) AS N FROM SUBSCRIPTIONS WHERE TELEGRAM_ID = ?')) {
        return { n: store.countSubscriptionsByTelegram(params[0]) };
    }
    if (sql.startsWith('SELECT * FROM CLASSES WHERE VIEW_ID = ?')) {
        return store.getClassByViewId(params[0]);
    }
    if (sql.startsWith('SELECT * FROM CLASSES WHERE ID = ?')) {
        return store.getClassById(params[0]);
    }
    if (sql.startsWith('SELECT ID, VIEW_ID FROM CLASSES WHERE ID = ?')) {
        const r = store.getClassById(params[0]);
        return r ? { id: r.id, view_id: r.view_id } : undefined;
    }
    if (sql.startsWith('SELECT ID, VIEW_ID FROM CLASSES WHERE VIEW_ID = ?')) {
        const r = store.getClassByViewId(params[0]);
        return r ? { id: r.id, view_id: r.view_id } : undefined;
    }
    if (sql.startsWith('SELECT ID, TEACHER_ID FROM CLASSES WHERE VIEW_ID = ?')) {
        const r = store.getClassByViewId(params[0]);
        return r ? { id: r.id, teacher_id: r.teacher_id } : undefined;
    }
    if (sql.startsWith('SELECT TEACHER_ID FROM CLASSES WHERE ID = ?')) {
        const r = store.getClassById(params[0]);
        return r ? { teacher_id: r.teacher_id } : undefined;
    }
    if (sql.startsWith('SELECT CLASS_NAME, SCHOOL_NAME FROM CLASSES WHERE ID = ?')) {
        const r = store.getClassById(params[0]);
        return r ? { class_name: r.class_name, school_name: r.school_name } : undefined;
    }
    if (sql.startsWith('SELECT ID FROM CLASSES WHERE ID = ?')) {
        const r = store.getClassById(params[0]);
        return r ? { id: r.id } : undefined;
    }
    if (sql.startsWith('SELECT ID FROM CLASSES WHERE VIEW_ID = ?')) {
        const r = store.getClassByViewId(params[0]);
        return r ? { id: r.id } : undefined;
    }
    if (sql.startsWith('SELECT 1 AS OK FROM SUBSCRIPTIONS WHERE CLASS_ID = ? AND LINK_ID = ?')) {
        return store.hasSubscription(params[0], params[1]) ? { ok: 1 } : undefined;
    }
    if (
        sql.includes('FROM STUDENTS S JOIN CLASSES C ON C.ID = S.CLASS_ID WHERE S.ID = ?')
    ) {
        return store.getStudentWithClass(params[0]);
    }
    throw new Error(`json-db get not implemented: ${sql.slice(0, 80)}`);
}

function executeAll(store, sql, params) {
    if (sql.startsWith('SELECT * FROM STUDENTS WHERE CLASS_ID = ?')) {
        const order = sql.includes('ORDER BY XP DESC') ? 'xp' : 'name';
        return store.listStudentsByClass(params[0], order);
    }
    if (
        sql.startsWith(
            'SELECT * FROM CLASSES WHERE TEACHER_ID = ? ORDER BY ID DESC LIMIT ? OFFSET ?'
        )
    ) {
        return store.listClassesByTeacher(params[0], { limit: params[1], offset: params[2] });
    }
    if (sql.includes('FROM SUBSCRIPTIONS S INNER JOIN CLASSES C ON C.ID = S.CLASS_ID')) {
        return store.listBoardsForTelegram(params[0]);
    }
    if (sql.startsWith('SELECT S.TELEGRAM_ID, S.LINK_ID, S.CLASS_ID, C.CLASS_NAME, C.SCHOOL_NAME')) {
        return store.statusSnapshot().subRows;
    }
    if (sql.includes('COUNT(ST.ID) AS TOTAL_STUDENTS')) {
        return store.statusSnapshot().classRows;
    }
    if (sql.startsWith('SELECT DISTINCT LINK_ID FROM SUBSCRIPTIONS WHERE CLASS_ID = ?')) {
        return store.distinctLinkIdsForClass(params[0]);
    }
    throw new Error(`json-db all not implemented: ${sql.slice(0, 80)}`);
}

function executeRun(store, sql, params) {
    if (sql.startsWith('INSERT INTO CLASSES (TEACHER_ID, CLASS_NAME, SCHOOL_NAME, VIEW_ID)')) {
        const r = store.insertClass({
            teacher_id: params[0],
            class_name: params[1],
            school_name: params[2],
            view_id: params[3]
        });
        return { lastID: r.lastID, changes: 1 };
    }
    if (sql.startsWith('INSERT INTO STUDENTS (CLASS_ID, NAME)')) {
        const r = store.insertStudent(params[0], params[1]);
        return { lastID: r.lastID, changes: 1 };
    }
    if (sql.startsWith('UPDATE STUDENTS SET XP = XP + ? WHERE ID = ?')) {
        const r = store.updateStudentXp(params[1], params[0]);
        return { lastID: null, changes: r.changes };
    }
    if (sql.startsWith('UPDATE STUDENTS SET NAME = ? WHERE ID = ?')) {
        const r = store.updateStudentName(params[1], params[0]);
        return { lastID: null, changes: r.changes };
    }
    if (sql.startsWith('DELETE FROM STUDENTS WHERE CLASS_ID = ?')) {
        store.deleteStudentsByClassId(params[0]);
        return { lastID: null, changes: 1 };
    }
    if (sql.startsWith('DELETE FROM SUBSCRIPTIONS WHERE CLASS_ID = ?')) {
        const r = store.deleteSubscriptionsByClassId(params[0]);
        return { lastID: null, changes: r.changes };
    }
    if (sql.startsWith('DELETE FROM CLASSES WHERE ID = ?')) {
        store.deleteClass(params[0]);
        return { lastID: null, changes: 1 };
    }
    if (sql.startsWith('DELETE FROM STUDENTS WHERE ID = ?')) {
        const r = store.deleteStudent(params[0]);
        return { lastID: null, changes: r.changes };
    }
    if (sql.startsWith('INSERT OR IGNORE INTO SUBSCRIPTIONS (LINK_ID, TELEGRAM_ID, CLASS_ID)')) {
        const r = store.insertSubscriptionIgnore({
            link_id: params[0],
            telegram_id: params[1],
            class_id: params[2]
        });
        return { lastID: r.lastID, changes: r.changes };
    }
    if (sql.startsWith('DELETE FROM SUBSCRIPTIONS WHERE CLASS_ID = ? AND LINK_ID = ?')) {
        const r = store.deleteSubscriptionsByClassAndLink(params[0], params[1]);
        return { lastID: null, changes: r.changes };
    }
    if (sql.startsWith('DELETE FROM SUBSCRIPTIONS WHERE TELEGRAM_ID = ? AND CLASS_ID = ?')) {
        const r = store.deleteSubscriptionsByTelegramAndClass(params[0], params[1]);
        return { lastID: null, changes: r.changes };
    }
    throw new Error(`json-db run not implemented: ${sql.slice(0, 80)}`);
}

module.exports = { createJsonDbAdapter, JsonStore };
