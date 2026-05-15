const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const router = express.Router();
const db = require('../lib/db');
const { requireUser } = require('../middleware/auth');
const { broadcastXP } = require('../lib/linkbot');
const {
    broadcastLeaderboard,
    broadcastClassAnnouncement,
    broadcastPdfSync,
    buildPdfSyncData
} = require('../lib/realtime');
const { formatStudentName } = require('../lib/format-student-name');
const { v4: uuidv4 } = require('uuid');
const {
    ensureMaterialsDir,
    pdfFilePathForClass,
    classHasPdfFile,
    deleteClassPdf,
    looksLikePdf,
    MAX_CLASS_PDF_BYTES,
    countPdfPages
} = require('../lib/class-materials');

router.use(requireUser);

const multerPdf = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_CLASS_PDF_BYTES }
});

router.get('/start-teaching', (req, res) => {
    res.redirect(303, '/teacher');
});

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

// Teacher manage page for a specific class (by share view_id)
router.get('/manage/:id', (req, res) => {
    const viewId = req.params.id;

    db.get('SELECT * FROM classes WHERE view_id = ?', [viewId], (classErr, classInfo) => {
        if (classErr || !classInfo) {
            return res.redirect('/?error=' + encodeURIComponent('Class not found'));
        }

        if (!canManageClass(classInfo, req.session.user_id)) {
            return res.redirect('/?error=' + encodeURIComponent('You do not have access to manage this class'));
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

                const pdfSyncBootstrap = buildPdfSyncData(classInfo, classInfo.id);

                res.render('class-manage', {
                    classInfo,
                    students: students || [],
                    bulkFormNonce,
                    pdfSyncBootstrap,
                    headerBackHref: '/',
                    headerBackLabel: 'Back to classes'
                });
            }
        );
    });
});

// Create a new class
router.post('/create', (req, res) => {
    const wantsJson = Boolean(req.get('Accept') && req.get('Accept').includes('application/json'));
    const submittedNonce = req.body._formNonce;
    const expectedNonce = req.session.createClassNonce;

    if (!submittedNonce || !expectedNonce || submittedNonce !== expectedNonce) {
        if (wantsJson) {
            res.status(400).json({ ok: false, error: 'invalid_nonce' });
            return;
        }
        res.redirect(303, '/');
        return;
    }

    delete req.session.createClassNonce;

    const { className, schoolName } = req.body;
    const teacherId = req.session.user_id;
    const viewId = uuidv4().substring(0, 8); // Short unique ID for the URL

    db.run(`INSERT INTO classes (teacher_id, class_name, school_name, view_id) VALUES (?, ?, ?, ?)`,
        [teacherId, className, schoolName, viewId], function (err) {
            if (err) {
                if (wantsJson) {
                    res.status(500).json({ ok: false, error: 'create_failed' });
                    return;
                }
                res.send('Error creating class.');
                return;
            }

            const newClass = {
                id: this.lastID,
                view_id: viewId,
                class_name: className,
                school_name: schoolName
            };

            if (wantsJson) {
                const formNonce = crypto.randomBytes(32).toString('hex');
                req.session.createClassNonce = formNonce;
                res.json({ ok: true, class: newClass, formNonce });
                return;
            }

            res.redirect(303, `/class/manage/${viewId}`);
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

        deleteClassPdf(cid);

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
        if (!broadcastClassAnnouncement(classId, rawMsg)) {
            res.status(400).json({ ok: false, error: 'empty_message' });
            return;
        }
        res.json({ ok: true });
    });
});

router.get('/material-pdf/:viewId', (req, res) => {
    const viewId = typeof req.params.viewId === 'string' ? req.params.viewId.trim() : '';
    if (!viewId) {
        res.status(400).end();
        return;
    }
    db.get('SELECT id FROM classes WHERE view_id = ?', [viewId], (err, row) => {
        if (err || !row) {
            res.status(404).end();
            return;
        }
        const fp = pdfFilePathForClass(row.id);
        if (!classHasPdfFile(row.id)) {
            res.status(404).end();
            return;
        }
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
        res.sendFile(fp, (sendErr) => {
            if (sendErr && !res.headersSent) {
                res.status(500).end();
            }
        });
    });
});

