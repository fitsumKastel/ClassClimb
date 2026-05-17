const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { requireUser } = require('../middleware/auth');
const { broadcastXP, broadcastClassMessage } = require('../lib/linkbot');
const { broadcastLeaderboard, broadcastClassAnnouncement } = require('../lib/realtime');
const { formatStudentName } = require('../lib/format-student-name');
const { formatClassLabel } = require('../lib/format-class-label');
const { v4: uuidv4 } = require('uuid');

router.use(requireUser);

function canManageClass(classInfo, userId) {
    if (!classInfo || !userId) {
        return false;
    }
    const owner = classInfo.teacher_id != null ? String(classInfo.teacher_id) : '';
    if (owner === '') {
        return true;
    }
    return owner === String(userId);
}

function newClassViewId() {
    return uuidv4().replace(/-/g, '').slice(0, 12);
}

function isViewIdUniqueError(err) {
    if (!err || !err.message) {
        return false;
    }
    return /UNIQUE constraint failed:.*view_id/i.test(String(err.message));
}

const INSERT_CLASS_SQL = `INSERT INTO classes (teacher_id, class_name, school_name, view_id) VALUES (?, ?, ?, ?)`;

function insertClassRecord(teacherId, className, schoolName, viewId, attempt, callback) {
    db.run(INSERT_CLASS_SQL, [teacherId, className, schoolName, viewId], function (err) {
        if (err && isViewIdUniqueError(err) && attempt < 8) {
            insertClassRecord(teacherId, className, schoolName, newClassViewId(), attempt + 1, callback);
            return;
        }
        callback.call(this, err, viewId);
    });
}

// Teacher manage page for a specific class (by share view_id)
router.get('/manage/:id', (req, res) => {
    const viewId = req.params.id;

    db.get('SELECT * FROM classes WHERE view_id = ?', [viewId], (classErr, classInfo) => {
        if (classErr || !classInfo) {
            return res.redirect('/?error=' + encodeURIComponent('Class not found'));
        }

        if (!canManageClass(classInfo, req.session.user_id)) {
            return res.redirect(303, `/view/${classInfo.id}`);
        }

        db.all(
            'SELECT * FROM students WHERE class_id = ? ORDER BY name COLLATE NOCASE ASC, id ASC',
            [classInfo.id],
            (studentsErr, students) => {
                if (studentsErr) {
                    return res.redirect('/?error=' + encodeURIComponent('Failed to load class students'));
                }

                const viewId = classInfo.view_id;
                if (!req.session.bulkAddNonces) {
                    req.session.bulkAddNonces = {};
                }
                const bulkFormNonce = crypto.randomBytes(32).toString('hex');
                req.session.bulkAddNonces[viewId] = bulkFormNonce;

                res.render('class-manage', {
                    classInfo,
                    students: students || [],
                    bulkFormNonce,
                    headerBackHref: '/teacher',
                    headerBackLabel: 'Back to classes',
                    headerEyebrow: 'Teacher console',
                    headerTitle: classInfo.class_name,
                    headerSubtitle: classInfo.school_name || null
                });
            }
        );
    });
});

function mintCreateClassNonce(req) {
    const formNonce = crypto.randomBytes(32).toString('hex');
    req.session.createClassNonce = formNonce;
    return formNonce;
}

function sendCreateJson(req, res, status, body) {
    req.session.save((saveErr) => {
        if (saveErr) {
            console.error('POST /class/create: session save failed:', saveErr.message || saveErr);
        }
        res.status(status).json(body);
    });
}

// Create a new class
router.post('/create', (req, res) => {
    const wantsJson = Boolean(req.get('Accept') && req.get('Accept').includes('application/json'));
    const submittedNonce = req.body._formNonce;
    const expectedNonce = req.session.createClassNonce;

    if (!submittedNonce || !expectedNonce || submittedNonce !== expectedNonce) {
        const freshNonce = mintCreateClassNonce(req);
        if (wantsJson) {
            sendCreateJson(req, res, 400, { ok: false, error: 'invalid_nonce', formNonce: freshNonce });
            return;
        }
        res.redirect(303, '/teacher');
        return;
    }

    const className = formatClassLabel(typeof req.body.className === 'string' ? req.body.className : '');
    const schoolName = formatClassLabel(typeof req.body.schoolName === 'string' ? req.body.schoolName : '');
    const teacherId = String(req.session.user_id || '').trim();

    if (!teacherId) {
        if (wantsJson) {
            sendCreateJson(req, res, 401, { ok: false, error: 'not_signed_in' });
            return;
        }
        res.redirect(303, '/auth/login?return=' + encodeURIComponent('/teacher'));
        return;
    }

    if (!className || !schoolName) {
        if (wantsJson) {
            sendCreateJson(req, res, 400, { ok: false, error: 'missing_fields' });
            return;
        }
        res.redirect(303, '/teacher?error=' + encodeURIComponent('Class name and school are required.'));
        return;
    }

    const viewId = newClassViewId();

    insertClassRecord(teacherId, className, schoolName, viewId, 0, function (err, insertedViewId) {
        if (err) {
            console.error('POST /class/create:', err.message || err);
            const code =
                /EACCES|EPERM|EROFS|ENOSPC/i.test(String(err.message || err)) ?
                    'storage_failed'
                :   'create_failed';
            if (wantsJson) {
                sendCreateJson(req, res, 500, { ok: false, error: code });
                return;
            }
            res.status(500).send('Error creating class.');
            return;
        }

        const classId = this.lastID;
        delete req.session.createClassNonce;

        const newClass = {
            id: classId,
            view_id: insertedViewId,
            class_name: className,
            school_name: schoolName
        };

        if (wantsJson) {
            const formNonce = mintCreateClassNonce(req);
            sendCreateJson(req, res, 200, { ok: true, class: newClass, formNonce });
            return;
        }

        req.session.save((saveErr) => {
            if (saveErr) {
                console.error('POST /class/create: session save failed:', saveErr.message || saveErr);
            }
            res.redirect(303, `/class/manage/${insertedViewId}`);
        });
    });
});

