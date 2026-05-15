const fs = require('fs');
const path = require('path');
const { getClassMaterialsDir } = require('./storage-paths');

function materialsRoot() {
    return getClassMaterialsDir();
}

function ensureMaterialsDir() {
    fs.mkdirSync(materialsRoot(), { recursive: true });
}

function pdfFilePathForClass(classId) {
    return path.join(materialsRoot(), `${Number(classId)}.pdf`);
}

function classHasPdfFile(classId) {
    try {
        return fs.existsSync(pdfFilePathForClass(classId));
    } catch {
        return false;
    }
}

function deleteClassPdf(classId) {
    try {
        const p = pdfFilePathForClass(classId);
        if (fs.existsSync(p)) {
            fs.unlinkSync(p);
        }
    } catch {
        /* ignore */
    }
}

/** First bytes should be %PDF */
function looksLikePdf(buffer) {
    if (!buffer || buffer.length < 5) {
        return false;
    }
    const head = String.fromCharCode(buffer[0], buffer[1], buffer[2], buffer[3], buffer[4]);
    return head === '%PDF-';
}

const MAX_CLASS_PDF_BYTES = 20 * 1024 * 1024;

async function countPdfPages(buffer) {
    try {
        const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const task = getDocument({
            data: new Uint8Array(buffer),
            disableWorker: true,
            useSystemFonts: true
        });
        const pdf = await task.promise;
        const n = pdf.numPages;
        await pdf.destroy();
        return typeof n === 'number' && Number.isFinite(n) ? n : 0;
    } catch {
        return 0;
    }
}

module.exports = {
    ensureMaterialsDir,
    pdfFilePathForClass,
    classHasPdfFile,
    deleteClassPdf,
    looksLikePdf,
    MAX_CLASS_PDF_BYTES,
    countPdfPages
};

Object.defineProperty(module.exports, 'materialsDir', {
    enumerable: true,
    get() {
        return getClassMaterialsDir();
    }
});
