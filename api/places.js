// api/places.js — Vercel Serverless Proxy for Google Places API
// Security: Google API key is stored ONLY in Vercel environment variable GOOGLE_API_KEY
// Never put the key in frontend code or commit it to GitHub
//
// PROTECTION DES FRAIS GOOGLE (ajoutée le 01/11/2026)
// Avant chaque appel à Google, on vérifie AUPRÈS DE MEMBERSTACK (côté serveur, impossible à tricher) :
//   1. que la personne est connectée (token Memberstack envoyé par le site) ;
//   2. qu'elle a un abonnement payant actif (Starter, Pro ou Entreprise) ;
//   3. Starter : 3 recherches par jour maximum, comptées sur le serveur (dans les metaData du membre) ;
//      Pro / Entreprise : illimité (garde-fou anti-abus à 300 recherches/jour).
// Il faut la variable Vercel MEMBERSTACK_SECRET_KEY (clé secrète sk_... de Memberstack).
// Si elle manque, le site continue de marcher comme avant (sans protection) pour ne jamais bloquer les clients.

const MS_APP_ID = 'app_cmouj89r400020sz3f45tfk3e';
const MS_ADMIN = 'https://admin.memberstack.com';
const PAID_PRICES = ['prc_starter-mw82039c', 'prc_pro-ei8103c9', 'prc_entreprise-ib6k0elp'];
const PAID_PLANS = ['pln_starter-2c70ujw', 'pln_pro-888003rj', 'pln_entreprise-237m0uzz'];
const PRO_PRICES = ['prc_pro-ei8103c9', 'prc_entreprise-ib6k0elp'];
const PRO_PLANS = ['pln_pro-888003rj', 'pln_entreprise-237m0uzz'];
const INACTIVE = ['CANCELED', 'CANCELLED', 'ENDED', 'EXPIRED', 'INACTIVE', 'UNPAID', 'INCOMPLETE_EXPIRED', 'REQUIRES_PAYMENT'];
const STARTER_DAILY_LIMIT = 3;
const PRO_DAILY_LIMIT = 300;          // garde-fou anti-abus (compte piraté), jamais atteint par un vrai client
const CALLS_PER_SEARCH = 8;           // une recherche = 3 à 6 requêtes Google selon le filtre
const REQUESTS_PER_MINUTE = 300;      // anti-spam par membre (photos comprises)
const ALLOWED_ORIGINS = ['https://transportpro.pro', 'https://www.transportpro.pro'];

// Petits caches en mémoire (gardés tant que le serveur Vercel reste "chaud")
const authCache = new Map();   // token -> { until, result }
const rateCache = new Map();   // memberId -> { minute, n }
const searchCache = new Map(); // memberId -> { sid, n }

function priceOf(p) { return p.priceId || (p.payment && p.payment.priceId) || ''; }
function isActive(p) {
  if (!p || p.active === false) return false;
  return !INACTIVE.includes(String(p.status || '').toUpperCase());
}
function isPaid(p) { return PAID_PRICES.includes(priceOf(p)) || PAID_PLANS.includes(p.planId); }
function isPro(p) { return PRO_PRICES.includes(priceOf(p)) || PRO_PLANS.includes(p.planId); }
function brusselsDay() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Brussels' }).format(new Date());
}

