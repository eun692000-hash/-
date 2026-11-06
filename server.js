const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT) || 10000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'products.json');
const APP_ACCESS_KEY = process.env.APP_ACCESS_KEY || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';

app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));
app.use((req, res, next) => {
  const origin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Key, X-Admin-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function ensureStore() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ products: [] }, null, 2));
}
function readStore() {
  ensureStore();
  try { const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); return { products: Array.isArray(data.products) ? data.products : [] }; }
  catch { return { products: [] }; }
}
function writeStore(data) {
  ensureStore();
  const temp = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  fs.renameSync(temp, DATA_FILE);
}
function requireApp(req, res, next) {
  if (!APP_ACCESS_KEY) return res.status(503).json({ error: '서버에 APP_ACCESS_KEY 환경변수가 설정되지 않았습니다.' });
  if (!safeEqual(req.get('x-app-key') || '', APP_ACCESS_KEY)) return res.status(401).json({ error: '접속 코드가 올바르지 않습니다.' });
  next();
}
function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) return res.status(503).json({ error: '서버에 ADMIN_KEY 환경변수가 설정되지 않았습니다.' });
  if (!safeEqual(req.get('x-admin-key') || '', ADMIN_KEY)) return res.status(403).json({ error: '관리자 등록 코드가 올바르지 않습니다.' });
  next();
}
function safeEqual(a, b) {
  const aa = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function clean(value, max = 180) { return String(value ?? '').replace(/[<>]/g, '').trim().slice(0, max); }
function validPrice(value) { const n = Number(value); return Number.isSafeInteger(n) && n > 0 && n <= 100000000; }

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'oliveprice-shared', storage: DATA_FILE }));
app.get('/api/products', requireApp, (_req, res) => res.json({ items: readStore().products }));

app.post('/api/products', requireApp, requireAdmin, (req, res) => {
  const body = req.body || {};
  const name = clean(body.name);
  const brand = clean(body.brand || '기타', 100);
  const currentPrice = Number(body.currentPrice);
  const originalPrice = Number(body.originalPrice || body.currentPrice);
  if (!name || !validPrice(currentPrice) || !validPrice(originalPrice)) return res.status(400).json({ error: '상품명과 올바른 현재가·정상가를 입력해 주세요.' });
  let externalUrl = clean(body.externalUrl || '', 500);
  if (externalUrl && !/^https:\/\/(www\.)?oliveyoung\.co\.kr\//i.test(externalUrl)) return res.status(400).json({ error: '올리브영 공식몰 URL만 등록할 수 있습니다.' });
  const store = readStore();
  if (store.products.some(p => p.externalUrl && externalUrl && p.externalUrl === externalUrl)) return res.status(409).json({ error: '이미 등록된 상품 URL입니다.' });
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const item = {
    id: `user_${crypto.randomUUID()}`,
    code: clean(body.code || '직접등록', 40), brand, name,
    cleanSearchName: name, category: clean(body.category || '스킨케어', 40), emoji: '🧴',
    originalPrice, basePrice: validPrice(body.basePrice) ? Number(body.basePrice) : originalPrice,
    currentPrice, saleBadge: '가격 기록', externalUrl,
    history: Array.isArray(body.history) && body.history.length ? body.history.slice(-200) : [{ date: today, price: currentPrice, isSpecialSale: currentPrice < originalPrice, event: '최초 등록' }],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  store.products.unshift(item); writeStore(store);
  res.status(201).json({ item });
});

app.post('/api/products/:id/prices', requireApp, (req, res) => {
  const price = Number(req.body?.price);
  if (!validPrice(price)) return res.status(400).json({ error: '올바른 가격을 입력해 주세요.' });
  const store = readStore();
  const item = store.products.find(p => p.id === req.params.id);
  if (!item) return res.status(404).json({ error: '상품을 찾을 수 없습니다.' });
  const today = clean(req.body?.date || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }), 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return res.status(400).json({ error: '날짜 형식이 올바르지 않습니다.' });
  if (!Array.isArray(item.history)) item.history = [];
  const record = { date: today, price, isSpecialSale: price < Number(item.basePrice || item.originalPrice), event: clean(req.body?.event || '사용자 가격 기록', 60) };
  const existing = item.history.findIndex(h => h.date === today);
  if (existing >= 0) item.history[existing] = record; else item.history.push(record);
  item.history.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  item.currentPrice = price; item.updatedAt = new Date().toISOString();
  writeStore(store);
  res.json({ item });
});

app.listen(PORT, '0.0.0.0', () => console.log(`OlivePrice shared API listening on ${PORT}; data=${DATA_FILE}`));
