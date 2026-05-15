(function () {
    var openBtn = document.getElementById('tg-open-btn');
    var finishForm = document.getElementById('tg-finish-form');
    var againWrap = document.getElementById('tg-again-wrap');
    var againBtn = document.getElementById('tg-again-btn');
    if (!openBtn || !finishForm) {
        return;
    }

    var KEY = 'classclimb_tg_opened';
    var LINK_KEY = 'classclimb_pending_link_id';
    var prepareReturn = openBtn.getAttribute('data-prepare-return') || '';
    var prepareClassId = openBtn.getAttribute('data-prepare-class-id') || '';

    function showFinish() {
        openBtn.classList.add('hidden');
        finishForm.classList.remove('hidden');
        if (againWrap) {
            againWrap.classList.remove('hidden');
        }
    }

    function openTelegramApp(url) {
        window.location.assign(url);
    }

    function currentOpenUrl() {
        return openBtn.getAttribute('data-open-url') || '';
    }

    function setOpenUrl(url) {
        openBtn.setAttribute('data-open-url', url);
    }

    function rememberLinkId(id) {
        var s = String(id || '').trim();
        if (!/^[0-9a-fA-F]{16}$/.test(s)) {
            return;
        }
        try {
            sessionStorage.setItem(LINK_KEY, s);
        } catch (e) {
            /* ignore */
        }
    }

    function pageLinkId() {
        return String(openBtn.getAttribute('data-pending-link-id') || '').trim();
    }

    function go(url, optLinkId) {
        setOpenUrl(url);
        rememberLinkId(optLinkId || pageLinkId());
        showFinish();
        openTelegramApp(url);
    }

    var initialUrl = currentOpenUrl();
    if (sessionStorage.getItem(KEY) === '1' && initialUrl) {
        showFinish();
    }

    function prepareLoginThenOpen() {
        return fetch('/auth/prepare-login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            credentials: 'same-origin',
            body: JSON.stringify({
                return: prepareReturn || undefined,
                class_id: prepareClassId || undefined
            })
        })
            .then(function (r) {
                return r.json().then(function (data) {
                    return { ok: r.ok, data: data };
                });
            })
            .then(function (result) {
                if (!result.ok || !result.data.ok || !result.data.openBotUrl) {
                    var err = (result.data && result.data.error) || 'linkbot';
                    window.location.href = '/?error=' + encodeURIComponent(err);
                    return null;
                }
                return result.data;
            });
    }

    finishForm.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var submitBtn = finishForm.querySelector('button[type="submit"]');
        var hid = finishForm.querySelector('input[name="link_id"]');
        var val = hid && hid.value ? String(hid.value).trim() : '';
        if (!/^[0-9a-fA-F]{16}$/.test(val)) {
            try {
                val = sessionStorage.getItem(LINK_KEY) || '';
            } catch (e) {
                val = '';
            }
        }
        if (!/^[0-9a-fA-F]{16}$/.test(val)) {
            val = pageLinkId();
        }
        var params = new URLSearchParams();
        if (/^[0-9a-fA-F]{16}$/.test(val)) {
            params.set('link_id', val);
        }

        if (submitBtn) {
            submitBtn.disabled = true;
        }

        fetch('/auth/complete', {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
            },
            body: params.toString(),
            credentials: 'same-origin'
        })
            .then(function (r) {
                return r.text().then(function (text) {
                    var data = null;
                    var trimmed = typeof text === 'string' ? text.trim() : '';
                    if (trimmed) {
                        try {
                            data = JSON.parse(trimmed);
                        } catch (parseErr) {
                            data = {
                                ok: false,
                                message:
                                    'Server did not return JSON (status ' +
                                    r.status +
                                    '). Redeploy the latest ClassClimb code or try the Finish button again.'
                            };
                        }
                    } else {
                        data = { ok: false, message: 'Empty response from server (status ' + r.status + ').' };
                    }
                    return { httpOk: r.ok, status: r.status, data: data };
                });
            })
            .then(function (result) {
                var data = result.data;
                if (result.httpOk && data && data.ok === true && typeof data.redirect === 'string') {
                    window.location.href = data.redirect;
                    return;
                }
                var msg =
                    (data && (data.message || data.error)) ||
                    'Login failed. Use Open Telegram again.';
                if (!result.httpOk && result.status >= 500) {
                    msg = 'Server error (' + result.status + '). Try again in a moment.';
                }
                window.location.href = '/?error=' + encodeURIComponent(msg);
            })
            .catch(function () {
                window.location.href =
                    '/?error=' +
                    encodeURIComponent(
                        'Could not reach the server (offline or blocked). Check connection and try Finish again.'
                    );
            })
            .finally(function () {
                if (submitBtn) {
                    submitBtn.disabled = false;
                }
            });
    });

    openBtn.addEventListener('click', function () {
        sessionStorage.setItem(KEY, '1');

        var existing = currentOpenUrl();
        if (existing) {
            go(existing);
            return;
        }

        prepareLoginThenOpen()
            .then(function (data) {
                if (data && data.openBotUrl) {
                    go(data.openBotUrl, data.linkId);
                }
            })
            .catch(function () {
                window.location.href = '/?error=linkbot';
            });
    });

    if (againBtn) {
        againBtn.addEventListener('click', function () {
            againBtn.disabled = true;
            prepareLoginThenOpen()
                .then(function (data) {
                    if (data && data.openBotUrl) {
                        go(data.openBotUrl, data.linkId);
                    }
                })
                .catch(function () {
                    window.location.href = '/?error=linkbot';
                })
                .finally(function () {
                    againBtn.disabled = false;
                });
        });
    }
})();
