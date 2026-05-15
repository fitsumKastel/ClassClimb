/**
 * Class PDF viewer (pdf.js, canvas only — no default PDF toolbar).
 * Teacher: change page + POST /class/pdf-page so leaderboard clients stay on the same slide.
 */
(function (global) {
    'use strict';

    var pdfjsLib = null;
    var resizeHookInstalled = false;

    function loadPdfJs() {
        if (pdfjsLib) {
            return Promise.resolve(pdfjsLib);
        }
        return import('/vendor/pdf.min.mjs').then(function (lib) {
            lib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
            pdfjsLib = lib;
            return lib;
        });
    }

    function clamp(n, lo, hi) {
        return Math.min(Math.max(n, lo), hi);
    }

    function clearEl(el) {
        while (el && el.firstChild) {
            el.removeChild(el.firstChild);
        }
    }

    function isLandscapeTheater() {
        return global.innerWidth > global.innerHeight && global.innerWidth >= 480;
    }

    function measureCanvasHost(canvas) {
        var wrap = canvas && canvas.closest ? canvas.closest('.cc-pdf-canvas-wrap') : null;
        if (!wrap) {
            return { w: 320, h: 420 };
        }
        var rect = wrap.getBoundingClientRect();
        var w = Math.max(1, rect.width);
        var h = Math.max(1, rect.height);
        if (h < 64 && wrap.parentElement) {
            var pr = wrap.parentElement.getBoundingClientRect();
            h = Math.max(h, pr.height - 8);
            w = Math.max(w, pr.width - 8);
        }
        return { w: w, h: h };
    }

    function fitScale(baseViewport, dim, pad) {
        var p = pad == null ? 8 : pad;
        var scaleW = (dim.w - p) / baseViewport.width;
        var scaleH = (dim.h - p) / baseViewport.height;
        var scale = Math.min(scaleW, scaleH);
        return Math.max(0.25, Math.min(scale, 4));
    }

    function makeCanvasWrap(className) {
        var wrap = document.createElement('div');
        wrap.className = className || 'cc-pdf-canvas-wrap relative w-full overflow-hidden rounded-lg border border-zinc-800 bg-[#0a0a0a]';
        var canvas = document.createElement('canvas');
        canvas.className = 'block';
        wrap.appendChild(canvas);
        return { wrap: wrap, canvas: canvas };
    }

    function watchCanvasWrap(wrap, onResize) {
        if (!wrap || typeof onResize !== 'function') {
            return function () {};
        }
        var scheduled = null;
        function tick() {
            scheduled = null;
            onResize();
        }
        function schedule() {
            if (scheduled != null) return;
            scheduled = global.requestAnimationFrame(tick);
        }
        if (typeof global.ResizeObserver !== 'undefined') {
            var ro = new global.ResizeObserver(schedule);
            ro.observe(wrap);
            return function () {
                ro.disconnect();
                if (scheduled != null) global.cancelAnimationFrame(scheduled);
            };
        }
        global.addEventListener('resize', schedule);
        global.addEventListener('orientationchange', schedule);
        return function () {
            global.removeEventListener('resize', schedule);
            global.removeEventListener('orientationchange', schedule);
            if (scheduled != null) global.cancelAnimationFrame(scheduled);
        };
    }

    function fullscreenIconSvg() {
        return (
            '<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
            '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />' +
            '</svg>'
        );
    }

    function bindFullscreen(stageEl, btn, onChange) {
        if (!stageEl || !btn) return;
        function syncUi() {
            var on =
                document.fullscreenElement === stageEl ||
                document.webkitFullscreenElement === stageEl;
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
            btn.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Enter fullscreen');
            btn.title = on ? 'Exit fullscreen' : 'Fullscreen';
            stageEl.classList.toggle('cc-pdf-stage--fullscreen', on);
            if (typeof onChange === 'function') onChange();
        }
        btn.addEventListener('click', function () {
            var active = document.fullscreenElement || document.webkitFullscreenElement;
            if (active) {
                var exit = document.exitFullscreen || document.webkitExitFullscreen;
                if (exit) exit.call(document);
                return;
            }
            var req = stageEl.requestFullscreen || stageEl.webkitRequestFullscreen;
            if (req) req.call(stageEl);
        });
        document.addEventListener('fullscreenchange', syncUi);
        document.addEventListener('webkitfullscreenchange', syncUi);
        syncUi();
    }

    function installGlobalResizeHook(fn) {
        if (!resizeHookInstalled) {
            resizeHookInstalled = true;
            global.__ccPdfResize = fn;
        } else {
            var prev = global.__ccPdfResize;
            global.__ccPdfResize = function () {
                if (typeof prev === 'function') prev();
                fn();
            };
        }
    }

    function applyPdfSyncToState(state, data) {
        if (!data || data.type !== 'pdf_sync') {
            return;
        }
        state.boot = data;
        state.hasPdf = Boolean(data.hasPdf);
        state.live = Boolean(data.live);
        state.numPages = Number(data.numPages) || 0;
        state.page = clamp(Number(data.page) || 1, 1, Math.max(1, state.numPages));
        state.rev = Number(data.rev) || 0;
        state.pdfUrl = typeof data.pdfUrl === 'string' ? data.pdfUrl : '';
    }

    async function loadDocument(state) {
        var lib = await loadPdfJs();
        if (!state.pdfUrl) {
            state.pdf = null;
            state.numPages = 0;
            return;
        }
        var task = lib.getDocument({ url: state.pdfUrl, withCredentials: true });
        state.pdf = await task.promise;
        state.numPages = state.pdf.numPages || 0;
        state.page = clamp(state.page, 1, Math.max(1, state.numPages));
    }

    async function renderCurrent(state, canvases) {
        if (!state.pdf || !canvases || !canvases.length) {
            return;
        }
        var pageNum = clamp(state.page, 1, state.numPages);
        for (var i = 0; i < canvases.length; i++) {
            var canvas = canvases[i];
            if (!canvas || !canvas.parentElement) continue;
            var page = await state.pdf.getPage(pageNum);
            var base = page.getViewport({ scale: 1 });
            var dim = measureCanvasHost(canvas);
            var scale = fitScale(base, dim);
            var viewport = page.getViewport({ scale: scale });
            var ctx = canvas.getContext('2d');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            await page.render({ canvasContext: ctx, viewport: viewport }).promise;
        }
    }

    function postJson(url, body) {
        return fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(body)
        }).then(function (res) {
            return res.json().then(function (data) {
                return { ok: res.ok, data: data || {} };
            });
        });
    }

    /**
     * @param {{ classId: string, bootstrap: object, mainRoot: HTMLElement, modalRoot?: HTMLElement|null, pdfStage?: HTMLElement|null }} opts
     */
    async function initTeacher(opts) {
        var classId = String(opts.classId || '');
        var mainRoot = opts.mainRoot;
        if (!classId || !mainRoot) return;

        var pdfStage = opts.pdfStage || mainRoot.closest('#cc-teacher-pdf-stage') || mainRoot.parentElement;

        var state = { boot: opts.bootstrap || {}, hasPdf: false, live: false, numPages: 0, page: 1, rev: 0, pdfUrl: '', pdf: null };
        applyPdfSyncToState(state, state.boot);

        clearEl(mainRoot);
        var ui = document.createElement('div');
        ui.className =
            'cc-pdf-viewer-root flex min-h-0 flex-1 flex-col gap-2 rounded-2xl border border-zinc-800/90 bg-[#111] p-3 shadow-sm shadow-black/20 sm:p-4';
        ui.innerHTML =
            '<div class="flex flex-col gap-3">' +
            '<div class="cc-pdf-toolbar-block flex flex-wrap items-center justify-between gap-2">' +
            '<p class="text-xs font-semibold uppercase tracking-wide text-zinc-500">Class material (PDF)</p>' +
            '<label class="flex cursor-pointer items-center gap-2 text-xs text-zinc-300">' +
            '<input type="checkbox" id="cc-pdf-live" class="h-4 w-4 rounded border-zinc-600 bg-[#111] text-blue-600 focus:ring-blue-500/40" />' +
            '<span>Show this PDF on the leaderboard — same page as here</span>' +
            '</label>' +
            '</div>' +
            '<div class="cc-pdf-toolbar-block cc-pdf-toolbar-upload flex flex-wrap items-center gap-2">' +
            '<input type="file" accept="application/pdf,.pdf" id="cc-pdf-file" class="max-w-full text-xs text-zinc-400 file:mr-2 file:rounded-lg file:border-0 file:bg-zinc-800 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-zinc-200" />' +
            '<button type="button" id="cc-pdf-upload" class="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-700">Upload</button>' +
            '<span id="cc-pdf-status" class="text-xs text-zinc-500"></span>' +
            '</div>' +
            '<div id="cc-pdf-nav" class="cc-pdf-toolbar-block hidden flex flex-wrap items-center justify-between gap-2">' +
            '<div class="flex items-center gap-2">' +
            '<button type="button" id="cc-pdf-prev" class="rounded-lg border border-zinc-700 px-2 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-800">Prev</button>' +
            '<button type="button" id="cc-pdf-next" class="rounded-lg border border-zinc-700 px-2 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-800">Next</button>' +
            '<span id="cc-pdf-page-label" class="text-xs tabular-nums text-zinc-400"></span>' +
            '</div>' +
            '<button type="button" id="cc-pdf-fullscreen" class="inline-flex items-center justify-center rounded-lg border border-zinc-700 p-1.5 text-zinc-200 hover:bg-zinc-800" aria-pressed="false" aria-label="Enter fullscreen" title="Fullscreen">' +
            fullscreenIconSvg() +
            '</button>' +
            '</div>' +
            '<div id="cc-pdf-canvas-host-main" class="cc-pdf-canvas-host flex min-h-0 flex-1 flex-col"></div>' +
            '</div>';
        mainRoot.appendChild(ui);

        var hostMain = ui.querySelector('#cc-pdf-canvas-host-main');
        var mainPair = makeCanvasWrap('cc-pdf-canvas-wrap relative flex min-h-[12rem] flex-1 overflow-hidden rounded-lg border border-zinc-800 bg-black');
        hostMain.appendChild(mainPair.wrap);

        var modalPair = null;
        if (opts.modalRoot) {
            clearEl(opts.modalRoot);
            modalPair = makeCanvasWrap('cc-pdf-canvas-wrap relative max-h-48 w-full overflow-hidden rounded-lg border border-zinc-800 bg-black');
            opts.modalRoot.appendChild(modalPair.wrap);
        }

        function canvases() {
            var list = [mainPair.canvas];
            if (modalPair) list.push(modalPair.canvas);
            return list;
        }

        var unwatchMain = watchCanvasWrap(mainPair.wrap, function () {
            if (state.pdf) renderCurrent(state, canvases());
        });
        installGlobalResizeHook(function () {
            if (state.pdf) renderCurrent(state, canvases());
        });

        var liveEl = ui.querySelector('#cc-pdf-live');
        var fileEl = ui.querySelector('#cc-pdf-file');
        var uploadBtn = ui.querySelector('#cc-pdf-upload');
        var statusEl = ui.querySelector('#cc-pdf-status');
        var navEl = ui.querySelector('#cc-pdf-nav');
        var prevBtn = ui.querySelector('#cc-pdf-prev');
        var nextBtn = ui.querySelector('#cc-pdf-next');
        var pageLabel = ui.querySelector('#cc-pdf-page-label');
        var fsBtn = ui.querySelector('#cc-pdf-fullscreen');

        if (pdfStage && fsBtn) {
            bindFullscreen(pdfStage, fsBtn, function () {
                renderCurrent(state, canvases());
            });
        }

        function setStatus(t) {
            if (statusEl) statusEl.textContent = t || '';
        }

        function syncLiveCheckbox() {
            if (liveEl) liveEl.checked = Boolean(state.live);
        }

        function updateNavUi() {
            var show = Boolean(state.hasPdf && state.numPages > 0);
            if (navEl) navEl.classList.toggle('hidden', !show);
            if (pageLabel) {
                pageLabel.textContent = show ? state.page + ' / ' + state.numPages : '';
            }
        }

        async function refreshRender() {
            updateNavUi();
            syncLiveCheckbox();
            if (!state.hasPdf || !state.pdfUrl) {
                if (mainPair.canvas.getContext) {
                    var c = mainPair.canvas.getContext('2d');
                    if (c) {
                        mainPair.canvas.width = 0;
                        mainPair.canvas.height = 0;
                    }
                }
                return;
            }
            try {
                await loadDocument(state);
                await renderCurrent(state, canvases());
            } catch (e) {
                setStatus('Could not load PDF.');
            }
        }

        async function goPage(delta) {
            if (!state.numPages) return;
            var next = clamp(state.page + delta, 1, state.numPages);
            if (next === state.page) return;
            state.page = next;
            await renderCurrent(state, canvases());
            var r = await postJson('/class/pdf-page', { classId: classId, page: state.page });
            if (!r.ok || !r.data.ok) {
                setStatus('Could not sync page.');
            } else {
                setStatus('');
            }
        }

        async function setLiveFromUi() {
            var want = Boolean(liveEl && liveEl.checked);
            var r = await postJson('/class/pdf-live', { classId: classId, live: want });
            if (!r.ok || !r.data.ok) {
                setStatus('Could not update leaderboard view.');
                syncLiveCheckbox();
                return;
            }
            state.live = want;
            setStatus('');
        }

        if (liveEl) {
            liveEl.addEventListener('change', function () {
                setLiveFromUi();
            });
        }
        if (prevBtn) prevBtn.addEventListener('click', function () {
            goPage(-1);
        });
        if (nextBtn) nextBtn.addEventListener('click', function () {
            goPage(1);
        });

        if (uploadBtn && fileEl) {
            uploadBtn.addEventListener('click', async function () {
                var f = fileEl.files && fileEl.files[0];
                if (!f) {
                    setStatus('Choose a PDF file first.');
                    return;
                }
                setStatus('Uploading…');
                uploadBtn.disabled = true;
                try {
                    var fd = new FormData();
                    fd.append('pdf', f, f.name || 'material.pdf');
                    var res = await fetch('/class/material-pdf/' + encodeURIComponent(opts.viewId || ''), {
                        method: 'POST',
                        body: fd,
                        credentials: 'same-origin'
                    });
                    var data = await res.json().catch(function () {
                        return {};
                    });
                    if (!res.ok || !data.ok) {
                        setStatus(data.error === 'not_pdf' ? 'Not a valid PDF.' : 'Upload failed.');
                        uploadBtn.disabled = false;
                        return;
                    }
                    fileEl.value = '';
                    applyPdfSyncToState(state, {
                        type: 'pdf_sync',
                        hasPdf: true,
                        live: false,
                        page: 1,
                        numPages: data.numPages || 0,
                        rev: data.rev || 0,
                        pdfUrl: '/class/material-pdf/' + encodeURIComponent(opts.viewId || '') + '?rev=' + (data.rev || 0)
                    });
                    state.page = 1;
                    await refreshRender();
                    setStatus('Uploaded.');
                } catch (e) {
                    setStatus('Network error.');
                }
                uploadBtn.disabled = false;
            });
        }

        await refreshRender();

        return {
            onPdfSyncMessage: function (data) {
                var prevRev = state.rev;
                var prevUrl = state.pdfUrl;
                applyPdfSyncToState(state, data);
                syncLiveCheckbox();
                if (!state.hasPdf || !state.pdfUrl) {
                    state.pdf = null;
                    updateNavUi();
                    refreshRender();
                    return;
                }
                var needDocReload =
                    !state.pdf ||
                    prevUrl !== state.pdfUrl ||
                    (data.rev != null && Number(data.rev) !== Number(prevRev));
                if (needDocReload) {
                    refreshRender();
                } else {
                    state.page = clamp(Number(data.page) || 1, 1, Math.max(1, state.numPages));
                    updateNavUi();
                    renderCurrent(state, canvases());
                }
            },
            rerenderModal: function () {
                if (modalPair && state.pdf) {
                    renderCurrent(state, canvases());
                }
            },
            destroy: function () {
                unwatchMain();
            }
        };
    }

    /**
     * @param {{ classId: string, bootstrap: object, leaderboardRoot: HTMLElement, listContainer: HTMLElement }} opts
     */
    async function initLeaderboard(opts) {
        var classId = String(opts.classId || '');
        var root = opts.leaderboardRoot;
        var listEl = opts.listContainer;
        if (!classId || !root || !listEl) return;

        var state = { boot: opts.bootstrap || {}, hasPdf: false, live: false, numPages: 0, page: 1, rev: 0, pdfUrl: '', pdf: null };
        applyPdfSyncToState(state, state.boot);

        if (listEl.parentNode && !listEl.parentNode.classList.contains('cc-leaderboard-stack')) {
            listEl.parentNode.classList.add('cc-leaderboard-stack');
        }

        var outerLayout =
            listEl.closest('.cc-leaderboard-layout') || listEl.closest('.flex.min-h-screen');

        var pdfHost = document.createElement('div');
        pdfHost.id = 'cc-leaderboard-pdf-host';
        pdfHost.className = 'cc-leaderboard-pdf-host mb-4 hidden w-full flex flex-1 min-h-0 flex-col';
        listEl.parentNode.insertBefore(pdfHost, listEl);

        var pair = makeCanvasWrap('cc-pdf-canvas-wrap relative flex min-h-[12rem] flex-1 overflow-hidden rounded-xl border border-zinc-200 bg-white');

        var fsBar = document.createElement('div');
        fsBar.className = 'mb-2 flex justify-end';
        var fsBtn = document.createElement('button');
        fsBtn.type = 'button';
        fsBtn.className =
            'inline-flex items-center justify-center rounded-lg border border-zinc-300 bg-white p-1.5 text-zinc-700 hover:bg-zinc-50';
        fsBtn.innerHTML = fullscreenIconSvg();
        fsBar.appendChild(fsBtn);
        pdfHost.appendChild(fsBar);
        pdfHost.appendChild(pair.wrap);

        bindFullscreen(pdfHost, fsBtn, function () {
            renderCurrent(state, [pair.canvas]);
        });

        var unwatch = watchCanvasWrap(pair.wrap, function () {
            if (state.pdf) renderCurrent(state, [pair.canvas]);
        });

        var lastStudents = null;

        function applyLayout() {
            var showPdf = Boolean(state.live && state.hasPdf && state.numPages > 0 && state.pdf);
            var landscape = isLandscapeTheater();

            if (outerLayout) {
                outerLayout.classList.toggle('cc-leaderboard-pdf-active', showPdf);
            }

            pdfHost.classList.toggle('hidden', !showPdf);

            if (!showPdf) {
                listEl.classList.remove('hidden');
                if (typeof global.ccTailwindRefresh === 'function') global.ccTailwindRefresh();
                return;
            }

            if (landscape) {
                listEl.classList.remove('hidden');
            } else {
                listEl.classList.add('hidden');
            }

            if (typeof global.ccTailwindRefresh === 'function') global.ccTailwindRefresh();
        }

        async function refreshRender() {
            if (!state.hasPdf || !state.live || !state.pdfUrl) {
                state.pdf = null;
                applyLayout();
                return;
            }
            try {
                await loadDocument(state);
                await renderCurrent(state, [pair.canvas]);
            } catch (e) {
                state.pdf = null;
            }
            applyLayout();
        }

        global.addEventListener('resize', function () {
            applyLayout();
            if (state.pdf) renderCurrent(state, [pair.canvas]);
        });
        global.addEventListener('orientationchange', function () {
            global.setTimeout(function () {
                applyLayout();
                if (state.pdf) renderCurrent(state, [pair.canvas]);
            }, 100);
        });

        await refreshRender();

        return {
            onPdfSyncMessage: function (data) {
                applyPdfSyncToState(state, data);
                refreshRender();
            },
            cacheStudents: function (students) {
                lastStudents = students;
            },
            getCachedStudents: function () {
                return lastStudents;
            },
            destroy: function () {
                unwatch();
            }
        };
    }

    global.ClassPdfSync = {
        initTeacher: initTeacher,
        initLeaderboard: initLeaderboard
    };
})(typeof window !== 'undefined' ? window : globalThis);
