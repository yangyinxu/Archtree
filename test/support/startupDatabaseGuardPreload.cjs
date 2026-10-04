// Startup entry tests must never connect to MongoDB; any attempt turns the exit code into 99.
let connectionAttempts = 0;
require('mongodb').MongoClient.prototype.connect = async function () {
  connectionAttempts++;
  throw new Error('Synthetic startup test forbids database connections.');
};
process.on('exit', () => {
  if (connectionAttempts !== 0) process.exitCode = 99;
});
