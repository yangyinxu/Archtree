// Isolated startup tests must neither load user configuration nor connect to MongoDB.
require('dotenv').config = () => ({ parsed: {} });
require('./startupDatabaseGuardPreload.cjs');
