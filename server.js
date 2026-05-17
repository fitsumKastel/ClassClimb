const { loadEnvFromRoot } = require('./lib/load-env');
loadEnvFromRoot();

require('./lib/storage-paths').initStorage();

const path = require('path');
const fs = require('fs');

// LiteSpeed / cPanel often installs npm under ~/nodevenv/<app>/<nodeMajor>/lib/node_modules
// (not next to server.js). Register on Module.globalPaths so all files (e.g. routes) resolve deps.
(function registerHostNodeModules() {
    const Module = require('module');
    const push = (p) => {
        if (p && fs.existsSync(p) && !Module.globalPaths.includes(p)) {
            Module.globalPaths.push(p);
        }
    };
    const override = (process.env.CLASSCLIMB_NODE_MODULES || '').trim();
    if (override) {
        push(override);
        return;
    }
    const majorMatch = process.version.match(/^v(\d+)/);
    if (!majorMatch) {
        return;
    }
    const alt = path.join(
        path.dirname(__dirname),
        'nodevenv',
        path.basename(__dirname),
        majorMatch[1],
        'lib',
        'node_modules'
    );
    push(alt);
})();

const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { initRealtime } = require('./lib/realtime');
const session = require('express-session');
const SqliteSessionStore = require('./lib/sqlite-session-store');
const { getSessionsDir } = require('./lib/storage-paths');
const db = require('./lib/db');
const { telegramAppStartUrl, seedLinkbotSiteSecretFromEnv } = require('./lib/linkbot');
const { requireUser, safeReturnPath } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const classRoutes = require('./routes/class');
const { appUpdateModeMiddleware, isAppUpdateMode } = require('./lib/app-update-mode');

const app = express();

