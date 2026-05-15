/**
 * Class PDF viewer (pdf.js, canvas only — no default PDF toolbar).
 * Teacher: change page + POST /class/pdf-page so leaderboard clients stay on the same slide.
 */
(function (global) {
    'use strict';

    var pdfjsLib = null;

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

    function makeCanvasWrap(className) {
        var wrap = document.createElement('div');
        wrap.className = className || 'relative w-full overflow-hidden rounded-lg border border-zinc-800 bg-[#0a0a0a]';
        var canvas = document.createElement('canvas');
        canvas.className = 'mx-auto block max-h-[min(70vh,520px)] w-auto max-w-full';
        wrap.appendChild(canvas);
        return { wrap: wrap, canvas: canvas };
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
            var w = canvas.parentElement.clientWidth || 320;
            var scale = Math.max(0.75, Math.min(2.25, (w - 8) / base.width));
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
     * @param {{ classId: string, bootstrap: object, mainRoot: HTMLElement, modalRoot?: HTMLElement|null }} opts
     */
    async function initTeacher(opts) {
        var classId = String(opts.classId || '');
        var mainRoot = opts.mainRoot;
        if (!classId || !mainRoot) return;

        var state = { boot: opts.bootstrap || {}, hasPdf: false, live: false, numPages: 0, page: 1, rev: 0, pdfUrl: '', pdf: null };
        applyPdfSyncToState(state, state.boot);

        clearEl(mainRoot);
        var ui = document.createElement('div');
        ui.className = 'rounded-2xl border border-zinc-800/90 bg-[#111] p-4 shadow-sm shadow-black/20';
        ui.innerHTML =
            '<div class="flex flex-col gap-3">' +
            '<div class="flex flex-wrap items-center justify-between gap-2">' +
            '<p class="text-xs font-semibold uppercase tracking-wide text-zinc-500">Class material (PDF)</p>' +
            '<label class="flex cursor-pointer items-center gap-2 text-xs text-zinc-300">' +
            '<input type="checkbox" id="cc-pdf-live" class="h-4 w-4 rounded border-zinc-600 bg-[#111] text-blue-600 focus:ring-blue-500/40" />' +
            '<span>Show this PDF on the leaderboard — same page as here</span>' +
            '</label>' +
            '</div>' +
            '<div class="flex flex-wrap items-center gap-2">' +
            '<input type="file" accept="application/pdf,.pdf" id="cc-pdf-file" class="max-w-full text-xs text-zinc-400 file:mr-2 file:rounded-lg file:border-0 file:bg-zinc-800 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-zinc-200" />' +
            '<button type="button" id="cc-pdf-upload" class="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-700">Upload</button>' +
            '<span id="cc-pdf-status" class="text-xs text-zinc-500"></span>' +
            '</div>' +
            '<div id="cc-pdf-nav" class="hidden flex flex-wrap items-center justify-between gap-2">' +
            '<div class="flex items-center gap-2">' +
            '<button type="button" id="cc-pdf-prev" class="rounded-lg border border-zinc-700 px-2 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-800">Prev</button>' +
            '<button type="button" id="cc-pdf-next" class="rounded-lg border border-zinc-700 px-2 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-800">Next</button>' +
            '<span id="cc-pdf-page-label" class="text-xs tabular-nums text-zinc-400"></span>' +
            '</div>' +
            '</div>' +
            '<div id="cc-pdf-canvas-host-main"></div>' +
            '</div>';
        mainRoot.appendChild(ui);

        var hostMain = ui.querySelector('#cc-pdf-canvas-host-main');
        var mainPair = makeCanvasWrap('relative w-full overflow-auto rounded-lg border border-zinc-800 bg-black');
        hostMain.appendChild(mainPair.wrap);

        var modalPair = null;
        if (opts.modalRoot) {
            clearEl(opts.modalRoot);
            modalPair = makeCanvasWrap('relative max-h-48 w-full overflow-auto rounded-lg border border-zinc-800 bg-black');
            opts.modalRoot.appendChild(modalPair.wrap);
        }

        function canvases() {
            var list = [mainPair.canvas];
            if (modalPair) list.push(modalPair.canvas);
            return list;
        }

        var liveEl = ui.querySelector('#cc-pdf-live');
        var fileEl = ui.querySelector('#cc-pdf-file');
        var uploadBtn = ui.querySelector('#cc-pdf-upload');
        var statusEl = ui.querySelector('#cc-pdf-status');
        var navEl = ui.querySelector('#cc-pdf-nav');
        var prevBtn = ui.querySelector('#cc-pdf-prev');
        var nextBtn = ui.querySelector('#cc-pdf-next');
        var pageLabel = ui.querySelector('#cc-pdf-page-label');

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

        var pdfHost = document.createElement('div');
        pdfHost.id = 'cc-leaderboard-pdf-host';
        pdfHost.className = 'mb-4 hidden w-full';
        listEl.parentNode.insertBefore(pdfHost, listEl);

        var pair = makeCanvasWrap('relative w-full overflow-auto rounded-xl border border-zinc-200 bg-white');
        pdfHost.appendChild(pair.wrap);

        var lastStudents = null;

        function applyLayout() {
            var showPdf =
                Boolean(state.live && state.hasPdf && state.numPages > 0 && state.pdf);
            pdfHost.classList.toggle('hidden', !showPdf);
            listEl.classList.toggle('hidden', showPdf);
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
            }
        };
    }

    global.ClassPdfSync = {
        initTeacher: initTeacher,
        initLeaderboard: initLeaderboard
    };
})(typeof window !== 'undefined' ? window : globalThis);
