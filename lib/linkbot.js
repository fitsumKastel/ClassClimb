const axios = require('axios');
const db = require('./db');

function apiBase() {
    return (process.env.LINKBOT_API_BASE || 'https://linkbot.eweei.com/api').replace(/\/$/, '');
}

function apiKey() {
    return (process.env.LINKBOT_API_KEY || process.env.LINKBOT_KEY || '').trim();
}

function apiHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    const key = apiKey();
    if (key) {
        headers['X-API-Key'] = key;
    }
    return headers;
}

const DEFAULT_BOT_WEB = 'https://t.me/Link_account_bot';

function parseTelegramBotUsername(botUrl) {
    const raw = String(botUrl || '').trim();
    const fallback = 'Link_account_bot';
    if (!raw) {
        return fallback;
    }
    try {
        const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
        if (u.protocol === 'tg:') {
            const d = u.searchParams.get('domain');
            if (d) {
                return d.replace(/^@/, '');
            }
        }
        if (u.hostname === 't.me' || u.hostname === 'www.t.me' || u.hostname === 'telegram.me') {
            const seg = u.pathname.replace(/^\//, '').split('/')[0];
            if (seg) {
                return seg.replace(/^@/, '');
            }
        }
    } catch {
        /* ignore */
    }
    return fallback;
}

/**
 * Opens the Telegram app (not the t.me web page). Same window: use location.assign(href).
 * https://core.telegram.org/bots/features#deep-linking
 */
function telegramAppStartUrl(botUrl, linkId) {
    const domain = parseTelegramBotUsername(botUrl || DEFAULT_BOT_WEB);
    const payload = String(linkId || '').trim();
    const q = new URLSearchParams();
    q.set('domain', domain);
    if (payload) {
        q.set('start', payload);
    }
    return `tg://resolve?${q.toString()}`;
}

/**
 * HTTPS t.me link (browser). Prefer telegramAppStartUrl for the in-app login button.
 */
function telegramBotStartUrl(botUrl, linkId) {
    const base = String(botUrl || DEFAULT_BOT_WEB).trim();
    const payload = String(linkId || '').trim();
    if (!payload) {
        return base;
    }
    try {
        const u = new URL(base.includes('://') ? base : `https://${base}`);
        u.searchParams.set('start', payload);
        return u.toString();
    } catch {
        const join = base.includes('?') ? '&' : '?';
        return `${base}${join}start=${encodeURIComponent(payload)}`;
    }
}

/** Copy LINKBOT_SITE_SECRET / LINKBOT_SECRET from env into app_settings so create_link works without editing .env after the first boot. */
async function seedLinkbotSiteSecretFromEnv() {
    const s = (process.env.LINKBOT_SITE_SECRET || process.env.LINKBOT_SECRET || '').trim();
    if (!s || typeof db.setSetting !== 'function') {
        return;
    }
    try {
        await db.setSetting('linkbot_site_secret', s);
    } catch (e) {
        console.warn('Linkbot: could not save site secret to database:', e && e.message ? e.message : e);
    }
}

/**
 * Register a 16-char hex link with LinkBot (same flow as JustAGuess create_link.php).
 */
async function createLink(linkId, siteName) {
    const base = apiBase();
    const siteNameFinal = (siteName || process.env.SITE_NAME || 'ClassClimb').trim();
    const id = String(linkId).trim();
    if (!/^[0-9a-fA-F]{16}$/.test(id) || !siteNameFinal) {
        return { success: false, error: 'Invalid link_id or site_name', site_secret: null };
    }

    let siteSecret = (
        process.env.LINKBOT_SITE_SECRET ||
        process.env.LINKBOT_SECRET ||
        ''
    ).trim();
    if (!siteSecret && typeof db.getSetting === 'function') {
        try {
            siteSecret = String((await db.getSetting('linkbot_site_secret')) || '').trim();
        } catch (e) {
            siteSecret = '';
        }
    }

    const payload = { link_id: id, site_name: siteNameFinal };
    if (siteSecret) {
        payload.site_secret = siteSecret;
    }

    try {
        const url = `${base}/create_link.php`;
        const { data, status } = await axios.post(url, payload, {
            headers: apiHeaders(),
            timeout: 10000,
            validateStatus: () => true
        });

        if (status >= 200 && status < 300) {
            const secretFromBody =
                data && typeof data.site_secret === 'string' ? String(data.site_secret).trim() : '';
            const toStore = (secretFromBody || siteSecret || '').trim();
            if (toStore && typeof db.setSetting === 'function') {
                try {
                    await db.setSetting('linkbot_site_secret', toStore);
                } catch (_) {
                    /* ignore */
                }
            }
            return { success: true, error: null, site_secret: secretFromBody || null };
        }

        const errMsg =
            data && typeof data.error === 'string'
                ? data.error
                : data && typeof data.message === 'string'
                  ? data.message
                  : `HTTP ${status}`;
        return { success: false, error: errMsg, site_secret: null };
    } catch (e) {
        return {
            success: false,
            error: e.message || 'LinkBot request failed',
            site_secret: null
        };
    }
}

/**
 * GET check.php – whether the user has pasted the code in the bot.
 */
async function checkConnection(linkId) {
    const base = apiBase();
    const id = String(linkId).trim();
    if (!id || !/^[0-9a-fA-F]{16}$/.test(id)) {
        return { connected: false, error: 'Invalid link_id' };
    }

    let url = `${base}/check.php?link_id=${encodeURIComponent(id)}`;
    const key = apiKey();
    if (key) {
        url += `&api_key=${encodeURIComponent(key)}`;
    }

    try {
        const { data, status } = await axios.get(url, {
            headers: {
                Accept: 'application/json',
                ...(key ? { 'X-API-Key': key } : {})
            },
            timeout: 5000,
            validateStatus: () => true
        });

        if (!data || typeof data !== 'object') {
            return { connected: false, error: 'Invalid response' };
        }

        const linked = Object.prototype.hasOwnProperty.call(data, 'linked')
            ? Boolean(data.linked)
            : Boolean(data.connected);

        return {
            connected: linked,
            error: typeof data.error === 'string' ? data.error : null
        };
    } catch (e) {
        return { connected: false, error: e.message || 'check failed' };
    }
}

/**
 * GET get_user.php – telegram_id / telegram_name after linked.
 */
async function getUser(linkId) {
    const base = apiBase();
    const id = String(linkId).trim();
    if (!id || !/^[0-9a-fA-F]{16}$/.test(id)) {
        return null;
    }

    let url = `${base}/get_user.php?link_id=${encodeURIComponent(id)}`;
    const key = apiKey();
    if (key) {
        url += `&api_key=${encodeURIComponent(key)}`;
    }

    try {
        const { data, status } = await axios.get(url, {
            headers: {
                Accept: 'application/json',
                ...(key ? { 'X-API-Key': key } : {})
            },
            timeout: 5000,
            validateStatus: () => true
        });

        if (status < 200 || status >= 300 || !data || typeof data !== 'object') {
            return null;
        }

        // Match check.php: some deployments use `linked`, others `connected` (get_user must not be stricter than check)
        const linked = Object.prototype.hasOwnProperty.call(data, 'linked')
            ? Boolean(data.linked)
            : Boolean(data.connected);
        if (!linked) {
            return null;
        }

        const telegramRaw =
            data.telegram_id != null
                ? data.telegram_id
                : data.telegramId != null
                  ? data.telegramId
                  : data.user_id != null
                    ? data.user_id
                    : null;
        const telegramId = telegramRaw != null ? String(telegramRaw).trim() : '';
        if (!telegramId) {
            return null;
        }

        return {
            ...data,
            connected: true,
            telegram_id: telegramId
        };
    } catch (e) {
        return null;
    }
}

/** Full URL to the live leaderboard for Telegram notifications (requires SITE_URL). */
function publicLeaderboardUrl(classId) {
    const base = (process.env.SITE_URL || '').trim().replace(/\/$/, '');
    if (!base) {
        return '';
    }
    const id = String(classId == null ? '' : classId).trim();
    if (!id || !/^\d+$/.test(id)) {
        return '';
    }
    return `${base}/view/${id}`;
}

const NOTIFY_TIMEOUT_MS = 10000;

/**
 * POST notify.php – one request: `message` plus `link_id` (single) or `link_ids` (broadcast).
 */
async function notifySubscribers(linkIds, message) {
    const base = apiBase();
    const msg = String(message).trim();
    const ids = Array.from(
        new Set(
            (Array.isArray(linkIds) ? linkIds : [])
                .map((x) => String(x == null ? '' : x).trim())
                .filter((id) => /^[0-9a-fA-F]{16}$/.test(id))
        )
    );
    if (!ids.length || !msg) {
        return { success: false };
    }

    const payload = { message: msg };
    if (ids.length === 1) {
        payload.link_id = ids[0];
    } else {
        payload.link_ids = ids;
    }
    const key = apiKey();
    if (key) {
        payload.api_key = key;
    }

    try {
        const url = `${base}/notify.php`;
        const { status } = await axios.post(url, payload, {
            headers: apiHeaders(),
            timeout: NOTIFY_TIMEOUT_MS,
            validateStatus: () => true
        });
        return { success: status >= 200 && status < 300 };
    } catch (e) {
        console.log('Linkbot notify error:', e.message);
        return { success: false };
    }
}

async function notifyLink(linkId, message) {
    return notifySubscribers([linkId], message);
}

function broadcastXP(classId, studentName, xpAmount) {
    const appNameRaw = typeof process.env.SITE_NAME === 'string' ? process.env.SITE_NAME.trim() : '';
    const appName = appNameRaw || 'ClassClimb';

    db.get(
        'SELECT class_name, school_name FROM classes WHERE id = ?',
        [classId],
        (classErr, classRow) => {
            if (classErr || !classRow) {
                return;
            }

            const classParts = [classRow.class_name, classRow.school_name]
                .map((s) => (typeof s === 'string' ? s.trim() : ''))
                .filter(Boolean);
            const classLabel = classParts.length ? classParts.join(' · ') : `Class #${classId}`;

            const stu = String(studentName || '').trim() || 'A student';
            const xpNum = Number(xpAmount);
            const n = Number.isFinite(xpNum) ? Math.trunc(xpNum) : 0;
            const xpLine =
                n > 0
                    ? `${stu} earned +${n} XP.`
                    : n < 0
                      ? `${stu} lost ${Math.abs(n)} XP.`
                      : `${stu} — XP unchanged.`;

            const boardUrl = publicLeaderboardUrl(classId);
            let msg = `${appName} — ${classLabel} — ${xpLine}`;
            if (boardUrl) {
                msg += `\n\nOpen leaderboard: ${boardUrl}`;
            }

            db.all(
                'SELECT DISTINCT link_id FROM subscriptions WHERE class_id = ? AND link_id IS NOT NULL AND link_id != ?',
                [classId, ''],
                (err, rows) => {
                    if (err || !rows || !rows.length) {
                        return;
                    }
                    const linkIds = rows.map((row) => row.link_id).filter(Boolean);
                    notifySubscribers(linkIds, msg).catch(() => {});
                }
            );
        }
    );
}

module.exports = {
    seedLinkbotSiteSecretFromEnv,
    createLink,
    checkConnection,
    getUser,
    notifyLink,
    notifySubscribers,
    broadcastXP,
    telegramBotStartUrl,
    telegramAppStartUrl
};
