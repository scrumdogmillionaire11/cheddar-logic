/**
 * Database Client — sql.js wrapper
 * Provides synchronous-like interface to sql.js (pure JS SQLite)
 * 
 * Note: sql.js is in-memory, data is persisted via saveDatabase()
 * Call getDatabase() once, then use the same instance
 */

const initSqlJs = require('sql.js/dist/sql-asm.js');
const fs = require('fs');
const path = require('path');

let dbInstance = null;
let SQL = null;
let dbPath = null;

/**
 * Initialize the database
 * Must be called once before use
 */
async function initDatabase() {
  if (SQL) return SQL;
  
  SQL = await initSqlJs();
  return SQL;
}

/**
 * Load database from disk or create new
 */
function loadDatabase() {
  const dbFile = dbPath || (process.env.DATABASE_PATH || 
    path.join(process.env.CHEDDAR_DATA_DIR || '/tmp/cheddar-logic', 'cheddar.db'));
  
  dbPath = dbFile;
  const dir = path.dirname(dbFile);
  
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  try {
    if (fs.existsSync(dbFile)) {
      const buffer = fs.readFileSync(dbFile);
      return new SQL.Database(buffer);
    }
  } catch (e) {
    console.warn(`Failed to load existing database: ${e.message}`);
  }

  // Create new database
  return new SQL.Database();
}

/**
 * Save database to disk
 */
function saveDatabase() {
  if (!dbInstance || !dbPath) return;
  
  try {
    const data = dbInstance.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
  } catch (e) {
    console.error(`Failed to save database: ${e.message}`);
  }
}

/**
 * Get database instance
 * Initializes synchronously (sql.js must be pre-initialized)
 */
function getDatabase() {
  if (dbInstance) return dbInstance;

  if (!SQL) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }

  dbInstance = loadDatabase();
  
  // Enable foreign keys
  dbInstance.run('PRAGMA foreign_keys = ON');
  
  return dbInstance;
}

/**
 * Close and save database
 */
function closeDatabase() {
  if (dbInstance) {
    saveDatabase();
    dbInstance.close();
    dbInstance = null;
  }
}

/**
 * Wrapper for prepared statements
 */
class Statement {
  constructor(db, query) {
    this.db = db;
    this.query = query;
    this.stmt = db.prepare(query);
  }

  run(...params) {
    try {
      this.stmt.bind(params);
      this.stmt.step();
      this.stmt.reset();
      saveDatabase();
      return { changes: this.db.getRowsModified() };
    } catch (e) {
      throw new Error(`Statement error: ${e.message}`);
    }
  }

  get(...params) {
    try {
      this.stmt.bind(params);
      if (this.stmt.step()) {
        const row = this.stmt.getAsObject();
        this.stmt.reset();
        return row;
      }
      this.stmt.reset();
      return null;
    } catch (e) {
      throw new Error(`Statement error: ${e.message}`);
    }
  }

  all(...params) {
    try {
      this.stmt.bind(params);
      const results = [];
      while (this.stmt.step()) {
        results.push(this.stmt.getAsObject());
      }
      this.stmt.reset();
      return results;
    } catch (e) {
      throw new Error(`Statement error: ${e.message}`);
    }
  }
}

/**
 * Database wrapper object
 */
class DatabaseWrapper {
  constructor(sqlDb) {
    this._db = sqlDb;
  }

  prepare(query) {
    return new Statement(this._db, query);
  }

  exec(sql) {
    try {
      this._db.run(sql);
      saveDatabase();
    } catch (e) {
      throw new Error(`Exec error: ${e.message}`);
    }
  }

  pragma(pragma) {
    // Most pragmas can be ignored in sql.js
    if (pragma === 'foreign_keys = ON') {
      this._db.run('PRAGMA foreign_keys = ON');
    }
  }

  close() {
    closeDatabase();
  }
}

module.exports = {
  initDatabase,
  getDatabase: () => {
    const db = getDatabase();
    return new DatabaseWrapper(db);
  },
  closeDatabase,
  saveDatabase
};
