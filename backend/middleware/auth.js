const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'wms-secret-2024-degistir';

function auth(roles = []) {
  return (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token gerekli' });
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
      if (roles.length && !roles.includes(decoded.role)) {
        return res.status(403).json({ error: 'Yetki yok' });
      }
      next();
    } catch {
      return res.status(401).json({ error: 'Geçersiz token' });
    }
  };
}

module.exports = { auth, JWT_SECRET };