// Behind LiteSpeed/nginx HTTPS termination Node often sees HTTP; trust proxy unless disabled.
if (process.env.TRUST_PROXY !== '0') {
    app.set('trust proxy', 1);
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const sessionMaxAgeDays = Math.max(1, parseInt(process.env.SESSION_MAX_AGE_DAYS || '30', 10) || 30);
const sessionMaxAgeMs = sessionMaxAgeDays * 24 * 60 * 60 * 1000;
const siteUrl = (process.env.SITE_URL || '').trim();
const cookieSecure =
    process.env.COOKIE_SECURE === '1' || (siteUrl.startsWith('https://') && process.env.COOKIE_SECURE !== '0');

const sameSiteRaw = (process.env.SESSION_COOKIE_SAME_SITE || 'lax').toLowerCase();
const cookieSameSite =
    sameSiteRaw === 'none' || sameSiteRaw === 'strict' || sameSiteRaw === 'lax' ? sameSiteRaw : 'lax';
const cookieSecureEffective = cookieSameSite === 'none' ? true : cookieSecure;

const sessionStore = new SqliteSessionStore({
    db: 'sessions.db',
    dir: getSessionsDir(),
    concurrentDB: true
});

const sessionSecret = process.env.SESSION_SECRET || 'class-climb-2026';

app.use('/asset', express.static(path.join(__dirname, 'asset')));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(
    session({
        store: sessionStore,
        name: 'classclimb.sid',
        secret: sessionSecret,
        resave: false,
        saveUninitialized: false,
        rolling: true,
        cookie: {
            maxAge: sessionMaxAgeMs,
            httpOnly: true,
            sameSite: cookieSameSite,
            secure: cookieSecureEffective,
            path: '/'
        }
    })
);

app.use((req, res, next) => {
    res.locals.currentPath = req.path;
    res.locals.navStudentView = req.path.startsWith('/view/');
    res.locals.userId = req.session.user_id || null;
    res.locals.headerBackHref = null;
    res.locals.headerBackLabel = null;
    res.locals.headerEyebrow = null;
    res.locals.headerTitle = null;
    res.locals.headerSubtitle = null;
    res.locals.ccDrawerRoot =
        'group fixed inset-0 z-[110] opacity-0 invisible pointer-events-none transition-[opacity,visibility] duration-200 data-[open=true]:opacity-100 data-[open=true]:visible data-[open=true]:pointer-events-auto';
    res.locals.ccDrawerBackdrop =
        'absolute inset-0 border-0 bg-black/90 p-0 opacity-0 transition-opacity duration-200 group-data-[open=true]:opacity-100';
    res.locals.ccDrawerPanel =
        'absolute top-0 flex h-full min-h-[100dvh] max-h-[100dvh] w-full max-w-sm translate-x-full flex-col border-l border-zinc-800 bg-black shadow-[-12px_0_32px_rgba(0,0,0,0.5)] transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-data-[open=true]:translate-x-0';
    res.locals.ccDrawerNavItem =
        'flex w-full cursor-pointer items-center justify-start gap-3 border-0 bg-transparent py-3 px-1 text-left text-base font-normal text-white [-webkit-appearance:none] [appearance:none] transition hover:opacity-80 font-inherit';
    next();
});

app.use(appUpdateModeMiddleware);

app.use('/auth', authRoutes);
app.use('/class', classRoutes);

function renderStudentHome(req, res, { error }) {
    const userId = String(req.session.user_id);
    delete req.session.createClassNonce;
    db.all(
        `SELECT DISTINCT c.id, c.view_id, c.class_name, c.school_name
         FROM subscriptions s
         INNER JOIN classes c ON c.id = s.class_id
         WHERE s.telegram_id = ?
         ORDER BY c.class_name COLLATE NOCASE ASC, c.id ASC`,
        [userId],
        (subErr, boards) => {
            if (subErr) {
                res.status(500).send('Failed to load your boards.');
                return;
            }
            res.render('index', {
                signedIn: true,
                isTeacher: false,
                studentBoards: boards || [],
                classes: [],
                error: error || null,
                pageBase: '/'
            });
        }
    );
}

function renderTeacherDashboard(req, res, { error, pageBase, pageRequested, showCreateClass }) {
    const teacherId = String(req.session.user_id);
    const formNonce = crypto.randomBytes(32).toString('hex');
    if (showCreateClass) {
        req.session.createClassNonce = formNonce;
    } else {
        delete req.session.createClassNonce;
    }

    const classesPageSize = Math.max(1, parseInt(process.env.CLASSES_PAGE_SIZE || '10', 10) || 10);
    const pageReq = Math.max(1, parseInt(pageRequested, 10) || 1);
    const base = pageBase || '/';

    db.get(
        'SELECT COUNT(*) AS n FROM classes WHERE teacher_id = ?',
        [teacherId],
        (countErr, countRow) => {
            if (countErr) {
                res.status(500).send('Failed to load classes.');
                return;
            }
            const totalCount = countRow && countRow.n != null ? Number(countRow.n) : 0;
            const totalPages = Math.max(1, Math.ceil(totalCount / classesPageSize));
            const page = Math.min(pageReq, totalPages);
            const offset = (page - 1) * classesPageSize;

            db.all(
                'SELECT * FROM classes WHERE teacher_id = ? ORDER BY id DESC LIMIT ? OFFSET ?',
                [teacherId, classesPageSize, offset],
                (err, classes) => {
                    if (err) {
                        res.status(500).send('Failed to load classes.');
                        return;
                    }
                    res.render('index', {
                        signedIn: true,
                        isTeacher: true,
                        showCreateClass: showCreateClass === true,
                        classes: classes || [],
                        classesPage: page,
                        classesTotalPages: totalPages,
                        classesTotalCount: totalCount,
                        classesPageSize,
                        formNonce: showCreateClass ? formNonce : null,
                        error: error || null,
                        pageBase: base
                    });
                }
            );
        }
    );
}

function renderSignedInHome(req, res, error) {
    const teacherId = String(req.session.user_id);

    db.get(
        'SELECT COUNT(*) AS n FROM classes WHERE teacher_id = ?',
        [teacherId],
        (countErr, countRow) => {
            if (countErr) {
                res.status(500).send('Failed to load classes.');
                return;
            }
            const ownedCount = countRow && countRow.n != null ? Number(countRow.n) : 0;
            if (ownedCount > 0) {
                renderTeacherDashboard(req, res, {
                    error,
                    pageBase: '/',
                    pageRequested: req.query.page
                });
                return;
            }
            db.get(
                'SELECT COUNT(*) AS n FROM subscriptions WHERE telegram_id = ?',
                [teacherId],
                (subErr, subRow) => {
                    if (subErr) {
                        res.status(500).send('Failed to load account.');
                        return;
                    }
                    const subCount = subRow && subRow.n != null ? Number(subRow.n) : 0;
                    if (subCount > 0) {
                        renderStudentHome(req, res, { error });
                        return;
                    }
                    renderTeacherDashboard(req, res, {
                        error,
                        pageBase: '/',
                        pageRequested: req.query.page
                    });
                }
            );
        }
<<<<<<< Updated upstream
    );
}

// Teacher URL: full teacher tools only after creating a class; otherwise student boards / empty state.
app.get('/teacher', requireUser, (req, res) => {
    const error = typeof req.query.error === 'string' ? req.query.error : null;
    const teacherId = String(req.session.user_id);

    db.get(
        'SELECT COUNT(*) AS n FROM classes WHERE teacher_id = ?',
        [teacherId],
        (countErr, countRow) => {
            if (countErr) {
                res.status(500).send('Failed to load classes.');
                return;
            }
            const ownedCount = countRow && countRow.n != null ? Number(countRow.n) : 0;
            if (ownedCount > 0) {
                renderTeacherDashboard(req, res, {
                    error,
                    pageBase: '/teacher',
                    pageRequested: req.query.page
                });
                return;
            }
            renderStudentHome(req, res, { error });
        }
    );
=======
        const formNonce = crypto.randomBytes(32).toString('hex');
        req.session.createClassNonce = formNonce;
        const setupError = typeof req.query.error === 'string' ? req.query.error.trim() : '';
        res.render('start-teaching', {
            formNonce,
            setupError: setupError || null,
            headerBackHref: '/',
            headerBackLabel: 'Back to home',
            headerEyebrow: 'Get started',
            headerTitle: 'Create your class',
            headerSubtitle: 'Set up a class to get a share link for students.'
        });
    });
>>>>>>> Stashed changes
});