function getToken(req) {
  const h = req.headers.authorization || req.headers.Authorization || '';
  if (typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7).trim();
  const c = req.headers.cookie || '';
  const m = c.match(/(?:^|;\s*)_ms-mid=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

async function msFetch(path, opts = {}) {
  const r = await fetch(MS_ADMIN + path, {
    ...opts,
    headers: { 'X-API-KEY': process.env.MEMBERSTACK_SECRET_KEY, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  let data = null;
  try { data = await r.json(); } catch (e) {}
  return { status: r.status, data };
}

// Renvoie { ok:true, member, pro } ou { ok:false, code, status, message } ; { ok:true, open:true } si protection désactivée
async function checkMember(req, fresh) {
  if (!process.env.MEMBERSTACK_SECRET_KEY) return { ok: true, open: true };
  const token = getToken(req);
  if (!token || token.length > 4000) return { ok: false, status: 401, code: 'AUTH', message: 'Connectez-vous pour faire une recherche.' };

  const cached = authCache.get(token);
  if (!fresh && cached && cached.until > Date.now()) return cached.result;

  let result;
  try {
    const v = await msFetch('/members/verify-token', { method: 'POST', body: JSON.stringify({ token }) });
    if (v.status >= 500) return { ok: true, open: true }; // Memberstack en panne : on ne bloque pas les clients
    const vd = (v.data && (v.data.data || v.data)) || {};
    const id = vd.id;
    const aud = vd.aud;
    if (v.status !== 200 || !id || (aud && aud !== MS_APP_ID)) {
      result = { ok: false, status: 401, code: 'AUTH', message: 'Session expirée : reconnectez-vous.' };
    } else {
      const g = await msFetch('/members/' + encodeURIComponent(id));
      if (g.status >= 500) return { ok: true, open: true };
      const member = g.data && (g.data.data !== undefined ? g.data.data : (g.data.id ? g.data : null));
      const plans = ((member && member.planConnections) || []).filter(p => isActive(p) && isPaid(p));
      if (!member) result = { ok: false, status: 401, code: 'AUTH', message: 'Compte introuvable : reconnectez-vous.' };
      else if (!plans.length) result = { ok: false, status: 403, code: 'NO_PLAN', message: 'Un abonnement actif est nécessaire pour faire une recherche.' };
      else result = { ok: true, member, pro: plans.some(isPro) };
    }
  } catch (e) {
    return { ok: true, open: true }; // erreur réseau vers Memberstack : on ne bloque pas les clients
  }
  // On ne garde en cache que les réponses positives (un client qui vient de payer n'est jamais bloqué par le cache)
  if (result.ok) authCache.set(token, { until: Date.now() + 60000, result });
  else authCache.delete(token);
  if (authCache.size > 2000) authCache.clear();
  return result;
}

function rateLimited(memberId) {
  const minute = Math.floor(Date.now() / 60000);
  const e = rateCache.get(memberId);
  if (!e || e.minute !== minute) { rateCache.set(memberId, { minute, n: 1 }); return false; }
  e.n++;
  return e.n > REQUESTS_PER_MINUTE;
}

// Compte les recherches côté serveur (une recherche = plusieurs requêtes avec le même identifiant)
async function countSearch(auth, sid) {
  const m = auth.member;
  const day = brusselsDay();
  const meta = m.metaData || {};
  const cur = searchCache.get(m.id);
  if (sid && cur && cur.sid === sid) {
    cur.n++;
    if (cur.n > CALLS_PER_SEARCH) return { ok: false, status: 429, code: 'TOO_MANY', message: 'Trop de requêtes : relancez une nouvelle recherche.' };
    return { ok: true };
  }
  let count = meta.tfDay === day ? (parseInt(meta.tfCount, 10) || 0) : 0;
  if (sid && meta.tfDay === day && meta.tfSid === sid) return { ok: true }; // même recherche, autre serveur
  const limit = auth.pro ? PRO_DAILY_LIMIT : STARTER_DAILY_LIMIT;
  if (count >= limit) {
    return { ok: false, status: 429, code: 'LIMIT', message: auth.pro
      ? 'Limite de sécurité atteinte pour aujourd\'hui. Contactez le support.'
      : 'Limite de 3 recherches atteinte ! Passez au Pro.' };
  }
  count++;
  const newSid = sid || ('s' + Date.now());
  const newMeta = { tfDay: day, tfCount: String(count), tfSid: newSid };
  m.metaData = { ...meta, ...newMeta };          // met aussi à jour le cache
  searchCache.set(m.id, { sid: newSid, n: 1 });
  if (searchCache.size > 5000) searchCache.clear();
  try {
    await msFetch('/members/' + encodeURIComponent(m.id), { method: 'PATCH', body: JSON.stringify({ metaData: newMeta }) });
  } catch (e) {}
  return { ok: true, remaining: auth.pro ? null : limit - count };
}

export default async function handler(req, res) {
  // CORS : seul le site TransportPro peut utiliser ce proxy
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-TF-Search');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const GKEY = process.env.GOOGLE_API_KEY;
  if (!GKEY) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  // ── Vérification du membre AVANT tout appel payant à Google ──────────────
  let auth = await checkMember(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.code, message: auth.message });
  if (auth.member && rateLimited(auth.member.id)) {
    return res.status(429).json({ error: 'TOO_MANY', message: 'Trop de requêtes, patientez une minute.' });
  }

  // ── GET requests: geocode, autocomplete, photo ──────────────────────────
  if (req.method === 'GET') {
    const { endpoint, address, input, name, maxWidthPx, language } = req.query;
    const lang = /^[a-z]{2}$/.test(language || '') ? language : 'fr';

    if (endpoint === 'geocode') {
      if (typeof address !== 'string' || !address.trim() || address.length > 150) {
        return res.status(400).json({ error: 'Adresse invalide' });
      }
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&language=${lang}&key=${GKEY}`;
      const r = await fetch(url);
      const data = await r.json();
      return res.status(200).json(data);
    }

    if (endpoint === 'autocomplete') {
      if (typeof input !== 'string' || !input.trim() || input.length > 150) {
        return res.status(400).json({ error: 'Texte invalide' });
      }
      const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}&types=(cities)&language=${lang}&key=${GKEY}`;
      const r = await fetch(url);
      const data = await r.json();
      return res.status(200).json(data);
    }

    if (endpoint === 'photo') {
      // name = resource name like "places/xxx/photos/yyy"
      // Sécurité : n'accepter qu'un vrai nom de photo Google (sinon le proxy pourrait appeler d'autres API Google avec la clé)
      if (typeof name !== 'string' || !/^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/.test(name)) {
        return res.status(400).json({ error: 'Nom de photo invalide' });
      }
      const width = Math.min(Math.max(parseInt(maxWidthPx, 10) || 80, 16), 400);
      const url = `https://places.googleapis.com/v1/${name}/media?maxWidthPx=${width}&key=${GKEY}&skipHttpRedirect=false`;
      const r = await fetch(url, { redirect: 'follow' });
      if (!r.ok) {
        return res.status(r.status).json({ error: 'Photo not found' });
      }
      const contentType = r.headers.get('content-type') || 'image/jpeg';
      const buf = await r.arrayBuffer();
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'private, max-age=86400');
      return res.status(200).send(Buffer.from(buf));
    }

    return res.status(400).json({ error: 'Unknown endpoint' });
  }

  // ── POST request: searchText ─────────────────────────────────────────────
  if (req.method === 'POST') {
    // Vercel does NOT always parse JSON body — handle both cases
    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch (e) {
        return res.status(400).json({ error: 'Body JSON invalide' });
      }
    }
    if (!body) {
      return res.status(400).json({ error: 'Body manquant' });
    }

    const { endpoint, textQuery, locationBias, languageCode, maxResultCount } = body;

    if (endpoint === 'searchText') {
      if (typeof textQuery !== 'string' || !textQuery.trim() || textQuery.length > 200) {
        return res.status(400).json({ error: 'Recherche invalide' });
      }
      // Compte la recherche (limite Starter 3/jour vérifiée ici, côté serveur)
      if (auth.member) {
        const sidRaw = req.headers['x-tf-search'];
        const sid = typeof sidRaw === 'string' && /^[A-Za-z0-9_-]{6,40}$/.test(sidRaw) ? sidRaw : '';
        let c = await countSearch(auth, sid);
        // Limite atteinte ? On revérifie EN DIRECT l'abonnement (un client qui vient de passer Pro n'est jamais bloqué)
        if (!c.ok && c.code === 'LIMIT' && !auth.pro) {
          const fresh = await checkMember(req, true);
          if (fresh.ok && fresh.member) { auth = fresh; c = await countSearch(auth, sid); }
          else if (fresh.ok && fresh.open) c = { ok: true };
        }
        if (!c.ok) return res.status(c.status).json({ error: c.code, message: c.message });
      }

      const payload = {
        textQuery,
        languageCode: /^[a-z]{2}$/.test(languageCode || '') ? languageCode : 'fr',
        maxResultCount: Math.min(Math.max(parseInt(maxResultCount, 10) || 20, 1), 20),
      };
      if (locationBias) payload.locationBias = locationBias;

      const url = `https://places.googleapis.com/v1/places:searchText?key=${GKEY}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.currentOpeningHours,places.photos,places.nationalPhoneNumber,places.websiteUri,places.googleMapsUri,places.types,places.primaryType',
        },
        body: JSON.stringify(payload),
      });

      const data = await r.json();
      return res.status(200).json(data);
    }

    return res.status(400).json({ error: 'Unknown POST endpoint' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
