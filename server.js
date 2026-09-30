/* =====================================================================
   WATCHDOG BACKEND (RC7) — veilige proxy voor Live Search, met wisselbare zoekbron.
   - De geheime API-sleutels blijven op de server. De frontend (GitHub Pages) kent ze nooit.
   - Zoekbronnen: SerpApi en Serper (beide Google + Google Shopping). Kies met SEARCH_PROVIDER.
     Geeft de gekozen bron een fout of is het tegoed op, dan probeert de backend automatisch de andere.
   - Bevat GEEN mock-/demodata: zonder geldige sleutel geeft /api/search eerlijk 'not-configured' terug.
   - Het antwoordformaat is gelijk aan RC6, dus index.html hoeft niet te veranderen.
   ===================================================================== */
const express = require('express');
const cors = require('cors');

const PORT = process.env.PORT || 8787;
const ORIGIN = process.env.WATCHDOG_ORIGIN || '';

// ---- Zoekbronnen: sleutels en keuze ----
const KEYS = {
  serpapi: process.env.SERPAPI_KEY || '',
  serper: process.env.SERPER_API_KEY || '',
};
const PREFERRED = String(process.env.SEARCH_PROVIDER || 'serpapi').trim().toLowerCase();
const FALLBACK_ON = String(process.env.SEARCH_FALLBACK || 'aan').trim().toLowerCase() !== 'uit';
const COUNTRY = process.env.SEARCH_COUNTRY || 'nl';
const LANGUAGE = process.env.SEARCH_LANGUAGE || 'nl';
// Beschermt je gratis tegoed: maximaal zoveel ECHTE aanroepen naar de zoekbronnen per dag (cache telt niet mee).
const DAILY_LIMIT = Math.max(0, parseInt(process.env.SEARCH_DAILY_LIMIT || '80', 10) || 0);
// Hoe lang een identieke zoekopdracht uit de cache komt (minuten). Scheelt tegoed en is sneller.
const CACHE_MINUTES = Math.max(0, parseInt(process.env.SEARCH_CACHE_MINUTES || '360', 10) || 0);
const UPSTREAM_TIMEOUT_MS = 15000;

// ---- AI-assistent (Mistral AI, Frankrijk). Sleutel alleen op de server. ----
const MISTRAL_KEY = process.env.MISTRAL_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'mistral-small-latest';
const AI_DAILY_LIMIT = Math.max(0, parseInt(process.env.AI_DAILY_LIMIT || '300', 10) || 0);   // totaal per dag
const AI_USER_LIMIT = Math.max(1, parseInt(process.env.AI_USER_DAILY_LIMIT || '25', 10) || 25); // per gebruiker (IP) per dag

const PROVIDER_NAMES = {
  serpapi: 'Google Shopping (via SerpApi)',
  serper: 'Google Shopping (via Serper)',
};

function providerOrder() {
  const all = ['serpapi', 'serper'].filter(p => KEYS[p]);
  if (!all.length) return [];
  const first = all.includes(PREFERRED) ? PREFERRED : all[0];
  const rest = all.filter(p => p !== first);
  return FALLBACK_ON ? [first, ...rest] : [first];
}

const app = express();
app.set('trust proxy', 1); // Render zet een proxy voor de app; zo klopt req.ip
app.use(express.json({ limit: '20kb' }));

// ---- CORS: alleen de eigen WATCHDOG-frontend mag deze backend aanroepen ----
// WATCHDOG_ORIGIN mag ook een volledig adres zijn (bijv. https://naam.github.io/watchdog/#/home):
// we halen er zelf alleen het domeindeel uit, want de browser stuurt alleen "https://naam.github.io".
function toOrigin(s) {
  s = String(s || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try { return new URL(s).origin.toLowerCase(); } catch (e) { return null; }
}
const ALLOWED_ORIGINS = ORIGIN.split(',').map(toOrigin).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => cb(null, !!origin && ALLOWED_ORIGINS.includes(String(origin).toLowerCase())),
  methods: ['GET', 'POST'],
}));

// ---- eenvoudige rate limit per IP ----
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < 60000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) { for (const [k, v] of hits) if (!v.some(t => now - t < 60000)) hits.delete(k); }
  return recent.length > 30; // max 30 requests/minuut/IP
}

// ---- dagteller (per UTC-dag) ----
let day = new Date().toISOString().slice(0, 10);
let usedToday = 0;
const usedPerProvider = { serpapi: 0, serper: 0 };
function countUpstream(p) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) { day = today; usedToday = 0; usedPerProvider.serpapi = 0; usedPerProvider.serper = 0; }
  usedToday++; usedPerProvider[p]++;
}
function dailyLimitReached() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) return false;
  return DAILY_LIMIT > 0 && usedToday >= DAILY_LIMIT;
}

// ---- cache ----
const cache = new Map();
function cacheGet(k) {
  const e = cache.get(k);
  if (!e) return null;
  if (Date.now() - e.t > CACHE_MINUTES * 60000) { cache.delete(k); return null; }
  return e.v;
}
function cachePut(k, v) {
  if (!CACHE_MINUTES) return;
  cache.set(k, { t: Date.now(), v });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
}

// ---- zoekvraag opschonen: "zoek een wasmachine onder 500 euro" -> "wasmachine onder 500 euro" ----
function cleanQuery(q) {
  let s = String(q || '').trim();
  s = s.replace(/^(hey|hoi|hallo)[,!\s]+/i, '');
  s = s.replace(/^(kun|kan|wil)\s+(je|jij|u)\s+(voor\s+mij\s+)?/i, '');
  s = s.replace(/^(ik\s+)?(zoek|zoeken|zoekt|op\s+zoek\s+naar)\s+(naar\s+)?/i, '');
  s = s.replace(/^(een|de|het)\s+/i, '');
  s = s.replace(/\s+(voor\s+mij\s+)?(zoeken|opzoeken)\??$/i, '');
  s = s.replace(/[?!.]+$/, '').trim();
  return s || String(q || '').trim();
}

// ---- prijs uit tekst: "€ 1.299,00", "€499.99", "1.299 €" ----
function parsePrice(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).replace(/[^\d.,]/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');          // 1.299,00
  else if (lastDot > lastComma && lastComma >= 0) s = s.replace(/,/g, '');      // 1,299.00
  else if (lastComma >= 0 && s.length - lastComma - 1 !== 3) s = s.replace(',', '.'); // 499,9
  else if (lastComma >= 0) s = s.replace(',', '');                              // 1,299
  else if (lastDot >= 0 && s.length - lastDot - 1 === 3) s = s.replace(/\./g, '');  // 1.299 (Nederlandse duizendtallen)
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
function currencyOf(v) {
  const s = String(v || '');
  if (/€|EUR/i.test(s)) return 'EUR';
  if (/\$|USD/i.test(s)) return 'USD';
  if (/£|GBP/i.test(s)) return 'GBP';
  return null;
}
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return null; } }

// ---- fetch met timeout; geeft een duidelijke fout met HTTP-status ----
async function fetchJson(url, opts) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const r = await fetch(url, Object.assign({}, opts, { signal: ctl.signal }));
    const txt = await r.text();
    let data = null;
    try { data = JSON.parse(txt); } catch (e) {}
    if (!r.ok) { const err = new Error('HTTP ' + r.status); err.status = r.status; err.body = txt.slice(0, 500); throw err; }
    return data || {};
  } catch (e) {
    if (e && e.name === 'AbortError') { const err = new Error('timeout'); err.status = 504; throw err; }
    throw e;
  } finally { clearTimeout(t); }
}

