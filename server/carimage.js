// Finds a picture of the customer's year/make/model and caches it in data/cars/.
// 1. IMAGIN.studio (IMAGIN_CUSTOMER_KEY): studio render, transparent PNG.
// 2. Wikipedia: the lead photo of the model's article (free, no key).
// Returns { file, type, kind } or null; the tracker draws a silhouette when nothing is found.
const fs = require('fs');
const path = require('path');
const config = require('./config');

const dir = path.join(config.dataDir, 'cars');
fs.mkdirSync(dir, { recursive: true });
// Wikimedia rate-limits clients whose User-Agent carries no contact URL
const UA = `GoodShepardRepairTracker/1.0 (${config.siteUrl.startsWith('https') ? config.siteUrl : 'https://www.facebook.com/goodshepardautobody/'})`;
const MISS_TTL = 24 * 60 * 60 * 1000; // retry a failed lookup after a day
const inflight = new Map();

const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const cacheKey = (b) => slug(`${b.car_year}-${b.car_make}-${b.car_model}`) || slug(b.vehicle);

function cached(key) {
  for (const [ext, type, kind] of [['png', 'image/png', 'render'], ['jpg', 'image/jpeg', 'photo']]) {
    const file = path.join(dir, `${key}.${ext}`);
    if (fs.existsSync(file)) return { file, type, kind };
  }
  const miss = path.join(dir, `${key}.miss`);
  if (fs.existsSync(miss) && Date.now() - fs.statSync(miss).mtimeMs < MISS_TTL) return { none: true };
  return null;
}

async function download(url, file, maxBytes = 6e6) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !type.startsWith('image/')) return false;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 2000 || buf.length > maxBytes) return false;
  fs.writeFileSync(file, buf);
  return true;
}

async function fromImagin(b, key) {
  if (!config.imaginKey || !b.car_make || !b.car_model) return null;
  const model = slug(b.car_model).split('-')[0]; // "q50-3-0t" -> "q50" (model family)
  const q = new URLSearchParams({
    customer: config.imaginKey, make: slug(b.car_make), modelFamily: model, modelYear: b.car_year || '',
    angle: '23', zoomType: 'fullscreen', fileType: 'png', width: '1200',
  });
  const file = path.join(dir, `${key}.png`);
  return (await download(`https://cdn.imagin.studio/getImage?${q}`, file)) ? { file, type: 'image/png', kind: 'render' } : null;
}

async function wiki(params) {
  const q = new URLSearchParams({ format: 'json', formatversion: '2', ...params });
  const res = await fetch(`https://en.wikipedia.org/w/api.php?${q}`, { headers: { 'User-Agent': UA } });
  return res.ok ? res.json() : null;
}

async function fromWikipedia(b, key) {
  const make = (b.car_make || '').trim(), model = (b.car_model || '').trim();
  const base = make && model ? `${make} ${model.split(/\s+/)[0]}` : b.vehicle.replace(/^\d{4}\s+/, '');
  if (!base) return null;
  const search = await wiki({ action: 'query', list: 'search', srsearch: `${base} car`, srlimit: '6', srnamespace: '0' });
  const words = base.toLowerCase().split(/\s+/);
  // the exact "Make Model" article first (redirects follow, e.g. GL450 -> GL-Class), then close search hits
  const titles = [base, ...(search?.query?.search || []).map((r) => r.title)
    .filter((t) => words.every((w) => t.toLowerCase().includes(w.replace(/[^a-z0-9-]/g, ''))))
    .slice(0, 3)];
  for (const title of titles) {
    const page = await wiki({ action: 'query', prop: 'pageimages', piprop: 'thumbnail', pithumbsize: '1200', redirects: '1', titles: title });
    const src = page?.query?.pages?.[0]?.thumbnail?.source;
    let host = '';
    try { host = new URL(src).hostname; } catch { continue; }
    if (!src.startsWith('https://') || !host.endsWith('.wikimedia.org') || /\.svg/i.test(src)) continue;
    const file = path.join(dir, `${key}.jpg`);
    if (await download(src, file)) {
      // Wikimedia photos are CC-licensed: keep the article so the tracker can credit it
      const article = page?.query?.pages?.[0]?.title || title;
      fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify({ page: article, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(article.replace(/ /g, '_'))}` }));
      return { file, type: 'image/jpeg', kind: 'photo', credit: article };
    }
  }
  return null;
}

async function carImage(b) {
  const key = cacheKey(b);
  if (!key) return null;
  const hit = cached(key);
  if (hit) return hit.none ? null : hit;
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    try {
      const found = (await fromImagin(b, key)) || (await fromWikipedia(b, key));
      if (!found) fs.writeFileSync(path.join(dir, `${key}.miss`), String(Date.now()));
      return found;
    } catch (e) {
      console.error('car image lookup failed', e.message);
      return null; // network trouble: try again next time
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, job);
  return job;
}

// what the tracker needs to label the picture, without fetching anything
function imageInfo(b) {
  const key = cacheKey(b);
  const hit = key && cached(key);
  if (!hit || hit.none) return null;
  let credit = null;
  try { credit = JSON.parse(fs.readFileSync(path.join(dir, `${key}.json`), 'utf8')); } catch {}
  return { kind: hit.kind, credit };
}

module.exports = { carImage, imageInfo };
