// AdsVideoMaker: сайт рекламных роликов. Ключ fal.ai на сервере, оплата кристаллами через Stripe, админка /admin.
// Как в SnapDance: клиент покупает пакет кристаллов, получает личный код AV-…, цены в кристаллах считаются сами
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
const CLIPS_DIR = path.join(DATA_DIR, 'clips');       // ролики клиентов
const EX_DIR = path.join(DATA_DIR, 'examples');       // примеры на главной
const CLIP_DAYS = Math.max(1, +env.CLIP_DAYS || 90);  // сколько дней хранить ролики клиентов
try { fs.mkdirSync(CLIPS_DIR, { recursive: true }); fs.mkdirSync(EX_DIR, { recursive: true }); } catch {}
const CONTACT = (env.CONTACT_EMAIL || '').trim();
const OWNER = (env.OWNER_NAME || '').trim();
const DEFAULT_PACKS = [
  { id: 'start', name: 'Старт', credits: 50, price: 4.99, popular: false },
  { id: 'business', name: 'Бизнес', credits: 150, price: 12.99, popular: true },
  { id: 'agency', name: 'Агентство', credits: 500, price: 39.99, popular: false },
];
// старые пакеты по умолчанию (до перехода на дешёвые ролики до 15 сек) — заменяются автоматически
const OLD_DEFAULT_PRICES = [[14.99, 44.99, 119.99], [19.99, 44.99, 119.99]];
const emptyDb = () => ({
  keys: {},     // AV-… → { credits, spent, email, created, source, note, allowUsd, usd }
  orders: [],   // { id, key, email, pack, credits, amount, currency, created }
  videos: [],   // журнал списаний: { id, key, action, rubies, usd, created, free }
  clips: [],    // готовые ролики клиентов: { id, key, created, size, poster, title, captions, lang, mode, domain }
  examples: [], // примеры на главной: { id, caption, hidden, created, poster }
  trials: {},   // хеш адреса → код с подарочными роликами (один подарок на адрес)
  settings: { packs: DEFAULT_PACKS, currency: 'eur', econ: {}, freeVideos: 3 },
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
// переход на дешёвые ролики до 15 сек: старые цены по умолчанию заменяем новыми (свои настройки не трогаем)
if (!db.settings.v15) {
  const pr = (db.settings.packs || []).map((p) => p.price).join(',');
  if (OLD_DEFAULT_PRICES.some((a) => a.join(',') === pr)) db.settings.packs = DEFAULT_PACKS;
  const u = (db.settings.econ && db.settings.econ.usd) || null;
  if (u && u.std === 1.2 && u.redraw === 0.1 && u.rebuild === 0.3) delete db.settings.econ.usd;
  if (u && u.premium !== undefined) { delete u.premium; }
  db.settings.v15 = true;
  setTimeout(() => save(), 0);
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
// Экономика: цена в кристаллах = себестоимость fal.ai × наценка
// =====================================================================
const ACTIONS = {
  std: 'Ролик 15 сек',
  std30: 'Ролик 30 сек',
  redraw: 'Перерисовать сцену',
  rebuild: 'Пересобрать ролик 15 сек',
  rebuild30: 'Пересобрать ролик 30 сек',
};
const LABELS = { ...ACTIONS, premium: 'Ролик «Премиум» (старый)' };
const DEFAULT_ECON = {
  markup: 3,        // во сколько раз клиент платит больше себестоимости fal.ai
  feePct: 4,        // комиссия Stripe с запасом, %
  feeFixed: 0.3,    // фиксированная часть комиссии Stripe, в валюте пакетов
  vat: 0,           // НДС / IVA, если цены пакетов его включают, %
  fx: null,         // курс валюты пакетов к $; null — по умолчанию
  failReserve: 10,  // запас на неудачные генерации и автоисправления, %
  usd: { std: 0.15, std30: 0.28, redraw: 0.02, rebuild: 0.08, rebuild30: 0.12 }, // себестоимость действия в fal.ai, $ (дешёвые модели, ролик до 15 сек, без автоанализа)
};
const FX = { eur: 1.05, usd: 1, gbp: 1.25 };
const ALLOW_X = 1.6; // сколько $ fal.ai разрешено потратить на оплаченное действие (с запасом на повторы)
function econ() {
  const s = db.settings.econ || {};
  const e = { ...DEFAULT_ECON, ...s, usd: { ...DEFAULT_ECON.usd, ...(s.usd || {}) } };
  for (const k of Object.keys(e.usd)) if (!ACTIONS[k]) delete e.usd[k];
  e.fxRate = Number(e.fx) > 0 ? Number(e.fx) : FX[currency()] || 1;
  return e;
}
// сколько $ остаётся вам с одного кристалла по самому выгодному пакету — после комиссии Stripe и НДС
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
  if (b.freeVideos !== undefined) db.settings.freeVideos = Math.max(0, Math.min(10, parseInt(b.freeVideos, 10) || 0));
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
    econ: e, freeVideos: freeVideos(), currency: currency().toUpperCase(), rubyValueUsd: +rv.toFixed(4), rubyPrice: +rubyPrice.toFixed(4), rubiesPerUsd: +rubiesPerUsd().toFixed(2),
    actions: Object.entries(ACTIONS).map(([id, label]) => ({
      id, label, usd: e.usd[id], def: DEFAULT_ECON.usd[id], rubies: P[id],
      client: +(P[id] * rubyPrice).toFixed(2), net: +(P[id] * rv).toFixed(2), x: +(P[id] * rv / Math.max(0.001, e.usd[id])).toFixed(2),
    })),
  };
}

// себестоимость одного вызова нейросети в fal.ai ($) — для учёта расходов и лимита по оплаченному
function callCost(endpoint, body) {
  if (endpoint.startsWith('fal-ai/any-llm')) return 0.005;
  if (endpoint.startsWith('openai/gpt-image-2')) {
    const q = (body && body.quality) || 'medium', edit = endpoint.endsWith('/edit');
    return q === 'low' ? (edit ? 0.02 : 0.006) : q === 'high' ? 0.2 : (edit ? 0.07 : 0.05);
  }
  if (endpoint.startsWith('fal-ai/kling-video')) return 0.35;
  if (endpoint === 'fal-ai/elevenlabs/tts/eleven-v3') return Math.max(0.005, String((body && body.text) || '').length / 1000 * 0.1);
  if (endpoint === 'fal-ai/elevenlabs/music') return Math.max(0.1, ((body && body.music_length_ms) || 30000) / 60000 * 0.8);
  if (endpoint === 'CassetteAI/music-generator') return 0.02;
  return 0.05;
}

// =====================================================================
// Stripe
// =====================================================================
// ключи читаем терпимо: без кавычек и пробелов, с похожими названиями переменных,
// и даже если ключи перепутаны местами
const clean = (v) => String(v || '').trim().replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, '');
const envAny = (...names) => { for (const n of names) if (clean(env[n])) return clean(env[n]); return ''; };
const allStripe = [envAny('STRIPE_SECRET_KEY', 'STRIPE_SECRET', 'STRIPE_SK', 'STRIPE_KEY'), envAny('STRIPE_PUBLISHABLE_KEY', 'STRIPE_PUBLIC_KEY', 'STRIPE_PUBLISHABLE', 'STRIPE_PK', 'STRIPE_PUB_KEY')];
const SK = allStripe.find((k) => /^(sk|rk)_/.test(k)) || allStripe[0];
const PK = allStripe.find((k) => /^pk_/.test(k)) || '';
const stripe = /^(sk|rk)_/.test(SK) ? new Stripe(SK) : null;
const stripeOn = () => Boolean(stripe && /^pk_/.test(PK));
const stripeMode = () => (/_live_/.test(SK) ? 'боевой режим' : /_test_/.test(SK) ? 'тестовый режим' : '');
const WEBHOOK_SECRET = envAny('STRIPE_WEBHOOK_SECRET', 'STRIPE_WEBHOOK', 'STRIPE_WHSEC');
function stripeMsg(e) {
  const m = String((e && e.message) || e);
  if (/invalid api key|no api key|expired api key/i.test(m) || (e && e.statusCode === 401)) return 'Оплата: Stripe не принял ключ. Проверьте STRIPE_SECRET_KEY в Railway → Variables (sk_live_… или sk_test_… целиком, без пробелов).';
  if (/live charges|activate|activation|charges_enabled/i.test(m)) return 'Оплата: аккаунт Stripe ещё не активирован для приёма платежей. Завершите активацию в Stripe или используйте тестовый ключ sk_test_….';
  if (/currency/i.test(m)) return 'Оплата: Stripe не принимает эту валюту для вашего аккаунта. Поменяйте валюту пакетов в админке.';
  if (/url/i.test(m) && /valid|invalid/i.test(m)) return 'Оплата: Stripe не принял адрес сайта. Задайте PUBLIC_URL в Railway → Variables: https://ваш-адрес, без / в конце.';
  return 'Оплата: Stripe ответил ошибкой — ' + m.slice(0, 200);
}
// зачислить кристаллы по оплаченной сессии (один раз на сессию)
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
if (!PERSISTENT) console.warn('⚠️  Volume не подключён — кристаллы клиентов пропадут при обновлении сайта');

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

