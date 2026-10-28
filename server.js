// Сервис рекламных роликов: отдаёт страницу, прячет ключ fal.ai на сервере и принимает оплату через Stripe.
// Запуск: FAL_KEY=... STRIPE_SECRET_KEY=... STRIPE_PUBLISHABLE_KEY=... node server.js
import express from 'express';
import Stripe from 'stripe';
import { createHandler, route as FAL_ROUTE } from '@fal-ai/server-proxy/express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const PORT = env.PORT || 3000;
const CODES = (env.ACCESS_CODES || '').split(',').map((s) => s.trim()).filter(Boolean);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

// ---------- цены: себестоимость в fal.ai × наценка ----------
const MARKUP = Math.max(1, +env.MARKUP || 3);
const CURRENCY = (env.CURRENCY || 'eur').toLowerCase();
// Примерная себестоимость одного ролика в fal.ai ($) с запасом на автоисправления и пару правок
const COST = {
  premium: +env.COST_PREMIUM || 4.5, // живое видео в сценах (Kling) + премиум-музыка
  std: +env.COST_STD || 1.5,         // анимированные кадры
  topup: +env.COST_TOPUP || 1,       // пополнение «на правки»
};
const PRODUCT = {
  premium: 'Рекламный ролик — Премиум (3 версии)',
  std: 'Рекламный ролик — Быстрый (3 версии)',
  topup: 'Пополнение баланса на правки ролика',
};
const priceCents = (kind) => Math.round(COST[kind] * MARKUP * 100);

// Себестоимость одного вызова нейросети в fal.ai ($). С баланса клиента списывается она,
// а клиент платит в MARKUP раз больше — это и есть наценка.
function callCost(endpoint, body) {
  if (endpoint.startsWith('fal-ai/any-llm')) return 0.01;
  if (endpoint.startsWith('openai/gpt-image-2')) return 0.07;
  if (endpoint.startsWith('fal-ai/kling-video')) return 0.35;
  if (endpoint === 'fal-ai/elevenlabs/tts/eleven-v3') return Math.max(0.005, String((body && body.text) || '').length / 1000 * 0.1);
  if (endpoint === 'fal-ai/elevenlabs/music') return Math.max(0.1, ((body && body.music_length_ms) || 30000) / 60000 * 0.8);
  if (endpoint === 'CassetteAI/music-generator') return 0.02;
  return 0.05;
}

const stripe = env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY) : null;
const PAYMENTS = !!(stripe && env.STRIPE_PUBLISHABLE_KEY);

if (!env.FAL_KEY) console.warn('⚠️  FAL_KEY не задан — генерация работать не будет');
if (!PAYMENTS && !CODES.length) console.warn('⚠️  Нет ни Stripe, ни ACCESS_CODES — любой, кто знает адрес, сможет тратить ваш баланс fal.ai');
if (PAYMENTS) console.log(`💳 Оплата Stripe включена. Цены: премиум ${priceCents('premium') / 100}, быстрый ${priceCents('std') / 100}, правки ${priceCents('topup') / 100} ${CURRENCY.toUpperCase()} (наценка ×${MARKUP})`);

// ---------- кошельки клиентов (баланс в $ себестоимости) ----------
// Кошелёк создаётся первой оплатой; ключ кошелька — id этой сессии Stripe.
// Браузер клиента хранит токен «id.подпись», подделать его нельзя.
const DATA_DIR = env.DATA_DIR || path.join(__dirname, 'data');
const WALLETS_FILE = path.join(DATA_DIR, 'wallets.json');
const SECRET = crypto.createHash('sha256').update('wallet:' + (env.WALLET_SECRET || env.STRIPE_SECRET_KEY || env.FAL_KEY || 'dev')).digest();
const sign = (id) => id + '.' + crypto.createHmac('sha256', SECRET).update(id).digest('base64url').slice(0, 32);
const unsign = (token) => {
  const id = String(token || '').split('.')[0];
  if (!id) return null;
  const a = Buffer.from(sign(id)), b = Buffer.from(String(token));
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? id : null;
};
let wallets = {};
try { wallets = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8')); } catch {}
let saveTimer = null;
function saveWallets() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(WALLETS_FILE + '.tmp', JSON.stringify(wallets));
      fs.renameSync(WALLETS_FILE + '.tmp', WALLETS_FILE);
    } catch (e) { console.error('Не удалось сохранить балансы', e); }
  }, 500);
}
const remaining = (w) => Math.max(0, w.budget - w.spent);

