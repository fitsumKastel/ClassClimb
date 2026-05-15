/**
 * Landscape theater mode: hide top nav, enable left-rail tools on teacher console.
 */
(function (global) {
    'use strict';

    var mq = global.matchMedia('(orientation: landscape) and (min-width: 640px)');

    function syncTheaterClass() {
        var on = mq.matches;
        document.body.classList.toggle('cc-theater-landscape', on);
        if (typeof global.ccTailwindRefresh === 'function') {
            global.ccTailwindRefresh();
        }
        if (typeof global.__ccPdfResize === 'function') {
            global.__ccPdfResize();
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

    if (typeof mq.addEventListener === 'function') {
        mq.addEventListener('change', syncTheaterClass);
    } else if (typeof mq.addListener === 'function') {
        mq.addListener(syncTheaterClass);
    }

    syncTheaterClass();
    wireRailButtons();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wireRailButtons);
    }
})(typeof window !== 'undefined' ? window : globalThis);