// адрес сайта: PUBLIC_URL в любом виде («сайт.up.railway.app», «https://сайт/», с кавычками) → https://сайт
function cleanOrigin(v) {
  let s = String(v || '').trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  try { const u = new URL(s); return /^[\w.-]+(:\d+)?$/.test(u.host) ? `${u.protocol}//${u.host}` : ''; } catch { return ''; }
}
const origin = (req) => cleanOrigin(env.PUBLIC_URL) || `${String(req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0]}://${req.get('host')}`;
if (env.PUBLIC_URL && !cleanOrigin(env.PUBLIC_URL)) console.warn('⚠️  PUBLIC_URL выглядит неправильно — нужен адрес сайта, например https://adsvideomaker.up.railway.app');

// клиент определяется личным кодом в заголовке x-key
const guard = wrap(async (req, res, next) => {
  const k = normKey(req.get('x-key'));
  if (!db.keys[k]) throw new UserError('Код не найден. Купите кристаллы или введите свой код.', 401);
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

const freeVideos = () => Math.max(0, Math.min(10, parseInt(db.settings.freeVideos ?? 3, 10) || 0));
const publicExamples = () => db.examples.filter((e) => !e.hidden).map((e) => ({ id: e.id, caption: e.caption || '', url: `/media/e/${e.id}.mp4`, poster: e.poster ? `/media/e/${e.id}.jpg` : '' }));
app.get('/api/config', (req, res) => res.json({
  brand: BRAND, currency: currency(), stripe: stripeOn(), publishableKey: stripeOn() ? PK : '',
  packs: db.settings.packs, prices: prices(), freeVideos: freeVideos(), examples: publicExamples(), contact: CONTACT, owner: OWNER, clipDays: CLIP_DAYS,
}));

app.get('/api/me', limit(120, 60e3), guard, (req, res) => res.json({ key: req.key, credits: req.rec.credits, free: req.rec.free || 0 }));

// подарок новому посетителю: N бесплатных роликов, не больше одного подарка на интернет-адрес
const ipHash = (req) => crypto.createHash('sha256').update('ip:' + (env.TRIAL_SECRET || env.FAL_KEY || 'x') + ':' + String(req.ip || '')).digest('hex').slice(0, 32);
app.post('/api/trial', limit(10, 60e3), wrap(async (req, res) => {
  const n = freeVideos();
  if (!n) return res.json({ key: '', free: 0, given: false });
  const h = ipHash(req), old = db.trials[h] && db.keys[db.trials[h]];
  // повторный подарок с того же адреса не выдаём, и чужой код никому не показываем
  if (old) return res.json({ key: '', free: 0, given: false });
  const key = newKey();
  db.keys[key] = { credits: 0, free: n, spent: 0, email: '', created: Date.now(), source: 'trial', note: '', allowUsd: 0, usd: 0 };
  db.trials[h] = key;
  save();
  res.json({ key, free: n, credits: 0, given: true });
}));

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
      line_items: [{ quantity: 1, price_data: { currency: currency(), unit_amount: Math.round(pack.price * 100), product_data: { name: `${BRAND} — ${pack.name}`, description: `${pack.credits} кристаллов на рекламные ролики` } } }],
      metadata: { pack: pack.id, credits: String(pack.credits), key },
    });
    res.json({ clientSecret: s.client_secret, sessionId: s.id });
  } catch (e) { console.error('Stripe:', e.message); throw new UserError(stripeMsg(e), 502); }
}));