// =====================================================================
// Bron 1: SerpApi — https://serpapi.com  (engine=google_shopping, daarna engine=google)
// =====================================================================
async function serpapiShopping(q) {
  const u = new URL('https://serpapi.com/search.json');
  u.search = new URLSearchParams({ engine: 'google_shopping', q, gl: COUNTRY, hl: LANGUAGE, google_domain: 'google.' + COUNTRY, api_key: KEYS.serpapi }).toString();
  const d = await fetchJson(u.toString());
  if (d.error && !/hasn't returned any results/i.test(d.error)) { const e = new Error(d.error); e.status = 502; e.body = d.error; throw e; }
  const list = [].concat(d.shopping_results || [], d.inline_shopping_results || []);
  return list.map(it => {
    const url = it.link || it.product_link || '';
    return {
      title: it.title || '',
      url,
      snippet: [it.delivery, it.extensions && it.extensions.join(' · ')].filter(Boolean).join(' · '),
      image: it.thumbnail || null,
      source: it.source || hostOf(url),
      attributes: {
        price: parsePrice(it.price) != null ? parsePrice(it.price) : parsePrice(it.extracted_price),
        priceText: it.price || null,
        currency: currencyOf(it.price) || 'EUR',
        availability: it.delivery || null,
        brand: null,
        rating: Number.isFinite(+it.rating) && +it.rating > 0 ? +it.rating : null,
        reviews: Number.isFinite(+it.reviews) && +it.reviews > 0 ? +it.reviews : null,
      },
    };
  }).filter(x => x.url);
}
async function serpapiWeb(q) {
  const u = new URL('https://serpapi.com/search.json');
  u.search = new URLSearchParams({ engine: 'google', q, gl: COUNTRY, hl: LANGUAGE, google_domain: 'google.' + COUNTRY, num: '10', api_key: KEYS.serpapi }).toString();
  const d = await fetchJson(u.toString());
  if (d.error && !/hasn't returned any results/i.test(d.error)) { const e = new Error(d.error); e.status = 502; e.body = d.error; throw e; }
  return (d.organic_results || []).map(it => {
    const rich = (it.rich_snippet && (it.rich_snippet.top || it.rich_snippet.bottom)) || {};
    const ext = rich.detected_extensions || {};
    return {
      title: it.title || '', url: it.link || '', snippet: it.snippet || '', image: it.thumbnail || null,
      source: it.source || hostOf(it.link),
      attributes: { price: parsePrice(ext.price), currency: ext.currency || null, availability: null, brand: null },
    };
  }).filter(x => x.url);
}

// =====================================================================
// Bron 2: Serper — https://serper.dev  (/shopping, daarna /search)
// =====================================================================
async function serperCall(path, q) {
  return fetchJson('https://google.serper.dev/' + path, {
    method: 'POST',
    headers: { 'X-API-KEY': KEYS.serper, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q, gl: COUNTRY, hl: LANGUAGE }),
  });
}
async function serperShopping(q) {
  const d = await serperCall('shopping', q);
  return (d.shopping || []).map(it => ({
    title: it.title || '', url: it.link || '', snippet: it.delivery || '', image: it.imageUrl || null,
    source: it.source || hostOf(it.link),
    attributes: { price: parsePrice(it.price), priceText: it.price || null, currency: currencyOf(it.price) || 'EUR', availability: it.delivery || null, brand: null, rating: Number.isFinite(+it.rating) && +it.rating > 0 ? +it.rating : null, reviews: Number.isFinite(+it.ratingCount) && +it.ratingCount > 0 ? +it.ratingCount : null },
  })).filter(x => x.url);
}
async function serperWeb(q) {
  const d = await serperCall('search', q);
  return (d.organic || []).map(it => ({
    title: it.title || '', url: it.link || '', snippet: it.snippet || '', image: it.imageUrl || null,
    source: hostOf(it.link),
    attributes: { price: parsePrice(it.price), currency: currencyOf(it.price), availability: null, brand: null },
  })).filter(x => x.url);
}

// ---- Prijscontrole: een prijs die sterk afwijkt van de rest (bijv. huur per maand, of een verkeerd gelezen bedrag)
// tonen we NIET als koopprijs. De prijs wordt dan null ("niet bevestigd") en het resultaat komt achteraan.
function markSuspectPrices(results) {
  const prices = results.map(r => r.attributes && r.attributes.price).filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (prices.length < 5) return results;
  const median = prices[Math.floor(prices.length / 2)];
  const ok = [], suspect = [];
  for (const r of results) {
    const a = r.attributes || {};
    const v = a.price;
    const perMonth = /(p\/?m|per\s*maand|\/\s*m(nd|aand)|mnd)/i.test(String(a.priceText || '') + ' ' + (r.snippet || ''));
    if (Number.isFinite(v) && (perMonth || v < median * 0.25 || v > median * 4)) {
      a.suspectPrice = v; a.price = null;
      a.priceNote = perMonth ? 'prijs per maand (huur of abonnement)' : 'prijs wijkt sterk af, niet bevestigd';
      suspect.push(r);
    } else ok.push(r);
  }
  return ok.concat(suspect);
}


// ---- Google-Shopping-links (google.com/shopping/product/…) openen in de EU vaak een
// kapotte toestemmingspagina (consent.google.nl, fout 400). Die sturen we daarom nooit door.
// In plaats daarvan: een zoeklink bij de winkel zelf (bekende winkels) of een gewone zoekopdracht.
const SHOP_SEARCH = [
  [/bol(\.com)?/i, 'https://www.bol.com/nl/nl/s/?searchtext='],
  [/coolblue/i, 'https://www.coolblue.nl/zoeken?query='],
  [/media\s*markt/i, 'https://www.mediamarkt.nl/nl/search.html?query='],
  [/amazon/i, 'https://www.amazon.nl/s?k='],
  [/zalando/i, 'https://www.zalando.nl/catalogus/?q='],
  [/wehkamp/i, 'https://www.wehkamp.nl/zoeken/?term='],
  [/\bh\s*&\s*m\b|\bhm\.com/i, 'https://www2.hm.com/nl_nl/search-results.html?q='],
  [/about\s*you/i, 'https://www.aboutyou.nl/zoeken?term='],
  [/de\s*bijenkorf/i, 'https://www.debijenkorf.nl/zoeken?SearchTerm='],
  [/\bc\s*&\s*a\b/i, 'https://www.c-and-a.com/nl/nl/shop/search?q='],
  [/intertoys/i, 'https://www.intertoys.nl/search?q='],
  [/game\s*mania/i, 'https://www.gamemania.nl/search?q='],
  [/\bblokker\b/i, 'https://www.blokker.nl/zoeken?q='],
  [/\bhema\b/i, 'https://www.hema.nl/zoeken?q='],
  [/\bikea\b/i, 'https://www.ikea.com/nl/nl/search/?q='],
  [/decathlon/i, 'https://www.decathlon.nl/search?Ntt='],
  [/douglas/i, 'https://www.douglas.nl/nl/search?q='],
  [/ici\s*paris/i, 'https://www.iciparisxl.nl/search?text='],
  [/kruidvat/i, 'https://www.kruidvat.nl/search?q='],
  [/praxis/i, 'https://www.praxis.nl/search?text='],
  [/gamma/i, 'https://www.gamma.nl/assortiment/zoeken?text='],
  [/expert/i, 'https://www.expert.nl/zoeken?q='],
  [/belsimpel/i, 'https://www.belsimpel.nl/zoeken?q='],
  [/\bmarktplaats/i, 'https://www.marktplaats.nl/q/'],
];
function isGoogleLink(u) { const h = hostOf(u) || ''; return /(^|\.)google\.[a-z.]+$/i.test(h) || /^consent\.google/i.test(h); }
function safeLink(r) {
  if (!r || !r.url || !isGoogleLink(r.url)) return r;
  const title = String(r.title || '').replace(/\s+/g, ' ').trim().slice(0, 90);
  const src = String(r.source || '');
  const m = SHOP_SEARCH.find(([re]) => re.test(src));
  const url = m ? m[1] + encodeURIComponent(title) : 'https://duckduckgo.com/?q=' + encodeURIComponent(title + (src ? ' ' + src : ''));
  return Object.assign({}, r, { url, attributes: Object.assign({}, r.attributes, { linkKind: m ? 'shop-search' : 'web-search', googleLink: true }) });
}

const PROVIDERS = {
  serpapi: { shopping: serpapiShopping, web: serpapiWeb },
  serper: { shopping: serperShopping, web: serperWeb },
};

// Eerst Google Shopping (prijzen); levert dat niets op, dan gewone Google-resultaten.
// Elke echte aanroep telt voor de daglimiet.
async function searchWith(p, q) {
  countUpstream(p);
  let results = await PROVIDERS[p].shopping(q);
  let kind = 'shopping';
  if (!results.length) {
    if (dailyLimitReached()) return { results, kind };
    countUpstream(p);
    results = await PROVIDERS[p].web(q);
    kind = 'web';
  }
  return { results: markSuspectPrices(results.map(safeLink)).slice(0, 20), kind };
}

// ---- AI: tellers per dag ----
let aiDay = new Date().toISOString().slice(0, 10), aiUsed = 0;
const aiPerIp = new Map();
function aiAllowed(ip) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== aiDay) { aiDay = today; aiUsed = 0; aiPerIp.clear(); }
  if (AI_DAILY_LIMIT > 0 && aiUsed >= AI_DAILY_LIMIT) return 'de daglimiet van de AI-assistent is bereikt; morgen werkt het weer';
  const n = aiPerIp.get(ip) || 0;
  if (n >= AI_USER_LIMIT) return 'je hebt vandaag je maximum aantal AI-vragen gesteld; morgen kan het weer';
  aiPerIp.set(ip, n + 1); aiUsed++;
  return null;
}
const AI_SYSTEM = [
  'Je bent de assistent van WATCHDOG, een Nederlandse app die mensen helpt meer uit hun geld te halen.',
  'Antwoord altijd in eenvoudig Nederlands, kort (maximaal 150 woorden), vriendelijk en concreet.',
  'Gebruik de meegestuurde cijfers van de gebruiker als die relevant zijn en reken ze correct door. Verzin geen cijfers, tarieven, regelingen of producten.',
  'Weet je iets niet zeker (zoals actuele bedragen of regels), zeg dat dan en verwijs naar de officiële bron (bijvoorbeeld toeslagen.nl, belastingdienst.nl, rijksoverheid.nl of de eigen gemeente).',
  'Je geeft geen persoonlijk financieel advies en raadt geen specifieke financiële producten, banken of verzekeraars aan. Je geeft uitleg, rekenvoorbeelden en algemene tips. De gebruiker beslist zelf.',
  'Voor het zoeken van producten en prijzen kan de gebruiker in de app typen: "zoek …".',
].join(' ');

