/**
 * Only allow same-origin relative paths (prevents open redirects).
 */
function safeReturnPath(url) {
    if (!url || typeof url !== 'string') {
        return null;
    }
    const u = url.trim();
    if (!u.startsWith('/') || u.startsWith('//')) {
        return null;
    }
    if (u.includes('://')) {
        return null;
    }
    return u;
}

function requireUser(req, res, next) {
    if (!req.session.user_id) {
        const returnTo = encodeURIComponent(req.originalUrl);
        res.redirect(303, `/auth/login?return=${returnTo}`);
        return;
    }
    next();
}

module.exports = {
    safeReturnPath,
    requireUser
};