// подтверждение оплаты: кристаллы зачисляются, браузер получает личный код
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

// списать кристаллы за действие: новый ролик, перерисовка сцены или пересборка
app.post('/api/spend', limit(60, 60e3), express.json({ limit: '10kb' }), guard, wrap(async (req, res) => {
  const action = String((req.body && req.body.action) || '');
  if (!ACTIONS[action]) throw new UserError('Неизвестное действие.');
  const rec = req.rec, free = (action === 'std' || action === 'std30') && (rec.free || 0) > 0;
  const P = free ? 0 : prices()[action];
  if (!free && rec.credits < P) throw new UserError(rec.credits ? `Нужно 💎 ${P}, на балансе 💎 ${rec.credits}. Пополните кристаллы.` : 'Бесплатные ролики закончились. Купите кристаллы, чтобы делать ролики дальше.', 402);
  if (free) rec.free -= 1;
  rec.credits -= P;
  rec.spent = (rec.spent || 0) + P;
  rec.allowUsd = (rec.allowUsd || 0) + econ().usd[action] * ALLOW_X;
  const v = { id: newId(), key: req.key, action, rubies: P, usd: 0, created: Date.now(), free };
  db.videos.unshift(v);
  if (db.videos.length > 5000) db.videos.length = 5000;
  rec.current = v.id;
  save();
  res.json({ ok: true, id: v.id, credits: rec.credits, free: rec.free || 0, charged: P, wasFree: free });
}));