// ---- /api/ai — beantwoordt een vrije vraag met de (anonieme) cijfers als context ----
app.post('/api/ai', async (req, res) => {
  if (rateLimited(req.ip || 'unknown')) return res.status(429).json({ ok: false, error: 'te veel aanvragen, probeer het over een minuut opnieuw' });
  if (!MISTRAL_KEY) return res.json({ ok: false, sourceType: 'not-configured', error: 'De AI-assistent is nog niet ingesteld op de server.' });
  const q = String((req.body && req.body.question) || '').trim();
  if (!q || q.length > 500) return res.status(400).json({ ok: false, error: 'ongeldige vraag' });
  const ctx = req.body && typeof req.body.context === 'object' && req.body.context ? req.body.context : {};
  const ctxTxt = JSON.stringify(ctx).slice(0, 2000);
  const blocked = aiAllowed(req.ip || 'unknown');
  if (blocked) return res.status(429).json({ ok: false, error: blocked });
  /* bij "te druk" (429) of een model dat niet in je abonnement zit: automatisch een ander Mistral-model proberen */
  const models = [AI_MODEL].concat(['ministral-8b-latest', 'open-mistral-nemo', 'mistral-small-latest'].filter(m => m !== AI_MODEL));
  let last = null;
  for (const model of models) {
    try {
      const d = await fetchJson('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + MISTRAL_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, temperature: 0.3, max_tokens: 400,
          messages: [
            { role: 'system', content: AI_SYSTEM },
            { role: 'user', content: 'Mijn cijfers (per maand, in euro, zelf ingevuld in de app): ' + ctxTxt + '\n\nMijn vraag: ' + q },
          ],
        }),
      });
      const answer = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
      if (!answer) throw Object.assign(new Error('leeg antwoord'), { status: 502 });
      return res.json({ ok: true, source: 'Mistral AI (' + model + ')', answer: String(answer).trim(), fetchedAt: new Date().toISOString() });
    } catch (e) {
      last = e;
      console.error('AI-vraag mislukt met ' + model + ' (' + (e.status || e.message) + '):', String(e.body || e.message || '').slice(0, 500));
      if (!(e.status === 429 || e.status === 400 || e.status === 404)) break;
    }
  }
  /* korte reden van Mistral doorgeven (nooit sleutels): helpt bij instellen */
  let why = '';
  try { const b = JSON.parse(String(last && last.body || '{}')); why = String(b.message || b.detail || (b.error && b.error.message) || '').slice(0, 160); } catch (x) { why = String(last && last.body || '').replace(/\s+/g, ' ').slice(0, 160); }
  const st = last && (last.status || last.message);
  const hint = st === 401 ? 'De Mistral-sleutel wordt niet geaccepteerd.' : st === 429 ? 'Mistral weigert (te druk, of nog geen actief abonnement/tegoed).' : '';
  return res.status(502).json({ ok: false, error: 'de AI-dienst gaf een fout terug (' + st + ')' + (hint ? '. ' + hint : ''), detail: why || null });
});

// ---- /api/health — GEEFT NOOIT SECRETS TERUG ----
app.get('/api/health', async (req, res) => {
  const order = providerOrder();
  let watches = null; try { watches = typeof WATCH !== 'undefined' ? await WATCH.status() : null; } catch (e) { watches = { storage: 'fout' }; }
  res.json({
    watches,
    backend: 'online',
    liveSearch: order.length ? 'configured' : 'not-configured',
    provider: order[0] || null,
    fallback: order.slice(1),
    usedToday,
    ai: MISTRAL_KEY ? 'configured' : 'not-configured',
    tts: ttsReady() ? 'configured' : 'not-configured',
    regelingen: 'live (CVDR)',
    ttsProvider: ttsReady() ? TTS_PROVIDER : null,
    ttsVoice: ttsReady() && TTS_PROVIDER !== 'elevenlabs' ? TTS_VOICE : (ttsReady() ? 'eigen stem' : null),
    dailyLimit: DAILY_LIMIT || null,
    version: 'RC13',
    jobs: KEYS.serpapi ? 'configured (Google Jobs via SerpApi)' : 'not-configured',
    time: new Date().toISOString(),
  });
});

// ---- /api/search ----
app.post('/api/search', async (req, res) => {
  if (rateLimited(req.ip || 'unknown')) {
    return res.status(429).json({ ok: false, error: 'te veel aanvragen, probeer het over een minuut opnieuw' });
  }
  const raw = String((req.body && req.body.query) || '').trim();
  if (!raw || raw.length > 300) return res.status(400).json({ ok: false, error: 'ongeldige zoekopdracht' });

  const order = providerOrder();
  if (!order.length) {
    return res.json({
      ok: false, isLive: false, source: 'Live Search', sourceType: 'not-configured', fetchedAt: new Date().toISOString(), results: [],
      error: 'Live Search is nog niet geconfigureerd op deze backend (geen SERPAPI_KEY of SERPER_API_KEY ingesteld).',
    });
  }

  const q = cleanQuery(raw);
  const cacheKey = q.toLowerCase();
  const hit = cacheGet(cacheKey);
  if (hit) return res.json(Object.assign({}, hit, { cached: true }));

  if (dailyLimitReached()) {
    return res.status(429).json({ ok: false, error: 'de daglimiet voor live zoeken is bereikt; morgen werkt het weer' });
  }

  const failures = [];
  for (const p of order) {
    try {
      const { results, kind } = await searchWith(p, q);
      const body = {
        ok: true,
        isLive: true,
        source: kind === 'shopping' ? PROVIDER_NAMES[p] : PROVIDER_NAMES[p].replace('Google Shopping', 'Google'),
        sourceType: 'live-search',
        provider: p,
        query: q,
        fetchedAt: new Date().toISOString(),
        results,
      };
      if (failures.length) console.warn('Live Search: overgeschakeld naar ' + p + ' na fout bij ' + failures.join(', '));
      cachePut(cacheKey, body);
      return res.json(body);
    } catch (e) {
      console.error('Live Search via ' + p + ' mislukt (' + (e.status || e.message) + '):', String(e.body || e.message || '').slice(0, 500));
      failures.push(p + ' (' + (e.status || e.message) + ')');
      if (dailyLimitReached()) break;
    }
  }
  return res.status(502).json({ ok: false, error: 'de externe zoekbron gaf een fout terug (' + failures.join(', ') + ')' });
});



