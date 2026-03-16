const express = require('express');
const db = require('../db');
const { auth } = require('../middleware/auth');
const router = express.Router();

// Stok listesi (seri bazlı)
router.get('/', auth(), (req, res) => {
  const { status, location, product_id, q } = req.query;
  let sql = `
    SELECT s.*, p.name as product_name, p.sku, p.barcode, p.desi,
           l.code as location_code, l.name as location_name
    FROM serials s
    JOIN products p ON s.product_id = p.id
    LEFT JOIN locations l ON s.location_id = l.id
    WHERE 1=1
  `;
  const params = [];
  if (status) { sql += ' AND s.status = ?'; params.push(status); }
  if (location) { sql += ' AND l.code = ?'; params.push(location); }
  if (product_id) { sql += ' AND s.product_id = ?'; params.push(product_id); }
  if (q) { sql += ' AND (s.serial_no LIKE ? OR p.sku LIKE ? OR p.name LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  sql += ' ORDER BY s.updated_at DESC LIMIT 500';
  res.json(db.prepare(sql).all(...params));
});

// Özet stok (ürün + lokasyon bazlı)
router.get('/summary', auth(), (req, res) => {
  const rows = db.prepare(`
    SELECT p.id, p.sku, p.name, p.desi, p.barcode,
           l.code as location_code, l.name as location_name,
           s.status, COUNT(s.id) as qty
    FROM serials s
    JOIN products p ON s.product_id = p.id
    LEFT JOIN locations l ON s.location_id = l.id
    WHERE s.status IN ('mk','stok')
    GROUP BY p.id, l.id, s.status
    ORDER BY p.name, l.code
  `).all();
  res.json(rows);
});

// Seri no sorgula
router.get('/serial/:no', auth(), (req, res) => {
  const s = db.prepare(`
    SELECT s.*, p.name as product_name, p.sku, p.desi, p.width, p.height, p.depth, p.weight,
           l.code as location_code, l.name as location_name
    FROM serials s
    JOIN products p ON s.product_id = p.id
    LEFT JOIN locations l ON s.location_id = l.id
    WHERE s.serial_no = ?
  `).get(req.params.no);
  if (!s) return res.status(404).json({ error: 'Seri no bulunamadı' });
  const history = db.prepare(`
    SELECT m.*, fl.code as from_code, tl.code as to_code, u.name as user_name
    FROM stock_movements m
    LEFT JOIN locations fl ON m.from_location_id = fl.id
    LEFT JOIN locations tl ON m.to_location_id = tl.id
    LEFT JOIN users u ON m.user_id = u.id
    WHERE m.serial_id = ?
    ORDER BY m.created_at DESC
  `).all(s.id);
  res.json({ ...s, history });
});

// ── MAL KABUL ─────────────────────────────────────────────────
router.post('/mal-kabul', auth(['admin', 'depo']), (req, res) => {
  const { product_id, serials, notes } = req.body;
  // serials: ['SN001','SN002',...] veya tek: serial_no string
  if (!product_id) return res.status(400).json({ error: 'Ürün gerekli' });
  const serialList = Array.isArray(serials) ? serials : [serials];
  if (!serialList.length || !serialList[0]) return res.status(400).json({ error: 'Seri no gerekli' });

  const mkLoc = db.prepare("SELECT id FROM locations WHERE type='mk' LIMIT 1").get();
  if (!mkLoc) return res.status(500).json({ error: 'MK lokasyonu tanımlı değil' });

  const insertSerial = db.prepare(`INSERT OR IGNORE INTO serials (serial_no, product_id, location_id, status, notes) VALUES (?, ?, ?, 'mk', ?)`);
  const insertMove = db.prepare(`INSERT INTO stock_movements (serial_id, product_id, to_location_id, movement_type, user_id, notes) VALUES (?, ?, ?, 'mal_kabul', ?, ?)`);

  const tx = db.transaction(() => {
    let ok = 0, dup = 0;
    for (const sn of serialList) {
      const trimmed = sn.trim();
      if (!trimmed) continue;
      const existing = db.prepare('SELECT id FROM serials WHERE serial_no = ?').get(trimmed);
      if (existing) { dup++; continue; }
      const r = insertSerial.run(trimmed, product_id, mkLoc.id, notes || null);
      insertMove.run(r.lastInsertRowid, product_id, mkLoc.id, req.user.id, notes || null);
      ok++;
    }
    return { ok, dup };
  });
  const result = tx();
  res.json({ message: `${result.ok} adet mal kabul yapıldı${result.dup ? `, ${result.dup} tekrar` : ''}` });
});

// ── TRANSFER ─────────────────────────────────────────────────
router.post('/transfer', auth(['admin', 'depo']), (req, res) => {
  const { serials, to_location_id, notes } = req.body;
  if (!serials?.length || !to_location_id) return res.status(400).json({ error: 'Seri no ve hedef lokasyon gerekli' });

  const toLoc = db.prepare('SELECT * FROM locations WHERE id = ?').get(to_location_id);
  if (!toLoc) return res.status(404).json({ error: 'Lokasyon bulunamadı' });

  const tx = db.transaction(() => {
    let ok = 0;
    for (const sn of serials) {
      const serial = db.prepare("SELECT * FROM serials WHERE serial_no = ? AND status IN ('mk','stok')").get(sn.trim());
      if (!serial) continue;
      db.prepare(`UPDATE serials SET location_id=?, status='stok', updated_at=datetime('now') WHERE id=?`).run(to_location_id, serial.id);
      db.prepare(`INSERT INTO stock_movements (serial_id, product_id, from_location_id, to_location_id, movement_type, user_id, notes) VALUES (?,?,?,?,'transfer',?,?)`).run(serial.id, serial.product_id, serial.location_id, to_location_id, req.user.id, notes || null);
      ok++;
    }
    return ok;
  });
  const ok = tx();
  res.json({ message: `${ok} adet transfer yapıldı` });
});

// ── STOK ÇIKIŞ / SEVKİYAT ────────────────────────────────────
router.post('/cikis', auth(['admin', 'sevkiyat', 'depo']), (req, res) => {
  const { serials, shipment_id, plate, notes, force_karantina } = req.body;
  if (!serials?.length) return res.status(400).json({ error: 'Seri no gerekli' });

  // Karantina kontrolü — force_karantina=true gönderilmediyse uyar
  if (!force_karantina) {
    const karantinaList = [];
    for (const sn of serials) {
      const serial = db.prepare(`
        SELECT s.serial_no, l.code as loc_code, l.type as loc_type
        FROM serials s LEFT JOIN locations l ON s.location_id=l.id
        WHERE s.serial_no=?
      `).get(sn.trim());
      if (serial?.loc_type === 'karantina') karantinaList.push(serial.serial_no);
    }
    if (karantinaList.length > 0) {
      return res.status(400).json({
        error: 'Karantina uyarısı',
        karantina: true,
        items: karantinaList,
        message: `${karantinaList.length} adet karantinada: ${karantinaList.join(', ')}`
      });
    }
  }

  const sevkLoc = db.prepare("SELECT id FROM locations WHERE type='sevkiyat' LIMIT 1").get();

  const tx = db.transaction(() => {
    let ok = 0, skip = 0;
    for (const sn of serials) {
      const serial = db.prepare("SELECT * FROM serials WHERE serial_no=? AND status IN ('mk','stok')").get(sn.trim());
      if (!serial) { skip++; continue; }
      db.prepare(`UPDATE serials SET status='cikis', plate=?, location_id=?, updated_at=datetime('now') WHERE id=?`)
        .run(plate||null, sevkLoc?.id||null, serial.id);
      db.prepare(`INSERT INTO stock_movements (serial_id, product_id, from_location_id, to_location_id, movement_type, user_id, notes, plate, reference)
        VALUES (?,?,?,?,'cikis',?,?,?,?)`)
        .run(serial.id, serial.product_id, serial.location_id, sevkLoc?.id||null, req.user.id, notes||null, plate||null, shipment_id?String(shipment_id):null);
      if (shipment_id) {
        db.prepare('INSERT OR IGNORE INTO shipment_items (shipment_id, serial_id, product_id) VALUES (?,?,?)').run(shipment_id, serial.id, serial.product_id);
      }
      ok++;
    }
    return { ok, skip };
  });
  const result = tx();
  res.json({ message: `${result.ok} adet çıkış yapıldı${result.skip?' ('+result.skip+' bulunamadı)':''}` });
});

// Lokasyon listesi
router.get('/locations', auth(), (req, res) => {
  res.json(db.prepare('SELECT * FROM locations WHERE active=1 ORDER BY type, code').all());
});

router.post('/locations', auth(['admin']), (req, res) => {
  const { code, name, zone, type, capacity } = req.body;
  if (!code) return res.status(400).json({ error: 'Kod gerekli' });
  try {
    const r = db.prepare('INSERT INTO locations (code, name, zone, type, capacity) VALUES (?,?,?,?,?)').run(code, name || code, zone || null, type || 'normal', capacity || null);
    res.json({ id: r.lastInsertRowid, message: 'Lokasyon oluşturuldu' });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Lokasyon kodu zaten var' });
    res.status(500).json({ error: e.message });
  }
});

// Hareket geçmişi
router.get('/movements', auth(), (req, res) => {
  const { type, product_id, date_from, date_to } = req.query;
  let sql = `
    SELECT m.*, p.name as product_name, p.sku,
           fl.code as from_code, tl.code as to_code,
           u.name as user_name, s.serial_no
    FROM stock_movements m
    JOIN products p ON m.product_id = p.id
    LEFT JOIN serials s ON m.serial_id = s.id
    LEFT JOIN locations fl ON m.from_location_id = fl.id
    LEFT JOIN locations tl ON m.to_location_id = tl.id
    LEFT JOIN users u ON m.user_id = u.id
    WHERE 1=1
  `;
  const params = [];
  if (type) { sql += ' AND m.movement_type = ?'; params.push(type); }
  if (product_id) { sql += ' AND m.product_id = ?'; params.push(product_id); }
  if (date_from) { sql += ' AND m.created_at >= ?'; params.push(date_from); }
  if (date_to) { sql += ' AND m.created_at <= ?'; params.push(date_to + ' 23:59:59'); }
  sql += ' ORDER BY m.created_at DESC LIMIT 1000';
  res.json(db.prepare(sql).all(...params));
});

module.exports = router;
