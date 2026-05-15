/**
 * Title-case a single segment (first letter upper, rest lower). Uses en-US for consistent casing.
 */
function titleCaseSegment(segment) {
    if (!segment) {
        return '';
    }
    const lower = segment.toLocaleLowerCase('en-US');
    const first = lower.charAt(0).toLocaleUpperCase('en-US');
    return first + lower.slice(1);
}

/**
 * Format a full student name: trim, collapse spaces, title-case each word (space-separated)
 * and each hyphenated part (e.g. "jean-pierre marie" -> "Jean-Pierre Marie").
 */
function formatStudentName(raw) {
    const collapsed = String(raw || '')
        .trim()
        .replace(/\s+/g, ' ');
    if (!collapsed) {
        return '';
    }
    return collapsed
        .split(' ')
        .map((word) =>
            word
                .split('-')
                .map((part) => titleCaseSegment(part))
                .join('-')
        )
        .join(' ');
}

module.exports = { formatStudentName, titleCaseSegment };
