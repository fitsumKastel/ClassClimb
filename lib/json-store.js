const fs = require('fs');
const path = require('path');
const { getDataDir, initStorage } = require('./storage-paths');

const COLLECTION_FILES = {
    classes: 'classes.json',
    subscriptions: 'subscriptions.json',
    app_settings: 'app_settings.json',
    meta: '_meta.json'
};

/**
 * Document storage with separate JSON files per collection (MongoDB-style).
 * Students are stored per class in students/{classId}.json so large rosters
 * do not load into one giant file.
 */
class JsonStore {
    constructor(rootDir) {
        this.rootDir = rootDir;
        this.studentsDir = path.join(rootDir, 'students');
        this._fileLocks = Object.create(null);
        fs.mkdirSync(this.studentsDir, { recursive: true });
        this._ensureCollections();
    }

    static open() {
        initStorage();
        return new JsonStore(getDataDir());
    }

    _ensureCollections() {
        if (!fs.existsSync(this.rootDir)) {
            fs.mkdirSync(this.rootDir, { recursive: true });
        }
        if (!fs.existsSync(this.studentsDir)) {
            fs.mkdirSync(this.studentsDir, { recursive: true });
        }
        for (const file of Object.values(COLLECTION_FILES)) {
            const fp = path.join(this.rootDir, file);
            if (!fs.existsSync(fp)) {
                this._writeJson(fp, file === 'app_settings.json' ? {} : []);
            }
        }
        const meta = this._readJson(path.join(this.rootDir, COLLECTION_FILES.meta));
        if (!meta.counters) {
            meta.counters = { classes: 0, students: 0, subscriptions: 0 };
            this._writeJson(path.join(this.rootDir, COLLECTION_FILES.meta), meta);
        }
    }

    _lock(filePath, fn) {
        while (this._fileLocks[filePath]) {
            /* spin — single-threaded Node; concurrent requests queue on event loop */
        }
        this._fileLocks[filePath] = true;
        try {
            return fn();
        } finally {
            delete this._fileLocks[filePath];
        }
    }

    _readJson(filePath, fallback) {
        if (!fs.existsSync(filePath)) {
            return fallback !== undefined ? fallback : null;
        }
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch {
            return fallback !== undefined ? fallback : null;
        }
    }

    _writeJson(filePath, data) {
        const dir = path.dirname(filePath);
        fs.mkdirSync(dir, { recursive: true });
        const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(tmp, filePath);
    }

    _collectionPath(name) {
        const file = COLLECTION_FILES[name];
        if (!file) {
            throw new Error(`Unknown collection: ${name}`);
        }
        return path.join(this.rootDir, file);
    }

    _studentsPath(classId) {
        return path.join(this.studentsDir, `${Number(classId)}.json`);
    }

    _readMeta() {
        return this._readJson(this._collectionPath('meta'), { counters: { classes: 0, students: 0, subscriptions: 0 } });
    }

    _writeMeta(meta) {
        this._writeJson(this._collectionPath('meta'), meta);
    }

    _nextId(counterName) {
        return this._lock(this._collectionPath('meta'), () => {
            const meta = this._readMeta();
            const next = (Number(meta.counters[counterName]) || 0) + 1;
            meta.counters[counterName] = next;
            this._writeMeta(meta);
            return next;
        });
    }

    _readCollection(name) {
        const fp = this._collectionPath(name);
        return this._lock(fp, () => {
            const data = this._readJson(fp, name === 'app_settings' ? {} : []);
            if (name === 'app_settings') {
                return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
            }
            return Array.isArray(data) ? data : [];
        });
    }

    _writeCollection(name, data) {
        const fp = this._collectionPath(name);
        this._lock(fp, () => {
            this._writeJson(fp, data);
        });
    }

    _readStudentIndex() {
        const fp = path.join(this.studentsDir, '_index.json');
        return this._lock(fp, () => this._readJson(fp, {}));
    }

    _writeStudentIndex(index) {
        const fp = path.join(this.studentsDir, '_index.json');
        this._lock(fp, () => this._writeJson(fp, index));
    }

    _setStudentClass(studentId, classId) {
        const index = this._readStudentIndex();
        index[String(studentId)] = Number(classId);
        this._writeStudentIndex(index);
    }

    _removeStudentFromIndex(studentId) {
        const index = this._readStudentIndex();
        delete index[String(studentId)];
        this._writeStudentIndex(index);
    }

    _readStudentsFile(classId) {
        const fp = this._studentsPath(classId);
        return this._lock(fp, () => {
            const rows = this._readJson(fp, []);
            return Array.isArray(rows) ? rows : [];
        });
    }

    _writeStudentsFile(classId, rows) {
        const fp = this._studentsPath(classId);
        this._lock(fp, () => {
            if (!rows.length) {
                if (fs.existsSync(fp)) {
                    fs.unlinkSync(fp);
                }
                return;
            }
            this._writeJson(fp, rows);
        });
    }

    // --- Settings ---

