const express = require('express');
const db = require('../db');
const { auth } = require('../middleware/auth');
const router = express.Router();

router.get('/', auth(), (req, res) => {
  const sessions = db.prepare(`
    SELECT cs.*, u.name as user_name,
    (SELECT COUNT(*) FROM count_items WHERE session_id=cs.id) as item_count
    FROM count_sessions cs LEFT JOIN users u ON cs.user_id=u.id
    ORDER BY cs.created_at DESC
  `).all();
  res.json(sessions);
});

router.post('/', auth(['admin', 'depo', 'sayim']), (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Sayım adı gerekli' });
  const r = db.prepare('INSERT INTO count_sessions (name, user_id) VALUES (?,?)').run(name, req.user.id);
  res.json({ id: r.lastInsertRowid, message: 'Sayım oturumu açıldı' });
});

// Sayım kalemi ekle
router.post('/:id/scan', auth(['admin', 'depo', 'sayim']), (req, res) => {
  try {
    const { serial_no, product_id, location_id, qty } = req.body;
    const session = db.prepare("SELECT * FROM count_sessions WHERE id=? AND status='acik'").get(req.params.id);
    if (!session) return res.status(400).json({ error: 'Aktif sayım oturumu bulunamadı' });

    let pid = product_id || null;
    let sn = serial_no ? String(serial_no).trim() : null;
    if (!sn) return res.status(400).json({ error: 'Seri no / SKU / EAN gerekli' });

    // Önce seri no olarak bak
    if (!pid) {
      const serial = db.prepare('SELECT product_id FROM serials WHERE serial_no=?').get(sn);
      if (serial) pid = serial.product_id;
    }
    // Sonra SKU veya EAN olarak bak
    if (!pid) {
      const prod = db.prepare('SELECT id FROM products WHERE sku=? OR barcode=?').get(sn, sn);
      if (prod) { pid = prod.id; sn = null; }
    }

    if (!pid) return res.status(404).json({ error: `"${sn}" — ürün bulunamadı. SKU, seri no veya EAN kontrol edin.` });

    const systemQty = db.prepare("SELECT COUNT(*) as cnt FROM serials WHERE product_id=? AND status IN ('mk','stok')").get(pid).cnt;
    const counted = qty ? parseInt(qty) : 1;
    const locId = location_id ? parseInt(location_id) : null;

    const existing = db.prepare(`
      SELECT * FROM count_items WHERE session_id=? AND product_id=?
      AND ((?  IS NULL AND location_id IS NULL) OR location_id=?)
    `).get(req.params.id, pid, locId, locId);

    let newCounted;
    if (existing) {
      newCounted = existing.counted_qty + counted;
      db.prepare('UPDATE count_items SET counted_qty=?, system_qty=?, difference=?, counted_at=datetime("now") WHERE id=?')
        .run(newCounted, systemQty, newCounted - systemQty, existing.id);
    } else {
      newCounted = counted;
      db.prepare('INSERT INTO count_items (session_id, product_id, location_id, serial_no, counted_qty, system_qty, difference, user_id) VALUES (?,?,?,?,?,?,?,?)')
        .run(req.params.id, pid, locId, serial_no ? String(serial_no).trim() : null, newCounted, systemQty, newCounted - systemQty, req.user.id);
    }

    const product = db.prepare('SELECT sku, name, desi FROM products WHERE id=?').get(pid);
    res.json({ message: 'Kaydedildi', product, counted_qty: newCounted, system_qty: systemQty, difference: newCounted - systemQty });
  } catch(e) {
    console.error('Sayım scan error:', e);
    res.status(500).json({ error: 'Sunucu hatası: ' + e.message });
  }
});

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

router.put('/:id/close', auth(['admin']), (req, res) => {
  db.prepare("UPDATE count_sessions SET status='kapali', closed_at=datetime('now') WHERE id=?").run(req.params.id);
  res.json({ message: 'Sayım kapatıldı' });
});

router.put('/:id/approve', auth(['admin']), (req, res) => {
  const session = db.prepare("SELECT * FROM count_sessions WHERE id=? AND status='kapali'").get(req.params.id);
  if (!session) return res.status(400).json({ error: 'Önce sayımı kapatın' });
  db.prepare("UPDATE count_sessions SET status='onaylandi' WHERE id=?").run(req.params.id);
  res.json({ message: 'Sayım onaylandı' });
});

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
  const buf = Buffer.from(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
  res.setHeader('Content-Disposition', 'attachment; filename=sayim.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
});

module.exports = router;
