(function () {
    function applyUppercase(el) {
        var start = el.selectionStart;
        var end = el.selectionEnd;
        var next = el.value.toUpperCase();
        if (el.value === next) {
            return;
        }
        el.value = next;
        if (start != null && end != null) {
            try {
                el.setSelectionRange(start, end);
            } catch (e) {
                /* ignore */
            }
        }
    }

    function bindUppercaseInput(el) {
        if (!el || el.dataset.uppercaseBound === '1') {
            return;
        }
        el.dataset.uppercaseBound = '1';
        el.classList.add('uppercase');
        el.addEventListener('input', function () {
            applyUppercase(el);
        });
        el.addEventListener('paste', function () {
            requestAnimationFrame(function () {
                applyUppercase(el);
            });
        });
    }

    function init() {
        document.querySelectorAll('[data-uppercase-input]').forEach(bindUppercaseInput);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
