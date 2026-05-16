/** Trim and uppercase class / school labels for storage and display. */
function formatClassLabel(raw) {
    if (typeof raw !== 'string') {
        return '';
    }
    return raw.trim().toUpperCase();
}

module.exports = { formatClassLabel };