// =====================================================================
// RC12 — MEER VERDIENEN: vacatures via Google Jobs (SerpApi)
// Google Jobs verzamelt vacatures van veel sites (o.a. Indeed, LinkedIn, Nationale Vacaturebank, werkgevers).
// We lezen die sites NIET zelf uit; alleen de officiële SerpApi-koppeling. De sleutel blijft op de server.
// Er wordt nooit iets over de gebruiker meegestuurd: alleen functie + plaats + straal.
// =====================================================================
function parseSalary(t) {
  const s = String(t || '').toLowerCase();
  if (!s) return null;
  const per = /uur|hour/.test(s) ? 'uur' : /jaar|year|annum/.test(s) ? 'jaar' : /maand|month/.test(s) ? 'maand' : /week/.test(s) ? 'week' : null;
  const nums = [];
  const re = /(\d{1,3}(?:[.\s]\d{3})+|\d+(?:[.,]\d+)?)\s*(k)?/g; let m;
  while ((m = re.exec(s))) {
    let raw = m[1];
    let v = /[.\s]\d{3}$/.test(raw) && !/,/.test(raw) ? parseFloat(raw.replace(/[.\s]/g, '')) : parseFloat(raw.replace(/\./g, '').replace(',', '.'));
    if (m[2]) v *= 1000;
    if (Number.isFinite(v) && v > 0) nums.push(v);
  }
  if (!nums.length) return null;
  const min = Math.min.apply(null, nums.slice(0, 2)), max = Math.max.apply(null, nums.slice(0, 2));
  let p = per;
  if (!p) p = max > 20000 ? 'jaar' : max > 500 ? 'maand' : 'uur';
  if ((p === 'maand' && (max < 500 || max > 30000)) || (p === 'uur' && (max < 8 || max > 300)) || (p === 'jaar' && (max < 8000 || max > 400000))) return null;
  return { min, max, per: p, text: String(t).slice(0, 80) };
}
function jobId(j) { return crypto.createHash('sha1').update(String(j.job_id || (j.title + '|' + j.company_name + '|' + j.location))).digest('hex').slice(0, 16); }
function cleanJobQuery(q) { return String(q || '').replace(/\s+/g, ' ').trim().slice(0, 80); }
async function searchJobs(q, loc, radius, remote) {
  q = cleanJobQuery(q); loc = String(loc || '').replace(/[^\p{L}\p{N}\s,'-]/gu, '').trim().slice(0, 60);
  radius = Math.max(0, Math.min(100, parseInt(radius, 10) || 0));
  if (!q) return { ok: false, error: 'geen functie opgegeven' };
  if (!KEYS.serpapi) return { ok: false, notConfigured: true, error: 'Vacatures zoeken is nog niet ingesteld (SerpApi-sleutel ontbreekt op de server).' };
  const key = 'jobs:' + [q, loc, radius, remote ? 1 : 0].join('|').toLowerCase();
  const hit = cacheGet(key); if (hit) return Object.assign({}, hit, { cached: true });
  if (dailyLimitReached()) return { ok: false, error: 'daglimiet voor zoeken bereikt; morgen werkt het weer' };
  const u = new URL('https://serpapi.com/search.json');
  const p = { engine: 'google_jobs', q: q + (loc && !remote ? ' ' + loc : ''), gl: COUNTRY, hl: LANGUAGE, google_domain: 'google.' + COUNTRY, api_key: KEYS.serpapi };
  if (loc) p.location = loc + ', Netherlands';
  if (radius) p.lrad = String(radius);
  if (remote) p.ltype = '1';
  u.search = new URLSearchParams(p).toString();
  let d;
  try { countUpstream('serpapi'); d = await fetchJson(u.toString()); }
  catch (e) {
    // plaats onbekend bij Google: nog één keer zonder 'location'
    if (loc && /location/i.test(String(e.body || ''))) { delete p.location; u.search = new URLSearchParams(p).toString(); countUpstream('serpapi'); d = await fetchJson(u.toString()); }
    else throw e;
  }
  if (d.error && !/hasn't returned any results/i.test(d.error)) { const e = new Error(d.error); e.status = 502; throw e; }
  const jobs = (d.jobs_results || []).map(j => {
    const ex = j.detected_extensions || {};
    const sal = parseSalary(ex.salary || (j.extensions || []).find(x => /€|eur|per (uur|maand|jaar)/i.test(x)) || '');
    const ap = (j.apply_options || []).filter(a => a && /^https:\/\//.test(a.link || ''));
    return {
      id: jobId(j), title: String(j.title || '').slice(0, 120), company: String(j.company_name || '').slice(0, 80), location: String(j.location || '').slice(0, 80),
      via: String(j.via || '').replace(/^via\s+/i, '').slice(0, 60), posted: ex.posted_at || null, schedule: ex.schedule_type || null, remote: !!ex.work_from_home,
      salary: sal, url: (ap[0] && ap[0].link) || j.share_link || null, apply: ap.slice(0, 4).map(a => ({ title: String(a.title || hostOf(a.link) || '').slice(0, 40), url: a.link })),
      snippet: String(j.description || '').replace(/\s+/g, ' ').slice(0, 280),
    };
  }).filter(j => j.title && j.url);
  const body = { ok: true, isLive: true, source: 'Google Jobs (via SerpApi)', query: q, location: loc || null, radius: radius || null, fetchedAt: new Date().toISOString(), jobs };
  cachePut(key, body);
  return body;
}
app.post('/api/jobs', async (req, res) => {
  if (rateLimited(req.ip || 'unknown')) return res.status(429).json({ ok: false, error: 'te veel aanvragen, probeer het over een minuut opnieuw' });
  const b = req.body || {};
  const q = String(b.query || '').trim();
  if (!q || q.length > 80) return res.status(400).json({ ok: false, error: 'ongeldige functie' });
  try { const r = await searchJobs(q, b.location, b.radius, !!b.remote); res.status(r.ok || r.notConfigured ? 200 : 429).json(r); }
  catch (e) { console.error('Vacatures zoeken mislukt:', e.status || '', String(e.body || e.message).slice(0, 300)); res.status(502).json({ ok: false, error: 'de vacaturebron gaf een fout terug' }); }
});

// =====================================================================
// ---- /api/tts — natuurlijke stem voor de hond (RC9) ----
// Provider kiezen met TTS_PROVIDER: 'azure' | 'elevenlabs' | 'google' | 'openai'. Sleutels staan ALLEEN hier op de server.
//   azure      : AZURE_SPEECH_KEY + AZURE_SPEECH_REGION (bijv. westeurope)   stem: TTS_VOICE (standaard nl-NL-MaartenNeural)
//   elevenlabs : ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID                     model: ELEVENLABS_MODEL (standaard eleven_multilingual_v2)
//   google     : GOOGLE_TTS_KEY                                              stem: TTS_VOICE (standaard nl-NL-Chirp3-HD-Charon)
//   openai     : OPENAI_API_KEY                                              stem: TTS_VOICE (standaard ash)
// Grenzen: max 600 tekens per verzoek, TTS_DAILY_CHARS per dag (standaard 40000), cache voor vaste zinnen.
// =====================================================================
const TTS_PROVIDER = String(process.env.TTS_PROVIDER || '').trim().toLowerCase();
const TTS_KEYS = {
  azure: process.env.AZURE_SPEECH_KEY || '',
  elevenlabs: process.env.ELEVENLABS_API_KEY || '',
  google: process.env.GOOGLE_TTS_KEY || '',
  openai: process.env.OPENAI_API_KEY || '',
};
const TTS_DEFAULT_VOICE = { azure: 'nl-NL-MaartenNeural', google: 'nl-NL-Chirp3-HD-Charon', openai: 'ash', elevenlabs: process.env.ELEVENLABS_VOICE_ID || '' };
const TTS_VOICE = process.env.TTS_VOICE || TTS_DEFAULT_VOICE[TTS_PROVIDER] || '';
const TTS_RATE = Math.min(1.3, Math.max(0.8, parseFloat(process.env.TTS_RATE || '1.04') || 1.04)); // ~150 woorden/min
const TTS_DAILY_CHARS = Math.max(0, parseInt(process.env.TTS_DAILY_CHARS || '40000', 10) || 0);
function ttsReady() {
  if (!TTS_PROVIDER || !TTS_KEYS[TTS_PROVIDER]) return false;
  if (TTS_PROVIDER === 'azure' && !process.env.AZURE_SPEECH_REGION) return false;
  if (TTS_PROVIDER === 'elevenlabs' && !TTS_VOICE) return false;
  return true;
}
let ttsDay = '', ttsChars = 0;
function ttsBudget(n) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== ttsDay) { ttsDay = today; ttsChars = 0; }
  if (TTS_DAILY_CHARS > 0 && ttsChars + n > TTS_DAILY_CHARS) return false;
  ttsChars += n; return true;
}
const ttsCache = new Map(); // kleine cache (vaste zinnen zoals begroetingen)
function ttsCacheGet(k) { const v = ttsCache.get(k); if (!v) return null; ttsCache.delete(k); ttsCache.set(k, v); return v; }
function ttsCachePut(k, buf) { if (buf.length > 400000) return; ttsCache.set(k, buf); while (ttsCache.size > 120) ttsCache.delete(ttsCache.keys().next().value); }
const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
// tekst uitspreekbaar maken: bedragen, afkortingen, merknaam, geen emoji
function ttsClean(t) {
  return String(t || '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/€\s?(\d+(?:[.,]\d{1,2})?)/g, (m, n) => n.replace('.', ',') + ' euro')
    .replace(/\bWATCHDOG\b/g, 'Watchdog')
    .replace(/\bp\/m\b|\/mnd\b|per mnd\b/gi, ' per maand')
    .replace(/\s+/g, ' ').trim();
}
async function ttsFetch(url, opts) {
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, Object.assign({}, opts, { signal: ctl.signal }));
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; e.body = await r.text().catch(() => ''); throw e; }
    return r;
  } finally { clearTimeout(tm); }
}
const TTS = {
  async azure(text, voice) {
    const pct = Math.round((TTS_RATE - 1) * 100);
    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="nl-NL"><voice name="${xmlEsc(voice)}"><prosody rate="${pct >= 0 ? '+' : ''}${pct}%" pitch="+2%">${xmlEsc(text)}</prosody></voice></speak>`;
    const r = await ttsFetch(`https://${process.env.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST', body: ssml,
      headers: { 'Ocp-Apim-Subscription-Key': TTS_KEYS.azure, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3', 'User-Agent': 'watchdog-backend' },
    });
    return Buffer.from(await r.arrayBuffer());
  },
  async elevenlabs(text, voice) {
    const model = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';
    const body = { text, model_id: model, voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true, speed: TTS_RATE } };
    if (/flash|turbo/.test(model)) body.language_code = 'nl';
    const r = await ttsFetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_64`, {
      method: 'POST', body: JSON.stringify(body), headers: { 'xi-api-key': TTS_KEYS.elevenlabs, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
    });
    return Buffer.from(await r.arrayBuffer());
  },
  async google(text, voice) {
    const r = await ttsFetch('https://texttospeech.googleapis.com/v1/text:synthesize?key=' + encodeURIComponent(TTS_KEYS.google), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { text }, voice: { languageCode: 'nl-NL', name: voice }, audioConfig: { audioEncoding: 'MP3', speakingRate: TTS_RATE } }),
    });
    const j = await r.json(); return Buffer.from(j.audioContent || '', 'base64');
  },
  async openai(text, voice) {
    const r = await ttsFetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + TTS_KEYS.openai, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts', voice, input: text, response_format: 'mp3', speed: TTS_RATE,
        instructions: 'Spreek Nederlands (Nederland, geen Vlaams accent). Je bent WATCHDOG, een vrolijke, warme en betrouwbare beagle die mensen helpt geld te besparen. Glimlach in je stem, levendige intonatie, rustig en duidelijk bij bedragen en advies.' }),
    });
    return Buffer.from(await r.arrayBuffer());
  },
};
app.post('/api/tts', async (req, res) => {
  if (!ttsReady()) return res.status(503).json({ ok: false, sourceType: 'not-configured', error: 'De stem is nog niet ingesteld op de server.' });
  if (rateLimited(req.ip || 'unknown')) return res.status(429).json({ ok: false, error: 'te veel aanvragen, probeer het over een minuut opnieuw' });
  const text = ttsClean(req.body && req.body.text);
  if (!text || text.length > 600) return res.status(400).json({ ok: false, error: 'tekst ontbreekt of is te lang (max 600 tekens)' });
  const key = TTS_PROVIDER + '|' + TTS_VOICE + '|' + TTS_RATE + '|' + text;
  const hit = ttsCacheGet(key);
  const send = buf => { res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=86400', 'X-TTS-Provider': TTS_PROVIDER }); res.send(buf); };
  if (hit) return send(hit);
  if (!ttsBudget(text.length)) return res.status(429).json({ ok: false, error: 'de daglimiet voor de stem is bereikt; de app gebruikt nu de stem van je telefoon' });
  try {
    const buf = await TTS[TTS_PROVIDER](text, TTS_VOICE);
    if (!buf || buf.length < 200) throw new Error('lege audio');
    ttsCachePut(key, buf); return send(buf);
  } catch (e) {
    console.error('TTS via ' + TTS_PROVIDER + ' mislukt (' + (e.status || e.message) + '):', String(e.body || e.message || '').slice(0, 400));
    return res.status(502).json({ ok: false, error: 'de stemdienst gaf een fout terug (' + (e.status || e.message) + ')' });
  }
});


// =====================================================================
// ---- /api/regelingen — ECHTE gemeentelijke regelingen (RC10) ----
// Bron: Centrale Voorziening Decentrale Regelgeving (CVDR) via de open SRU-zoekdienst van overheid.nl
// (licentie CC-0, dagelijks bijgewerkt). Geen sleutel nodig. Alleen de gemeentenaam gaat naar de server,
// geen persoonsgegevens. Of iets bij iemand past, beoordeelt de app op het toestel en blijft "mogelijk".
// =====================================================================
const REG_CACHE = new Map(); // gemeente -> {t, body}
const REG_TTL = 12 * 3600e3;
const SRU = 'https://zoekservice.overheid.nl/sru/Search';
const REG_Q = {
  inkomen: 'minimaregelingen minimaregeling minimabeleid inkomenstoeslag kwijtschelding kindpakket meedoen meedoenregeling participatiefonds stadspas U-pas Ooievaarspas Rotterdampas Meedoenpas Gelrepas declaratieregeling bijstand energietoeslag zorgverzekering',
  wonen: 'duurzaamheidslening stimuleringslening blijverslening starterslening verduurzaming isolatie energiebesparing zonnepanelen duurzaamheid',
};
const REG_EXCL = /archief|aanwijzingsbesluit|daeb|zakelijk|algemene bijstand|verlagingen|verlagen|draagkracht|ambtelijke|handhaving|terugvordering|verhaal|cliëntenparticipatie|re-?integratie|ondernem|fraude|boete|mandaat|vereniging|sport|cultuur|organisatie|instelling|monument|bomen|personeel|raadsleden|wethouder|bestuurders|rekenkamer|bedrijven|ondernemers|evenement|horeca|kunst|onderwijshuisvesting|bouwleges|leges|precario|grafrechten|reclame|parkeer/i;
const REG_HINT = [
  [/compensatie toeslagen|herstel.*toeslagen/i, 'Ondersteuning voor mensen die gedupeerd zijn door de toeslagenaffaire.'],
  [/inkomenstoeslag/i, 'Een jaarlijkse toeslag als je al langere tijd een laag inkomen hebt.'],
  [/kwijtschelding/i, 'Geen of minder gemeentelijke belastingen (zoals afvalstoffenheffing) bij een laag inkomen.'],
  [/energietoeslag|energiekosten/i, 'Tegemoetkoming in de energiekosten bij een laag inkomen.'],
  [/zorgverzekering/i, 'Voordelige collectieve zorgverzekering via de gemeente bij een laag inkomen.'],
  [/starterslening/i, 'Een lening die helpt bij het kopen van je eerste woning.'],
  [/blijverslening/i, 'Een lening om je woning aan te passen zodat je er langer kunt blijven wonen.'],
  [/duurzaamheidslening|stimuleringslening|verduurzaming|isolatie|energiebesparing|zonnepanelen|duurzaam/i, 'Subsidie of voordelige lening om je woning te verduurzamen.'],
  [/bijzondere bijstand/i, 'Vergoeding van noodzakelijke, onverwachte kosten als je die zelf niet kunt betalen.'],
  [/kindpakket|meedoen|participatiefonds|stadspas|u-pas|ooievaarspas|rotterdampas|gelrepas|declaratie|minimaregeling|minimabeleid/i, 'Tegoed of korting voor sport, cultuur, school of meedoen bij een laag inkomen.'],
];
function xmlTag(r, tag) { const m = r.match(new RegExp('<' + tag + '(?:\\s[^>]*)?>([^<]*)<')); return m ? m[1].replace(/&amp;/g, '&').trim() : ''; }
async function sruFetch(q) {
  const url = SRU + '?' + new URLSearchParams({ version: '1.2', operation: 'searchRetrieve', 'x-connection': 'cvdr', maximumRecords: '100', query: q });
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 15000);
  try { const r = await fetch(url, { signal: ctl.signal }); if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; } return await r.text(); }
  finally { clearTimeout(tm); }
}
async function regelingenVoor(gemeente) {
  const today = new Date().toISOString().slice(0, 10), seen = new Map();
  for (const cat of Object.keys(REG_Q)) {
    const q = `creator="${gemeente.replace(/"/g, '')}" and title any "${REG_Q[cat]}" sortBy dcterms.modified/sort.descending`;
    const xml = await sruFetch(q);
    for (const r of xml.split('<record>').slice(1)) {
      if (!/scheme="overheid:Gemeente"/.test(r)) continue;
      const creator = xmlTag(r, 'dcterms:creator'); if (creator.toLowerCase() !== gemeente.toLowerCase()) continue;
      const title = xmlTag(r, 'dcterms:title'), id = xmlTag(r, 'dcterms:identifier'), work = id.replace(/_\d+$/, '');
      const inw = xmlTag(r, 'overheidrg:inwerkingtredingDatum'), uit = xmlTag(r, 'overheidrg:uitwerkingtredingDatum');
      if (!title || REG_EXCL.test(title)) continue;
      if (uit && uit <= today) continue;                       // niet meer geldig
      if (inw && inw < '2016-01-01') continue;
      { const yr = title.match(/\b(20\d\d)\b/); if (/eenmalig|tijdelijk/i.test(title) && yr && +yr[1] < +today.slice(0, 4) - 1) continue; } // verlopen eenmalige regelingen                 // zeer oude regels zijn vaak niet meer actueel bijgehouden
      if (seen.has(work) && (seen.get(work).since || '') >= inw) continue;  // alleen de nieuwste geldende versie
      const hint = (REG_HINT.find(h => h[0].test(title)) || [null, ''])[1];
      if (!hint) continue;                                      // alleen regelingen voor inwoners met een herkenbaar doel
      seen.set(work, { id: work, version: id, title, cat, hint, since: inw || null, future: !!(inw && inw > today), modified: xmlTag(r, 'dcterms:modified') || null,
        url: xmlTag(r, 'preferred_work_url') || ('https://lokaleregelgeving.overheid.nl/' + work) });
    }
  }
  return [...seen.values()].sort((a, b) => (a.cat === b.cat ? 0 : a.cat === 'inkomen' ? -1 : 1) || String(b.since).localeCompare(String(a.since))).slice(0, 25);
}
app.get('/api/regelingen', async (req, res) => {
  if (rateLimited(req.ip || 'unknown')) return res.status(429).json({ ok: false, error: 'te veel aanvragen, probeer het over een minuut opnieuw' });
  const g = String(req.query.gemeente || '').trim();
  if (!g || g.length > 60 || !/^[\p{L}\s'().-]+$/u.test(g)) return res.status(400).json({ ok: false, error: 'ongeldige gemeentenaam' });
  const key = g.toLowerCase(), hit = REG_CACHE.get(key);
  if (hit && Date.now() - hit.t < REG_TTL) return res.json(Object.assign({}, hit.body, { cached: true }));
  try {
    const items = await regelingenVoor(g);
    const body = { ok: true, gemeente: g, source: 'Lokale wet- en regelgeving (overheid.nl, CVDR)', sourceType: 'official', fetchedAt: new Date().toISOString(), items };
    REG_CACHE.set(key, { t: Date.now(), body }); if (REG_CACHE.size > 400) REG_CACHE.delete(REG_CACHE.keys().next().value);
    return res.json(body);
  } catch (e) {
    console.error('Regelingen voor ' + g + ' mislukt (' + (e.status || e.message) + ')');
    return res.status(502).json({ ok: false, error: 'de bron voor lokale regelingen is nu niet bereikbaar' });
  }
});

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// =====================================================================
// RC11 — BLIJVENDE WATCHES · CONTROLE OP DE ACHTERGROND · WEB-PUSH
// Geen extra npm-pakketten: opslag via Upstash Redis REST (fetch) of een JSON-bestand; push met VAPID (ES256) +
// aes128gcm-versleuteling (RFC 8291) via node:crypto.
//
//  Opslag (STORE):
//    UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN → Upstash Redis (blijvend, ook bij herstart/redeploy op Render)
//    anders DATA_FILE (standaard ./data/watchdog-data.json) → blijvend zolang de schijf blijft (op Render Free NIET na herstart)
//  Identiteit: anoniem apparaat-token (X-WD-Token, 32+ tekens, door de app gemaakt). Server bewaart alleen sha256(token).
//  Controle: POST /api/cron/check met header X-Cron-Secret = CRON_SECRET (bijv. elk 3 uur via GitHub Actions).
//  Push: VAPID-sleutels uit VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY, anders eenmalig gemaakt en in STORE bewaard.
// =====================================================================

const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// ---------------------------------------------------------------- opslag
function makeStore() {
  const url = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, ''), tok = process.env.UPSTASH_REDIS_REST_TOKEN || '';
  if (url && tok) {
    const cmd = async (...args) => {
      const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) throw new Error('opslag: ' + (j.error || r.status));
      return j.result;
    };
    return {
      kind: 'upstash', persistent: true,
      async get(k) { const v = await cmd('GET', k); return v == null ? null : JSON.parse(v); },
      async set(k, v) { await cmd('SET', k, JSON.stringify(v)); },
      async del(k) { await cmd('DEL', k); },
      async sadd(k, m) { await cmd('SADD', k, m); },
      async srem(k, m) { await cmd('SREM', k, m); },
      async smembers(k) { return (await cmd('SMEMBERS', k)) || []; },
    };
  }
  const file = process.env.DATA_FILE || path.join(__dirname, 'data', 'watchdog-data.json');
  let db = { kv: {}, sets: {} };
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  let t = null;
  const flush = () => { try { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, file); } catch (e) { console.error('WATCHDOG opslag schrijven mislukt:', e.message); } };
  const later = () => { clearTimeout(t); t = setTimeout(flush, 50); };
  process.on('exit', flush);
  return {
    kind: 'file', persistent: !!process.env.DATA_FILE_PERSISTENT, file,
    async get(k) { return k in db.kv ? JSON.parse(JSON.stringify(db.kv[k])) : null; },
    async set(k, v) { db.kv[k] = v; later(); },
    async del(k) { delete db.kv[k]; later(); },
    async sadd(k, m) { const s = new Set(db.sets[k] || []); s.add(m); db.sets[k] = [...s]; later(); },
    async srem(k, m) { db.sets[k] = (db.sets[k] || []).filter(x => x !== m); later(); },
    async smembers(k) { return (db.sets[k] || []).slice(); },
    flushNow: flush,
  };
}

