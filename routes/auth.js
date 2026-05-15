const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { safeReturnPath } = require('../middleware/auth');
const { createLink, checkConnection, getUser, telegramAppStartUrl } = require('../lib/linkbot');

function resolveClassRow(raw, cb) {
    const q = String(raw || '').trim();
    if (!q) {
        cb(null, null);
        return;
    }

    if (/^\d+$/.test(q)) {
        db.get('SELECT id, view_id FROM classes WHERE id = ?', [parseInt(q, 10)], (err, row) => {
            cb(err, row);
        });
        return;
    }

    db.get('SELECT id, view_id FROM classes WHERE view_id = ?', [q], (err, row) => {
        cb(err, row);
    });
}

router.post('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            res.redirect(303, '/');
            return;
        }
        res.redirect(303, '/');
    });
});

// Bookmark / middleware entry: send everything to home (one-step Open Telegram there).
router.get('/login', (req, res) => {
    if (req.session.user_id) {
        const ret = safeReturnPath(req.query.return);
        res.redirect(303, ret || '/');
        return;
    }

    const q = new URLSearchParams();
    if (req.query.return) {
        q.set('return', String(req.query.return));
    }
    if (req.query.class_id) {
        q.set('class_id', String(req.query.class_id));
    }
    const qs = q.toString();
    res.redirect(303, qs ? `/?${qs}` : '/');
});

router.post('/prepare-login', async (req, res) => {
    if (req.session.user_id) {
        res.status(400).json({ ok: false, error: 'Already signed in.' });
        return;
    }

    const ret = safeReturnPath(req.body && req.body.return);
    if (ret) {
        req.session.afterLoginRedirect = ret;
    } else {
        delete req.session.afterLoginRedirect;
    }

    const rawClass = req.body && req.body.class_id;
    if (rawClass && String(rawClass).trim()) {
        req.session.last_viewed_class = String(rawClass).trim();
    } else {
        delete req.session.last_viewed_class;
    }

    const linkId = crypto.randomBytes(8).toString('hex');
    const siteName = process.env.SITE_NAME || 'ClassClimb';

    try {
        const created = await createLink(linkId, siteName);
        if (!created.success) {
            res.status(400).json({ ok: false, error: created.error || 'linkbot' });
            return;
        }

        req.session.pending_link_id = linkId;
        const botUrl = process.env.LINKBOT_BOT_URL || 'https://t.me/Link_account_bot';
        const openBotUrl = telegramAppStartUrl(botUrl, linkId);
        res.json({ ok: true, openBotUrl, linkId });
    } catch (e) {
        res.status(500).json({ ok: false, error: 'linkbot' });
    }
});

router.get('/connect', (req, res) => {
    res.redirect(303, '/');
});

function bodyLinkId(req) {
    const raw = req.body && req.body.link_id;
    const s = raw != null ? String(raw).trim() : '';
    return /^[0-9a-fA-F]{16}$/.test(s) ? s : null;
}

router.post('/complete', async (req, res) => {
    try {
        let linkId = req.session.pending_link_id;
        if (!linkId || !/^[0-9a-fA-F]{16}$/.test(String(linkId))) {
            linkId = bodyLinkId(req);
        }
        if (!linkId || !/^[0-9a-fA-F]{16}$/.test(linkId)) {
            res.status(400).json({
                ok: false,
                error: 'missing_link',
                message: 'Missing login session. Use Open Telegram again.'
            });
            return;
        }

        const check = await checkConnection(linkId);
        if (!check.connected) {
            const msg = 'Not linked yet. Open Telegram, tap Start, then tap Finish here.';
            res.status(400).json({ ok: false, error: 'not_linked', message: msg });
            return;
        }

        const userData = await getUser(linkId);
        if (!userData) {
            const msg = 'Could not verify. Try again.';
            res.status(400).json({ ok: false, error: 'verify_failed', message: msg });
            return;
        }

        const telegramId = String(userData.telegram_id).trim();

        req.session.user_id = telegramId;
        req.session.linkbot_link_id = linkId;
        delete req.session.pending_link_id;

        const rawClass = req.session.last_viewed_class;
        const afterLogin = req.session.afterLoginRedirect;

        function finishRedirect(target) {
            delete req.session.afterLoginRedirect;
            res.json({ ok: true, redirect: target });
        }

        if (rawClass) {
            resolveClassRow(rawClass, (err, classRow) => {
                delete req.session.last_viewed_class;

                if (!err && classRow) {
                    db.run(
                        'INSERT OR IGNORE INTO subscriptions (link_id, telegram_id, class_id) VALUES (?, ?, ?)',
                        [linkId, telegramId, classRow.id],
                        () => {
                            finishRedirect(`/view/${classRow.id}`);
                        }
                    );
                } else if (afterLogin) {
                    finishRedirect(afterLogin);
                } else {
                    finishRedirect('/');
                }
            });
        } else if (afterLogin) {
            finishRedirect(afterLogin);
        } else {
            finishRedirect('/');
        }
    } catch (e) {
        console.error('POST /auth/complete:', e);
        res.status(500).json({
            ok: false,
            error: 'server',
            message: 'Login server error. Try again.'
        });
    }
});

router.post('/unsubscribe', (req, res) => {
    const { classId } = req.body;
    const telegramId = req.session.user_id;
    const linkId = req.session.linkbot_link_id;

    if (linkId) {
        db.run(
            'DELETE FROM subscriptions WHERE class_id = ? AND link_id = ?',
            [classId, linkId],
            (err) => {
                res.json({ success: !err });
            }
        );
    } else if (telegramId) {
        db.run(
            'DELETE FROM subscriptions WHERE telegram_id = ? AND class_id = ?',
            [telegramId, classId],
            (err) => {
                res.json({ success: !err });
            }
        );
    } else {
        res.json({ success: false });
    }
});

module.exports = router;
