/**
 * Landscape theater: overlay side navs on PDF, rotate page content in portrait (no modal).
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

    function isLeaderboardTheater() {
        return document.body.classList.contains('cc-leaderboard-theater');
    }

    function syncContentRotation() {
        var portrait = isPortrait();
        var teacherLayout = document.getElementById('cc-teacher-layout');
        var lbWrap = document.getElementById('leaderboard-page-wrap');
        if (teacherLayout && isTeacherConsole()) {
            teacherLayout.classList.toggle('cc-content-rotated', portrait);
        }
        if (lbWrap) {
            lbWrap.classList.toggle(
                'cc-content-rotated',
                portrait && lbWrap.classList.contains('cc-leaderboard-pdf-active')
            );
        }
    }

    function effectiveLandscape() {
        if (isLandscapeLayout()) return true;
        if (!isPortrait()) return false;
        if (isTeacherConsole()) return true;
        var lbWrap = document.getElementById('leaderboard-page-wrap');
        return !!(lbWrap && lbWrap.classList.contains('cc-leaderboard-pdf-active'));
    }

    function syncTheaterClass() {
        syncContentRotation();
        document.body.classList.toggle('cc-theater-landscape', effectiveLandscape());
        document.body.classList.toggle(
            'cc-theater-portrait-rotated',
            isPortrait() &&
                (isTeacherConsole() ||
                    !!(
                        document.getElementById('leaderboard-page-wrap') &&
                        document.getElementById('leaderboard-page-wrap').classList.contains('cc-leaderboard-pdf-active')
                    ))
        );
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
            ['cc-rail-open-drawer', 'class-manage-menu-btn'],
            ['cc-lb-rail-menu', 'leaderboard-menu-btn'],
            ['cc-lb-rail-refresh', 'leaderboard-refresh-btn']
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
