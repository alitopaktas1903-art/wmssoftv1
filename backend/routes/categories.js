const express = require('express');
const db = require('../db');
const { auth } = require('../middleware/auth');
const router = express.Router();

router.get('/', auth(), (req, res) => {
  res.json(db.prepare('SELECT * FROM categories WHERE active=1 ORDER BY name').all());
});

router.post('/', auth(['admin']), (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'İsim gerekli' });
  try {
    const r = db.prepare('INSERT INTO categories (name) VALUES (?)').run(name.trim());
    res.json({ id: r.lastInsertRowid, message: 'Kategori oluşturuldu' });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Bu isimde kategori zaten var' });
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', auth(['admin']), (req, res) => {
  db.prepare('UPDATE categories SET active=0 WHERE id=?').run(req.params.id);
  res.json({ message: 'Silindi' });
});

module.exports = router;