// ---------------------------------------------------------------- productbegrip (zelfde regels als de app)
const PRODX = {
  classify(title, note) {
    const t = ' ' + String(title || '').toLowerCase() + ' ';
    const c = {};
    if (/\bps5\s*pro\b|playstation\s*5\s*pro|\bpro\s+console/.test(t)) c.family = 'ps5pro';
    else if (/\bps5\b|playstation\s*5|playstation5/.test(t)) c.family = 'ps5';
    else if (/\bps4\b|playstation\s*4/.test(t)) c.family = 'ps4';
    else if (/xbox\s*series\s*x/.test(t)) c.family = 'xsx';
    else if (/xbox\s*series\s*s/.test(t)) c.family = 'xss';
    else if (/switch\s*2/.test(t)) c.family = 'switch2';
    else if (/nintendo\s*switch|\bswitch\s*oled/.test(t)) c.family = 'switch';
    c.slim = /\bslim\b/.test(t);
    if (/digital|digitaal|zonder\s*(disc|schijf)|disc-?less|all digital/.test(t)) c.edition = 'digital';
    else if (/\bdisc\b|disk|blu-?ray|met\s*(disc|schijf)|standard edition|standaard editie/.test(t)) c.edition = 'disc';
    c.bundle = /bundel|bundle|\+\s*\w|\bincl\.?|inclusief|met\s+(extra\s+)?(controller|game|spel)|ghost of|fc\s?2\d|ea sports|call of duty|fortnite|astro bot|gran turismo|spider-?man|god of war|hogwarts|minecraft|mario kart|zelda|pokemon|pokémon/.test(t);
    c.refurb = /refurb|renewed|gereviseerd|zo goed als nieuw|als nieuw|tweedehands|2e hands|gebruikt|nette staat|netjes|goede staat|used|b-?grade|nieuwstaat|occasion|pre-?owned|marktplaats/.test(t);
    c.rental = /\bhuur|\bhuren\b|abonnement|lease|per maand|p\/m\b|\/mnd/.test(t + ' ' + String(note || '').toLowerCase());
    const consoleish = /\bconsole|\bslim\b|\bdisc\b|blu-?ray edition|digital|edition|\d+\s?(gb|tb)\b|cfi-|\bsystem\b/.test(t) && !!c.family;
    c.accessory = /portal|psvr|\bvr2\b|disc drive|schijfstation|blu-?ray drive/.test(t) || (/controller|dualsense|dualshock|headset|oplaad|laadstation|charging|cover|skin|faceplate|standaard(?! editie)|\bstand\b|hoes|case\b|kabel|camera|remote|afstandsbediening|ssd|koeler|cooling|sticker|games?\b|spel\b|spellen|voucher|cadeaukaart|gift ?card/.test(t) && !consoleish);
    return c;
  },
  /* verdict: match | apart (lijkt, maar anders: bundel/refurbished) | uit (ander product, accessoire, huur) */
  verdict(c, it) {
    if (!it || !it.family) return { v: 'match' };
    if (c.rental) return { v: 'uit', r: 'huur of abonnement' };
    if (c.accessory) return { v: 'uit', r: 'accessoire of game' };
    if (!c.family) return { v: 'uit', r: 'ander product' };
    if (c.family !== it.family) return { v: 'uit', r: 'ander model' };
    if (it.edition && c.edition && c.edition !== it.edition) return { v: 'uit', r: c.edition === 'digital' ? 'digitale versie' : 'versie met disc' };
    if (it.cond === 'nieuw' && c.refurb) return { v: 'apart', r: 'refurbished of tweedehands' };
    if (c.bundle && !it.bundleOk) return { v: 'apart', r: 'bundel met game of extra' };
    if (it.edition && !c.edition) return { v: 'apart', r: 'versie niet zeker (disc of digitaal)' };
    return { v: 'match' };
  },
};

