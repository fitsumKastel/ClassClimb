/**
 * Landscape theater: hide top bar, use left side nav; trigger PDF resize on layout change.
 */
(function (global) {
    'use strict';

    function isLandscapeLayout() {
        return global.innerWidth > global.innerHeight && global.innerWidth >= 480;
    }

    function syncTheaterClass() {
        var on = isLandscapeLayout();
        document.body.classList.toggle('cc-theater-landscape', on);
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
    wireRailButtons();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            syncTheaterClass();
            wireRailButtons();
        });
    }
})(typeof window !== 'undefined' ? window : globalThis);
