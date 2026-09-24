// api/places.js — Vercel Serverless Proxy for Google Places API
// Security: Google API key is stored ONLY in Vercel environment variable GOOGLE_API_KEY
// Never put the key in frontend code or commit it to GitHub

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const GKEY = process.env.GOOGLE_API_KEY;
  if (!GKEY) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  // ── GET requests: geocode, autocomplete, photo ──────────────────────────
  if (req.method === 'GET') {
    const { endpoint, address, input, name, maxWidthPx, language } = req.query;

    if (endpoint === 'geocode') {
      const lang = language || 'fr';
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&language=${lang}&key=${GKEY}`;
      const r = await fetch(url);
      const data = await r.json();
      return res.status(200).json(data);
    }

    if (endpoint === 'autocomplete') {
      const lang = language || 'fr';
      const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}&types=(cities)&language=${lang}&key=${GKEY}`;
      const r = await fetch(url);
      const data = await r.json();
      return res.status(200).json(data);
    }

    if (endpoint === 'photo') {
      // name = resource name like "places/xxx/photos/yyy"
      const width = maxWidthPx || 80;
      const url = `https://places.googleapis.com/v1/${name}/media?maxWidthPx=${width}&key=${GKEY}&skipHttpRedirect=false`;
      const r = await fetch(url, { redirect: 'follow' });
      if (!r.ok) {
        return res.status(r.status).json({ error: 'Photo not found' });
      }
      const contentType = r.headers.get('content-type') || 'image/jpeg';
      const buf = await r.arrayBuffer();
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
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
      const payload = {
        textQuery,
        languageCode: languageCode || 'fr',
        maxResultCount: maxResultCount || 20,
      };
      if (locationBias) payload.locationBias = locationBias;

      const url = `https://places.googleapis.com/v1/places:searchText?key=${GKEY}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.currentOpeningHours,places.photos,places.nationalPhoneNumber,places.websiteUri,places.googleMapsUri',
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
