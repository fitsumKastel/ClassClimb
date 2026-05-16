/**
 * When enabled, GET requests show the update page instead of the main app.
 * Set APP_UPDATE_MODE=1 (or true/on) during deploys; off by default.
 */
function isAppUpdateMode() {
    const v = (process.env.APP_UPDATE_MODE || '0').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function updatePageMessage() {
    const custom = (process.env.APP_UPDATE_MESSAGE || '').trim();
    return custom || 'We are rolling out an update. The app will be back shortly.';
}

/** Paths that stay reachable while update mode is on (admin, static assets). */
function isUpdateModeBypass(pathname) {
    if (!pathname || pathname === '/') return false;
    if (pathname.startsWith('/asset')) return true;
    if (pathname.startsWith('/status')) return true;
    return false;
}

function appUpdateModeMiddleware(req, res, next) {
    if (!isAppUpdateMode()) {
        return next();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return next();
    }
    if (isUpdateModeBypass(req.path)) {
        return next();
    }
    res.status(503);
    return res.render('update', { updateMessage: updatePageMessage() });
}

module.exports = {
    isAppUpdateMode,
    appUpdateModeMiddleware,
    updatePageMessage
};
