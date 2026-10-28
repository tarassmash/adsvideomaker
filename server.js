// AdsVideoMaker: сайт рекламных роликов. Ключ fal.ai на сервере, оплата рубинами через Stripe, админка /admin.
// Как в SnapDance: клиент покупает пакет рубинов, получает личный код AV-…, цены в рубинах считаются сами
// из себестоимости fal.ai × наценка с учётом комиссии Stripe и НДС.
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
const BRAND = env.STUDIO_NAME || 'AdsVideoMaker';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

class UserError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
  if (!(e instanceof UserError)) console.error(e);
  const msg = e instanceof UserError ? e.message : 'Внутренняя ошибка сервера. Попробуйте ещё раз.';
  if (!res.headersSent) res.status(e.status || 500).json({ error: msg, detail: msg });
});

// =====================================================================
// База (JSON-файл на Volume)
// =====================================================================
const DATA_DIR = env.RAILWAY_VOLUME_MOUNT_PATH || env.DATA_DIR || path.join(__dirname, 'data');
const PERSISTENT = Boolean(env.RAILWAY_VOLUME_MOUNT_PATH || env.DATA_DIR);
const DB_FILE = path.join(DATA_DIR, 'adsvideo-db.json');
const DEFAULT_PACKS = [
  { id: 'start', name: 'Старт', credits: 200, price: 19.99, popular: false },
  { id: 'business', name: 'Бизнес', credits: 500, price: 44.99, popular: true },
  { id: 'agency', name: 'Агентство', credits: 1500, price: 119.99, popular: false },
];
const emptyDb = () => ({
  keys: {},     // AV-… → { credits, spent, email, created, source, note, allowUsd, usd }
  orders: [],   // { id, key, email, pack, credits, amount, currency, created }
  videos: [],   // { id, key, action, quality, rubies, usd, created }
  settings: { packs: DEFAULT_PACKS, currency: 'eur', econ: {} },
});
let db = emptyDb();
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) { const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); db = { ...emptyDb(), ...d, settings: { ...emptyDb().settings, ...(d.settings || {}) } }; }
} catch (e) { console.error('Не удалось прочитать базу:', e.message); }
let saveTimer = null;
const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 300); };
function flush() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db));
    fs.renameSync(DB_FILE + '.tmp', DB_FILE);
  } catch (e) { console.error('Не удалось сохранить базу:', e.message); }
}
process.on('SIGTERM', () => { flush(); process.exit(0); });
process.on('SIGINT', () => { flush(); process.exit(0); });

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newKey() {
  let k;
  do {
    const c = [...crypto.randomBytes(12)].map((x) => ALPHABET[x % ALPHABET.length]).join('');
    k = `AV-${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}`;
  } while (db.keys[k]);
  return k;
}
const normKey = (k) => String(k || '').trim().toUpperCase();
const newId = () => crypto.randomBytes(8).toString('hex');
const keyRec = (k) => db.keys[normKey(k)] || null;
const currency = () => db.settings.currency || 'eur';

// =====================================================================
// Экономика: цена в рубинах = себестоимость fal.ai × наценка
// =====================================================================
const ACTIONS = {
  premium: 'Ролик «Премиум» (3 версии, живое видео)',
  std: 'Ролик «Быстрый» (3 версии)',
  redraw: 'Перерисовать сцену',
  rebuild: 'Пересобрать ролик',
};
const DEFAULT_ECON = {
  markup: 3,        // во сколько раз клиент платит больше себестоимости fal.ai
  feePct: 4,        // комиссия Stripe с запасом, %
  feeFixed: 0.3,    // фиксированная часть комиссии Stripe, в валюте пакетов
  vat: 0,           // НДС / IVA, если цены пакетов его включают, %
  fx: null,         // курс валюты пакетов к $; null — по умолчанию
  failReserve: 10,  // запас на неудачные генерации и автоисправления, %
  usd: { premium: 3.8, std: 1.2, redraw: 0.1, rebuild: 0.3 }, // себестоимость действия в fal.ai, $
};
const FX = { eur: 1.05, usd: 1, gbp: 1.25 };
const ALLOW_X = 1.6; // сколько $ fal.ai разрешено потратить на оплаченное действие (с запасом на повторы)
function econ() {
  const s = db.settings.econ || {};
  const e = { ...DEFAULT_ECON, ...s, usd: { ...DEFAULT_ECON.usd, ...(s.usd || {}) } };
  e.fxRate = Number(e.fx) > 0 ? Number(e.fx) : FX[currency()] || 1;
  return e;
}
// сколько $ остаётся вам с одного рубина по самому выгодному пакету — после комиссии Stripe и НДС
function rubyValueUsd() {
  const e = econ(), packs = db.settings.packs || [];
  if (!packs.length) return 0.05;
  return Math.min(...packs.map((p) => {
    const afterVat = p.price / (1 + (e.vat || 0) / 100);
    const afterFee = afterVat - p.price * (e.feePct / 100) - e.feeFixed;
    return Math.max(1e-4, afterFee / p.credits) * e.fxRate;
  }));
}
const rubiesPerUsd = () => econ().markup * (1 + econ().failReserve / 100) / rubyValueUsd();
const prices = () => { const k = rubiesPerUsd(), e = econ(); return Object.fromEntries(Object.keys(ACTIONS).map((a) => [a, Math.max(1, Math.ceil(e.usd[a] * k))])); };

