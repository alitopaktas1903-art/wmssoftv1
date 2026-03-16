const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');

require('./db');

const app = express();
const PORT = process.env.PORT || 3001;
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/products', require('./routes/products'));
app.use('/api/stock', require('./routes/stock'));
app.use('/api/shipments', require('./routes/shipments'));
app.use('/api/counting', require('./routes/counting'));

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.listen(PORT, '0.0.0.0', () => console.log(`WMS çalışıyor: port ${PORT}`));