// ---------------------------------------------------------------- web-push (VAPID + RFC 8291 aes128gcm)
const hkdf = (salt, ikm, info, len) => {
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  return crypto.createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest().slice(0, len);
};
function encryptPush(payload, p256dh, auth, opts) {
  opts = opts || {};
  const ua = unb64u(p256dh), authSecret = unb64u(auth);
  const ecdh = crypto.createECDH('prime256v1');
  if (opts.asPrivate) ecdh.setPrivateKey(unb64u(opts.asPrivate)); else ecdh.generateKeys();
  const asPub = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(ua);
  const salt = opts.salt ? unb64u(opts.salt) : crypto.randomBytes(16);
  const prkKey = crypto.createHmac('sha256', authSecret).update(shared).digest();
  const ikm = crypto.createHmac('sha256', prkKey).update(Buffer.concat([Buffer.from('WebPush: info\0'), ua, asPub, Buffer.from([1])])).digest().slice(0, 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, ct]);
}
function vapidJwt(aud, keys, subject) {
  const h = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const p = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const key = crypto.createPrivateKey({ key: keys.jwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(h + '.' + p), { key, dsaEncoding: 'ieee-p1363' });
  return h + '.' + p + '.' + b64u(sig);
}

// ---------------------------------------------------------------- de Watch Engine
function install(app, deps) {
  const { rateLimited, searchCached, searchJobs, log } = deps;
  const STORE = makeStore();
  const CRON_SECRET = process.env.CRON_SECRET || '';
  const INTERVAL_H = Math.max(1, parseFloat(process.env.WATCH_INTERVAL_HOURS || '12') || 12);
  const MAX_PER_RUN = Math.max(1, parseInt(process.env.WATCH_MAX_PER_RUN || '8', 10) || 8);
  const SUBJECT = process.env.VAPID_SUBJECT || 'https://nirmalmadarie.github.io/watchdog/';
  const APP_URL = (process.env.WATCHDOG_APP_URL || 'https://nirmalmadarie.github.io/watchdog/').replace(/#.*$/, '');
  const MAX_WATCHES = 20;

  async function vapid() {
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
      const pub = unb64u(process.env.VAPID_PUBLIC_KEY);
      return { pub: process.env.VAPID_PUBLIC_KEY, jwk: { kty: 'EC', crv: 'P-256', x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), d: process.env.VAPID_PRIVATE_KEY } };
    }
    let k = await STORE.get('vapid');
    if (!k) {
      const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const jwk = privateKey.export({ format: 'jwk' });
      k = { pub: b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)])), jwk };
      await STORE.set('vapid', k);
    }
    return k;
  }
  async function sendPush(sub, payload) {
    const keys = await vapid();
    const u = new URL(sub.endpoint);
    const body = encryptPush(JSON.stringify(payload), sub.keys.p256dh, sub.keys.auth);
    const r = await fetch(sub.endpoint, {
      method: 'POST',
      headers: { TTL: '86400', Urgency: payload.priority === 'high' ? 'high' : 'normal', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Authorization: `vapid t=${vapidJwt(u.origin, keys, SUBJECT)}, k=${keys.pub}` },
      body,
    });
    return r.status;
  }

  const uidOf = req => { const t = String(req.get('X-WD-Token') || ''); return /^[A-Za-z0-9_-]{32,128}$/.test(t) ? crypto.createHash('sha256').update(t).digest('hex').slice(0, 32) : null; };
  const guard = (req, res) => {
    if (rateLimited(req.ip || 'x')) { res.status(429).json({ ok: false, error: 'te veel aanvragen' }); return null; }
    const uid = uidOf(req); if (!uid) { res.status(401).json({ ok: false, error: 'geen geldig apparaat-token' }); return null; }
    return uid;
  };
  const clean = w => ({ id: w.id, type: w.type || 'prijs', loc: w.loc || null, radius: w.radius || null, minSalary: w.minSalary || null, seenCount: (w.seen || []).length, subject: w.subject, query: w.query, intent: w.intent, target: w.target, trig: w.trig, status: w.status, createdAt: w.createdAt, lastCheckedAt: w.lastCheckedAt || null, lastRelevantChange: w.lastRelevantChange || null, current: w.current || null, lastNotified: w.lastNotified || null, notify: w.notify });
  const str = (v, n) => String(v == null ? '' : v).slice(0, n);

  app.get('/api/watches', async (req, res) => {
    const uid = guard(req, res); if (!uid) return;
    try { const ids = await STORE.smembers('u:' + uid + ':w'); const L = (await Promise.all(ids.map(id => STORE.get('w:' + id)))).filter(Boolean); res.json({ ok: true, storage: STORE.kind, watches: L.map(clean) }); }
    catch (e) { res.status(503).json({ ok: false, error: 'opslag niet bereikbaar' }); }
  });
  app.post('/api/watches', async (req, res) => {
    const uid = guard(req, res); if (!uid) return;
    const b = (req.body && req.body.watch) || {};
    if (b.type === 'regeling') {
      const g = str(b.gemeente, 60).trim();
      if (!g) return res.status(400).json({ ok: false, error: 'onvolledige regeling-Watch' });
      try {
        const ids = await STORE.smembers('u:' + uid + ':w');
        if (ids.length >= MAX_WATCHES) return res.status(400).json({ ok: false, error: 'maximaal ' + MAX_WATCHES + ' Watches' });
        const id = 'w_' + crypto.randomBytes(9).toString('hex');
        const w = { id, uid, type: 'regeling', subject: 'Regelingen ' + g, gemeente: g, seen: (Array.isArray(b.seen) ? b.seen : []).map(x => str(x, 60)).slice(0, 300), target: { maxPrice: 0 }, trig: 'nieuw',
          status: 'active', createdAt: Date.now(), lastCheckedAt: null, lastRelevantChange: null, lastNotified: null, notify: { push: true }, current: null,
          source: 'Lokale wet- en regelgeving (overheid.nl, CVDR) via WATCHDOG-server', clientRef: str(b.clientRef, 40) };
        await STORE.set('w:' + id, w); await STORE.sadd('u:' + uid + ':w', id); await STORE.sadd('all:w', id);
        return res.json({ ok: true, storage: STORE.kind, persistent: STORE.persistent, watch: clean(w) });
      } catch (e) { return res.status(503).json({ ok: false, error: 'opslag niet bereikbaar' }); }
    }
    if (b.type === 'vacature') {
      const q = str(b.query, 80).trim();
      if (!q) return res.status(400).json({ ok: false, error: 'onvolledige vacature-Watch' });
      try {
        const ids = await STORE.smembers('u:' + uid + ':w');
        if (ids.length >= MAX_WATCHES) return res.status(400).json({ ok: false, error: 'maximaal ' + MAX_WATCHES + ' Watches' });
        const id = 'w_' + crypto.randomBytes(9).toString('hex');
        const minSal = +b.minSalary > 0 && +b.minSalary < 50000 ? Math.round(+b.minSalary) : null;
        const w = { id, uid, type: 'vacature', subject: str(b.subject || q, 80), query: q, loc: str(b.location, 60), radius: Math.max(0, Math.min(100, parseInt(b.radius, 10) || 0)), remote: !!b.remote,
          minSalary: minSal, seen: (Array.isArray(b.seen) ? b.seen : []).map(x => str(x, 20)).slice(0, 200), target: { maxPrice: 0 }, trig: 'nieuw',
          status: 'active', createdAt: Date.now(), lastCheckedAt: null, lastRelevantChange: null, lastNotified: null, notify: { push: true }, current: null,
          source: 'Google Jobs (SerpApi) via WATCHDOG-server', clientRef: str(b.clientRef, 40) };
        await STORE.set('w:' + id, w); await STORE.sadd('u:' + uid + ':w', id); await STORE.sadd('all:w', id);
        return res.json({ ok: true, storage: STORE.kind, persistent: STORE.persistent, watch: clean(w) });
      } catch (e) { return res.status(503).json({ ok: false, error: 'opslag niet bereikbaar' }); }
    }
    const max = +((b.target || {}).maxPrice);
    if (!b.query || !(max > 0) || max > 100000) return res.status(400).json({ ok: false, error: 'onvolledige Watch' });
    try {
      const ids = await STORE.smembers('u:' + uid + ':w');
      if (ids.length >= MAX_WATCHES) return res.status(400).json({ ok: false, error: 'maximaal ' + MAX_WATCHES + ' Watches' });
      const id = 'w_' + crypto.randomBytes(9).toString('hex');
      const it = b.intent && typeof b.intent === 'object' ? b.intent : {};
      const w = {
        id, uid, type: 'prijs', subject: str(b.subject, 80), query: str(b.query, 120),
        intent: { family: str(it.family, 20) || null, edition: str(it.edition, 12) || null, cond: str(it.cond, 12) || null, bundleOk: !!it.bundleOk, category: str(it.category, 20) || null, brand: str(it.brand, 30) || null, label: str(it.label, 60) || null, country: 'NL', currency: 'EUR' },
        target: { maxPrice: Math.round(max * 100) / 100 }, trig: ['grens', 'slim'].includes(b.trig) ? b.trig : 'grens',
        current: b.current && +b.current.price > 0 ? { price: +b.current.price, shop: str(b.current.shop, 60), url: str(b.current.url, 500), title: str(b.current.title, 120), at: Date.now() } : null,
        status: 'active', createdAt: Date.now(), lastCheckedAt: null, lastRelevantChange: null, lastNotified: null, notify: { push: true },
        source: 'Live Search (SerpApi/Serper via WATCHDOG-server)', clientRef: str(b.clientRef, 40),
      };
      await STORE.set('w:' + id, w); await STORE.sadd('u:' + uid + ':w', id); await STORE.sadd('all:w', id);
      res.json({ ok: true, storage: STORE.kind, persistent: STORE.persistent, watch: clean(w) });
    } catch (e) { res.status(503).json({ ok: false, error: 'opslag niet bereikbaar' }); }
  });
  app.post('/api/watches/:id/status', async (req, res) => {
    const uid = guard(req, res); if (!uid) return;
    const w = await STORE.get('w:' + req.params.id).catch(() => null);
    if (!w || w.uid !== uid) return res.status(404).json({ ok: false, error: 'Watch niet gevonden' });
    const st = String((req.body || {}).status || '');
    if (st === 'deleted') { await STORE.del('w:' + w.id); await STORE.srem('u:' + uid + ':w', w.id); await STORE.srem('all:w', w.id); return res.json({ ok: true }); }
    if (!['active', 'paused', 'done'].includes(st)) return res.status(400).json({ ok: false, error: 'ongeldige status' });
    w.status = st; if ((req.body || {}).maxPrice > 0) w.target.maxPrice = +req.body.maxPrice;
    await STORE.set('w:' + w.id, w); res.json({ ok: true, watch: clean(w) });
  });
  app.get('/api/push/key', async (req, res) => { try { res.json({ ok: true, key: (await vapid()).pub }); } catch (e) { res.status(503).json({ ok: false, error: 'push niet beschikbaar' }); } });
  app.post('/api/push/subscribe', async (req, res) => {
    const uid = guard(req, res); if (!uid) return;
    const s = (req.body || {}).subscription || {};
    if (!/^https:\/\//.test(s.endpoint || '') || !s.keys || !s.keys.p256dh || !s.keys.auth) return res.status(400).json({ ok: false, error: 'ongeldige push-inschrijving' });
    await STORE.set('u:' + uid + ':push', { endpoint: str(s.endpoint, 600), keys: { p256dh: str(s.keys.p256dh, 200), auth: str(s.keys.auth, 60) }, at: Date.now() });
    res.json({ ok: true });
  });
  app.post('/api/push/unsubscribe', async (req, res) => { const uid = guard(req, res); if (!uid) return; await STORE.del('u:' + uid + ':push'); res.json({ ok: true }); });
  app.get('/api/events', async (req, res) => {
    const uid = guard(req, res); if (!uid) return;
    res.json({ ok: true, events: (await STORE.get('u:' + uid + ':ev')) || [] });
  });
  app.post('/api/events/ack', async (req, res) => {
    const uid = guard(req, res); if (!uid) return;
    const ids = new Set(((req.body || {}).ids || []).map(String));
    const L = ((await STORE.get('u:' + uid + ':ev')) || []).filter(e => !ids.has(e.id));
    await STORE.set('u:' + uid + ':ev', L); res.json({ ok: true, left: L.length });
  });

  // --------------------------------------------------------- één Watch controleren
  function median(a) { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; }
  async function checkJobs(w, now) {
    const first = !w.lastCheckedAt && !(w.seen || []).length; // eerste controle = nulmeting, geen melding
    let r; try { r = await searchJobs(w.query, w.loc, w.radius, w.remote); } catch (e) { r = { ok: false, error: e.message }; }
    w.lastCheckedAt = now;
    if (!r || !r.ok) { w.lastError = (r && r.error) || 'zoeken mislukt'; await STORE.set('w:' + w.id, w); return { id: w.id, ok: false, error: w.lastError }; }
    w.lastError = null;
    const seen = new Set(w.seen || []);
    const perMonth = s => !s ? null : s.per === 'maand' ? s.max : s.per === 'jaar' ? s.max / 12.96 : s.per === 'uur' ? s.max * 165 : s.per === 'week' ? s.max * 4.33 : null;
    const fits = j => !w.minSalary || !j.salary || (perMonth(j.salary) || 0) >= w.minSalary; // zonder salaris: meenemen, maar eerlijk vermelden
    const fresh = r.jobs.filter(j => !seen.has(j.id) && fits(j));
    r.jobs.forEach(j => seen.add(j.id));
    w.seen = Array.from(seen).slice(-300);
    w.current = { n: r.jobs.length, at: now };
    let notified = null;
    if (fresh.length && w.status === 'active' && !first) {
      w.lastRelevantChange = now;
      const top = fresh.slice(0, 3);
      const ev = { id: 'sev_' + crypto.randomBytes(6).toString('hex'), watchId: w.id, clientRef: w.clientRef, type: 'vacature', priority: 'medium', ts: now,
        title: `Woef! ${fresh.length} nieuwe ${fresh.length === 1 ? 'vacature' : 'vacatures'}.`, message: `Voor "${w.subject}"${w.loc ? ' in de buurt van ' + w.loc : ''}: ${top.map(j => j.title + (j.company ? ' bij ' + j.company : '')).join('; ')}${fresh.length > 3 ? ' en meer' : ''}.`,
        jobs: top.map(j => ({ id: j.id, title: j.title, company: j.company, location: j.location, salary: j.salary, url: j.url, via: j.via })) };
      const L = (await STORE.get('u:' + w.uid + ':ev')) || []; L.push(ev); await STORE.set('u:' + w.uid + ':ev', L.slice(-30));
      w.lastNotified = { at: now, ev: ev.id, n: fresh.length }; notified = ev;
      const sub = await STORE.get('u:' + w.uid + ':push');
      if (sub && w.notify && w.notify.push) {
        try { const st = await sendPush(sub, { title: ev.title, body: ev.message, tag: w.id, priority: 'medium', url: APP_URL + '#/verdienen' }); ev.push = st; if (st === 404 || st === 410) await STORE.del('u:' + w.uid + ':push'); }
        catch (e) { ev.push = 'fout: ' + e.message; }
      }
    }
    await STORE.set('w:' + w.id, w);
    return { id: w.id, ok: true, type: 'vacature', total: r.jobs.length, fresh: fresh.length, notified: !!notified, push: notified && notified.push };
  }
  // nieuwe of gewijzigde gemeentelijke regelingen (hooguit 1× per 20 uur per Watch)
  async function checkRegs(w, now) {
    if (w.lastCheckedAt && now - w.lastCheckedAt < 20 * 3600e3) return { id: w.id, ok: true, type: 'regeling', skipped: 'recent gecontroleerd' };
    const first = !w.lastCheckedAt && !(w.seen || []).length;
    let items; try { items = await regelingenVoor(w.gemeente); } catch (e) { w.lastCheckedAt = now; w.lastError = 'bron niet bereikbaar'; await STORE.set('w:' + w.id, w); return { id: w.id, ok: false, error: w.lastError }; }
    w.lastCheckedAt = now; w.lastError = null;
    const seen = new Set(w.seen || []);
    const key = x => x.id + '@' + x.version;
    const fresh = items.filter(x => !seen.has(key(x)) && !seen.has(x.id));
    items.forEach(x => { seen.add(key(x)); });
    w.seen = Array.from(seen).slice(-400); w.current = { n: items.length, at: now };
    let notified = null;
    if (fresh.length && w.status === 'active' && !first) {
      w.lastRelevantChange = now;
      const top = fresh.slice(0, 3);
      const ev = { id: 'sev_' + crypto.randomBytes(6).toString('hex'), watchId: w.id, clientRef: w.clientRef, type: 'regeling', priority: 'medium', ts: now,
        title: `Woef! Iets nieuws bij gemeente ${w.gemeente}.`, message: top.map(x => x.title + (x.hint ? ' – ' + x.hint : '')).join('; ') + (fresh.length > 3 ? ' en meer.' : '.') + ' Je hebt hier mogelijk recht op; controleer de voorwaarden.',
        regs: top.map(x => ({ id: x.id, title: x.title, hint: x.hint, url: x.url })) };
      const L = (await STORE.get('u:' + w.uid + ':ev')) || []; L.push(ev); await STORE.set('u:' + w.uid + ':ev', L.slice(-30));
      w.lastNotified = { at: now, ev: ev.id, n: fresh.length }; notified = ev;
      const sub = await STORE.get('u:' + w.uid + ':push');
      if (sub && w.notify && w.notify.push) {
        try { const st = await sendPush(sub, { title: ev.title, body: ev.message, tag: w.id, priority: 'medium', url: APP_URL + '#/kansen' }); ev.push = st; if (st === 404 || st === 410) await STORE.del('u:' + w.uid + ':push'); }
        catch (e) { ev.push = 'fout: ' + e.message; }
      }
    }
    await STORE.set('w:' + w.id, w);
    return { id: w.id, ok: true, type: 'regeling', total: items.length, fresh: fresh.length, notified: !!notified };
  }
  async function checkOne(w, now) {
    if (w.type === 'vacature') return checkJobs(w, now);
    if (w.type === 'regeling') return checkRegs(w, now);
    const r = await searchCached(w.query);
    w.lastCheckedAt = now;
    if (!r || !r.ok) { w.lastError = (r && r.error) || 'zoeken mislukt'; return { id: w.id, ok: false, error: w.lastError }; }
    w.lastError = null;
    const rows = (r.results || []).map(x => { const a = x.attributes || {}; const c = PRODX.classify(x.title, a.priceNote); return { title: x.title, url: x.url, shop: x.source, price: Number.isFinite(a.price) && a.price > 0 ? a.price : null, c, vd: PRODX.verdict(c, w.intent) }; });
    const match = rows.filter(x => x.vd.v === 'match' && x.price != null);
    const med = median(match.map(x => x.price));
    const trusted = match.filter(x => !(med && match.length >= 3 && x.price < med * 0.7)); // verdacht laag = niet bevestigd
    const best = trusted.sort((a, b) => a.price - b.price)[0] || null;
    const prev = w.current && w.current.price;
    if (best) { w.current = { price: best.price, shop: best.shop, url: best.url, title: best.title, at: now, n: match.length }; if (prev == null || Math.abs(prev - best.price) >= 1) w.lastRelevantChange = now; }
    const tgt = w.target.maxPrice;
    let notified = null;
    if (best && best.price <= tgt && w.status === 'active') {
      const ln = w.lastNotified && w.lastNotified.price;
      const again = ln == null || best.price <= ln - Math.max(5, ln * 0.02); // geen spam: alleen nieuwe, duidelijk lagere prijs
      if (again) {
        const ev = { id: 'sev_' + crypto.randomBytes(6).toString('hex'), watchId: w.id, clientRef: w.clientRef, type: 'watch', priority: 'medium', ts: now,
          title: 'Woef! Ik heb hem gevonden.', message: `De ${w.subject} die ik voor je bewaak is nu €${best.price.toFixed(2).replace('.', ',')}${best.shop ? ' bij ' + best.shop : ''}. Je grens was €${String(tgt).replace('.', ',')}.`,
          price: best.price, was: prev || null, target: tgt, shop: best.shop, url: best.url, productTitle: best.title };
        const L = (await STORE.get('u:' + w.uid + ':ev')) || []; L.push(ev); await STORE.set('u:' + w.uid + ':ev', L.slice(-30));
        w.lastNotified = { price: best.price, at: now, ev: ev.id };
        notified = ev;
        const sub = await STORE.get('u:' + w.uid + ':push');
        if (sub && w.notify && w.notify.push) {
          try {
            const st = await sendPush(sub, { title: ev.title, body: ev.message, tag: w.id, priority: ev.priority, url: APP_URL + '#/doel/srv:' + w.id + '/' + ev.id });
            ev.push = st; if (st === 404 || st === 410) await STORE.del('u:' + w.uid + ':push');
          } catch (e) { ev.push = 'fout: ' + e.message; }
        }
      }
    }
    await STORE.set('w:' + w.id, w);
    return { id: w.id, ok: true, matched: match.length, best: best && best.price, target: tgt, notified: !!notified, push: notified && notified.push };
  }
  app.post('/api/cron/check', async (req, res) => {
    if (!CRON_SECRET || req.get('X-Cron-Secret') !== CRON_SECRET) return res.status(401).json({ ok: false, error: 'niet toegestaan' });
    const now = Date.now(), force = String(req.query.force || '') === '1';
    const ids = await STORE.smembers('all:w');
    const all = (await Promise.all(ids.map(id => STORE.get('w:' + id)))).filter(w => w && w.status === 'active');
    const due = all.filter(w => force || !w.lastCheckedAt || now - w.lastCheckedAt > INTERVAL_H * 3600e3).sort((a, b) => (a.lastCheckedAt || 0) - (b.lastCheckedAt || 0)).slice(0, MAX_PER_RUN);
    const out = [];
    for (const w of due) { try { out.push(await checkOne(w, now)); } catch (e) { out.push({ id: w.id, ok: false, error: e.message }); } }
    const run = { at: now, active: all.length, checked: out.length, notified: out.filter(x => x.notified).length };
    await STORE.set('cron:last', run);
    log && log('Watch-controle: ' + JSON.stringify(run));
    res.json({ ok: true, run, results: out });
  });
  async function status() {
    const last = await STORE.get('cron:last').catch(() => null);
    return { storage: STORE.kind, storagePersistent: STORE.persistent, cron: CRON_SECRET ? (last ? 'actief' : 'ingesteld, nog niet gedraaid') : 'niet ingesteld', cronLastRun: last && new Date(last.at).toISOString(), cronLastRunAt: last && last.at, watchIntervalHours: INTERVAL_H, push: 'web-push (VAPID)' };
  }
  return { STORE, status, encryptPush, vapidJwt, PRODX, checkOne };
}