// если файл с балансами потерялся (например, без постоянного диска на Railway) — восстанавливаем по Stripe
async function restoreWallet(id) {
  if (!stripe) return null;
  try {
    const s = await stripe.checkout.sessions.retrieve(id);
    if (s.payment_status !== 'paid') return null;
    const w = { budget: +s.metadata.budget || 0, spent: 0, sessions: [id], created: Date.now(), restored: true };
    try {
      const found = await stripe.paymentIntents.search({ query: `metadata['wallet']:'${id}' AND status:'succeeded'`, limit: 100 });
      for (const pi of found.data) if (pi.metadata.session && pi.metadata.session !== id && !w.sessions.includes(pi.metadata.session)) { w.budget += +pi.metadata.budget || 0; w.sessions.push(pi.metadata.session); }
    } catch {}
    wallets[id] = w; saveWallets();
    return w;
  } catch { return null; }
}
async function walletFromToken(token) {
  const id = unsign(token);
  if (!id) return null;
  return wallets[id] || (await restoreWallet(id));
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// простой лимит запросов с одного адреса, чтобы никто не «залил» сервис
const hits = new Map();
const limit = (max, windowMs) => (req, res, next) => {
  const key = req.ip + '|' + req.path + '|' + max;
  const now = Date.now();
  const h = hits.get(key) || { n: 0, t: now };
  if (now - h.t > windowMs) { h.n = 0; h.t = now; }
  h.n++; hits.set(key, h);
  if (h.n > max) return res.status(429).json({ error: 'слишком много запросов, подождите минуту' });
  next();
};
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (now - h.t > 3600e3) hits.delete(k); }, 600e3).unref();

// ---------- кто делает запрос: владелец по коду, клиент со своим балансом или открытый режим ----------
const fail = (res, status, msg) => res.status(status).json({ error: msg, detail: msg });
async function guard(req, res, next) {
  const code = req.get('x-access-code');
  if (code && CODES.includes(code)) { req.who = { kind: 'code' }; return next(); }
  if (code && !CODES.includes(code)) return fail(res, 401, 'неверный код доступа');
  const token = req.get('x-wallet');
  if (token && PAYMENTS) {
    const w = await walletFromToken(token);
    if (!w) return fail(res, 401, 'оплата не найдена — оплатите ролик заново');
    req.who = { kind: 'wallet', wallet: w };
    return next();
  }
  if (!PAYMENTS && !CODES.length) { req.who = { kind: 'open' }; return next(); }
  return fail(res, PAYMENTS ? 402 : 401, PAYMENTS ? 'нужна оплата ролика' : 'введите код доступа');
}

app.get('/api/config', (req, res) => res.json({
  codeRequired: !PAYMENTS && CODES.length > 0,
  payments: PAYMENTS ? {
    publishableKey: env.STRIPE_PUBLISHABLE_KEY, currency: CURRENCY,
    prices: { premium: priceCents('premium'), std: priceCents('std'), topup: priceCents('topup') },
  } : null,
}));
app.get('/api/check', limit(30, 60e3), guard, (req, res) => res.json({ ok: true, kind: req.who.kind }));

// баланс клиента в деньгах (то, что он ещё может потратить)
app.get('/api/wallet', limit(60, 60e3), guard, (req, res) => {
  if (req.who.kind !== 'wallet') return res.json({ unlimited: true });
  const left = remaining(req.who.wallet);
  res.json({
    balance: Math.floor(left * MARKUP * 100), currency: CURRENCY,
    enough: { premium: left >= COST.premium * 0.85, std: left >= COST.std * 0.85 },
  });
});