function saveEcon(b) {
  const n = (v, d, min, max) => { const x = Number(v); return Number.isFinite(x) && x >= min && x <= max ? x : d; };
  const cur = econ();
  const usd = {};
  for (const a of Object.keys(ACTIONS)) usd[a] = n(b.usd && b.usd[a], cur.usd[a], 0.001, 100);
  db.settings.econ = {
    markup: n(b.markup, cur.markup, 1, 20), feePct: n(b.feePct, cur.feePct, 0, 20), feeFixed: n(b.feeFixed, cur.feeFixed, 0, 5),
    vat: n(b.vat, cur.vat, 0, 30), fx: Number(b.fx) > 0 ? n(b.fx, null, 0.1, 10) : null, failReserve: n(b.failReserve, cur.failReserve, 0, 100), usd,
  };
  save();
}
function econReport() {
  const e = econ(), P = prices(), rv = rubyValueUsd(), packs = db.settings.packs || [];
  const best = packs.reduce((a, p) => (!a || p.price / p.credits < a.price / a.credits ? p : a), null);
  const rubyPrice = best ? best.price / best.credits : 0;
  return {
    econ: e, currency: currency().toUpperCase(), rubyValueUsd: +rv.toFixed(4), rubyPrice: +rubyPrice.toFixed(4), rubiesPerUsd: +rubiesPerUsd().toFixed(2),
    actions: Object.entries(ACTIONS).map(([id, label]) => ({
      id, label, usd: e.usd[id], def: DEFAULT_ECON.usd[id], rubies: P[id],
      client: +(P[id] * rubyPrice).toFixed(2), net: +(P[id] * rv).toFixed(2), x: +(P[id] * rv / Math.max(0.001, e.usd[id])).toFixed(2),
    })),
  };
}

// себестоимость одного вызова нейросети в fal.ai ($) — для учёта расходов и лимита по оплаченному
function callCost(endpoint, body) {
  if (endpoint.startsWith('fal-ai/any-llm')) return 0.01;
  if (endpoint.startsWith('openai/gpt-image-2')) return 0.07;
  if (endpoint.startsWith('fal-ai/kling-video')) return 0.35;
  if (endpoint === 'fal-ai/elevenlabs/tts/eleven-v3') return Math.max(0.005, String((body && body.text) || '').length / 1000 * 0.1);
  if (endpoint === 'fal-ai/elevenlabs/music') return Math.max(0.1, ((body && body.music_length_ms) || 30000) / 60000 * 0.8);
  if (endpoint === 'CassetteAI/music-generator') return 0.02;
  return 0.05;
}

