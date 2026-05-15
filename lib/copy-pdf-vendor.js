const fs = require('fs');
const path = require('path');

/**
 * Copy pdf.js build artifacts into public/vendor (for browser import).
 * Safe to call on every server start; skips missing sources (e.g. before npm install).
 *
 * @param {string} [appRoot] - Application root (directory containing package.json). Defaults to parent of this file's lib/.
 */
function copyPdfjsVendorFiles(appRoot) {
    const root = appRoot || path.join(__dirname, '..');
    const vendor = path.join(root, 'public', 'vendor');
    const nm = path.join(root, 'node_modules', 'pdfjs-dist', 'build');
    try {
        fs.mkdirSync(vendor, { recursive: true });
    } catch {
        return;
    }
    for (const f of ['pdf.worker.min.mjs', 'pdf.min.mjs']) {
        const src = path.join(nm, f);
        const dest = path.join(vendor, f);
        try {
            if (fs.existsSync(src)) {
                fs.copyFileSync(src, dest);
            }
        } catch {
            /* ignore per-file */
        }
    }
}

module.exports = { copyPdfjsVendorFiles };
