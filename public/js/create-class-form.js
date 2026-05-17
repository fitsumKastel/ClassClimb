(function () {
    function createClassErrorMessage(data) {
        if (!data || !data.error) {
            return 'Could not create class. Please try again.';
        }
        switch (data.error) {
            case 'invalid_nonce':
                return 'Session refreshed — try creating again.';
            case 'missing_fields':
                return 'Enter both a class name and a school name.';
            case 'not_signed_in':
                return 'Your session expired. Refresh the page and sign in again.';
            case 'storage_failed':
                return 'Server could not save the class (storage). Set CLASSCLIMB_STORAGE_ROOT on the host.';
            case 'create_failed':
                return 'Could not create class. Please try again.';
            default:
                return 'Could not create class. Please try again.';
        }
    }

    function applyFormNonce(form, formNonce) {
        if (!form || !formNonce) {
            return;
        }
        var nonceInput = form.querySelector('[name=_formNonce]');
        if (nonceInput) {
            nonceInput.value = formNonce;
        }
    }

    /**
     * @param {HTMLFormElement} form
     * @param {{ errEl?: HTMLElement, submitBtn?: HTMLButtonElement, onSuccess?: function(object): void }} opts
     */
    window.classclimbBindCreateClassForm = function (form, opts) {
        opts = opts || {};
        var errEl = opts.errEl || document.getElementById('create-class-error');
        var submitBtn = opts.submitBtn || document.getElementById('create-class-submit');
        if (!form) {
            return;
        }

        form.addEventListener('submit', function (e) {
            e.preventDefault();
            if (errEl) {
                errEl.textContent = '';
                errEl.classList.add('hidden');
            }

            var prevText = submitBtn ? submitBtn.textContent : '';
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.textContent = 'Creating…';
            }

            function postOnce(allowNonceRetry) {
                var fd = new FormData(form);
                var body = new URLSearchParams(fd);
                return fetch(form.action, {
                    method: 'POST',
                    headers: {
                        Accept: 'application/json',
                        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
                    },
                    body: body.toString(),
                    credentials: 'same-origin'
                })
                    .then(function (res) {
                        var ct = res.headers.get('content-type') || '';
                        if (ct.includes('application/json')) {
                            return res.json().then(function (data) {
                                return { ok: res.ok, data: data };
                            });
                        }
                        return { ok: false, data: null };
                    })
                    .then(function (result) {
                        if (
                            allowNonceRetry &&
                            result.data &&
                            result.data.error === 'invalid_nonce' &&
                            result.data.formNonce
                        ) {
                            applyFormNonce(form, result.data.formNonce);
                            return postOnce(false);
                        }
                        return result;
                    });
            }

            postOnce(true)
                .then(function (result) {
                    if (result.ok && result.data && result.data.ok && result.data.class) {
                        applyFormNonce(form, result.data.formNonce);
                        if (typeof opts.onSuccess === 'function') {
                            opts.onSuccess(result.data);
                        }
                        return;
                    }
                    if (errEl) {
                        errEl.textContent = createClassErrorMessage(result.data);
                        errEl.classList.remove('hidden');
                    }
                    if (result.data && result.data.formNonce) {
                        applyFormNonce(form, result.data.formNonce);
                    }
                })
                .catch(function () {
                    if (errEl) {
                        errEl.textContent = 'Network error. Check your connection and try again.';
                        errEl.classList.remove('hidden');
                    }
                })
                .finally(function () {
                    if (submitBtn) {
                        submitBtn.disabled = false;
                        submitBtn.textContent = prevText || 'Create class';
                    }
                });
        });
    };
})();