// возврат кристаллов, если действие не удалось и нейросети почти ничего не потратили
app.post('/api/refund', limit(30, 60e3), express.json({ limit: '10kb' }), guard, wrap(async (req, res) => {
  const v = db.videos.find((x) => x.id === String((req.body && req.body.id) || '') && x.key === req.key);
  if (!v) throw new UserError('Действие не найдено.', 404);
  const est = econ().usd[v.action] || 0;
  if (v.refunded || (v.usd || 0) > est * 0.15) return res.json({ ok: false, refunded: 0, credits: req.rec.credits });
  v.refunded = v.free ? 'free' : v.rubies;
  if (v.free) req.rec.free = (req.rec.free || 0) + 1;
  req.rec.credits += v.rubies;
  req.rec.spent = Math.max(0, (req.rec.spent || 0) - v.rubies);
  req.rec.allowUsd = Math.max(req.rec.usd || 0, (req.rec.allowUsd || 0) - est * ALLOW_X + (v.usd || 0));
  save();
  res.json({ ok: true, refunded: v.rubies, freeBack: !!v.free, credits: req.rec.credits, free: req.rec.free || 0 });
}));

// =====================================================================
// История роликов клиента (файлы на Volume) и страница «поделиться»
// =====================================================================
const MAX_VIDEO = 120 * 1024 * 1024;
const rawVideo = express.raw({ type: () => true, limit: MAX_VIDEO });
const rawImage = express.raw({ type: () => true, limit: 5 * 1024 * 1024 });
const isMp4 = (b) => Buffer.isBuffer(b) && b.length > 1000 && b.slice(4, 8).toString('latin1') === 'ftyp';
const isJpeg = (b) => Buffer.isBuffer(b) && b.length > 100 && b[0] === 0xff && b[1] === 0xd8;
const meta = (req) => { try { return JSON.parse(Buffer.from(String(req.get('x-meta') || ''), 'base64').toString('utf8')) || {}; } catch { return {}; } };
const str = (v, n) => String(v || '').slice(0, n);
const clipOut = (c) => ({ id: c.id, created: c.created, title: c.title, captions: c.captions, lang: c.lang, mode: c.mode, domain: c.domain, url: `/media/c/${c.id}.mp4`, poster: c.poster ? `/media/c/${c.id}.jpg` : '', share: `/v/${c.id}` });
const fileOf = (dir, id, ext) => path.join(dir, `${id}.${ext}`);
const rm = (f) => fs.promises.unlink(f).catch(() => {});

