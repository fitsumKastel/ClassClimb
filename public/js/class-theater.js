/**
 * Teacher console: landscape layout with content rotation in portrait (no modal).
 */
(function (global) {
    'use strict';

    function isPortrait() {
        return global.innerWidth < global.innerHeight;
    }

    function isLandscapeLayout() {
        return global.innerWidth > global.innerHeight;
    }

    function isTeacherConsole() {
        return document.body.classList.contains('cc-teacher-console');
    }

    function syncContentRotation() {
        var teacherLayout = document.getElementById('cc-teacher-layout');
        if (teacherLayout && isTeacherConsole()) {
            teacherLayout.classList.toggle('cc-content-rotated', isPortrait());
        }
    }

    function syncTheaterClass() {
        if (!isTeacherConsole()) return;
        syncContentRotation();
        var effectiveLandscape = isLandscapeLayout() || isPortrait();
        document.body.classList.toggle('cc-theater-landscape', effectiveLandscape);
        document.body.classList.toggle('cc-theater-portrait-rotated', isPortrait());
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

    global.ccSyncTheaterLayout = syncTheaterClass;

    global.addEventListener('resize', syncTheaterClass);
    global.addEventListener('orientationchange', function () {
        global.setTimeout(syncTheaterClass, 100);
    });

    syncTheaterClass();
    wireRailButtons();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            syncTheaterClass();
            wireRailButtons();
        });
    }
})(typeof window !== 'undefined' ? window : globalThis);
