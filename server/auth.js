// The shop's dashboard login: one shared password (ADMIN_PASSWORD), signed HttpOnly session cookie.
const crypto = require('crypto');
const config = require('./config');

const COOKIE = 'gs_admin';
const TTL = 12 * 60 * 60 * 1000;

const sign = (v) => crypto.createHmac('sha256', config.sessionSecret).update(v).digest('base64url');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function checkPassword(pw) {
  if (!config.adminPassword) return false;
  // hash both sides so the comparison is constant-time regardless of length
  const h = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(h(pw), h(config.adminPassword));
}

function sessionCookie(secure) {
  const exp = Date.now() + TTL;
  const v = `${exp}.${sign(String(exp))}`;
  return `${COOKIE}=${v}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${TTL / 1000}${secure ? '; Secure' : ''}`;
}
const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

function isAdmin(req) {
  const raw = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(COOKIE + '='));
  if (!raw) return false;
  const [exp, sig] = raw.slice(COOKIE.length + 1).split('.');
  return Number(exp) > Date.now() && !!sig && safeEq(sig, sign(exp));
}

// the visitor's address. X-Forwarded-For can't be trusted on Render: the proxy keeps whatever the client sent
// and only appends, so a forged first entry would dodge every limit. Cloudflare (in front of Render) overwrites
// CF-Connecting-IP and True-Client-IP with the real address, so those come first.
let ipSource = '';
function clientIp(req) {
  const h = req.headers;
  const cf = h['cf-connecting-ip'] || h['true-client-ip'];
  const xff = String(h['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const source = cf ? 'Cloudflare header' : xff.length ? `last of ${xff.length} X-Forwarded-For entries` : 'socket';
  if (source !== ipSource) { ipSource = source; console.log(`rate limits key on: ${source}`); } // says which, never the address
  if (cf) return String(cf).trim();
  return xff[xff.length - 1] || req.socket.remoteAddress || 'unknown';
}

// simple in-memory limiter: n attempts per window per key
const buckets = new Map();
// drop finished windows now and then so the map can't grow without end
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k); }, 10 * 60 * 1000).unref();
function limited(key, n, windowMs) {
  const now = Date.now();
  if (buckets.size > 50000) buckets.clear(); // flood of addresses: start over rather than run out of memory
  const b = buckets.get(key) || { count: 0, reset: now + windowMs };
  if (now > b.reset) { b.count = 0; b.reset = now + windowMs; }
  b.count++;
  buckets.set(key, b);
  return b.count > n;
}

module.exports = { checkPassword, sessionCookie, clearCookie, isAdmin, limited, clientIp };