// Home: guest landing vs signed-in teacher dashboard
app.get('/', (req, res) => {
    const error = typeof req.query.error === 'string' ? req.query.error : null;

    if (!req.session.user_id) {
        const pendingLogin = Boolean(req.session.pending_link_id);
        let openBotUrl = null;
        if (pendingLogin) {
            const botUrl = process.env.LINKBOT_BOT_URL || 'https://t.me/Link_account_bot';
            openBotUrl = telegramAppStartUrl(botUrl, req.session.pending_link_id);
        }
        const pendingLinkId =
            pendingLogin && req.session.pending_link_id ? String(req.session.pending_link_id).trim() : '';
        res.render('index', {
            signedIn: false,
            classes: [],
            formNonce: null,
            error,
            pendingLogin,
            pendingLinkId,
            openBotUrl,
            prepareReturn: safeReturnPath(req.query.return) || '',
            prepareClassId: typeof req.query.class_id === 'string' ? req.query.class_id.trim() : ''
        });
        return;
    }

    const subscribeLinkId = req.session.linkbot_link_id;
    const rawSubscribeClass = typeof req.query.class_id === 'string' ? req.query.class_id.trim() : '';
    const subscribeReturn = safeReturnPath(req.query.return);

<<<<<<< Updated upstream
=======
    function renderStudentHome(teacherId) {
        delete req.session.createClassNonce;
        db.all(
            `SELECT DISTINCT c.id, c.view_id, c.class_name, c.school_name
             FROM subscriptions s
             INNER JOIN classes c ON c.id = s.class_id
             WHERE s.telegram_id = ?
             ORDER BY c.class_name COLLATE NOCASE ASC, c.id ASC`,
            [teacherId],
            (subErr, boards) => {
                if (subErr) {
                    res.status(500).send('Failed to load your boards.');
                    return;
                }
                res.render('index', {
                    signedIn: true,
                    isTeacher: false,
                    studentBoards: boards || [],
                    classes: [],
                    error
                });
            }
        );
    }

    function renderTeacherDashboard(teacherId) {
        const formNonce = crypto.randomBytes(32).toString('hex');
        req.session.createClassNonce = formNonce;

        const classesPageSize = Math.max(1, parseInt(process.env.CLASSES_PAGE_SIZE || '10', 10) || 10);
        const pageRequested = Math.max(1, parseInt(req.query.page, 10) || 1);

        db.get(
            'SELECT COUNT(*) AS n FROM classes WHERE teacher_id = ?',
            [teacherId],
            (countErr, countRow) => {
                if (countErr) {
                    res.status(500).send('Failed to load classes.');
                    return;
                }
                const totalCount = countRow && countRow.n != null ? Number(countRow.n) : 0;
                const totalPages = Math.max(1, Math.ceil(totalCount / classesPageSize));
                const page = Math.min(pageRequested, totalPages);
                const offset = (page - 1) * classesPageSize;

                db.all(
                    'SELECT * FROM classes WHERE teacher_id = ? ORDER BY id DESC LIMIT ? OFFSET ?',
                    [teacherId, classesPageSize, offset],
                    (err, classes) => {
                        if (err) {
                            res.status(500).send('Failed to load classes.');
                            return;
                        }
                        res.render('index', {
                            signedIn: true,
                            isTeacher: true,
                            classes: classes || [],
                            classesPage: page,
                            classesTotalPages: totalPages,
                            classesTotalCount: totalCount,
                            classesPageSize,
                            formNonce,
                            error
                        });
                    }
                );
            }
        );
    }

    function renderSignedInDashboard() {
        const teacherId = String(req.session.user_id);

        db.get(
            'SELECT COUNT(*) AS n FROM classes WHERE teacher_id = ?',
            [teacherId],
            (countErr, countRow) => {
                if (countErr) {
                    res.status(500).send('Failed to load classes.');
                    return;
                }
                const ownedCount = countRow && countRow.n != null ? Number(countRow.n) : 0;
                if (ownedCount === 0) {
                    db.get(
                        'SELECT COUNT(*) AS n FROM subscriptions WHERE telegram_id = ?',
                        [teacherId],
                        (subCountErr, subCountRow) => {
                            if (subCountErr) {
                                res.status(500).send('Failed to load your account.');
                                return;
                            }
                            const subCount =
                                subCountRow && subCountRow.n != null ? Number(subCountRow.n) : 0;
                            if (subCount === 0) {
                                res.redirect(303, '/teacher');
                                return;
                            }
                            renderStudentHome(teacherId);
                        }
                    );
                    return;
                }
                renderTeacherDashboard(teacherId);
            }
        );
    }

>>>>>>> Stashed changes
    if (subscribeLinkId && rawSubscribeClass && subscribeReturn) {
        const lookupCb =
            /^\d+$/.test(rawSubscribeClass) ?
                (cb) => db.get('SELECT id FROM classes WHERE id = ?', [parseInt(rawSubscribeClass, 10)], cb)
            :   (cb) => db.get('SELECT id FROM classes WHERE view_id = ?', [rawSubscribeClass], cb);

        lookupCb((subClassErr, subClassRow) => {
            if (subClassErr || !subClassRow || subClassRow.id == null) {
                renderSignedInHome(req, res, error);
                return;
            }
            db.run(
                'INSERT OR IGNORE INTO subscriptions (link_id, telegram_id, class_id) VALUES (?, ?, ?)',
                [subscribeLinkId, String(req.session.user_id), subClassRow.id],
                () => {
                    res.redirect(303, subscribeReturn);
                }
            );
        });
        return;
    }

    renderSignedInHome(req, res, error);
});