router.post('/material-pdf/:viewId', (req, res, next) => {
    multerPdf.single('pdf')(req, res, (err) => {
        if (err) {
            res.status(400).json({ ok: false, error: 'upload' });
            return;
        }
        next();
    });
}, async (req, res) => {
    const viewId = typeof req.params.viewId === 'string' ? req.params.viewId.trim() : '';
    if (!viewId || !req.file || !req.file.buffer) {
        res.status(400).json({ ok: false, error: 'no_file' });
        return;
    }
    if (!looksLikePdf(req.file.buffer)) {
        res.status(400).json({ ok: false, error: 'not_pdf' });
        return;
    }

    db.get('SELECT id, teacher_id, class_pdf_rev FROM classes WHERE view_id = ?', [viewId], async (err, classRow) => {
        if (err || !classRow) {
            res.status(404).json({ ok: false, error: 'not_found' });
            return;
        }
        if (!canManageClass(classRow, req.session.user_id)) {
            res.status(403).json({ ok: false, error: 'forbidden' });
            return;
        }

        let numPages;
        try {
            numPages = await countPdfPages(req.file.buffer);
        } catch (e) {
            res.status(400).json({ ok: false, error: 'bad_pdf' });
            return;
        }
        if (!numPages || numPages < 1) {
            res.status(400).json({ ok: false, error: 'bad_pdf' });
            return;
        }

        const newRev = (Number(classRow.class_pdf_rev) || 0) + 1;
        ensureMaterialsDir();
        try {
            fs.writeFileSync(pdfFilePathForClass(classRow.id), req.file.buffer);
        } catch (wErr) {
            res.status(500).json({ ok: false, error: 'write_failed' });
            return;
        }

        db.run(
            'UPDATE classes SET class_pdf_rev = ?, class_pdf_num_pages = ?, pdf_follow_page = 1, pdf_follow_active = 0 WHERE id = ?',
            [newRev, numPages, classRow.id],
            (uErr) => {
                if (uErr) {
                    res.status(500).json({ ok: false, error: 'db_failed' });
                    return;
                }
                broadcastPdfSync(classRow.id);
                res.json({ ok: true, rev: newRev, numPages: numPages });
            }
        );
    });
});

router.post('/pdf-live', (req, res) => {
    const rawClassId = req.body && req.body.classId;
    const classId = parseInt(String(rawClassId != null ? rawClassId : ''), 10);
    if (!Number.isFinite(classId) || classId <= 0) {
        res.status(400).json({ ok: false, error: 'bad_class' });
        return;
    }
    const body = req.body || {};
    const live = body.live === true || body.live === 1 || body.live === '1';

    db.get('SELECT teacher_id FROM classes WHERE id = ?', [classId], (permErr, classRow) => {
        if (permErr || !classRow || !canManageClass(classRow, req.session.user_id)) {
            res.status(403).json({ ok: false, error: 'forbidden' });
            return;
        }
        if (live && !classHasPdfFile(classId)) {
            res.status(400).json({ ok: false, error: 'no_pdf' });
            return;
        }
        db.run('UPDATE classes SET pdf_follow_active = ? WHERE id = ?', [live ? 1 : 0, classId], (e2) => {
            if (e2) {
                res.status(500).json({ ok: false, error: 'db_failed' });
                return;
            }
            broadcastPdfSync(classId);
            res.json({ ok: true });
        });
    });
});

router.post('/pdf-page', (req, res) => {
    const rawClassId = req.body && req.body.classId;
    const classId = parseInt(String(rawClassId != null ? rawClassId : ''), 10);
    const pageRaw = req.body && req.body.page;
    const page = parseInt(String(pageRaw != null ? pageRaw : ''), 10);
    if (!Number.isFinite(classId) || classId <= 0 || !Number.isFinite(page) || page < 1) {
        res.status(400).json({ ok: false, error: 'bad_request' });
        return;
    }

    db.get(
        'SELECT teacher_id, class_pdf_num_pages FROM classes WHERE id = ?',
        [classId],
        (permErr, classRow) => {
            if (permErr || !classRow || !canManageClass(classRow, req.session.user_id)) {
                res.status(403).json({ ok: false, error: 'forbidden' });
                return;
            }
            const maxP = Math.max(1, Number(classRow.class_pdf_num_pages) || 0);
            if (!classHasPdfFile(classId) || maxP < 1) {
                res.status(400).json({ ok: false, error: 'no_pdf' });
                return;
            }
            const clamped = Math.min(Math.max(page, 1), maxP);
            db.run('UPDATE classes SET pdf_follow_page = ? WHERE id = ?', [clamped, classId], (e2) => {
                if (e2) {
                    res.status(500).json({ ok: false, error: 'db_failed' });
                    return;
                }
                broadcastPdfSync(classId);
                res.json({ ok: true, page: clamped });
            });
        }
    );
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