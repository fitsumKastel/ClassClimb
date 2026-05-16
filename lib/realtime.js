const cookie = require('cookie');
const signature = require('cookie-signature');
const WebSocket = require('ws');
const db = require('./db');

const rooms = new Map();

function parseSessionId(cookieHeader, name, secret) {
    const cookies = cookie.parse(cookieHeader || '');
    const raw = cookies[name];
    if (!raw || typeof raw !== 'string' || raw.indexOf('s:') !== 0) {
        return null;
    }
    return signature.unsign(raw.slice(2), secret) || null;
}

function addToRoom(classId, ws) {
    const id = String(classId);
    if (!rooms.has(id)) {
        rooms.set(id, new Set());
    }
    rooms.get(id).add(ws);
    ws._classclimbRoom = id;
}

function removeFromRoom(ws) {
    const id = ws._classclimbRoom;
    if (!id) {
        return;
    }
    const set = rooms.get(id);
    if (set) {
        set.delete(ws);
        if (set.size === 0) {
            rooms.delete(id);
        }
    }
    delete ws._classclimbRoom;
}

function toSafeInt(v) {
    if (v == null) {
        return null;
    }
    if (typeof v === 'bigint') {
        return Number(v);
    }
    const n = Number(v);
    if (Number.isFinite(n)) {
        return n;
    }
    const p = parseInt(String(v), 10);
    return Number.isFinite(p) ? p : null;
}

/** Plain objects safe for JSON.stringify (avoids BigInt / odd driver shapes breaking WS sends). */
function sanitizeLeaderboardRows(rows) {
    return (rows || [])
        .map((s) => {
            const id = toSafeInt(s && s.id);
            const xpRaw = s && s.xp != null ? s.xp : 0;
            const xpNum = toSafeInt(xpRaw);
            return {
                id,
                name: s && s.name != null ? String(s.name) : '',
                xp: xpNum != null ? xpNum : 0,
                class_id: toSafeInt(s && s.class_id)
            };
        })
        .filter((r) => r.id != null && Number.isFinite(r.id));
}

function leaderboardMessagePayload(students) {
    return JSON.stringify({
        type: 'leaderboard',
        students: sanitizeLeaderboardRows(students)
    });
}

const MAX_ANNOUNCEMENT_LEN = 1500;

/** Strip dangerous control chars; trim; cap length (for class-wide live messages). */
function sanitizeAnnouncementMessage(raw) {
    if (raw == null) {
        return '';
    }
    let s = String(raw);
    if (s.length > MAX_ANNOUNCEMENT_LEN) {
        s = s.slice(0, MAX_ANNOUNCEMENT_LEN);
    }
    s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    return s.trim();
}

function announcementMessagePayload(message) {
    return JSON.stringify({
        type: 'announcement',
        message: String(message)
    });
}

/** Push a custom text message to every WebSocket client in this class room (leaderboard + teacher console). */
function broadcastClassAnnouncement(classId, rawMessage) {
    const message = sanitizeAnnouncementMessage(rawMessage);
    if (!message) {
        return false;
    }
    const id = String(classId);
    const clients = rooms.get(id);
    if (!clients || clients.size === 0) {
        return true;
    }
    const payload = announcementMessagePayload(message);
    for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(payload);
            } catch (e) {
                /* ignore */
            }
        }
    }
    return true;
}

/**
 * @param {import('http').Server} httpServer
 * @param {import('express-session').Store} sessionStore
 * @param {{ cookieName: string; secret: string }} options
 */
function initRealtime(httpServer, sessionStore, options) {
    const { cookieName, secret } = options;

    const wss = new WebSocket.Server({
        server: httpServer,
        path: '/ws',
        verifyClient(info, cb) {
            const req = info.req;
            let classId;
            try {
                const u = new URL(req.url || '/', 'http://localhost');
                classId = u.searchParams.get('classId');
            } catch (e) {
                cb(false, 400, 'Bad Request');
                return;
            }
            if (!classId) {
                cb(false, 400, 'Bad Request');
                return;
            }

            const sid = parseSessionId(req.headers.cookie, cookieName, secret);
            if (!sid) {
                cb(false, 401, 'Unauthorized');
                return;
            }

            sessionStore.get(sid, (err, session) => {
                if (err || !session || !session.user_id) {
                    cb(false, 401, 'Unauthorized');
                    return;
                }
                db.get('SELECT id FROM classes WHERE id = ?', [classId], (e, row) => {
                    if (e || !row) {
                        cb(false, 404, 'Not Found');
                        return;
                    }
                    req.classclimbClassId = String(classId);
                    cb(true);
                });
            });
        }
    });

    wss.on('connection', (ws, req) => {
        const classId = req.classclimbClassId;
        if (!classId) {
            ws.close();
            return;
        }
        addToRoom(classId, ws);

        db.all(
            'SELECT * FROM students WHERE class_id = ? ORDER BY xp DESC, id ASC',
            [classId],
            (err, students) => {
                if (err || ws.readyState !== WebSocket.OPEN) {
                    return;
                }
                try {
                    ws.send(leaderboardMessagePayload(students));
                } catch (e) {
                    /* ignore */
                }
            }
        );

        ws.on('close', () => removeFromRoom(ws));
        ws.on('error', () => removeFromRoom(ws));
    });
}

function broadcastLeaderboard(classId) {
    const id = String(classId);
    const clients = rooms.get(id);
    if (!clients || clients.size === 0) {
        return;
    }

    db.all(
        'SELECT * FROM students WHERE class_id = ? ORDER BY xp DESC, id ASC',
        [id],
        (err, students) => {
            if (err) {
                return;
            }
            const payload = leaderboardMessagePayload(students);
            for (const ws of clients) {
                if (ws.readyState === WebSocket.OPEN) {
                    try {
                        ws.send(payload);
                    } catch (e) {
                        /* ignore */
                    }
                }
            }
        }
    );
}

module.exports = {
    initRealtime,
    broadcastLeaderboard,
    broadcastClassAnnouncement
};