app.get('/dashboard', (req, res) => {
    res.redirect(303, '/');
});

app.get('/status', (req, res) => {
    if (req.session.statusAuthed) {
        return statusData(req, res);
    }
    res.render('status', { authenticated: false, data: null });
});

function statusData(req, res) {
    db.all(
        `SELECT s.telegram_id, s.link_id, s.class_id, c.class_name, c.school_name
         FROM subscriptions s
         LEFT JOIN classes c ON c.id = s.class_id
         ORDER BY c.class_name COLLATE NOCASE ASC, s.telegram_id ASC`,
        [],
        (subErr, subRows) => {
            if (subErr) {
                return res.render('status', { authenticated: true, data: null, error: 'Database error' });
            }

            db.all(
                `SELECT c.id, c.class_name, c.school_name, COUNT(st.id) AS total_students
                 FROM classes c
                 LEFT JOIN students st ON st.class_id = c.id
                 GROUP BY c.id
                 ORDER BY c.class_name COLLATE NOCASE ASC`,
                [],
                (classErr, classRows) => {
                    if (classErr) {
                        return res.render('status', { authenticated: true, data: null, error: 'Database error' });
                    }

                    const subs = (subRows || []).map(r => ({
                        telegram_id: r.telegram_id,
                        link_id: r.link_id,
                        class_id: r.class_id,
                        class_name: r.class_name || 'Unknown',
                        school_name: r.school_name || ''
                    }));

                    const connectedPerClass = {};
                    subs.forEach(s => {
                        if (!connectedPerClass[s.class_id]) connectedPerClass[s.class_id] = new Set();
                        connectedPerClass[s.class_id].add(s.telegram_id);
                    });

                    const classes = (classRows || []).map(c => {
                        const totalStudents = Number(c.total_students) || 0;
                        const connected = connectedPerClass[c.id] ? connectedPerClass[c.id].size : 0;
                        const notConnected = Math.max(0, totalStudents - connected);
                        const label = c.class_name + (c.school_name ? ' (' + c.school_name + ')' : '');
                        return { id: c.id, label, totalStudents, connected, notConnected };
                    });

                    const totalStudents = classes.reduce((sum, c) => sum + c.totalStudents, 0);
                    const totalConnected = new Set(subs.map(s => s.telegram_id)).size;
                    const totalNotConnected = Math.max(0, totalStudents - totalConnected);
                    const totalClasses = classes.length;
                    const connectionRate = totalStudents > 0 ? Math.round((totalConnected / totalStudents) * 100) : 0;

                    res.render('status', {
                        authenticated: true,
                        error: null,
                        data: {
                            subscriptions: subs,
                            classes,
                            totalStudents,
                            totalConnected,
                            totalNotConnected,
                            totalClasses,
                            connectionRate
                        }
                    });
                }
            );
        }
    );
}

