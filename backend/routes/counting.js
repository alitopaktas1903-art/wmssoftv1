const express = require('express');
const db = require('../db');
const { auth } = require('../middleware/auth');
const router = express.Router();

// Sayım oturumları
router.get('/', auth(), (req, res) => {
  const sessions = db.prepare(`
    SELECT cs.*, u.name as user_name,
    (SELECT COUNT(*) FROM count_items WHERE session_id=cs.id) as item_count
    FROM count_sessions cs LEFT JOIN users u ON cs.user_id=u.id
    ORDER BY cs.created_at DESC
  `).all();
  res.json(sessions);
});

// Yeni sayım oturumu
router.post('/', auth(['admin', 'depo', 'sayim']), (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Sayım adı gerekli' });
  const r = db.prepare('INSERT INTO count_sessions (name, user_id) VALUES (?,?)').run(name, req.user.id);
  res.json({ id: r.lastInsertRowid, message: 'Sayım oturumu açıldı' });
});

// Sayım kalemi ekle / güncelle (el terminali okutma)
router.post('/:id/scan', auth(['admin', 'depo', 'sayim']), (req, res) => {
  const { serial_no, product_id, location_id, qty } = req.body;
  const session = db.prepare("SELECT * FROM count_sessions WHERE id=? AND status='acik'").get(req.params.id);
  if (!session) return res.status(400).json({ error: 'Aktif sayım oturumu yok' });

  // Seri no ile ürün bul
  let pid = product_id;
  let sn = serial_no;
  if (sn && !pid) {
    const serial = db.prepare('SELECT product_id FROM serials WHERE serial_no=?').get(sn);
    if (serial) pid = serial.product_id;
    else {
      // Barkod/SKU olarak dene
      const prod = db.prepare('SELECT id FROM products WHERE barcode=? OR sku=?').get(sn, sn);
      if (prod) { pid = prod.id; sn = null; }
    }
  }
  if (!pid) return res.status(404).json({ error: 'Ürün tanımlanamadı' });

  // Sistem stok miktarını hesapla
  const systemQty = db.prepare(`
    SELECT COUNT(*) as cnt FROM serials
    WHERE product_id=? AND status IN ('mk','stok')
    ${location_id ? 'AND location_id=?' : ''}
  `).get(pid, ...(location_id ? [location_id] : [])).cnt;

  // Var ise güncelle, yoksa ekle
  const existing = db.prepare('SELECT * FROM count_items WHERE session_id=? AND product_id=? AND (location_id=? OR (location_id IS NULL AND ? IS NULL))').get(req.params.id, pid, location_id || null, location_id || null);

  const counted = qty !== undefined ? parseInt(qty) : (existing ? existing.counted_qty + 1 : 1);
  const diff = counted - systemQty;

  if (existing) {
    db.prepare('UPDATE count_items SET counted_qty=?, system_qty=?, difference=?, counted_at=datetime("now") WHERE id=?').run(counted, systemQty, diff, existing.id);
  } else {
    db.prepare('INSERT INTO count_items (session_id, product_id, location_id, serial_no, counted_qty, system_qty, difference, user_id) VALUES (?,?,?,?,?,?,?,?)').run(req.params.id, pid, location_id || null, sn || null, counted, systemQty, diff, req.user.id);
  }

  const product = db.prepare('SELECT sku, name, desi FROM products WHERE id=?').get(pid);
  res.json({ message: 'Kaydedildi', product, counted_qty: counted, system_qty: systemQty, difference: diff });
});

// Sayım detayı
router.get('/:id', auth(), (req, res) => {
  const session = db.prepare('SELECT * FROM count_sessions WHERE id=?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Bulunamadı' });
  const items = db.prepare(`
    SELECT ci.*, p.sku, p.name as product_name, p.desi,
    l.code as location_code
    FROM count_items ci
    JOIN products p ON ci.product_id=p.id
    LEFT JOIN locations l ON ci.location_id=l.id
    WHERE ci.session_id=?
    ORDER BY ci.counted_at DESC
  `).all(req.params.id);
  res.json({ ...session, items });
});

// Sayım kapat
router.put('/:id/close', auth(['admin']), (req, res) => {
  db.prepare("UPDATE count_sessions SET status='kapali', closed_at=datetime('now') WHERE id=?").run(req.params.id);
  res.json({ message: 'Sayım kapatıldı' });
});

// Sayım onayla (farkları stoka uygula)
router.put('/:id/approve', auth(['admin']), (req, res) => {
  const session = db.prepare("SELECT * FROM count_sessions WHERE id=? AND status='kapali'").get(req.params.id);
  if (!session) return res.status(400).json({ error: 'Önce sayımı kapatın' });
  db.prepare("UPDATE count_sessions SET status='onaylandi' WHERE id=?").run(req.params.id);
  res.json({ message: 'Sayım onaylandı' });
});

// Excel export
router.get('/:id/export', auth(), (req, res) => {
  const XLSX = require('xlsx');
  const items = db.prepare(`
    SELECT p.sku, p.name as urun_adi, l.code as lokasyon,
    ci.counted_qty as sayilan, ci.system_qty as sistem, ci.difference as fark, ci.counted_at
    FROM count_items ci JOIN products p ON ci.product_id=p.id
    LEFT JOIN locations l ON ci.location_id=l.id
    WHERE ci.session_id=?
  `).all(req.params.id);
  const ws = XLSX.utils.json_to_sheet(items);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sayım');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename=sayim.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

module.exports = router;
