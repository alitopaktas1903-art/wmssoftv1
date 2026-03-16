const express = require('express');
const multer = require('multer');
const db = require('../db');
const { auth } = require('../middleware/auth');
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.get('/', auth(), (req, res) => {
  const { q, category } = req.query;
  let sql = 'SELECT * FROM products WHERE active = 1';
  const params = [];
  if (q) { sql += ' AND (sku LIKE ? OR name LIKE ? OR barcode LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (category) { sql += ' AND category = ?'; params.push(category); }
  sql += ' ORDER BY name';
  res.json(db.prepare(sql).all(...params));
});

router.get('/barcode/:barcode', auth(), (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE barcode = ? OR sku = ?').get(req.params.barcode, req.params.barcode);
  if (!p) return res.status(404).json({ error: 'Ürün bulunamadı' });
  res.json(p);
});

router.get('/export/excel', auth(), (req, res) => {
  const XLSX = require('xlsx');
  const products = db.prepare('SELECT sku, barcode, name, category, width, height, depth, weight, unit, min_stock FROM products WHERE active=1').all();
  // Barkodları string'e çevir
  const rows = products.map(p => ({ ...p, barcode: p.barcode ? String(p.barcode) : '' }));
  const ws = XLSX.utils.json_to_sheet(rows);
  // Sütun genişlikleri
  ws['!cols'] = [
    {wch:12},{wch:18},{wch:30},{wch:16},{wch:8},{wch:8},{wch:10},{wch:10},{wch:8},{wch:10}
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Ürünler');
  const buf = Buffer.from(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
  res.setHeader('Content-Disposition', 'attachment; filename=urunler.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
});

// Excel şablon
router.get('/template/excel', auth(), (req, res) => {
  const XLSX = require('xlsx');
  const headers = [{ sku:'URN001', barcode:'8680000000001', name:'Örnek Ürün 1', category:'Elektronik', width:30, height:20, depth:15, weight:2.5, unit:'ADET', min_stock:0 },
                   { sku:'URN002', barcode:'8680000000002', name:'Örnek Ürün 2', category:'Mobilya',    width:60, height:40, depth:30, weight:5.0, unit:'ADET', min_stock:0 }];
  const ws = XLSX.utils.json_to_sheet(headers);
  ws['!cols'] = [{wch:12},{wch:18},{wch:30},{wch:16},{wch:8},{wch:8},{wch:10},{wch:10},{wch:8},{wch:10}];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Şablon');
  const buf = Buffer.from(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
  res.setHeader('Content-Disposition', 'attachment; filename=urun_sablon.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
});

router.post('/import/excel', auth(['admin', 'depo']), upload.single('file'), (req, res) => {
  const XLSX = require('xlsx');
  const fileData = req.file?.buffer;
  if (!fileData) return res.status(400).json({ error: 'Dosya gerekli' });
  try {
    // raw:false → tüm değerleri string olarak oku (barkod .0 sorununu önler)
    const wb = XLSX.read(fileData, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { raw: false, defval: '' });
    let ok = 0, skip = 0, err = 0;
    const insert = db.prepare(`INSERT OR IGNORE INTO products
      (sku, barcode, name, category, width, height, depth, weight, desi, unit, min_stock)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const update = db.prepare(`UPDATE products SET
      barcode=?, name=?, category=?, width=?, height=?, depth=?, weight=?, desi=?, unit=?, min_stock=?, updated_at=datetime('now')
      WHERE sku=?`);
    const tx = db.transaction(() => {
      for (const r of rows) {
        if (!r.sku || !r.name) { err++; continue; }
        try {
          // Barkod: integer gibi görünen string'lerdeki .0 temizle
          let barcode = r.barcode ? String(r.barcode).replace(/\.0$/, '').trim() : null;
          if (!barcode) barcode = null;
          const w = parseFloat(r.width)||null;
          const h = parseFloat(r.height)||null;
          const d = parseFloat(r.depth)||null;
          const desi = (w && h && d) ? (w * h * d) / 3000 : null;
          const existing = db.prepare('SELECT id FROM products WHERE sku=?').get(r.sku);
          if (existing) {
            update.run(barcode, r.name, r.category||null, w, h, d, parseFloat(r.weight)||null, desi, r.unit||'ADET', parseInt(r.min_stock)||0, r.sku);
            skip++;
          } else {
            insert.run(r.sku, barcode, r.name, r.category||null, w, h, d, parseFloat(r.weight)||null, desi, r.unit||'ADET', parseInt(r.min_stock)||0);
            ok++;
          }
        } catch(e) { console.error('Row error:', e.message); err++; }
      }
    });
    tx();
    res.json({ message: `${ok} yeni ürün eklendi, ${skip} güncellendi${err ? ', '+err+' satır atlandı' : ''}` });
  } catch(e) {
    res.status(500).json({ error: 'Dosya okunamadı: ' + e.message });
  }
});

router.get('/:id', auth(), (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Ürün bulunamadı' });
  const stock = db.prepare(`
    SELECT l.code as location_code, l.name as location_name, COUNT(s.id) as qty
    FROM serials s JOIN locations l ON s.location_id = l.id
    WHERE s.product_id = ? AND s.status IN ('stok','mk')
    GROUP BY l.id
  `).all(req.params.id);
  res.json({ ...p, stock });
});

router.post('/', auth(['admin', 'depo']), (req, res) => {
  const { sku, barcode, name, description, width, height, depth, weight, category, unit, min_stock, seri_takip } = req.body;
  if (!sku || !name) return res.status(400).json({ error: 'SKU ve isim zorunlu' });
  const desi = (width && height && depth) ? (width * height * depth) / 3000 : null;
  try {
    const result = db.prepare(`INSERT INTO products (sku, barcode, name, description, width, height, depth, weight, desi, category, unit, min_stock, seri_takip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      sku, barcode||null, name, description||null,
      width||null, height||null, depth||null, weight||null, desi,
      category||null, unit||'ADET', min_stock||0, seri_takip!==undefined?seri_takip:1);
    res.json({ id: result.lastInsertRowid, message: 'Ürün oluşturuldu' });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'SKU veya barkod zaten var' });
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id', auth(['admin', 'depo']), (req, res) => {
  const { name, barcode, description, width, height, depth, weight, category, unit, min_stock, seri_takip } = req.body;
  const desi = (width && height && depth) ? (width * height * depth) / 3000 : null;
  db.prepare(`UPDATE products SET name=?, barcode=?, description=?, width=?, height=?, depth=?,
    weight=?, desi=?, category=?, unit=?, min_stock=?, seri_takip=?, updated_at=datetime('now') WHERE id=?`
  ).run(name, barcode||null, description||null, width||null, height||null, depth||null,
    weight||null, desi, category||null, unit||'ADET', min_stock||0, seri_takip!==undefined?seri_takip:1, req.params.id);
  res.json({ message: 'Güncellendi' });
});

router.delete('/:id', auth(['admin']), (req, res) => {
  db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ message: 'Silindi' });
});

module.exports = router;