app.post('/status', (req, res) => {
    const password = (process.env.STATUS_PASSWORD || 'classclimb2026').trim();
    if (req.body.password !== password) {
        return res.render('status', { authenticated: false, error: 'Incorrect password', data: null });
    }

    req.session.statusAuthed = true;
    res.redirect(303, '/status');
});

app.post('/status/logout', (req, res) => {
    delete req.session.statusAuthed;
    res.redirect(303, '/status');
});

// Leaderboard (requires sign-in — students and teachers)
app.get('/view/:classId', requireUser, (req, res) => {
    const classId = req.params.classId;

    db.get(
        'SELECT * FROM classes WHERE id = ?',
        [classId],
        (classErr, classRow) => {
        if (classErr || !classRow) {
            return res.redirect('/?error=' + encodeURIComponent('Class not found'));
        }

        const cn = typeof classRow.class_name === 'string' ? classRow.class_name.trim() : '';
        const sn = typeof classRow.school_name === 'string' ? classRow.school_name.trim() : '';
        const footerClassName = cn || `Class #${classId}`;
        const footerSchoolName = sn || null;

        const viewerId = req.session.user_id != null ? String(req.session.user_id) : '';
        const ownerId = classRow.teacher_id != null ? String(classRow.teacher_id) : '';
        const isClassTeacher = Boolean(ownerId && viewerId === ownerId);

        const backHref = isClassTeacher ? `/class/manage/${classRow.view_id}` : '/';
        const backLabel = isClassTeacher ? 'Back to manage' : 'Back to home';

        db.all(
            'SELECT * FROM students WHERE class_id = ? ORDER BY xp DESC, id ASC',
            [classId],
            (err, students) => {
                if (err) {
                    return res.redirect('/?error=' + encodeURIComponent('Failed to load leaderboard'));
                }

                function renderLeaderboardView(hasAlerts) {
                    res.render('leaderboard', {
                        students: students || [],
                        classId,
                        footerClassName,
                        footerSchoolName,
                        hasAlerts,
                        isClassTeacher,
                        headerBackHref: backHref,
                        headerBackLabel: backLabel
                    });
                }

                if (isClassTeacher) {
                    renderLeaderboardView(false);
                    return;
                }

                const linkId = req.session.linkbot_link_id || null;
                const telegramId = req.session.user_id != null ? String(req.session.user_id) : '';

                if (linkId && telegramId) {
                    db.run(
                        'INSERT OR IGNORE INTO subscriptions (link_id, telegram_id, class_id) VALUES (?, ?, ?)',
                        [linkId, telegramId, classId],
                        (insErr) => {
                            if (insErr) {
                                db.get(
                                    'SELECT 1 AS ok FROM subscriptions WHERE class_id = ? AND link_id = ?',
                                    [classId, linkId],
                                    (subErr, sub) => {
                                        renderLeaderboardView(Boolean(sub && sub.ok));
                                    }
                                );
                                return;
                            }
                            renderLeaderboardView(true);
                        }
                    );
                } else {
                    renderLeaderboardView(false);
                }
            }
        );
    });
});

const PORT = process.env.PORT || 3000;
const httpServer = http.createServer(app);

httpServer.on('error', (err) => {
    console.error('ClassClimb HTTP server error:', err.code || err.message || err);
});

initRealtime(httpServer, sessionStore, {
    cookieName: 'classclimb.sid',
    secret: sessionSecret
});

(async () => {
    try {
        await seedLinkbotSiteSecretFromEnv();
        httpServer.listen(PORT, '0.0.0.0', () => {
            console.log(`ClassClimb is listening on port ${PORT}`);
            if (isAppUpdateMode()) {
                console.log('APP_UPDATE_MODE is on — visitors see the update page (set APP_UPDATE_MODE=0 when done).');
            }
        });
    } catch (err) {
        console.error('ClassClimb startup failed:', err && err.message ? err.message : err);
        process.exit(1);
    }
})();