// ---- RC11: Watch Engine koppelen aan de bestaande zoeklaag (zelfde cache, daglimiet en providers) ----
async function searchCached(raw) {
  const q = cleanQuery(raw); const k = q.toLowerCase();
  const hit = cacheGet(k); if (hit) return hit;
  const order = providerOrder(); if (!order.length) return { ok: false, error: 'Live Search is niet ingesteld' };
  if (dailyLimitReached()) return { ok: false, error: 'daglimiet voor zoeken bereikt' };
  for (const p of order) {
    try { const { results, kind } = await searchWith(p, q); const body = { ok: true, isLive: true, source: kind === 'shopping' ? PROVIDER_NAMES[p] : PROVIDER_NAMES[p].replace('Google Shopping', 'Google'), sourceType: 'live-search', provider: p, query: q, fetchedAt: new Date().toISOString(), results }; cachePut(k, body); return body; }
    catch (e) { if (dailyLimitReached()) break; }
  }
  return { ok: false, error: 'de externe zoekbron gaf een fout terug' };
}
const WATCH = install(app, { rateLimited, searchCached, searchJobs, log: m => console.log(m) });

// ---- nette 404 en generieke foutafhandeling, nooit een stack trace naar de gebruiker ----
app.use((req, res) => res.status(404).json({ ok: false, error: 'onbekende route' }));
app.use((err, req, res, next) => {
  console.error('WATCHDOG backend error:', err && err.message);
  res.status(500).json({ ok: false, error: 'interne serverfout' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    const order = providerOrder();
    console.log(`WATCHDOG backend RC13 luistert op poort ${PORT} — Live Search: ${order.length ? order.join(' → ') : 'NIET GECONFIGUREERD'}`);
  });
}
module.exports = { app, cleanQuery, parsePrice, ttsClean, encryptPush, vapidJwt, PRODX, cachePut, get WATCH() { return WATCH; } };
