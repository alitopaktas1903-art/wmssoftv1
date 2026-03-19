const express = require('express');
const db = require('../db');
const { auth } = require('../middleware/auth');
const router = express.Router();

// Stok listesi
router.get('/', auth(), (req, res) => {
  const { status, location, product_id, q } = req.query;
  let sql = `SELECT s.*, p.name as product_name, p.sku, p.barcode, p.desi,
    l.code as location_code, l.name as location_name
    FROM serials s JOIN products p ON s.product_id=p.id
    LEFT JOIN locations l ON s.location_id=l.id WHERE 1=1`;
  const params = [];
  if (status) { sql += ' AND s.status=?'; params.push(status); }
  if (location) { sql += ' AND l.code=?'; params.push(location); }
  if (product_id) { sql += ' AND s.product_id=?'; params.push(product_id); }
  if (q) { sql += ' AND (s.serial_no LIKE ? OR p.sku LIKE ? OR p.name LIKE ?)'; params.push(`%${q}%`,`%${q}%`,`%${q}%`); }
  sql += ' ORDER BY s.updated_at DESC LIMIT 500';
  res.json(db.prepare(sql).all(...params));
});

// Özet stok
router.get('/summary', auth(), (req, res) => {
  res.json(db.prepare(`
    SELECT p.id, p.sku, p.name, p.desi, p.barcode,
    l.code as location_code, l.name as location_name,
    s.status, COUNT(s.id) as qty
    FROM serials s JOIN products p ON s.product_id=p.id
    LEFT JOIN locations l ON s.location_id=l.id
    WHERE s.status IN ('mk','stok')
    GROUP BY p.id, l.id, s.status ORDER BY p.name, l.code
  `).all());
});

// Seri no sorgula
router.get('/serial/:no', auth(), (req, res) => {
  const s = db.prepare(`
    SELECT s.*, p.name as product_name, p.sku, p.desi, p.width, p.height, p.depth, p.weight,
    l.code as location_code, l.name as location_name
    FROM serials s JOIN products p ON s.product_id=p.id
    LEFT JOIN locations l ON s.location_id=l.id
    WHERE s.serial_no=?
  `).get(req.params.no);
  if (!s) return res.status(404).json({ error: 'Seri no bulunamadı' });
  const history = db.prepare(`
    SELECT m.*, fl.code as from_code, tl.code as to_code, u.name as user_name
    FROM stock_movements m
    LEFT JOIN locations fl ON m.from_location_id=fl.id
    LEFT JOIN locations tl ON m.to_location_id=tl.id
    LEFT JOIN users u ON m.user_id=u.id
    WHERE m.serial_id=? ORDER BY m.created_at DESC
  `).all(s.id);
  res.json({ ...s, history });
});

// ── MAL KABUL ─────────────────────────────────────────────
router.post('/mal-kabul', auth(['admin','depo']), (req, res) => {
  try {
    const { product_id, serials, notes } = req.body;
    if (!product_id) return res.status(400).json({ error: 'Ürün gerekli' });

    // serials her zaman array yap
    let serialList = [];
    if (Array.isArray(serials)) serialList = serials;
    else if (typeof serials === 'string' && serials.trim()) serialList = [serials.trim()];
    else return res.status(400).json({ error: 'Seri no gerekli' });

    serialList = serialList.map(s => s.trim()).filter(s => s.length > 0);
    if (!serialList.length) return res.status(400).json({ error: 'Seri no gerekli' });

    // Ürün var mı kontrol
    const product = db.prepare('SELECT id FROM products WHERE id=? AND active=1').get(product_id);
    if (!product) return res.status(404).json({ error: 'Ürün bulunamadı' });

    const mkLoc = db.prepare("SELECT id FROM locations WHERE type='mk' LIMIT 1").get();
    if (!mkLoc) return res.status(500).json({ error: 'MK lokasyonu tanımlı değil. Yönetim > Lokasyonlar bölümünden MK tipi lokasyon ekleyin.' });

    let ok = 0, dup = 0;
    const tx = db.transaction(() => {
      for (const sn of serialList) {
        const existing = db.prepare('SELECT id FROM serials WHERE serial_no=?').get(sn);
        if (existing) { dup++; continue; }
        const r = db.prepare(`INSERT INTO serials (serial_no, product_id, location_id, status, notes) VALUES (?,?,?,'mk',?)`)
          .run(sn, product_id, mkLoc.id, notes||null);
        db.prepare(`INSERT INTO stock_movements (serial_id, product_id, to_location_id, movement_type, user_id, notes) VALUES (?,?,?,'mal_kabul',?,?)`)
          .run(r.lastInsertRowid, product_id, mkLoc.id, req.user.id, notes||null);
        ok++;
      }
    });
    tx();
    res.json({ message: `${ok} adet mal kabul yapıldı${dup ? `, ${dup} tekrar (atlandı)` : ''}` });
  } catch(e) {
    console.error('Mal kabul error:', e);
    res.status(500).json({ error: 'Sunucu hatası: ' + e.message });
  }
});

