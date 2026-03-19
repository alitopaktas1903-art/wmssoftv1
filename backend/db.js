const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'wms.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','depo','sevkiyat','sayim')),
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT UNIQUE NOT NULL,
    barcode TEXT,
    name TEXT NOT NULL,
    description TEXT,
    width REAL, height REAL, depth REAL, weight REAL, desi REAL,
    category TEXT, unit TEXT DEFAULT 'ADET', min_stock INTEGER DEFAULT 0,
    seri_takip INTEGER DEFAULT 1,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL, name TEXT, zone TEXT,
    type TEXT DEFAULT 'normal' CHECK(type IN ('normal','mk','sevkiyat','karantina')),
    capacity INTEGER, active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS serials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    serial_no TEXT UNIQUE NOT NULL,
    product_id INTEGER NOT NULL REFERENCES products(id),
    location_id INTEGER REFERENCES locations(id),
    status TEXT NOT NULL DEFAULT 'mk' CHECK(status IN ('mk','stok','transfer','cikis','sayim')),
    quantity INTEGER DEFAULT 1,
    plate TEXT, notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS stock_movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    serial_id INTEGER REFERENCES serials(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    from_location_id INTEGER REFERENCES locations(id),
    to_location_id INTEGER REFERENCES locations(id),
    movement_type TEXT NOT NULL,
    quantity INTEGER DEFAULT 1, plate TEXT, reference TEXT,
    user_id INTEGER REFERENCES users(id), notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS count_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    status TEXT DEFAULT 'acik' CHECK(status IN ('acik','kapali','onaylandi')),
    user_id INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now')), closed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS count_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES count_sessions(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    location_id INTEGER REFERENCES locations(id),
    serial_no TEXT, counted_qty INTEGER DEFAULT 0,
    system_qty INTEGER DEFAULT 0, difference INTEGER DEFAULT 0,
    user_id INTEGER REFERENCES users(id),
    counted_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS shipments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference TEXT UNIQUE NOT NULL, plate TEXT NOT NULL, driver TEXT,
    status TEXT DEFAULT 'hazirlaniyor',
    notes TEXT, user_id INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now')), shipped_at TEXT
  );
  CREATE TABLE IF NOT EXISTS shipment_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shipment_id INTEGER NOT NULL REFERENCES shipments(id),
    serial_id INTEGER REFERENCES serials(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    quantity INTEGER DEFAULT 1
  );

  INSERT OR IGNORE INTO users (username, password, name, role)
  VALUES ('admin', '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'Sistem Admin', 'admin');

  INSERT OR IGNORE INTO locations (code, name, type) VALUES ('MK', 'Mal Kabul', 'mk');
  INSERT OR IGNORE INTO locations (code, name, type) VALUES ('SEVK', 'Sevkiyat', 'sevkiyat');
  INSERT OR IGNORE INTO locations (code, name, type) VALUES ('A-01-01', 'Raf A-01-01', 'normal');
  INSERT OR IGNORE INTO locations (code, name, type) VALUES ('A-01-02', 'Raf A-01-02', 'normal');
  INSERT OR IGNORE INTO locations (code, name, type) VALUES ('B-01-01', 'Raf B-01-01', 'normal');
`);

// Migration — mevcut DB için
const migrations = [
  'ALTER TABLE products ADD COLUMN seri_takip INTEGER DEFAULT 1',
  'ALTER TABLE serials ADD COLUMN quantity INTEGER DEFAULT 1',
  `CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    active INTEGER DEFAULT 1
  )`,
  // EAN unique index'i kaldır (varsa)
  'DROP INDEX IF EXISTS sqlite_autoindex_products_2',

  'ALTER TABLE products ADD COLUMN seri_takip INTEGER DEFAULT 1',
  'ALTER TABLE serials ADD COLUMN quantity INTEGER DEFAULT 1',
  `CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    active INTEGER DEFAULT 1
  )`,
];
for (const m of migrations) {
  try { db.exec(m); } catch(e) { /* zaten varsa geç */ }
}

// Admin şifresini düzelt
try {
  const bcrypt = require('bcryptjs');
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  if (admin && !admin.password.startsWith('$2')) {
    db.prepare('UPDATE users SET password=? WHERE username=?')
      .run(bcrypt.hashSync('password', 10), 'admin');
    console.log('Admin şifresi düzeltildi');
  }
} catch(e) { console.error('Migration error:', e.message); }

module.exports = db;
