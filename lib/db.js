const { createJsonDbAdapter, JsonStore } = require('./json-db-adapter');

const store = JsonStore.open();
const db = createJsonDbAdapter(store);

/** Exposed for scripts that want direct document access. */
db.jsonStore = store;

module.exports = db;
