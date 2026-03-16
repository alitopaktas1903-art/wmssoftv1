const express = require('express');
const db = require('../db');
const { auth } = require('../middleware/auth');
const router = express.Router();

// Tüm ürünler
router.get('/', auth(), (req, res) => {
  const { q, category } = req.query;
  let sql = 'SELECT * FROM products WHERE active = 1';
  const params = [];
  if (q) { sql += ' AND (sku LIKE ? OR name LIKE ? OR barcode LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (category) { sql += ' AND category = ?'; params.push(category); }
  sql += ' ORDER BY name';
  res.json(db.prepare(sql).all(...params));
});

// Tekil ürün
router.get('/:id', auth(), (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Ürün bulunamadı' });
  // stok bilgisi
  const stock = db.prepare(`
    SELECT l.code as location_code, l.name as location_name, COUNT(s.id) as qty
    FROM serials s JOIN locations l ON s.location_id = l.id
    WHERE s.product_id = ? AND s.status IN ('stok','mk')
    GROUP BY l.id
  `).all(req.params.id);
  res.json({ ...p, stock });
});

// Barkod ile bul
router.get('/barcode/:barcode', auth(), (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE barcode = ? OR sku = ?').get(req.params.barcode, req.params.barcode);
  if (!p) return res.status(404).json({ error: 'Ürün bulunamadı' });
  res.json(p);
});

// Ürün oluştur
router.post('/', auth(['admin', 'depo']), (req, res) => {
  const { sku, barcode, name, description, width, height, depth, weight, category, unit, min_stock } = req.body;
  if (!sku || !name) return res.status(400).json({ error: 'SKU ve isim zorunlu' });
  const desi = (width && height && depth) ? (width * height * depth) / 3000 : null;
  try {
    const result = db.prepare(`
      INSERT INTO products (sku, barcode, name, description, width, height, depth, weight, desi, category, unit, min_stock)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sku, barcode || null, name, description || null, width || null, height || null, depth || null, weight || null, desi, category || null, unit || 'ADET', min_stock || 0);
    res.json({ id: result.lastInsertRowid, message: 'Ürün oluşturuldu' });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'SKU veya barkod zaten var' });
    res.status(500).json({ error: e.message });
  }
});

// Ürün güncelle
router.put('/:id', auth(['admin', 'depo']), (req, res) => {
  const { name, barcode, description, width, height, depth, weight, category, unit, min_stock } = req.body;
  const desi = (width && height && depth) ? (width * height * depth) / 3000 : null;
  db.prepare(`
    UPDATE products SET name=?, barcode=?, description=?, width=?, height=?, depth=?, weight=?, desi=?, category=?, unit=?, min_stock=?, updated_at=datetime('now')
    WHERE id=?
  `).run(name, barcode || null, description || null, width || null, height || null, depth || null, weight || null, desi, category || null, unit || 'ADET', min_stock || 0, req.params.id);
  res.json({ message: 'Güncellendi' });
});

// Ürün sil (soft)
router.delete('/:id', auth(['admin']), (req, res) => {
  db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ message: 'Silindi' });
});

// Excel export
router.get('/export/excel', auth(), (req, res) => {
  const XLSX = require('xlsx');
  const products = db.prepare('SELECT sku, barcode, name, category, width, height, depth, weight, desi, unit, min_stock FROM products WHERE active=1').all();
  const ws = XLSX.utils.json_to_sheet(products);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Ürünler');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename=urunler.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// Excel import
router.post('/import/excel', auth(['admin', 'depo']), (req, res) => {
  const XLSX = require('xlsx');
  if (!req.files?.file) return res.status(400).json({ error: 'Dosya gerekli' });
  const wb = XLSX.read(req.files.file.data);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  let ok = 0, err = 0;
  const insert = db.prepare(`INSERT OR REPLACE INTO products (sku, barcode, name, category, width, height, depth, weight, desi, unit, min_stock)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const tx = db.transaction(() => {
    for (const r of rows) {
      try {
        const desi = (r.width && r.height && r.depth) ? (r.width * r.height * r.depth) / 3000 : null;
        insert.run(r.sku, r.barcode || null, r.name, r.category || null, r.width || null, r.height || null, r.depth || null, r.weight || null, desi, r.unit || 'ADET', r.min_stock || 0);
        ok++;
      } catch { err++; }
    }
  });
  tx();
  res.json({ message: `${ok} ürün içe aktarıldı, ${err} hata` });
});

module.exports = router;
