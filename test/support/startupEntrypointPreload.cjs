// Isolated startup tests must neither load user configuration nor connect to MongoDB.
require('dotenv').config = () => ({ parsed: {} });
let connectionAttempts = 0;
require('mongodb').MongoClient.prototype.connect = async function () {
  connectionAttempts++;
  throw new Error('Synthetic startup test forbids database connections.');
};
process.on('exit', () => {
  if (connectionAttempts !== 0) process.exitCode = 99;
});