    getSetting(key) {
        const settings = this._readCollection('app_settings');
        return settings[key] != null ? String(settings[key]) : '';
    }

    setSetting(key, value) {
        const settings = this._readCollection('app_settings');
        settings[key] = value;
        this._writeCollection('app_settings', settings);
    }

    // --- Classes ---

    getClassById(id) {
        const rows = this._readCollection('classes');
        return rows.find((r) => Number(r.id) === Number(id)) || null;
    }

    getClassByViewId(viewId) {
        const rows = this._readCollection('classes');
        return rows.find((r) => String(r.view_id) === String(viewId)) || null;
    }

    listClassesByTeacher(teacherId, { limit, offset } = {}) {
        let rows = this._readCollection('classes').filter(
            (r) => String(r.teacher_id) === String(teacherId)
        );
        rows.sort((a, b) => Number(b.id) - Number(a.id));
        const off = Number(offset) || 0;
        const lim = limit != null ? Number(limit) : rows.length;
        return rows.slice(off, off + lim);
    }

    countClassesByTeacher(teacherId) {
        return this._readCollection('classes').filter((r) => String(r.teacher_id) === String(teacherId))
            .length;
    }

    insertClass({ teacher_id, class_name, school_name, view_id }) {
        const id = this._nextId('classes');
        const row = {
            id,
            teacher_id,
            class_name,
            school_name,
            view_id
        };
        const rows = this._readCollection('classes');
        rows.push(row);
        this._writeCollection('classes', rows);
        return { lastID: id, row };
    }

    deleteClass(id) {
        const cid = Number(id);
        const rows = this._readCollection('classes').filter((r) => Number(r.id) !== cid);
        this._writeCollection('classes', rows);
        this.deleteStudentsByClassId(cid);
        const subs = this._readCollection('subscriptions').filter((r) => Number(r.class_id) !== cid);
        this._writeCollection('subscriptions', subs);
    }

    listAllClasses() {
        return this._readCollection('classes').slice();
    }

    // --- Students ---

    listStudentsByClass(classId, order = 'name') {
        const rows = this._readStudentsFile(classId).map((r) => ({ ...r, class_id: Number(classId) }));
        if (order === 'xp') {
            rows.sort((a, b) => {
                const xp = Number(b.xp) - Number(a.xp);
                if (xp !== 0) return xp;
                return Number(a.id) - Number(b.id);
            });
        } else {
            rows.sort((a, b) => {
                const na = String(a.name || '');
                const nb = String(b.name || '');
                const cmp = na.localeCompare(nb, undefined, { sensitivity: 'base' });
                if (cmp !== 0) return cmp;
                return Number(a.id) - Number(b.id);
            });
        }
        return rows;
    }

    getStudentById(studentId) {
        const index = this._readStudentIndex();
        const classId = index[String(studentId)];
        if (classId == null) {
            return null;
        }
        const rows = this._readStudentsFile(classId);
        const row = rows.find((r) => Number(r.id) === Number(studentId));
        if (!row) {
            return null;
        }
        return { ...row, class_id: Number(classId) };
    }

    getStudentWithClass(studentId) {
        const student = this.getStudentById(studentId);
        if (!student) {
            return null;
        }
        const cls = this.getClassById(student.class_id);
        if (!cls) {
            return null;
        }
        return {
            teacher_id: cls.teacher_id,
            class_id: cls.id
        };
    }

    insertStudent(classId, name) {
        const cid = Number(classId);
        const id = this._nextId('students');
        const row = { id, name, xp: 0 };
        const rows = this._readStudentsFile(cid);
        rows.push(row);
        this._writeStudentsFile(cid, rows);
        this._setStudentClass(id, cid);
        return { lastID: id, row: { ...row, class_id: cid } };
    }

    updateStudentXp(studentId, delta) {
        const student = this.getStudentById(studentId);
        if (!student) {
            return { changes: 0 };
        }
        const rows = this._readStudentsFile(student.class_id);
        const idx = rows.findIndex((r) => Number(r.id) === Number(studentId));
        if (idx === -1) {
            return { changes: 0 };
        }
        rows[idx].xp = (Number(rows[idx].xp) || 0) + Number(delta);
        this._writeStudentsFile(student.class_id, rows);
        return { changes: 1 };
    }

    updateStudentName(studentId, name) {
        const student = this.getStudentById(studentId);
        if (!student) {
            return { changes: 0 };
        }
        const rows = this._readStudentsFile(student.class_id);
        const idx = rows.findIndex((r) => Number(r.id) === Number(studentId));
        if (idx === -1) {
            return { changes: 0 };
        }
        rows[idx].name = name;
        this._writeStudentsFile(student.class_id, rows);
        return { changes: 1 };
    }

    deleteStudent(studentId) {
        const student = this.getStudentById(studentId);
        if (!student) {
            return { changes: 0 };
        }
        const rows = this._readStudentsFile(student.class_id).filter(
            (r) => Number(r.id) !== Number(studentId)
        );
        this._writeStudentsFile(student.class_id, rows);
        this._removeStudentFromIndex(studentId);
        return { changes: 1 };
    }