app.post('/api/clips', limit(20, 60e3), guard, rawVideo, wrap(async (req, res) => {
  if (!isMp4(req.body)) throw new UserError('Это не видеофайл MP4.');
  const m = meta(req), id = newId();
  await fs.promises.writeFile(fileOf(CLIPS_DIR, id, 'mp4'), req.body);
  const c = {
    id, key: req.key, created: Date.now(), size: req.body.length, poster: false,
    title: str(m.title, 120), lang: str(m.lang, 20), mode: str(m.mode, 20), domain: str(m.domain, 120),
    captions: { tiktok: str(m.captions && m.captions.tiktok, 600), reels: str(m.captions && m.captions.reels, 900), shortsTitle: str(m.captions && m.captions.shortsTitle, 120), shorts: str(m.captions && m.captions.shorts, 600) },
  };
  db.clips.unshift(c);
  // у одного клиента храним не больше 200 роликов
  const mine = db.clips.filter((x) => x.key === req.key);
  for (const old of mine.slice(200)) { rm(fileOf(CLIPS_DIR, old.id, 'mp4')); rm(fileOf(CLIPS_DIR, old.id, 'jpg')); db.clips.splice(db.clips.indexOf(old), 1); }
  save();
  res.json(clipOut(c));
}));
app.post('/api/clips/:id/poster', limit(20, 60e3), guard, rawImage, wrap(async (req, res) => {
  const c = db.clips.find((x) => x.id === req.params.id && x.key === req.key);
  if (!c) throw new UserError('Ролик не найден.', 404);
  if (!isJpeg(req.body)) throw new UserError('Нужна картинка JPEG.');
  await fs.promises.writeFile(fileOf(CLIPS_DIR, c.id, 'jpg'), req.body);
  c.poster = true; save();
  res.json(clipOut(c));
}));
app.get('/api/clips', limit(60, 60e3), guard, (req, res) => res.json(db.clips.filter((c) => c.key === req.key).slice(0, 200).map(clipOut)));
app.post('/api/clips/delete', limit(30, 60e3), express.json({ limit: '10kb' }), guard, wrap(async (req, res) => {
  const i = db.clips.findIndex((x) => x.id === String(req.body && req.body.id) && x.key === req.key);
  if (i < 0) throw new UserError('Ролик не найден.', 404);
  const [c] = db.clips.splice(i, 1);
  rm(fileOf(CLIPS_DIR, c.id, 'mp4')); rm(fileOf(CLIPS_DIR, c.id, 'jpg'));
  save();
  res.json({ ok: true });
}));

// файлы роликов и примеров (адреса не угадать: 16 случайных символов)
const sendMedia = (dir) => (req, res) => {
  const m = String(req.params.file || '').match(/^([a-f0-9]{16})\.(mp4|jpg)$/);
  if (!m) return res.status(404).end();
  const f = fileOf(dir, m[1], m[2]);
  if (!fs.existsSync(f)) return res.status(404).end();
  res.set('cache-control', 'public, max-age=86400');
  res.sendFile(f);
};
app.get('/media/c/:file', sendMedia(CLIPS_DIR));
app.get('/media/e/:file', sendMedia(EX_DIR));

// страница ролика, которой клиент делится в соцсетях и мессенджерах
const escH = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
app.get('/v/:id', (req, res) => {
  const c = db.clips.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ролик не найден</title><body style="font-family:system-ui;text-align:center;padding:60px 20px"><h1>Ролик не найден</h1><p>Возможно, его удалили.</p><p><a href="/">Сделать свой рекламный ролик →</a></p>`);
  const o = origin(req), v = `${o}/media/c/${c.id}.mp4`, img = c.poster ? `${o}/media/c/${c.id}.jpg` : '';
  const title = c.title || 'Рекламный ролик';
  res.set('x-robots-tag', 'noindex');
  res.send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escH(title)} — ${escH(BRAND)}</title>
<meta property="og:type" content="video.other"><meta property="og:title" content="${escH(title)}"><meta property="og:description" content="Рекламный ролик, сделанный за пару минут в ${escH(BRAND)}">
<meta property="og:url" content="${o}/v/${c.id}"><meta property="og:video" content="${v}"><meta property="og:video:type" content="video/mp4"><meta property="og:video:width" content="1080"><meta property="og:video:height" content="1920">
${img ? `<meta property="og:image" content="${img}"><meta name="twitter:image" content="${img}">` : ''}<meta name="twitter:card" content="${img ? 'summary_large_image' : 'summary'}">
<style>body{margin:0;background:#0b0a10;color:#fff;font-family:Montserrat,system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;gap:18px;padding:22px 14px 40px;min-height:100vh;box-sizing:border-box}
video{width:min(380px,100%);aspect-ratio:9/16;border-radius:22px;background:#000;box-shadow:0 20px 60px rgba(0,0,0,.5)}h1{font-size:20px;margin:0;text-align:center}p{margin:0;color:rgba(255,255,255,.7);text-align:center;font-size:14px}
a.b{display:inline-block;background:linear-gradient(90deg,#7b2ff7,#ff2d55 55%,#ff8a3d);color:#fff;text-decoration:none;font-weight:900;padding:16px 26px;border-radius:18px}</style></head>
<body><h1>${escH(title)}</h1><video src="${v}" ${img ? `poster="${img}"` : ''} controls playsinline autoplay muted loop></video>
<p>Этот рекламный ролик сделан нейросетью за пару минут</p><a class="b" href="/">🎬 Сделать такой же ролик</a></body></html>`);
});

