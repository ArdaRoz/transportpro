export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  // ── GET : geocode, autocomplete, details ──────────────
  if (req.method === 'GET') {
    const { endpoint, name, ...params } = req.query;

    // Photo proxy (endpoint=photo&name=places/xxx/photos/xxx)
    if (endpoint === 'photo' && name) {
      const photoUrl = `https://places.googleapis.com/v1/${name}/media?maxWidthPx=80&key=${apiKey}`;
      const upstream = await fetch(photoUrl);
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      const buf = await upstream.arrayBuffer();
      return res.status(upstream.status).send(Buffer.from(buf));
    }

    const allowedGET = {
      geocode:      'https://maps.googleapis.com/maps/api/geocode/json',
      autocomplete: 'https://maps.googleapis.com/maps/api/place/autocomplete/json',
      details:      'https://maps.googleapis.com/maps/api/place/details/json',
    };
    const baseUrl = allowedGET[endpoint];
    if (!baseUrl) return res.status(400).json({ error: `Endpoint invalide: ${endpoint}` });

    const url = new URL(baseUrl);
    url.searchParams.set('key', apiKey);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    try {
      const upstream = await fetch(url.toString());
      const data = await upstream.json();
      return res.status(200).json(data);
    } catch (err) {
      return res.status(502).json({ error: 'Erreur Google API', details: err.message });
    }
  }

  // ── POST : Places API v1 searchText ───────────────────
  if (req.method === 'POST') {
    const { endpoint, ...body } = req.body || {};

    if (endpoint !== 'searchText') {
      return res.status(400).json({ error: 'Seul endpoint POST autorisé: searchText' });
    }

    try {
      const upstream = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.currentOpeningHours,places.photos,places.location,places.nationalPhoneNumber,places.websiteUri,places.googleMapsUri',
        },
        body: JSON.stringify(body),
      });
      const data = await upstream.json();
      return res.status(200).json(data);
    } catch (err) {
      return res.status(502).json({ error: 'Erreur Places API', details: err.message });
    }
  }

  return res.status(405).json({ error: 'Méthode non autorisée' });
}