// ── TRANSFER ──────────────────────────────────────────────
router.post('/transfer', auth(['admin','depo']), (req, res) => {
  try {
    const { serials, to_location_id, notes } = req.body;
    if (!serials?.length || !to_location_id) return res.status(400).json({ error: 'Seri no ve hedef lokasyon gerekli' });
    const toLoc = db.prepare('SELECT * FROM locations WHERE id=?').get(to_location_id);
    if (!toLoc) return res.status(404).json({ error: 'Lokasyon bulunamadı' });
    let ok = 0;
    const tx = db.transaction(() => {
      for (const sn of serials) {
        const serial = db.prepare("SELECT * FROM serials WHERE serial_no=? AND status IN ('mk','stok')").get(sn.trim());
        if (!serial) continue;
        db.prepare(`UPDATE serials SET location_id=?, status='stok', updated_at=datetime('now') WHERE id=?`).run(to_location_id, serial.id);
        db.prepare(`INSERT INTO stock_movements (serial_id, product_id, from_location_id, to_location_id, movement_type, user_id, notes) VALUES (?,?,?,?,'transfer',?,?)`)
          .run(serial.id, serial.product_id, serial.location_id, to_location_id, req.user.id, notes||null);
        ok++;
      }
    });
    tx();
    res.json({ message: `${ok} adet transfer yapıldı` });
  } catch(e) {
    console.error('Transfer error:', e);
    res.status(500).json({ error: 'Sunucu hatası: ' + e.message });
  }
});

// ── STOK ÇIKIŞ ────────────────────────────────────────────
router.post('/cikis', auth(['admin','sevkiyat','depo']), (req, res) => {
  try {
    const { serials, shipment_id, plate, notes, force_karantina } = req.body;
    if (!serials?.length) return res.status(400).json({ error: 'Seri no gerekli' });

    // Karantina kontrolü
    if (!force_karantina) {
      const karantinaList = [];
      for (const sn of serials) {
        const serial = db.prepare(`
          SELECT s.serial_no, l.type as loc_type FROM serials s
          LEFT JOIN locations l ON s.location_id=l.id WHERE s.serial_no=?
        `).get(sn.trim());
        if (serial?.loc_type === 'karantina') karantinaList.push(serial.serial_no);
      }
      if (karantinaList.length > 0) {
        return res.status(400).json({
          error: `Karantina uyarısı — ${karantinaList.length} adet karantinada: ${karantinaList.join(', ')}`,
          karantina: true,
          items: karantinaList
        });
      }
    }

    const sevkLoc = db.prepare("SELECT id FROM locations WHERE type='sevkiyat' LIMIT 1").get();
    let ok = 0, skip = 0;
    const tx = db.transaction(() => {
      for (const sn of serials) {
        const serial = db.prepare("SELECT * FROM serials WHERE serial_no=? AND status IN ('mk','stok')").get(sn.trim());
        if (!serial) { skip++; continue; }
        db.prepare(`UPDATE serials SET status='cikis', plate=?, location_id=?, updated_at=datetime('now') WHERE id=?`)
          .run(plate||null, sevkLoc?.id||null, serial.id);
        db.prepare(`INSERT INTO stock_movements (serial_id, product_id, from_location_id, to_location_id, movement_type, user_id, notes, plate, reference) VALUES (?,?,?,?,'cikis',?,?,?,?)`)
          .run(serial.id, serial.product_id, serial.location_id, sevkLoc?.id||null, req.user.id, notes||null, plate||null, shipment_id?String(shipment_id):null);
        if (shipment_id) {
          db.prepare('INSERT OR IGNORE INTO shipment_items (shipment_id, serial_id, product_id) VALUES (?,?,?)').run(shipment_id, serial.id, serial.product_id);
        }
        ok++;
      }
    });
    tx();
    res.json({ message: `${ok} adet çıkış yapıldı${skip?' ('+skip+' bulunamadı)':''}` });
  } catch(e) {
    console.error('Cikis error:', e);
    res.status(500).json({ error: 'Sunucu hatası: ' + e.message });
  }
});

// Lokasyon listesi
router.get('/locations', auth(), (req, res) => {
  res.json(db.prepare('SELECT * FROM locations WHERE active=1 ORDER BY type, code').all());
});

router.post('/locations', auth(['admin']), (req, res) => {
  const { code, name, zone, type, capacity } = req.body;
  if (!code) return res.status(400).json({ error: 'Kod gerekli' });
  try {
    const r = db.prepare('INSERT INTO locations (code, name, zone, type, capacity) VALUES (?,?,?,?,?)').run(code, name||code, zone||null, type||'normal', capacity||null);
    res.json({ id: r.lastInsertRowid, message: 'Lokasyon oluşturuldu' });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Lokasyon kodu zaten var' });
    res.status(500).json({ error: e.message });
  }
});

// Hareket geçmişi
router.get('/movements', auth(), (req, res) => {
  const { type, product_id, date_from, date_to } = req.query;
  let sql = `SELECT m.*, p.name as product_name, p.sku,
    fl.code as from_code, tl.code as to_code,
    u.name as user_name, s.serial_no
    FROM stock_movements m JOIN products p ON m.product_id=p.id
    LEFT JOIN serials s ON m.serial_id=s.id
    LEFT JOIN locations fl ON m.from_location_id=fl.id
    LEFT JOIN locations tl ON m.to_location_id=tl.id
    LEFT JOIN users u ON m.user_id=u.id WHERE 1=1`;
  const params = [];
  if (type) { sql += ' AND m.movement_type=?'; params.push(type); }
  if (product_id) { sql += ' AND m.product_id=?'; params.push(product_id); }
  if (date_from) { sql += ' AND m.created_at>=?'; params.push(date_from); }
  if (date_to) { sql += ' AND m.created_at<=?'; params.push(date_to+' 23:59:59'); }
  sql += ' ORDER BY m.created_at DESC LIMIT 1000';
  res.json(db.prepare(sql).all(...params));
});

module.exports = router;