// Delete class (teacher only); removes students and subscriptions
router.post('/delete', (req, res) => {
    const viewId = typeof req.body.viewId === 'string' ? req.body.viewId.trim() : '';
    if (!viewId) {
        res.status(400).json({ ok: false, error: 'bad_request' });
        return;
    }

    db.get('SELECT * FROM classes WHERE view_id = ?', [viewId], (err, classInfo) => {
        if (err || !classInfo) {
            res.status(404).json({ ok: false, error: 'not_found' });
            return;
        }
        if (!canManageClass(classInfo, req.session.user_id)) {
            res.status(403).json({ ok: false, error: 'forbidden' });
            return;
        }

        const cid = classInfo.id;
        if (req.session.bulkAddNonces && req.session.bulkAddNonces[viewId]) {
            delete req.session.bulkAddNonces[viewId];
        }

        db.run('DELETE FROM students WHERE class_id = ?', [cid], (e1) => {
            if (e1) {
                res.status(500).json({ ok: false, error: 'delete_failed' });
                return;
            }
            db.run('DELETE FROM subscriptions WHERE class_id = ?', [cid], (e2) => {
                if (e2) {
                    res.status(500).json({ ok: false, error: 'delete_failed' });
                    return;
                }
                db.run('DELETE FROM classes WHERE id = ?', [cid], (e3) => {
                    if (e3) {
                        res.status(500).json({ ok: false, error: 'delete_failed' });
                        return;
                    }
                    res.json({ ok: true });
                });
            });
        });
    });
});

// Bulk Add Students
router.post('/bulk-add/:id', (req, res) => {
    const viewId = req.params.id;
    const submittedNonce = req.body._formNonce;
    const expectedNonce = req.session.bulkAddNonces && req.session.bulkAddNonces[viewId];

    if (!submittedNonce || !expectedNonce || submittedNonce !== expectedNonce) {
        res.redirect(303, `/class/manage/${viewId}`);
        return;
    }

    delete req.session.bulkAddNonces[viewId];

    const rawNames = req.body.studentList; // A big string from a textarea

    const names = String(rawNames || '')
        .split(/[\n,]+/)
        .map((name) => formatStudentName(name))
        .filter((name) => name.length > 0);

    db.get('SELECT id, teacher_id FROM classes WHERE view_id = ?', [viewId], (err, classRow) => {
        if (err || !classRow) {
            return res.send('Class not found.');
        }
        if (!canManageClass(classRow, req.session.user_id)) {
            return res.status(403).send('You do not have access to this class.');
        }

        const stmt = db.prepare("INSERT INTO students (class_id, name) VALUES (?, ?)");
        try {
            names.forEach((name) => stmt.run(classRow.id, name));
        } catch (insertErr) {
            stmt.finalize(() => {});
            return res.status(500).send('Could not add students.');
        }
        broadcastLeaderboard(classRow.id);
        stmt.finalize(() => {
            res.redirect(303, `/class/manage/${viewId}`);
        });
    });
});

