// Сервис рекламных роликов: отдаёт страницу и прячет ключ fal.ai на сервере.
// Запуск: FAL_KEY=... ACCESS_CODES=код1,код2 node server.js
import express from 'express';
import { createHandler, route as FAL_ROUTE } from '@fal-ai/server-proxy/express';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const CODES = (process.env.ACCESS_CODES || '').split(',').map((s) => s.trim()).filter(Boolean);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

if (!process.env.FAL_KEY) console.warn('⚠️  FAL_KEY не задан — генерация работать не будет');
if (!CODES.length) console.warn('⚠️  ACCESS_CODES не задан — любой, кто знает адрес, сможет тратить ваш баланс fal.ai');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// ---------- коды доступа для клиентов ----------
const guard = (req, res, next) => {
  if (!CODES.length || CODES.includes(req.get('x-access-code') || '')) return next();
  res.status(401).json({ error: 'неверный код доступа' });
};

// простой лимит запросов с одного адреса, чтобы никто не «залил» сервис
const hits = new Map();
const limit = (max, windowMs) => (req, res, next) => {
  const key = req.ip + '|' + max;
  const now = Date.now();
  const h = hits.get(key) || { n: 0, t: now };
  if (now - h.t > windowMs) { h.n = 0; h.t = now; }
  h.n++; hits.set(key, h);
  if (h.n > max) return res.status(429).json({ error: 'слишком много запросов, подождите минуту' });
  next();
};
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (now - h.t > 3600e3) hits.delete(k); }, 600e3).unref();

app.get('/api/config', (req, res) => res.json({ codeRequired: CODES.length > 0 }));
app.get('/api/check', limit(30, 60e3), guard, (req, res) => res.json({ ok: true }));

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
app.all(FAL_ROUTE, limit(600, 60e3), guard, express.json({ limit: '5mb' }), (req, res, next) => {
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
