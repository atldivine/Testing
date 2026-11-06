// Google reviews and listing photos for the homepage, through Google's Places API (New), shown with Google's attribution.
// Needs GOOGLE_PLACES_KEY. The listing is Good Shepard Auto Body Inc. (GOOGLE_PLACE_ID in config), and results are
// cached for 12 hours in the settings table, so the page asks Google about twice a day whatever the traffic.
const config = require('./config');

const TTL = 12 * 60 * 60 * 1000;
const SEARCH = 'Good Shepard Auto Body Inc., 15 Old Middle Country Rd, Coram, NY 11727';
// the listing, for links when the API isn't set up yet
const LISTING = 'https://www.google.com/maps/search/?api=1&query=Good+Shepard+Auto+Body+Inc&query_place_id=ChIJez3DBQBB6IkRHQVdJwoE-I8';
// the listing's headline numbers, read off its Birdeye mirror of the Google profile on 2026-11-06.
// Shown until GOOGLE_PLACES_KEY is set; after that the live numbers replace them. Review text is never stored here.
const SNAPSHOT = { rating: 4.9, count: 111, topics: [] };
const MAX_PHOTOS = 12;

let memo = null; // { at, data }
let inflight = null;

async function call(url, { method = 'GET', body, fields }) {
  const res = await fetch(url, {
    method,
    headers: { 'X-Goog-Api-Key': config.placesKey, ...(fields ? { 'X-Goog-FieldMask': fields } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message || `Places ${res.status}`);
  return json;
}

async function placeId(db) {
  if (config.placeId) return config.placeId;
  const saved = db.getValue('google_place_id');
  if (saved) return saved;
  const r = await call('https://places.googleapis.com/v1/places:searchText', { method: 'POST', body: { textQuery: SEARCH, maxResultCount: 1 }, fields: 'places.id,places.displayName' });
  const id = r.places?.[0]?.id;
  if (!id) throw new Error('Google listing not found');
  db.setValue('google_place_id', id);
  return id;
}

// a listing photo's image address on Google's image host (allowed by the page CSP), plus who took it
async function photo(p) {
  const r = await call(`https://places.googleapis.com/v1/${p.name}/media?maxWidthPx=1400&skipHttpRedirect=true`, {});
  const by = p.authorAttributions?.[0];
  return r.photoUri ? { url: r.photoUri, width: p.widthPx, height: p.heightPx, author: by?.displayName || '', authorUrl: by?.uri || null } : null;
}

async function fetchFresh(db) {
  const id = await placeId(db);
  const p = await call(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}`, { fields: 'rating,userRatingCount,googleMapsUri,reviews,photos' });
  const photos = (await Promise.all((p.photos || []).slice(0, MAX_PHOTOS).map((x) => photo(x).catch(() => null)))).filter(Boolean);
  return {
    configured: true,
    topics: SNAPSHOT.topics,
    rating: p.rating ?? null,
    count: p.userRatingCount ?? 0,
    url: p.googleMapsUri || LISTING,
    writeUrl: `https://search.google.com/local/writereview?placeid=${encodeURIComponent(id)}`,
    photos,
    reviews: (p.reviews || []).map((r) => ({
      author: r.authorAttribution?.displayName || 'Google user',
      authorUrl: r.authorAttribution?.uri || null,
      photo: r.authorAttribution?.photoUri || null,
      rating: r.rating ?? null,
      when: r.relativePublishTimeDescription || '',
      at: r.publishTime || null,
      text: r.text?.text || r.originalText?.text || '',
      url: r.googleMapsUri || p.googleMapsUri || LISTING,
    })).filter((r) => r.text),
  };
}

// latest reviews: memory, then the saved copy, then Google; a failed refresh keeps serving the last good copy
async function get(db) {
  if (!config.placesKey) return { configured: false, url: LISTING, ...SNAPSHOT, reviews: [], photos: [] };
  if (!memo) { const saved = db.getValue('google_reviews'); if (saved) memo = JSON.parse(saved); }
  if (memo && Date.now() - memo.at < TTL) return memo.data;
  if (!inflight) {
    inflight = fetchFresh(db)
      .then((data) => { memo = { at: Date.now(), data }; db.setValue('google_reviews', JSON.stringify(memo)); return data; })
      .catch((e) => { console.error('google reviews', e.message); return memo ? memo.data : { configured: true, error: true, url: LISTING, ...SNAPSHOT, reviews: [], photos: [] }; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

module.exports = { get, LISTING };