    deleteStudentsByClassId(classId) {
        const cid = Number(classId);
        const rows = this._readStudentsFile(cid);
        for (const r of rows) {
            this._removeStudentFromIndex(r.id);
        }
        const fp = this._studentsPath(cid);
        if (fs.existsSync(fp)) {
            fs.unlinkSync(fp);
        }
    }

    countStudentsByClass(classId) {
        return this._readStudentsFile(classId).length;
    }

    // --- Subscriptions ---

    listSubscriptions() {
        return this._readCollection('subscriptions').slice();
    }

    listBoardsForTelegram(telegramId) {
        const classes = this._readCollection('classes');
        const byId = new Map(classes.map((c) => [Number(c.id), c]));
        const subs = this._readCollection('subscriptions').filter(
            (s) => String(s.telegram_id) === String(telegramId)
        );
        const seen = new Set();
        const out = [];
        for (const s of subs) {
            const cid = Number(s.class_id);
            if (seen.has(cid)) continue;
            seen.add(cid);
            const c = byId.get(cid);
            if (c) {
                out.push({
                    id: c.id,
                    view_id: c.view_id,
                    class_name: c.class_name,
                    school_name: c.school_name
                });
            }
        }
        out.sort((a, b) => {
            const cmp = String(a.class_name || '').localeCompare(String(b.class_name || ''), undefined, {
                sensitivity: 'base'
            });
            if (cmp !== 0) return cmp;
            return Number(a.id) - Number(b.id);
        });
        return out;
    }

    insertSubscriptionIgnore({ link_id, telegram_id, class_id }) {
        const rows = this._readCollection('subscriptions');
        const dupLink = rows.some(
            (r) => Number(r.class_id) === Number(class_id) && String(r.link_id) === String(link_id)
        );
        if (dupLink) {
            return { changes: 0, lastID: null };
        }
        const id = this._nextId('subscriptions');
        rows.push({
            id,
            link_id,
            telegram_id,
            class_id: Number(class_id)
        });
        this._writeCollection('subscriptions', rows);
        return { changes: 1, lastID: id };
    }

    hasSubscription(classId, linkId) {
        return this._readCollection('subscriptions').some(
            (r) => Number(r.class_id) === Number(classId) && String(r.link_id) === String(linkId)
        );
    }

    deleteSubscriptionsByClassAndLink(classId, linkId) {
        const rows = this._readCollection('subscriptions').filter(
            (r) => !(Number(r.class_id) === Number(classId) && String(r.link_id) === String(linkId))
        );
        const changes = this._readCollection('subscriptions').length - rows.length;
        this._writeCollection('subscriptions', rows);
        return { changes };
    }

    deleteSubscriptionsByClassId(classId) {
        const before = this._readCollection('subscriptions');
        const rows = before.filter((r) => Number(r.class_id) !== Number(classId));
        this._writeCollection('subscriptions', rows);
        return { changes: before.length - rows.length };
    }

    deleteSubscriptionsByTelegramAndClass(telegramId, classId) {
        const before = this._readCollection('subscriptions');
        const rows = before.filter(
            (r) =>
                !(
                    String(r.telegram_id) === String(telegramId) &&
                    Number(r.class_id) === Number(classId)
                )
        );
        this._writeCollection('subscriptions', rows);
        return { changes: before.length - rows.length };
    }

    distinctLinkIdsForClass(classId) {
        const set = new Set();
        for (const r of this._readCollection('subscriptions')) {
            if (Number(r.class_id) !== Number(classId)) continue;
            const lid = r.link_id != null ? String(r.link_id).trim() : '';
            if (lid) set.add(lid);
        }
        return [...set].map((link_id) => ({ link_id }));
    }

    statusSnapshot() {
        const classes = this.listAllClasses();
        const subs = this.listSubscriptions();
        const classRows = classes
            .map((c) => ({
                id: c.id,
                class_name: c.class_name,
                school_name: c.school_name,
                total_students: this.countStudentsByClass(c.id)
            }))
            .sort((a, b) =>
                String(a.class_name || '').localeCompare(String(b.class_name || ''), undefined, {
                    sensitivity: 'base'
                })
            );

        const subRows = subs
            .map((s) => {
                const c = classes.find((x) => Number(x.id) === Number(s.class_id));
                return {
                    telegram_id: s.telegram_id,
                    link_id: s.link_id,
                    class_id: s.class_id,
                    class_name: c ? c.class_name : null,
                    school_name: c ? c.school_name : null
                };
            })
            .sort((a, b) => {
                const ca = String(a.class_name || '').localeCompare(String(b.class_name || ''), undefined, {
                    sensitivity: 'base'
                });
                if (ca !== 0) return ca;
                return String(a.telegram_id || '').localeCompare(String(b.telegram_id || ''), undefined, {
                    sensitivity: 'base'
                });
            });

        return { subRows, classRows };
    }
}

module.exports = { JsonStore };