// старые ролики клиентов удаляются сами (примеры на главной не трогаем)
function cleanupClips() {
  const edge = Date.now() - CLIP_DAYS * 864e5;
  const old = db.clips.filter((c) => c.created < edge);
  if (!old.length) return;
  for (const c of old) { rm(fileOf(CLIPS_DIR, c.id, 'mp4')); rm(fileOf(CLIPS_DIR, c.id, 'jpg')); }
  db.clips = db.clips.filter((c) => c.created >= edge);
  save();
}
setInterval(cleanupClips, 6 * 3600e3).unref();
setTimeout(cleanupClips, 60e3).unref();

// =====================================================================
// Прокси fal.ai: ключ на сервере, только нужные модели, тратится не больше оплаченного
// =====================================================================
const falHandler = createHandler({
  allowedEndpoints: [
    'fal-ai/any-llm', 'fal-ai/any-llm/**',
    'openai/gpt-image-2', 'openai/gpt-image-2/**',
    'fal-ai/elevenlabs/tts/eleven-v3',
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
    const msg = 'Оплаченное действие закончилось — запустите его заново (кристаллы спишутся ещё раз).';
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
  if (!/^pk_/.test(PK)) {
    const seen = Object.keys(env).filter((k) => /stripe/i.test(k));
    return { ok: false, text: `нет STRIPE_PUBLISHABLE_KEY (pk_…). Сервер видит переменные: ${seen.join(', ') || 'никаких со словом STRIPE'}` };
  }
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
    storage: PERSISTENT ? `сохраняется (${DATA_DIR})` : 'ВНИМАНИЕ: Volume не подключён — кристаллы пропадут при обновлении',
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
      videos: db.videos.filter((v) => v.created >= from && v.created < to && (v.action === 'premium' || v.action === 'std' || v.action === 'std30')).length,
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
    clips: db.clips.length, trials: Object.keys(db.trials).length,
    freeUsed: db.videos.filter((v) => v.free && !v.refunded).length,
    freeCost: +db.videos.filter((v) => v.free).reduce((a, v) => a + (v.usd || 0), 0).toFixed(2),
    disk: { clips: db.clips.reduce((a, c) => a + (c.size || 0), 0), days: CLIP_DAYS },
    system: { fal: f.text, falOk: f.ok, stripe: s.text, stripeOk: s.ok, webhook: !!WEBHOOK_SECRET, persistent: PERSISTENT, dataDir: DATA_DIR, publicUrl: !!env.PUBLIC_URL },
  });
}));
admin.get('/videos', (req, res) => res.json(db.videos.slice(0, 300).map((v) => ({ ...v, label: LABELS[v.action] || v.action, email: (db.keys[v.key] || {}).email || '' }))));
admin.get('/clips', (req, res) => res.json(db.clips.slice(0, 200).map((c) => ({ ...clipOut(c), key: c.key, email: (db.keys[c.key] || {}).email || '', size: c.size }))));
admin.post('/clips/delete', wrap(async (req, res) => {
  const i = db.clips.findIndex((x) => x.id === String(req.body && req.body.id));
  if (i < 0) throw new UserError('Ролик не найден.', 404);
  const [c] = db.clips.splice(i, 1);
  rm(fileOf(CLIPS_DIR, c.id, 'mp4')); rm(fileOf(CLIPS_DIR, c.id, 'jpg'));
  save(); res.json({ ok: true });
}));
// примеры на главной
const exOut = (e) => ({ ...e, url: `/media/e/${e.id}.mp4`, posterUrl: e.poster ? `/media/e/${e.id}.jpg` : '' });
admin.get('/examples', (req, res) => res.json(db.examples.map(exOut)));
admin.post('/examples/from-clip', wrap(async (req, res) => {
  const c = db.clips.find((x) => x.id === String(req.body && req.body.id));
  if (!c) throw new UserError('Ролик не найден.', 404);
  const id = newId();
  await fs.promises.copyFile(fileOf(CLIPS_DIR, c.id, 'mp4'), fileOf(EX_DIR, id, 'mp4'));
  let poster = false;
  if (c.poster) { await fs.promises.copyFile(fileOf(CLIPS_DIR, c.id, 'jpg'), fileOf(EX_DIR, id, 'jpg')).then(() => (poster = true)).catch(() => {}); }
  const e = { id, caption: str(req.body.caption || c.title, 120), hidden: false, created: Date.now(), poster };
  db.examples.unshift(e); save();
  res.json(exOut(e));
}));
admin.post('/examples/update', wrap(async (req, res) => {
  const b = req.body || {}, i = db.examples.findIndex((x) => x.id === String(b.id));
  if (i < 0) throw new UserError('Пример не найден.', 404);
  const e = db.examples[i];
  if (b.caption !== undefined) e.caption = str(b.caption, 120);
  if (b.hidden !== undefined) e.hidden = !!b.hidden;
  if (b.move === -1 || b.move === 1) { const j = i + b.move; if (j >= 0 && j < db.examples.length) [db.examples[i], db.examples[j]] = [db.examples[j], db.examples[i]]; }
  save(); res.json(db.examples.map(exOut));
}));
admin.post('/examples/delete', wrap(async (req, res) => {
  const i = db.examples.findIndex((x) => x.id === String(req.body && req.body.id));
  if (i < 0) throw new UserError('Пример не найден.', 404);
  const [e] = db.examples.splice(i, 1);
  rm(fileOf(EX_DIR, e.id, 'mp4')); rm(fileOf(EX_DIR, e.id, 'jpg'));
  save(); res.json({ ok: true });
}));
admin.get('/orders', (req, res) => res.json(db.orders.slice(0, 300)));
admin.get('/keys', (req, res) => res.json(Object.entries(db.keys).map(([key, v]) => ({ key, ...v })).sort((a, b) => b.created - a.created).slice(0, 500)));
admin.post('/keys', wrap(async (req, res) => {
  const { credits, note, email } = req.body || {};
  const c = Math.max(0, Math.min(1e5, parseInt(credits, 10) || 0));
  if (!c) throw new UserError('Укажите количество кристаллов.');
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
const adminRaw = (fn) => wrap(async (req, res) => { isAdmin(req); await fn(req, res); });
app.post('/api/admin/examples/upload', limit(30, 60e3), rawVideo, adminRaw(async (req, res) => {
  if (!isMp4(req.body)) throw new UserError('Загрузите видео в формате MP4.');
  const id = newId();
  await fs.promises.writeFile(fileOf(EX_DIR, id, 'mp4'), req.body);
  const e = { id, caption: str(meta(req).caption, 120), hidden: false, created: Date.now(), poster: false };
  db.examples.unshift(e); save();
  res.json({ ...e, url: `/media/e/${id}.mp4` });
}));
app.post('/api/admin/examples/:id/poster', limit(30, 60e3), rawImage, adminRaw(async (req, res) => {
  const e = db.examples.find((x) => x.id === req.params.id);
  if (!e) throw new UserError('Пример не найден.', 404);
  if (!isJpeg(req.body)) throw new UserError('Нужна картинка JPEG.');
  await fs.promises.writeFile(fileOf(EX_DIR, e.id, 'jpg'), req.body);
  e.poster = true; save(); res.json({ ok: true });
}));
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