router.post('/student/add-one/:viewId', (req, res) => {
    const viewId = req.params.viewId;
    const wantsJson = Boolean(req.get('Accept') && req.get('Accept').includes('application/json'));
    const name = formatStudentName(typeof req.body.name === 'string' ? req.body.name : '');
    if (!name) {
        if (wantsJson) {
            res.status(400).json({ ok: false, error: 'name_required' });
            return;
        }
        res.status(400).send('Name required.');
        return;
    }

    db.get('SELECT id, teacher_id FROM classes WHERE view_id = ?', [viewId], (err, classRow) => {
        if (!classRow) {
            if (wantsJson) {
                res.status(404).json({ ok: false, error: 'not_found' });
                return;
            }
            res.status(404).send('Class not found.');
            return;
        }
        if (!canManageClass(classRow, req.session.user_id)) {
            if (wantsJson) {
                res.status(403).json({ ok: false, error: 'forbidden' });
                return;
            }
            res.status(403).send('Not allowed.');
            return;
        }

        db.run(
            'INSERT INTO students (class_id, name) VALUES (?, ?)',
            [classRow.id, name],
            function (insErr) {
                if (insErr) {
                    if (wantsJson) {
                        res.status(500).json({ ok: false, error: 'insert_failed' });
                        return;
                    }
                    res.status(500).send('Could not add student.');
                    return;
                }
                const student = { id: this.lastID, name, xp: 0, class_id: classRow.id };
                broadcastLeaderboard(classRow.id);
                if (wantsJson) {
                    res.json({ ok: true, student });
                    return;
                }
                res.redirect(303, `/class/manage/${viewId}`);
            }
        );
    });
});

router.post('/award-xp', (req, res) => {
    const { studentId, classId, studentName } = req.body;
    const rawXp = req.body.xpAmount;
    const xpDelta =
        typeof rawXp === 'number' && Number.isFinite(rawXp)
            ? Math.trunc(rawXp)
            : parseInt(String(rawXp || ''), 10);
    if (!Number.isFinite(xpDelta) || xpDelta === 0) {
        res.status(400).json({ success: false });
        return;
    }

    db.get('SELECT teacher_id FROM classes WHERE id = ?', [classId], (permErr, classRow) => {
        if (permErr || !classRow || !canManageClass(classRow, req.session.user_id)) {
            res.status(403).json({ success: false });
            return;
        }

    db.run("UPDATE students SET xp = xp + ? WHERE id = ?", [xpDelta, studentId], (err) => {
        if (err) return res.status(500).json({ success: false });

        broadcastLeaderboard(classId);
        res.json({ success: true });
        broadcastXP(classId, studentName, xpDelta);
    });
    });
});

router.post('/broadcast-message', (req, res) => {
    const rawClassId = req.body && req.body.classId;
    const classId = parseInt(String(rawClassId != null ? rawClassId : ''), 10);
    if (!Number.isFinite(classId) || classId <= 0) {
        res.status(400).json({ ok: false, error: 'bad_class' });
        return;
    }

    db.get('SELECT teacher_id FROM classes WHERE id = ?', [classId], (permErr, classRow) => {
        if (permErr || !classRow || !canManageClass(classRow, req.session.user_id)) {
            res.status(403).json({ ok: false, error: 'forbidden' });
            return;
        }
        const rawMsg = req.body && req.body.message;
        const delivered = broadcastClassAnnouncement(classId, rawMsg);
        if (!delivered) {
            res.status(400).json({ ok: false, error: 'empty_message' });
            return;
        }
        broadcastClassMessage(classId, delivered);
        res.json({ ok: true });
    });
});

router.post('/student/edit', (req, res) => {
    const { studentId, newName } = req.body;
    db.get(
        `SELECT c.teacher_id, c.id AS class_id FROM students s JOIN classes c ON c.id = s.class_id WHERE s.id = ?`,
        [studentId],
        (permErr, row) => {
            if (permErr || !row || !canManageClass(row, req.session.user_id)) {
                res.status(403).json({ success: false });
                return;
            }
            const classPk = row.class_id;
            db.run('UPDATE students SET name = ? WHERE id = ?', [newName, studentId], (err) => {
                if (!err) {
                    broadcastLeaderboard(classPk);
                }
                res.json({ success: !err });
            });
        }
    );
});

// Delete Student (Remove from class)
router.post('/student/delete/:id', (req, res) => {
    const studentPk = req.params.id;
    const wantsJson = Boolean(req.get('Accept') && req.get('Accept').includes('application/json'));
    db.get(
        `SELECT c.teacher_id, c.id AS class_id FROM students s JOIN classes c ON c.id = s.class_id WHERE s.id = ?`,
        [studentPk],
        (permErr, row) => {
            if (permErr || !row || !canManageClass(row, req.session.user_id)) {
                if (wantsJson) {
                    res.status(403).json({ ok: false, error: 'forbidden' });
                    return;
                }
                res.status(403).send('Not allowed.');
                return;
            }
            const classPk = row.class_id;
            db.run('DELETE FROM students WHERE id = ?', [studentPk], (err) => {
                if (!err) {
                    broadcastLeaderboard(classPk);
                }
                if (wantsJson) {
                    if (err) {
                        res.status(500).json({ ok: false, error: 'delete_failed' });
                        return;
                    }
                    res.json({ ok: true });
                    return;
                }
                const referer = req.get('Referer');
                res.redirect(
                    303,
                    referer && referer.startsWith(req.protocol + '://' + req.get('host')) ? referer : '/'
                );
            });
        }
    );
});

module.exports = router;
