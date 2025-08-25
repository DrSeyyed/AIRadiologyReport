import Database from 'better-sqlite3';

let _db;
export function getDb() {
  if (!_db) {
    _db = new Database('db/pacs.db');
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
  }
  return _db;
}