// ---------- оплата Stripe: окно оплаты прямо на странице ----------
app.post('/api/checkout', limit(20, 60e3), express.json({ limit: '10kb' }), async (req, res) => {
  if (!PAYMENTS) return fail(res, 400, 'оплата не настроена');
  const kind = ['premium', 'std', 'topup'].includes(req.body && req.body.kind) ? req.body.kind : 'premium';
  const walletId = req.body && req.body.wallet ? unsign(req.body.wallet) : null;
  const base = (env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  try {
    const meta = { kind, budget: String(COST[kind]), wallet: walletId || '' };
    const session = await stripe.checkout.sessions.create({
      ui_mode: 'embedded_page',
      mode: 'payment',
      redirect_on_completion: 'if_required',
      return_url: `${base}/?paid={CHECKOUT_SESSION_ID}`,
      line_items: [{ quantity: 1, price_data: { currency: CURRENCY, unit_amount: priceCents(kind), product_data: { name: PRODUCT[kind] } } }],
      metadata: meta,
      payment_intent_data: { metadata: meta, description: PRODUCT[kind] },
    });
    res.json({ clientSecret: session.client_secret, sessionId: session.id });
  } catch (e) {
    console.error('Stripe checkout', e.message);
    fail(res, 502, 'не удалось открыть оплату: ' + (e.message || e));
  }
});

// после оплаты: зачисляем деньги на баланс и выдаём браузеру токен кошелька
app.post('/api/claim', limit(30, 60e3), express.json({ limit: '10kb' }), async (req, res) => {
  if (!PAYMENTS) return fail(res, 400, 'оплата не настроена');
  const sid = String((req.body && req.body.sessionId) || '');
  if (!/^cs_[\w]+$/.test(sid)) return fail(res, 400, 'неверный номер оплаты');
  try {
    const s = await stripe.checkout.sessions.retrieve(sid);
    if (s.payment_status !== 'paid') return fail(res, 409, 'платёж ещё обрабатывается');
    const walletId = s.metadata.wallet || s.id;
    const w = wallets[walletId] || (walletId === s.id ? { budget: 0, spent: 0, sessions: [], created: Date.now() } : await restoreWallet(walletId));
    if (!w) return fail(res, 404, 'кошелёк не найден');
    wallets[walletId] = w;
    if (!w.sessions.includes(s.id)) {
      w.budget += +s.metadata.budget || 0;
      w.sessions.push(s.id);
      saveWallets();
      if (s.payment_intent) stripe.paymentIntents.update(String(s.payment_intent), { metadata: { wallet: walletId, session: s.id } }).catch(() => {});
    }
    res.json({ token: sign(walletId), balance: Math.floor(remaining(w) * MARKUP * 100), currency: CURRENCY });
  } catch (e) {
    console.error('Stripe claim', e.message);
    fail(res, 502, 'не удалось проверить оплату');
  }
});

// ---------- прокси fal.ai: ключ остаётся на сервере, разрешены только нужные модели ----------
const falHandler = createHandler({
  allowedEndpoints: [
    'fal-ai/any-llm', 'fal-ai/any-llm/**',
    'openai/gpt-image-2', 'openai/gpt-image-2/**',
    'fal-ai/kling-video/v2.5-turbo/pro/image-to-video',
    'fal-ai/elevenlabs/tts/eleven-v3',
    'fal-ai/elevenlabs/music',
    'CassetteAI/music-generator',
  ],
});
// списание с баланса клиента при каждом запуске нейросети
function charge(req, res, next) {
  if (req.who.kind !== 'wallet' || req.method !== 'POST') return next();
  let u;
  try { u = new URL(req.get('x-fal-target-url') || ''); } catch { return next(); }
  if (u.hostname !== 'fal.run' && !u.hostname.endsWith('.fal.run')) return next(); // загрузка файлов — бесплатно
  const cost = callCost(u.pathname.replace(/^\//, ''), req.body);
  const w = req.who.wallet;
  if (w.spent + cost > w.budget + 1e-9) return fail(res, 402, 'оплаченный баланс закончился — пополните, чтобы продолжить');
  w.spent += cost;
  saveWallets();
  // если нейросеть не приняла запрос — возвращаем списанное
  res.on('finish', () => { if (res.statusCode >= 400) { w.spent = Math.max(0, w.spent - cost); saveWallets(); } });
  next();
}
app.all(FAL_ROUTE, limit(600, 60e3), guard, express.json({ limit: '5mb' }), charge, (req, res) => {
  falHandler(req, res, () => {}).catch((e) => { if (!res.headersSent) res.status(502).json({ error: String(e.message || e) }); });
});

// ---------- скачивание медиа, если браузер не может напрямую (CORS) ----------
const isPrivate = (ip) => {
  if (net.isIPv4(ip)) return /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip);
  return /^(::1|::|fc|fd|fe80)/i.test(ip) || ip.startsWith('::ffff:') && isPrivate(ip.slice(7));
};
async function safeUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error('неверная ссылка'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('неверная ссылка');
  const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => []);
  if (!addrs.length || addrs.some((a) => isPrivate(a.address))) throw new Error('адрес недоступен');
  return u;
}
app.get('/api/media', limit(300, 60e3), guard, async (req, res) => {
  try {
    const u = await safeUrl(req.query.url);
    const r = await fetch(u, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(120000) });
    if (!r.ok) return res.status(502).json({ error: 'источник ответил ' + r.status });
    const type = r.headers.get('content-type') || 'application/octet-stream';
    if (!/^(image|video|audio)\/|octet-stream/i.test(type)) return res.status(415).json({ error: 'это не медиафайл' });
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 200e6) return res.status(413).json({ error: 'файл слишком большой' });
    res.set('content-type', type).set('cache-control', 'private, max-age=3600').send(buf);
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// ---------- данные и скриншоты приложения из App Store / Google Play ----------
async function appStoreInfo(link) {
  const u = new URL(link);
  const appleId = (u.pathname.match(/id(\d{5,})/) || [])[1];
  if (/apple\.com$/.test(u.hostname) && appleId) {
    const country = (u.pathname.match(/^\/([a-z]{2})\//) || [])[1] || 'us';
    const d = await (await fetch(`https://itunes.apple.com/lookup?id=${appleId}&country=${country}&entity=software`, { signal: AbortSignal.timeout(20000) })).json();
    const r = d && d.results && d.results[0];
    if (!r) throw new Error('App Store не нашёл это приложение');
    const big = (s) => s.replace(/\/(\d+)x(\d+)(bb|sr)?\.(png|jpg|jpeg|webp)$/i, (m, w, h) => `/${w * 3}x${h * 3}bb.jpg`);
    return {
      name: r.trackName, icon: r.artworkUrl512 || r.artworkUrl100, description: r.description || '', developer: r.sellerName || '',
      rating: r.averageUserRating || 0, ratingCount: r.userRatingCount || 0, price: r.price === 0 ? 'free' : (r.formattedPrice || ''),
      genre: r.primaryGenreName || '', shots: (r.screenshotUrls || []).map(big),
    };
  }
  const id = u.hostname === 'play.google.com' && u.searchParams.get('id');
  if (!id || !/^[\w.]+$/.test(id)) throw new Error('это не ссылка на App Store или Google Play');
  const md = await (await fetch('https://r.jina.ai/https://play.google.com/store/apps/details?id=' + encodeURIComponent(id) + '&hl=en', { signal: AbortSignal.timeout(40000) })).text();
  const imgs = [...md.matchAll(/!\[([^\]]*)\]\((https:\/\/play-lh\.googleusercontent\.com\/[^)\s]+)\)/g)].map((m) => ({ alt: m[1].toLowerCase(), url: m[2] }));
  const icon = (imgs.find((x) => /icon/.test(x.alt)) || {}).url || '';
  const shots = imgs.filter((x) => /screenshot/.test(x.alt)).map((x) => x.url.replace(/=([wsh]\d+[^=\s]*)$/, '=h2400'));
  const rating = +((md.match(/(\d[.,]\d)\s*(?:star|★)/i) || [])[1] || '0').replace(',', '.');
  const cnt = md.match(/([\d.,]+)\s*([KMB])?\+?\s*reviews/i) || [];
  const ratingCount = cnt[1] ? Math.round(parseFloat(cnt[1].replace(/,/g, '')) * ({ K: 1e3, M: 1e6, B: 1e9 }[cnt[2]] || 1)) : 0;
  const free = /\bFree\b|Install/i.test(md) && !/\$\d/.test(md.slice(0, 1500));
  return {
    name: (md.match(/^Title:\s*(.+)$/m) || [])[1] || id, icon, description: md.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').slice(0, 3000),
    developer: '', rating, ratingCount, price: free ? 'free' : '', genre: '', shots,
  };
}
app.get('/api/appshots', limit(30, 60e3), guard, async (req, res) => {
  try { res.json(await appStoreInfo(String(req.query.url || ''))); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// ---------- страница ----------
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.listen(PORT, () => console.log(`Сервис запущен: http://localhost:${PORT}`));