// =====================================================================
// Stripe
// =====================================================================
const SK = (env.STRIPE_SECRET_KEY || '').trim();
const PK = (env.STRIPE_PUBLISHABLE_KEY || '').trim();
const stripe = /^(sk|rk)_/.test(SK) ? new Stripe(SK) : null;
const stripeOn = () => Boolean(stripe && /^pk_/.test(PK));
const stripeMode = () => (/_live_/.test(SK) ? 'боевой режим' : /_test_/.test(SK) ? 'тестовый режим' : '');
const WEBHOOK_SECRET = (env.STRIPE_WEBHOOK_SECRET || '').trim();
function stripeMsg(e) {
  const m = String((e && e.message) || e);
  if (/invalid api key|no api key|expired api key/i.test(m) || (e && e.statusCode === 401)) return 'Оплата: Stripe не принял ключ. Проверьте STRIPE_SECRET_KEY в Railway → Variables (sk_live_… или sk_test_… целиком, без пробелов).';
  if (/live charges|activate|activation|charges_enabled/i.test(m)) return 'Оплата: аккаунт Stripe ещё не активирован для приёма платежей. Завершите активацию в Stripe или используйте тестовый ключ sk_test_….';
  if (/currency/i.test(m)) return 'Оплата: Stripe не принимает эту валюту для вашего аккаунта. Поменяйте валюту пакетов в админке.';
  if (/url/i.test(m) && /valid|invalid/i.test(m)) return 'Оплата: Stripe не принял адрес сайта. Задайте PUBLIC_URL в Railway → Variables: https://ваш-адрес, без / в конце.';
  return 'Оплата: Stripe ответил ошибкой — ' + m.slice(0, 200);
}
// зачислить рубины по оплаченной сессии (один раз на сессию)
function fulfill(s) {
  if (!s || s.payment_status !== 'paid') return null;
  const existing = db.orders.find((o) => o.id === s.id);
  if (existing) return { key: existing.key, added: 0, credits: (db.keys[existing.key] || {}).credits || 0 };
  const credits = parseInt(s.metadata && s.metadata.credits, 10) || 0;
  let key = normKey(s.metadata && s.metadata.key);
  const email = (s.customer_details && s.customer_details.email) || s.customer_email || '';
  if (!db.keys[key]) { key = newKey(); db.keys[key] = { credits: 0, spent: 0, email, created: Date.now(), source: 'stripe', note: '', allowUsd: 0, usd: 0 }; }
  db.keys[key].credits += credits;
  if (email && !db.keys[key].email) db.keys[key].email = email;
  db.orders.unshift({ id: s.id, key, email, pack: (s.metadata && s.metadata.pack) || '', credits, amount: (s.amount_total || 0) / 100, currency: s.currency || currency(), created: Date.now() });
  save();
  return { key, added: credits, credits: db.keys[key].credits };
}

if (!env.FAL_KEY) console.warn('⚠️  FAL_KEY не задан — генерация работать не будет');
if (!stripeOn()) console.warn('⚠️  Оплата выключена: нужны STRIPE_SECRET_KEY (sk_…) и STRIPE_PUBLISHABLE_KEY (pk_…)');
if (!env.ADMIN_PASSWORD) console.warn('⚠️  Админка выключена: задайте ADMIN_PASSWORD');
if (!PERSISTENT) console.warn('⚠️  Volume не подключён — рубины клиентов пропадут при обновлении сайта');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// простой лимит запросов с одного адреса
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

const origin = (req) => (env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

// клиент определяется личным кодом в заголовке x-key
const guard = wrap(async (req, res, next) => {
  const k = normKey(req.get('x-key'));
  if (!db.keys[k]) throw new UserError('Код не найден. Купите рубины или введите свой код.', 401);
  req.key = k; req.rec = db.keys[k];
  next();
});

// =====================================================================
// API для клиента
// =====================================================================
app.post('/api/stripe/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  if (!stripe || !WEBHOOK_SECRET) return res.status(400).json({ error: 'вебхук не настроен' });
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), WEBHOOK_SECRET); }
  catch { return res.status(400).json({ error: 'bad signature' }); }
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') fulfill(event.data.object);
  res.json({ received: true });
});

app.get('/api/config', (req, res) => res.json({
  brand: BRAND, currency: currency(), stripe: stripeOn(), publishableKey: stripeOn() ? PK : '',
  packs: db.settings.packs, prices: prices(),
}));

app.get('/api/me', limit(120, 60e3), guard, (req, res) => res.json({ key: req.key, credits: req.rec.credits }));

