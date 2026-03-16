const express = require('express');
const db = require('../db');
const { auth } = require('../middleware/auth');
const router = express.Router();

// Sevkiyat listesi
router.get('/', auth(), (req, res) => {
  const { status } = req.query;
  let sql = `SELECT s.*, u.name as user_name,
    (SELECT COUNT(*) FROM shipment_items WHERE shipment_id=s.id) as item_count
    FROM shipments s LEFT JOIN users u ON s.user_id=u.id WHERE 1=1`;
  const params = [];
  if (status) { sql += ' AND s.status=?'; params.push(status); }
  sql += ' ORDER BY s.created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

// Tekil sevkiyat
router.get('/:id', auth(), (req, res) => {
  const s = db.prepare(`SELECT s.*, u.name as user_name FROM shipments s LEFT JOIN users u ON s.user_id=u.id WHERE s.id=?`).get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Sevkiyat bulunamadı' });
  const items = db.prepare(`
    SELECT si.*, sr.serial_no, p.name as product_name, p.sku, p.desi
    FROM shipment_items si
    JOIN products p ON si.product_id=p.id
    LEFT JOIN serials sr ON si.serial_id=sr.id
    WHERE si.shipment_id=?
  `).all(req.params.id);
  res.json({ ...s, items });
});

// Yeni sevkiyat oluştur
router.post('/', auth(['admin', 'sevkiyat', 'depo']), (req, res) => {
  const { plate, driver, notes } = req.body;
  if (!plate) return res.status(400).json({ error: 'Plaka gerekli' });
  const ref = 'SEV-' + Date.now();
  const r = db.prepare('INSERT INTO shipments (reference, plate, driver, notes, user_id) VALUES (?,?,?,?,?)').run(ref, plate.toUpperCase(), driver || null, notes || null, req.user.id);
  res.json({ id: r.lastInsertRowid, reference: ref, message: 'Sevkiyat oluşturuldu' });
});

// Statü güncelle
router.put('/:id/status', auth(['admin', 'sevkiyat']), (req, res) => {
  const { status } = req.body;
  const shipped_at = status === 'yuklendi' ? "datetime('now')" : 'NULL';
  db.prepare(`UPDATE shipments SET status=?, shipped_at=${shipped_at} WHERE id=?`).run(status, req.params.id);
  res.json({ message: 'Statü güncellendi' });
});

// Plakaya göre kargo takip (public benzeri — sadece token gerekiyor)
router.get('/track/:plate', auth(), (req, res) => {
  const shipments = db.prepare(`
    SELECT s.reference, s.plate, s.driver, s.status, s.created_at, s.shipped_at,
    (SELECT COUNT(*) FROM shipment_items WHERE shipment_id=s.id) as item_count
    FROM shipments s WHERE s.plate=? ORDER BY s.created_at DESC
  `).all(req.params.plate.toUpperCase());
  res.json(shipments);
});

module.exports = router;
