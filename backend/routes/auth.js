const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { auth, JWT_SECRET } = require('../middleware/auth');
const router = express.Router();

// Giriş
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Kullanıcı adı ve şifre gerekli' });
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
  if (!user) return res.status(401).json({ error: 'Kullanıcı bulunamadı' });
  if (!bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: 'Şifre hatalı' });
  const token = jwt.sign({ id: user.id, username: user.username, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, user: { id: user.id, username: user.username, name: user.name, role: user.role } });
});

// Mevcut kullanıcı
router.get('/me', auth(), (req, res) => res.json(req.user));

// Kullanıcı listesi (admin)
router.get('/users', auth(['admin']), (req, res) => {
  const users = db.prepare('SELECT id, username, name, role, active, created_at FROM users ORDER BY name').all();
  res.json(users);
});

// Yeni kullanıcı
router.post('/users', auth(['admin']), (req, res) => {
  const { username, password, name, role } = req.body;
  if (!username || !password || !name || !role) return res.status(400).json({ error: 'Tüm alanlar zorunlu' });
  const hash = bcrypt.hashSync(password, 10);
  try {
    const result = db.prepare('INSERT INTO users (username, password, name, role) VALUES (?, ?, ?, ?)').run(username, hash, name, role);
    res.json({ id: result.lastInsertRowid, message: 'Kullanıcı oluşturuldu' });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Kullanıcı adı zaten var' });
    res.status(500).json({ error: e.message });
  }
});

// Şifre değiştir
router.put('/users/:id/password', auth(['admin']), (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Şifre gerekli' });
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, req.params.id);
  res.json({ message: 'Şifre güncellendi' });
});

// Kullanıcı aktif/pasif
router.put('/users/:id/toggle', auth(['admin']), (req, res) => {
  db.prepare('UPDATE users SET active = CASE WHEN active=1 THEN 0 ELSE 1 END WHERE id = ?').run(req.params.id);
  res.json({ message: 'Güncellendi' });
});

module.exports = router;
