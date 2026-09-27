// api/health.js — Contrôle de santé TransportPro
// Ouvre https://transportpro.pro/api/health : fait un vrai géocodage + une vraie
// recherche de sociétés (exactement comme le TransportFinder) et renvoie le résultat.
// La clé Google reste côté serveur (variable Vercel GOOGLE_API_KEY), jamais renvoyée.

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const KEY = process.env.GOOGLE_API_KEY;
  const out = {
    time: new Date().toISOString(),
    googleKeyConfigured: !!KEY,
    geocode: null,
    search: null,
    ok: false,
  };

  if (!KEY) {
    out.error = 'GOOGLE_API_KEY manquante sur Vercel';
    return res.status(500).json(out);
  }

  // 1. Géocodage (même appel que la recherche de ville)
  let lat = 50.8503, lng = 4.3517;
  try {
    const r = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=Bruxelles&language=fr&key=${KEY}`
    );
    const d = await r.json();
    out.geocode = { status: d.status, address: d.results?.[0]?.formatted_address || null };
    if (d.error_message) out.geocode.error = d.error_message;
    if (d.status === 'OK') {
      lat = d.results[0].geometry.location.lat;
      lng = d.results[0].geometry.location.lng;
    }
  } catch (e) {
    out.geocode = { status: 'FETCH_ERROR', error: e.message };
  }

  // 2. Recherche de sociétés (même appel que le TransportFinder)
  try {
    const r = await fetch(`https://places.googleapis.com/v1/places:searchText?key=${KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress',
      },
      body: JSON.stringify({
        textQuery: 'société transport routier marchandises',
        locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: 20000 } },
        languageCode: 'fr',
        maxResultCount: 10,
      }),
    });
    const d = await r.json();
    const places = d.places || [];
    out.search = {
      httpStatus: r.status,
      count: places.length,
      sample: places.slice(0, 3).map(p => p.displayName?.text),
    };
    if (d.error) out.search.error = d.error.message || d.error.status || 'erreur Google';
  } catch (e) {
    out.search = { count: 0, error: e.message };
  }

  out.ok = out.geocode?.status === 'OK' && (out.search?.count || 0) > 0;
  return res.status(out.ok ? 200 : 500).json(out);
}