// покупка пакета: окно оплаты Stripe прямо на странице
app.post('/api/checkout', limit(20, 60e3), express.json({ limit: '10kb' }), wrap(async (req, res) => {
  if (!stripeOn()) throw new UserError('Оплата ещё не подключена.', 503);
  const pack = (db.settings.packs || []).find((p) => p.id === (req.body && req.body.pack));
  if (!pack) throw new UserError('Пакет не найден.');
  const key = keyRec(req.body.key) ? normKey(req.body.key) : '';
  try {
    const s = await stripe.checkout.sessions.create({
      ui_mode: 'embedded_page',
      mode: 'payment',
      locale: 'auto',
      redirect_on_completion: 'if_required',
      return_url: `${origin(req)}/?session_id={CHECKOUT_SESSION_ID}`,
      allow_promotion_codes: true,
      line_items: [{ quantity: 1, price_data: { currency: currency(), unit_amount: Math.round(pack.price * 100), product_data: { name: `${BRAND} — ${pack.name}`, description: `${pack.credits} рубинов на рекламные ролики` } } }],
      metadata: { pack: pack.id, credits: String(pack.credits), key },
    });
    res.json({ clientSecret: s.client_secret, sessionId: s.id });
  } catch (e) { console.error('Stripe:', e.message); throw new UserError(stripeMsg(e), 502); }
}));

// подтверждение оплаты: рубины зачисляются, браузер получает личный код
app.get('/api/checkout/confirm', limit(30, 60e3), wrap(async (req, res) => {
  const id = String(req.query.session_id || '');
  if (!/^cs_\w+$/.test(id)) throw new UserError('Некорректный платёж.');
  if (!stripe) throw new UserError('Оплата ещё не подключена.', 503);
  let s;
  try { s = await stripe.checkout.sessions.retrieve(id); } catch (e) { throw new UserError(stripeMsg(e), 502); }
  const r = fulfill(s);
  if (!r) throw new UserError('Платёж ещё не подтверждён. Обновите страницу через минуту.', 409);
  res.json({ ...r, pack: (s.metadata && s.metadata.pack) || '', amount: (s.amount_total || 0) / 100, currency: s.currency || currency() });
}));

// списать рубины за действие: новый ролик, перерисовка сцены или пересборка
app.post('/api/spend', limit(60, 60e3), express.json({ limit: '10kb' }), guard, wrap(async (req, res) => {
  const action = String((req.body && req.body.action) || '');
  if (!ACTIONS[action]) throw new UserError('Неизвестное действие.');
  const P = prices()[action], rec = req.rec;
  if (rec.credits < P) throw new UserError(rec.credits ? `Нужно 💎 ${P}, на балансе 💎 ${rec.credits}. Пополните рубины.` : 'Рубины закончились. Пополните баланс.', 402);
  rec.credits -= P;
  rec.spent = (rec.spent || 0) + P;
  rec.allowUsd = (rec.allowUsd || 0) + econ().usd[action] * ALLOW_X;
  const v = { id: newId(), key: req.key, action, rubies: P, usd: 0, created: Date.now() };
  db.videos.unshift(v);
  if (db.videos.length > 5000) db.videos.length = 5000;
  rec.current = v.id;
  save();
  res.json({ ok: true, id: v.id, credits: rec.credits, charged: P });
}));

// возврат рубинов, если действие не удалось и нейросети почти ничего не потратили
app.post('/api/refund', limit(30, 60e3), express.json({ limit: '10kb' }), guard, wrap(async (req, res) => {
  const v = db.videos.find((x) => x.id === String((req.body && req.body.id) || '') && x.key === req.key);
  if (!v) throw new UserError('Действие не найдено.', 404);
  const est = econ().usd[v.action] || 0;
  if (v.refunded || (v.usd || 0) > est * 0.15) return res.json({ ok: false, refunded: 0, credits: req.rec.credits });
  v.refunded = v.rubies;
  req.rec.credits += v.rubies;
  req.rec.spent = Math.max(0, (req.rec.spent || 0) - v.rubies);
  req.rec.allowUsd = Math.max(req.rec.usd || 0, (req.rec.allowUsd || 0) - est * ALLOW_X + (v.usd || 0));
  save();
  res.json({ ok: true, refunded: v.rubies, credits: req.rec.credits });
}));

