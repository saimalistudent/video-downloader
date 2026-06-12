const path = require('path');
const fs = require('fs');

let db = null;
let sqlite3Module = null;

function loadSqlite3() {
  if (sqlite3Module !== null) return sqlite3Module;
  try {
    sqlite3Module = require('sqlite3').verbose();
  } catch (err) {
    sqlite3Module = false;
  }
  return sqlite3Module;
}

function isAvailable() {
  return Boolean(loadSqlite3());
}

function dbPath() {
  return path.join(process.cwd(), 'data', 'admin.db');
}

function openDb() {
  return new Promise(function (resolve, reject) {
    if (db) return resolve(db);
    const sqlite3 = loadSqlite3();
    if (!sqlite3) return reject(new Error('sqlite3 module not available'));

    const file = dbPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });

    db = new sqlite3.Database(file, function (err) {
      if (err) reject(err);
      else resolve(db);
    });
  });
}

function run(sql, params) {
  params = params || [];
  return openDb().then(function (database) {
    return new Promise(function (resolve, reject) {
      database.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  });
}

function get(sql, params) {
  params = params || [];
  return openDb().then(function (database) {
    return new Promise(function (resolve, reject) {
      database.get(sql, params, function (err, row) {
        if (err) reject(err);
        else resolve(row || null);
      });
    });
  });
}

function all(sql, params) {
  params = params || [];
  return openDb().then(function (database) {
    return new Promise(function (resolve, reject) {
      database.all(sql, params, function (err, rows) {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  });
}

module.exports = {
  isAvailable,
  dbPath,
  openDb,
  run,
  get,
  all,
};
