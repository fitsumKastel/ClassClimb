/**
 * Landscape theater: left student list, center PDF, right menu rail.
 * On portrait phones, request landscape and show a rotate prompt when needed.
 */
(function (global) {
    'use strict';

    var rotatePrompt = null;
    var landscapeLockAttempted = false;

    function isPortrait() {
        return global.innerWidth < global.innerHeight;
    }

    function isLandscapeLayout() {
        return global.innerWidth > global.innerHeight;
    }

    function isTeacherConsole() {
        return document.body.classList.contains('cc-teacher-console');
    }

    function getRotatePrompt() {
        if (!rotatePrompt) {
            rotatePrompt = document.getElementById('cc-rotate-prompt');
        }
        return rotatePrompt;
    }

    function showRotatePrompt() {
        if (!isTeacherConsole() || !isPortrait()) return;
        var el = getRotatePrompt();
        if (!el) return;
        el.classList.remove('hidden');
        el.setAttribute('aria-hidden', 'false');
    }

    function hideRotatePrompt() {
        var el = getRotatePrompt();
        if (!el) return;
        el.classList.add('hidden');
        el.setAttribute('aria-hidden', 'true');
    }

    function tryLockLandscape() {
        if (!isTeacherConsole() || !isPortrait()) return;
        var orient = global.screen && global.screen.orientation;
        if (!orient || typeof orient.lock !== 'function') {
            showRotatePrompt();
            return;
        }
        orient
            .lock('landscape')
            .then(function () {
                hideRotatePrompt();
            })
            .catch(function () {
                showRotatePrompt();
            });
    }

    function requestLandscapeOnPhone() {
        if (!isTeacherConsole()) return;
        if (!isPortrait()) {
            hideRotatePrompt();
            return;
        }
        if (!landscapeLockAttempted) {
            landscapeLockAttempted = true;
            tryLockLandscape();
        } else {
            showRotatePrompt();
        }
    }

    function syncTheaterClass() {
        var on = isLandscapeLayout();
        document.body.classList.toggle('cc-theater-landscape', on);
        if (on) {
            hideRotatePrompt();
        } else if (isTeacherConsole()) {
            requestLandscapeOnPhone();
        }
        if (typeof global.ccTailwindRefresh === 'function') {
            global.ccTailwindRefresh();
        }
        if (typeof global.__ccPdfResize === 'function') {
            global.requestAnimationFrame(function () {
                global.__ccPdfResize();
            });
        }
    }

    function wireRailButtons() {
        var map = [
            ['cc-rail-open-add-students', 'open-add-students-modal'],
            ['cc-rail-open-broadcast', 'open-broadcast-class-modal'],
            ['cc-rail-open-drawer', 'class-manage-menu-btn']
        ];
        map.forEach(function (pair) {
            var rail = document.getElementById(pair[0]);
            var target = document.getElementById(pair[1]);
            if (!rail || !target || rail.dataset.ccWired === '1') return;
            rail.dataset.ccWired = '1';
            rail.addEventListener('click', function () {
                target.click();
            });
        });
    }

    global.addEventListener('resize', syncTheaterClass);
    global.addEventListener('orientationchange', function () {
        global.setTimeout(syncTheaterClass, 100);
    });

    syncTheaterClass();
    requestLandscapeOnPhone();
    wireRailButtons();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            syncTheaterClass();
            requestLandscapeOnPhone();
            wireRailButtons();
        });
    }
})(typeof window !== 'undefined' ? window : globalThis);