// =====================================================================
// Прокси fal.ai: ключ на сервере, только нужные модели, тратится не больше оплаченного
// =====================================================================
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
function meter(req, res, next) {
  if (req.method !== 'POST') return next();
  let u;
  try { u = new URL(req.get('x-fal-target-url') || ''); } catch { return next(); }
  if (u.hostname !== 'fal.run' && !u.hostname.endsWith('.fal.run')) return next(); // загрузка файлов — бесплатно
  const cost = callCost(u.pathname.replace(/^\//, ''), req.body);
  const rec = req.rec;
  if ((rec.usd || 0) + cost > (rec.allowUsd || 0) + 1e-9) {
    const msg = 'Оплаченное действие закончилось — запустите его заново (рубины спишутся ещё раз).';
    return res.status(402).json({ error: msg, detail: msg });
  }
  rec.usd = (rec.usd || 0) + cost;
  const v = rec.current && db.videos.find((x) => x.id === rec.current);
  if (v) v.usd = +(v.usd + cost).toFixed(4);
  save();
  // если нейросеть не приняла запрос — расход не засчитываем
  res.on('finish', () => {
    if (res.statusCode >= 400) { rec.usd = Math.max(0, rec.usd - cost); if (v) v.usd = Math.max(0, +(v.usd - cost).toFixed(4)); save(); }
  });
  next();
}
app.all(FAL_ROUTE, limit(600, 60e3), guard, express.json({ limit: '5mb' }), meter, (req, res) => {
  falHandler(req, res, () => {}).catch((e) => { if (!res.headersSent) res.status(502).json({ error: String(e.message || e) }); });
});

// =====================================================================
// Проверка состояния и админка
// =====================================================================
async function stripeCheck() {
  if (!stripe) return { ok: false, text: 'не подключён (STRIPE_SECRET_KEY)' };
  if (!/^pk_/.test(PK)) return { ok: false, text: 'нет STRIPE_PUBLISHABLE_KEY (pk_…)' };
  try { await stripe.checkout.sessions.list({ limit: 1 }); return { ok: true, text: `подключён (${stripeMode()})` }; }
  catch (e) { return { ok: false, text: stripeMsg(e) }; }
}
async function falCheck() {
  if (!env.FAL_KEY) return { ok: false, text: 'нет FAL_KEY' };
  try {
    const r = await fetch('https://queue.fal.run/fal-ai/any-llm/requests/00000000-0000-0000-0000-000000000000/status', { headers: { authorization: 'Key ' + env.FAL_KEY }, signal: AbortSignal.timeout(8000) });
    if (r.status === 401 || r.status === 403) return { ok: false, text: 'ключ не принят' };
    return { ok: true, text: 'ключ принят' };
  } catch { return { ok: false, text: 'fal.ai не отвечает' }; }
}
app.get('/api/health', wrap(async (req, res) => {
  const [f, s] = await Promise.all([falCheck(), stripeCheck()]);
  res.json({
    fal: f.text, stripe: s.text, webhook: WEBHOOK_SECRET ? 'подключён' : 'не подключён (STRIPE_WEBHOOK_SECRET)',
    storage: PERSISTENT ? `сохраняется (${DATA_DIR})` : 'ВНИМАНИЕ: Volume не подключён — рубины пропадут при обновлении',
    admin: env.ADMIN_PASSWORD ? 'включена' : 'выключена (ADMIN_PASSWORD)',
  });
}));

function isAdmin(req) {
  const pass = env.ADMIN_PASSWORD || '';
  if (!pass) throw new UserError('Админка выключена: задайте ADMIN_PASSWORD в Railway → Variables.', 403);
  const a = crypto.createHash('sha256').update(pass).digest(), b = crypto.createHash('sha256').update(String(req.get('x-admin') || '')).digest();
  if (!crypto.timingSafeEqual(a, b)) throw new UserError('Неверный пароль.', 401);
}
const admin = express.Router();
admin.use(limit(120, 60e3), express.json({ limit: '100kb' }), wrap(async (req, res, next) => { isAdmin(req); next(); }));
admin.get('/stats', wrap(async (req, res) => {
  const DAY = 864e5, start = new Date(); start.setHours(0, 0, 0, 0);
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const from = start.getTime() - i * DAY, to = from + DAY;
    days.push({
      day: from,
      videos: db.videos.filter((v) => v.created >= from && v.created < to && (v.action === 'premium' || v.action === 'std')).length,
      revenue: db.orders.filter((o) => o.created >= from && o.created < to).reduce((s, o) => s + o.amount, 0),
    });
  }
  const since = (ms) => db.orders.filter((o) => o.created >= Date.now() - ms);
  const sum = (a) => a.reduce((s, o) => s + o.amount, 0);
  const vids = db.videos.filter((v) => v.action === 'premium' || v.action === 'std');
  const [f, s] = await Promise.all([falCheck(), stripeCheck()]);
  res.json({
    brand: BRAND, currency: currency(), days, today: days[13],
    revenue7: sum(since(7 * DAY)), revenue30: sum(since(30 * DAY)), revenueAll: sum(db.orders),
    orders: db.orders.length, videos: vids.length, premium: vids.filter((v) => v.action === 'premium').length, std: vids.filter((v) => v.action === 'std').length,
    edits: db.videos.length - vids.length,
    falCost: +db.videos.reduce((a, v) => a + (v.usd || 0), 0).toFixed(2),
    rubiesSold: db.orders.reduce((a, o) => a + o.credits, 0),
    rubiesLeft: Object.values(db.keys).reduce((a, k) => a + k.credits, 0),
    clients: Object.keys(db.keys).length,
    system: { fal: f.text, falOk: f.ok, stripe: s.text, stripeOk: s.ok, webhook: !!WEBHOOK_SECRET, persistent: PERSISTENT, dataDir: DATA_DIR, publicUrl: !!env.PUBLIC_URL },
  });
}));
admin.get('/videos', (req, res) => res.json(db.videos.slice(0, 300).map((v) => ({ ...v, label: ACTIONS[v.action] || v.action, email: (db.keys[v.key] || {}).email || '' }))));
admin.get('/orders', (req, res) => res.json(db.orders.slice(0, 300)));
admin.get('/keys', (req, res) => res.json(Object.entries(db.keys).map(([key, v]) => ({ key, ...v })).sort((a, b) => b.created - a.created).slice(0, 500)));
admin.post('/keys', wrap(async (req, res) => {
  const { credits, note, email } = req.body || {};
  const c = Math.max(0, Math.min(1e5, parseInt(credits, 10) || 0));
  if (!c) throw new UserError('Укажите количество рубинов.');
  const key = newKey();
  db.keys[key] = { credits: c, spent: 0, email: String(email || '').slice(0, 120), created: Date.now(), source: 'promo', note: String(note || '').slice(0, 120), allowUsd: 0, usd: 0 };
  save();
  res.json({ key, ...db.keys[key] });
}));
admin.post('/keys/adjust', wrap(async (req, res) => {
  const { key, delta } = req.body || {};
  const rec = keyRec(key);
  if (!rec) throw new UserError('Код не найден.', 404);
  rec.credits = Math.max(0, rec.credits + (parseInt(delta, 10) || 0));
  save();
  res.json({ key: normKey(key), credits: rec.credits });
}));
admin.post('/packs', wrap(async (req, res) => {
  const { packs, currency: cur } = req.body || {};
  if (!Array.isArray(packs) || !packs.length || packs.length > 6) throw new UserError('Нужно от 1 до 6 пакетов.');
  db.settings.packs = packs.map((p, i) => ({
    id: String(p.id || `pack${i}`).replace(/[^\w-]/g, '').slice(0, 20) || `pack${i}`,
    name: String(p.name || '').slice(0, 40) || 'Пакет',
    credits: Math.max(1, parseInt(p.credits, 10) || 1),
    price: Math.max(0.5, Math.round((parseFloat(p.price) || 1) * 100) / 100),
    popular: Boolean(p.popular),
  }));
  if (['eur', 'usd', 'gbp'].includes(cur)) db.settings.currency = cur;
  save();
  res.json({ packs: db.settings.packs, currency: db.settings.currency });
}));
admin.get('/prices', (req, res) => res.json(econReport()));
admin.post('/prices', (req, res) => { saveEcon(req.body || {}); res.json(econReport()); });
app.use('/api/admin', admin);
app.get('/admin', (req, res) => { res.set('x-robots-tag', 'noindex, nofollow'); res.sendFile(path.join(__dirname, 'public', 'admin.html')); });

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
