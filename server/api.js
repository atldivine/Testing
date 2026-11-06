// /api/* routes for online booking (public) and the shop's dashboard (admin).
const config = require('./config');
const db = require('./db');
const stripe = require('./stripe');
const auth = require('./auth');
const notify = require('./notify');
const fs = require('fs');
const { carImage, imageInfo } = require('./carimage');
const receipt = require('./receipt');
const reviews = require('./reviews');

const SERVICES = [
  'Collision estimate', 'Collision repair', 'Insurance claim repair', 'Dent & bumper repair',
  'Paint & refinishing', 'Scratch & scuff repair', 'Frame & unibody straightening', 'Not sure / other',
];

/* ---------- helpers ---------- */
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}
const fail = (res, status, error) => send(res, status, { error });

function readBody(req, limit = 20000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('That file is over 15 MB.'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
// what an upload really is, from its first bytes (never trust the name or the browser's type)
function sniff(buf) {
  const at = (o, str) => buf.subarray(o, o + str.length).toString('latin1') === str;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (at(0, '\x89PNG')) return { mime: 'image/png', ext: 'png' };
  if (at(0, 'RIFF') && at(8, 'WEBP')) return { mime: 'image/webp', ext: 'webp' };
  if (at(0, '%PDF')) return { mime: 'application/pdf', ext: 'pdf' };
  if (at(4, 'ftyp') && ['heic', 'heix', 'mif1', 'msf1', 'heif'].some((b) => at(8, b))) return { mime: 'image/heic', ext: 'heic' };
  return null;
}
const UPLOAD_MAX = 15 * 1024 * 1024;

async function readJSON(req) {
  // JSON-only POSTs: browsers can't send this cross-site without a CORS preflight we never grant
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw Object.assign(new Error('expected JSON'), { status: 415 });
  try { return JSON.parse((await readBody(req)) || '{}'); } catch { throw Object.assign(new Error('bad JSON'), { status: 400 }); }
}
const ip = auth.clientIp;
// pages the API builds itself (receipt, demo checkout) carry their own small inline script
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'self'";
const str = (v, max) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

const LIVE = ['paid', 'confirmed', 'completed', 'no_show', 'declined']; // bookings a customer can track

function publicBooking(b) {
  return {
    id: b.id, status: b.status, date: b.date, time: b.time, service: b.service, vehicle: b.vehicle,
    firstName: b.name.split(' ')[0], deposit: b.deposit_cents / 100, refunded: !!b.refunded,
    code: LIVE.includes(b.status) ? b.code : null,
  };
}

// deposit received: notify, and look up the car picture so the tracker has it ready
function onPaid(b) {
  notify.newBooking(b).catch(() => {});
  carImage(b).catch(() => {});
}

const stageLabel = (id) => (db.STAGES.find((s) => s.id === id) || {}).label || id;

function trackView(b) {
  const info = imageInfo(b);
  return {
    code: b.code, firstName: b.name.split(' ')[0], vehicle: b.vehicle,
    year: b.car_year, make: b.car_make, model: b.car_model,
    service: b.service, date: b.date, time: b.time, status: b.status,
    stage: b.stage, note: b.stage_note,
    stages: db.STAGES.map(({ id, label, blurb }) => ({ id, label, blurb })),
    events: db.events(b.id).map((e) => ({ stage: e.stage, label: stageLabel(e.stage), note: e.note, at: e.at })),
    image: info ? { url: `/api/track/${b.code}/car`, kind: info.kind, credit: info.credit } : null,
    records: db.records(b.id).filter((r) => r.sent_at).map((r) => ({ id: r.id, kind: r.kind, title: r.title, at: r.created_at, mime: r.mime, size: r.size, url: `/api/track/${b.code}/records/${r.id}` })),
    shopPhone: config.shopPhoneDisplay,
  };
}

function validateBooking(body) {
  const b = {
    service: str(body.service, 60), details: text(body.details, 1000),
    year: str(body.year, 4), make: str(body.make, 30), model: str(body.model, 40),
    date: str(body.date, 10), time: str(body.time, 5), name: str(body.name, 80),
    phone: str(body.phone, 30), email: str(body.email, 120).toLowerCase(),
  };
  const errors = {};
  if (!SERVICES.includes(b.service)) errors.service = 'Pick a service.';
  const maxYear = new Date().getFullYear() + 1;
  if (!/^\d{4}$/.test(b.year) || +b.year < 1950 || +b.year > maxYear) errors.year = 'Pick the year.';
  if (b.make.length < 2) errors.make = 'Enter the make, like Toyota.';
  if (b.model.length < 1) errors.model = 'Enter the model, like Camry.';
  b.vehicle = `${b.year} ${b.make} ${b.model}`.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date)) errors.date = 'Pick a drop-off day.';
  if (!/^\d{2}:\d{2}$/.test(b.time)) errors.time = 'Pick a drop-off time.';
  if (b.name.length < 2) errors.name = 'Enter your name.';
  if (b.phone.replace(/\D/g, '').length < 10) errors.phone = 'Enter a phone number we can text.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) errors.email = 'Enter a valid email for your receipt.';
  if (body.agree !== true) errors.agree = config.takesDeposit ? 'Please accept the deposit policy.' : 'Please accept the appointment policy.';
  return { b, errors };
}

// the shop's own entries: email and model year are optional, any day and time is allowed
const PAY_METHODS = ['cash', 'card', 'zelle', 'venmo', 'cashapp', 'check', 'other', 'none', 'waived'];
function validateManual(body) {
  const b = {
    service: str(body.service, 60), details: text(body.details, 1000),
    year: str(body.year, 4), make: str(body.make, 30), model: str(body.model, 40),
    date: str(body.date, 10), time: str(body.time, 5), name: str(body.name, 80),
    phone: str(body.phone, 30), email: str(body.email, 120).toLowerCase(), payMethod: str(body.payMethod, 12),
  };
  const errors = {};
  if (!SERVICES.includes(b.service)) errors.service = 'Pick a service.';
  if (b.year && (!/^\d{4}$/.test(b.year) || +b.year < 1950 || +b.year > new Date().getFullYear() + 1)) errors.year = 'Use a 4-digit year, or leave it blank.';
  if (b.make.length < 2) errors.make = 'Enter the make.';
  if (!b.model) errors.model = 'Enter the model.';
  b.vehicle = `${b.year} ${b.make} ${b.model}`.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date)) errors.date = 'Pick the drop-off day.';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.time)) errors.time = 'Pick the drop-off time.';
  if (b.name.length < 2) errors.name = "Enter the customer's name.";
  if (b.phone.replace(/\D/g, '').length < 10) errors.phone = 'Enter a 10-digit phone number.';
  if (b.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) errors.email = 'That email looks off. Fix it or leave it blank.';
  if (!PAY_METHODS.includes(b.payMethod)) errors.payMethod = 'Pick how the deposit was handled.';
  return { b, errors };
}

// a receipt the shop writes up: line items, what was paid today and how
function validateReceipt(body, b) {
  const items = Array.isArray(body.items) ? body.items : [];
  const errors = {};
  const clean = items
    .map((i) => ({ desc: str(i?.desc, 80), cents: Math.round(Number(i?.amount) * 100) }))
    .filter((i) => i.desc || i.cents);
  if (!clean.length) errors.items = 'Add at least one line with a price.';
  else if (clean.length > 30) errors.items = 'Keep it to 30 lines.';
  else if (clean.some((i) => !i.desc || !Number.isFinite(i.cents) || i.cents < 0 || i.cents > 10_000_000)) errors.items = 'Each line needs a description and a price.';
  const data = { items: clean, paidCents: Math.round(Number(body.paid || 0) * 100), method: str(body.method, 12), note: text(body.note, 400) };
  if (!errors.items) {
    const t = receipt.totals(b, { ...data, paidCents: 0 });
    if (!Number.isFinite(data.paidCents) || data.paidCents < 0 || data.paidCents > t.total - t.deposit) errors.paid = `Paid today can be $0 up to $${((t.total - t.deposit) / 100).toFixed(2)}.`;
  }
  if (data.method && !(data.method in receipt.METHODS)) errors.method = 'Pick how it was paid.';
  return { data, title: str(body.title, 60) || 'Receipt', errors };
}

// what the dashboard shows for each record
function adminRecord(b, r) {
  const out = { id: r.id, kind: r.kind, title: r.title, at: r.created_at, sentAt: r.sent_at, mime: r.mime, size: r.size, url: `/api/admin/records/${r.id}` };
  if (r.kind === 'receipt') out.totals = receipt.totals(b, JSON.parse(r.data));
  return out;
}

// stream a record: a file as itself, a receipt as its printable page
function sendRecord(res, b, r, cache) {
  if (r.kind === 'receipt') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': cache, 'Content-Security-Policy': PAGE_CSP });
    return res.end(receipt.page(b, r));
  }
  const file = db.recordPath(r);
  if (!fs.existsSync(file)) return fail(res, 404, 'That file is missing.');
  const name = `${r.title.replace(/[^\w .-]+/g, '').trim() || 'file'}.${r.file.split('.').pop()}`;
  // only sniffed photos and PDFs get here, served as exactly that type (nosniff); the page CSP would stop Chrome's PDF viewer
  res.removeHeader('Content-Security-Policy');
  res.writeHead(200, { 'Content-Type': r.mime, 'Content-Length': r.size, 'Cache-Control': cache, 'Content-Disposition': `inline; filename="${name}"` });
  return fs.createReadStream(file).pipe(res);
}

/* ---------- demo checkout (only when no Stripe key is configured) ---------- */
function demoPage(b) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Demo checkout · Good Shepard Auto Body</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f4f6;color:#16161c;font:15px/1.5 system-ui,sans-serif}
  main{width:min(420px,calc(100% - 32px));background:#fff;border:1px solid #ddd;padding:28px}
  .demo{margin:0 0 18px;padding:10px 12px;background:#fff4d6;border:1px solid #f0d27a;font-size:13px}
  h1{margin:0 0 4px;font-size:20px} .amt{font-size:32px;font-weight:700;margin:14px 0}
  button,a{display:block;width:100%;box-sizing:border-box;margin-top:10px;padding:13px;border:0;font:600 15px system-ui;text-align:center;text-decoration:none;cursor:pointer}
  button{background:#2463d6;color:#fff} a{background:#eee;color:#333}
</style></head><body><main>
  <p class="demo"><b>Demo mode.</b> No Stripe key is set, so no card is charged. With Stripe connected, customers see Stripe Checkout here.</p>
  <h1>Good Shepard Auto Body appointment deposit</h1>
  <p>${esc(b.service)} · ${esc(notify.prettyDate(b.date))} at ${esc(notify.prettyTime(b.time))}</p>
  <div class="amt">$${(b.deposit_cents / 100).toFixed(2)}</div>
  <button id="pay" type="button">Pay deposit (demo)</button>
  <a href="/book.html?booking=${encodeURIComponent(b.id)}&cancelled=1">Cancel</a>
</main><script>
  document.getElementById('pay').onclick = async (e) => {
    e.target.disabled = true;
    const r = await fetch('/api/demo/pay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ${JSON.stringify(b.id)} }) });
    const j = await r.json(); location.href = j.next || '/book.html';
  };
</script></body></html>`;
}

/* ---------- router ---------- */
async function handle(req, res, url) {
  const { pathname } = url;
  const m = req.method;
  db.expireHolds();

  try {
    /* public */
    if (m === 'GET' && pathname === '/api/booking/options') {
      return send(res, 200, { services: SERVICES, deposit: config.depositCents / 100, demo: config.takesDeposit && config.demoPayments, ...db.availability() });
    }

    if (m === 'GET' && pathname === '/api/reviews') {
      return send(res, 200, await reviews.get(db), { 'Cache-Control': 'public, max-age=600' });
    }

    if (m === 'POST' && pathname === '/api/bookings') {
      if (auth.limited('book:' + ip(req), 12, 60 * 60 * 1000)) return fail(res, 429, 'Too many attempts. Call or text us instead.');
      const { b, errors } = validateBooking(await readJSON(req));
      if (Object.keys(errors).length) return send(res, 422, { error: 'Check the highlighted fields.', fields: errors });
      const hold = db.createHold(b);
      if (!hold) return send(res, 409, { error: 'That time was just taken. Pick another slot.', fields: { time: 'No longer available.' } });
      if (!config.takesDeposit) { // free estimate appointment: the hold becomes a booking request straight away
        const booked = db.markPaid(hold.id, { sessionId: 'free', paymentIntent: 'free' });
        onPaid(booked);
        return send(res, 201, { id: hold.id, url: `/book.html?booking=${hold.id}` });
      }
      if (config.demoPayments) return send(res, 201, { id: hold.id, url: `/api/demo/checkout?booking=${hold.id}` });
      try {
        const session = await stripe.createDepositSession(hold);
        db.update(hold.id, { stripe_session_id: session.id });
        return send(res, 201, { id: hold.id, url: session.url });
      } catch (e) {
        console.error('stripe checkout failed', e.message);
        db.update(hold.id, { status: 'cancelled' });
        return fail(res, 502, "We couldn't start the payment. Try again, or call or text us to book.");
      }
    }

    let mm;
    if (m === 'GET' && (mm = pathname.match(/^\/api\/bookings\/([\w-]{10,40})$/))) {
      let b = db.get(mm[1]);
      if (!b) return fail(res, 404, 'Booking not found.');
      // the success redirect can arrive before the webhook; ask Stripe directly
      const sid = url.searchParams.get('session_id');
      if (b.status === 'pending_payment' || b.status === 'expired') {
        if (!config.demoPayments && sid && sid === b.stripe_session_id) {
          const s = await stripe.getSession(sid).catch(() => null);
          if (s && s.payment_status === 'paid' && s.metadata?.booking_id === b.id) {
            const was = b.status;
            b = db.markPaid(b.id, { sessionId: s.id, paymentIntent: s.payment_intent });
            if (was !== 'paid') onPaid(b);
          }
        }
      }
      return send(res, 200, publicBooking(b));
    }

    if (m === 'POST' && (mm = pathname.match(/^\/api\/bookings\/([\w-]{10,40})\/release$/))) {
      const b = db.get(mm[1]);
      if (b && b.status === 'pending_payment') db.update(b.id, { status: 'cancelled' });
      return send(res, 200, { ok: true });
    }

    if (m === 'GET' && (mm = pathname.match(/^\/api\/track\/([A-Za-z0-9]{6})$/))) {
      // codes are short, so cap guesses per visitor
      if (auth.limited('track:' + ip(req), 40, 10 * 60 * 1000)) return fail(res, 429, 'Too many tries. Wait a few minutes, or call or text us.');
      const b = db.byCode(mm[1]);
      if (!b || !LIVE.includes(b.status)) return fail(res, 404, "We couldn't find that code. Check the text we sent you, or call or text us.");
      if (!imageInfo(b)) await carImage(b).catch(() => null); // first view: fetch the picture once
      return send(res, 200, trackView(b));
    }
    if (m === 'GET' && (mm = pathname.match(/^\/api\/track\/([A-Za-z0-9]{6})\/car$/))) {
      if (auth.limited('trackimg:' + ip(req), 120, 10 * 60 * 1000)) return fail(res, 429, 'Too many requests.');
      const b = db.byCode(mm[1]);
      const img = b && LIVE.includes(b.status) ? await carImage(b).catch(() => null) : null;
      if (!img) return fail(res, 404, 'No picture.');
      res.writeHead(200, { 'Content-Type': img.type, 'Cache-Control': 'private, max-age=86400' });
      return fs.createReadStream(img.file).pipe(res);
    }

    if (m === 'GET' && (mm = pathname.match(/^\/api\/track\/([A-Za-z0-9]{6})\/records\/([\w-]{10,40})$/))) {
      if (auth.limited('trackrec:' + ip(req), 120, 10 * 60 * 1000)) return fail(res, 429, 'Too many requests.');
      const b = db.byCode(mm[1]), r = db.getRecord(mm[2]);
      if (!b || !LIVE.includes(b.status) || !r || r.booking_id !== b.id || !r.sent_at) return fail(res, 404, 'Not found.');
      return sendRecord(res, b, r, 'private, max-age=300');
    }

    if (m === 'POST' && pathname === '/api/stripe/webhook') {
      const raw = await readBody(req, 1e6);
      const evt = stripe.verifyWebhook(raw, req.headers['stripe-signature']);
      if (!evt) return fail(res, 400, 'bad signature');
      const s = evt.data?.object || {};
      const id = s.metadata?.booking_id || s.client_reference_id;
      if (id && evt.type === 'checkout.session.completed' && s.payment_status === 'paid') {
        const before = db.get(id);
        const b = db.markPaid(id, { sessionId: s.id, paymentIntent: s.payment_intent });
        if (b && before && before.status !== 'paid' && b.status === 'paid') onPaid(b);
      }
      if (id && evt.type === 'checkout.session.expired') {
        const b = db.get(id);
        if (b && b.status === 'pending_payment') db.update(id, { status: 'expired' });
      }
      return send(res, 200, { received: true });
    }

    if (config.demoPayments && m === 'GET' && pathname === '/api/demo/checkout') {
      const b = db.get(url.searchParams.get('booking') || '');
      if (!b || b.status !== 'pending_payment') { res.writeHead(302, { Location: '/book.html' }); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': PAGE_CSP });
      return res.end(demoPage(b));
    }
    if (config.demoPayments && m === 'POST' && pathname === '/api/demo/pay') {
      const { id } = await readJSON(req);
      const b = db.get(String(id || ''));
      // only a hold that's still open can be "paid"; a cancelled or expired booking stays that way
      if (!b || b.status !== 'pending_payment') return fail(res, 404, 'Booking not found.');
      const before = b.status;
      const paid = db.markPaid(b.id, { sessionId: 'demo', paymentIntent: 'demo' });
      if (before !== 'paid') onPaid(paid);
      return send(res, 200, { next: `/book.html?booking=${b.id}&session_id=demo` });
    }

    /* admin */
    if (m === 'POST' && pathname === '/api/admin/login') {
      if (!config.adminPassword) return fail(res, 503, 'Set ADMIN_PASSWORD in .env to turn on the dashboard.');
      // 10 tries per 15 minutes per address, then a wait; each wrong guess also pauses a second
      if (auth.limited('login:' + ip(req), 10, 15 * 60 * 1000)) return fail(res, 429, 'Too many sign-in attempts. Wait 15 minutes and try again.');
      const { password } = await readJSON(req);
      if (!auth.checkPassword(typeof password === 'string' ? password : '')) {
        await new Promise((r) => setTimeout(r, 1000));
        return fail(res, 401, 'Wrong password.');
      }
      const secure = config.siteUrl.startsWith('https://');
      return send(res, 200, { ok: true }, { 'Set-Cookie': auth.sessionCookie(secure) });
    }
    if (m === 'POST' && pathname === '/api/admin/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });

    if (pathname.startsWith('/api/admin/')) {
      if (!auth.isAdmin(req)) return fail(res, 401, 'Sign in first.');

      if (m === 'GET' && pathname === '/api/admin/me') {
        return send(res, 200, { ok: true, demo: config.takesDeposit && config.demoPayments, email: !!config.resendKey, sms: config.smsEnabled, stages: db.STAGES.map(({ id, label }) => ({ id, label })), services: SERVICES, slots: db.getSettings().slots, today: db.todayISO() });
      }

      if (m === 'GET' && pathname === '/api/admin/bookings') {
        const scope = ['upcoming', 'past', 'all'].includes(url.searchParams.get('scope')) ? url.searchParams.get('scope') : 'upcoming';
        return send(res, 200, { today: db.todayISO(), bookings: db.list({ scope }).map((b) => ({ ...b, records: db.records(b.id).map((r) => adminRecord(b, r)) })) });
      }

      // a booking the shop takes itself (phone, in person): confirmed with a tracking code right away
      if (m === 'POST' && pathname === '/api/admin/bookings') {
        const { b, errors } = validateManual(await readJSON(req));
        if (Object.keys(errors).length) return send(res, 422, { error: 'Check the highlighted fields.', fields: errors });
        const created = db.createManual(b);
        carImage(created).catch(() => {});
        return send(res, 201, { ...created, records: [], text: notify.texts.booked(created) });
      }

      if (m === 'POST' && (mm = pathname.match(/^\/api\/admin\/bookings\/([\w-]{10,40})\/receipt$/))) {
        const b = db.get(mm[1]);
        if (!b) return fail(res, 404, 'Booking not found.');
        const { data, title, errors } = validateReceipt(await readJSON(req), b);
        if (Object.keys(errors).length) return send(res, 422, { error: Object.values(errors)[0], fields: errors });
        return send(res, 201, adminRecord(b, db.addRecord(b.id, { kind: 'receipt', title, data })));
      }

      if (m === 'POST' && (mm = pathname.match(/^\/api\/admin\/bookings\/([\w-]{10,40})\/files$/))) {
        // a custom header forces a CORS preflight, so other sites can't post files with the shop's cookie
        if (req.headers['x-gs-upload'] !== '1') return fail(res, 400, 'Bad upload.');
        const b = db.get(mm[1]);
        if (!b) return fail(res, 404, 'Booking not found.');
        if (Number(req.headers['content-length'] || 0) > UPLOAD_MAX) return fail(res, 413, 'That file is over 15 MB.');
        const buffer = await readRaw(req, UPLOAD_MAX);
        const type = buffer.length ? sniff(buffer) : null;
        if (!type) return fail(res, 415, 'Upload a photo (JPG, PNG, WebP, HEIC) or a PDF.');
        let name = '';
        try { name = decodeURIComponent(req.headers['x-filename'] || ''); } catch {}
        const title = str(name.replace(/\.[^.]+$/, ''), 80) || (type.ext === 'pdf' ? 'Document' : 'Photo');
        return send(res, 201, adminRecord(b, db.addFile(b.id, { title, ...type, buffer })));
      }

      if (m === 'POST' && (mm = pathname.match(/^\/api\/admin\/bookings\/([\w-]{10,40})\/send$/))) {
        const b = db.get(mm[1]);
        if (!b) return fail(res, 404, 'Booking not found.');
        const { ids } = await readJSON(req);
        const all = db.records(b.id);
        const recs = Array.isArray(ids) && ids.length ? all.filter((r) => ids.includes(r.id)) : all.filter((r) => !r.sent_at);
        if (!recs.length) return fail(res, 400, 'Nothing new to send.');
        // attach files to the email while they fit comfortably under the provider's size cap
        let room = 25 * 1024 * 1024;
        const attachments = [];
        for (const r of recs.filter((x) => x.kind === 'file')) {
          if (r.size > room) continue;
          room -= r.size;
          attachments.push({ filename: `${r.title.replace(/[^\w .-]+/g, '').trim() || 'file'}.${r.file.split('.').pop()}`, content: fs.readFileSync(db.recordPath(r)).toString('base64') });
        }
        const receiptsHtml = recs.filter((r) => r.kind === 'receipt').map((r) => receipt.emailHtml(b, r)).join('');
        const result = await notify.records(b, recs, { receiptsHtml, attachments });
        db.markSent(recs.map((r) => r.id)); // on the tracker from now on, however the customer hears about it
        return send(res, 200, { ...result, text: notify.texts.records(b, recs), sent: recs.length });
      }

      if ((mm = pathname.match(/^\/api\/admin\/records\/([\w-]{10,40})$/))) {
        const r = db.getRecord(mm[1]);
        if (!r) return fail(res, 404, 'Record not found.');
        if (m === 'GET') return sendRecord(res, db.get(r.booking_id), r, 'no-store');
        if (m === 'DELETE') { db.deleteRecord(r.id); return send(res, 200, { ok: true }); }
      }

      if (m === 'POST' && (mm = pathname.match(/^\/api\/admin\/bookings\/([\w-]{10,40})$/))) {
        const b = db.get(mm[1]);
        if (!b) return fail(res, 404, 'Booking not found.');
        const { action, note, stage, notify: textIt } = await readJSON(req);
        const allowed = {
          confirm: ['paid'], decline: ['paid', 'confirmed'], complete: ['paid', 'confirmed'],
          no_show: ['paid', 'confirmed'], reopen: ['completed', 'no_show'], note: null, stage: ['paid', 'confirmed', 'completed'],
          send_code: ['paid', 'confirmed', 'completed'],
        };
        if (!(action in allowed)) return fail(res, 400, 'Unknown action.');
        if (allowed[action] && !allowed[action].includes(b.status)) return fail(res, 409, `Can't ${action.replace('_', '-')} a booking that's ${b.status.replace('_', ' ')}.`);

        if (action === 'note') return send(res, 200, db.update(b.id, { admin_note: text(note, 2000) }));
        if (action === 'send_code') return send(res, 200, { ...(await notify.code(b)), text: notify.texts.booked(b) });
        if (action === 'confirm') {
          const u = db.update(b.id, { status: 'confirmed' });
          notify.confirmed(u);
          return send(res, 200, { ...u, text: notify.texts.confirmed(u) });
        }
        if (action === 'complete') {
          if (b.stage !== 'picked_up') db.setStage(b.id, 'picked_up', '');
          return send(res, 200, db.update(b.id, { status: 'completed' }));
        }
        if (action === 'stage') {
          if (!db.STAGE_IDS.includes(stage)) return fail(res, 400, 'Unknown stage.');
          const msg = text(note, 300);
          let u = db.setStage(b.id, stage, msg);
          if (stage === 'picked_up' && u.status !== 'completed') u = db.update(b.id, { status: 'completed' });
          if (stage !== 'picked_up' && u.status === 'completed') u = db.update(b.id, { status: 'confirmed' });
          const label = stageLabel(stage);
          const sent = textIt ? await notify.stage(u, label, msg) : { sent: false, reason: 'skipped' };
          return send(res, 200, { ...u, sms: sent, text: notify.texts.stage(u, label, msg) });
        }
        if (action === 'no_show') return send(res, 200, db.update(b.id, { status: 'no_show' }));
        if (action === 'reopen') return send(res, 200, db.update(b.id, { status: 'confirmed' }));
        if (action === 'decline') {
          // the shop is turning the job down, so the deposit goes back
          let refunded = b.refunded;
          if (!refunded && b.deposit_cents && b.stripe_payment_intent && !['demo', 'free'].includes(b.stripe_payment_intent) && !config.demoPayments) {
            try { await stripe.refund(b.stripe_payment_intent, b.id); refunded = 1; }
            catch (e) { return fail(res, 502, `Stripe refund failed: ${e.message}. Nothing was changed.`); }
          } else if (b.stripe_payment_intent === 'demo') refunded = 1;
          const u = db.update(b.id, { status: 'declined', refunded });
          notify.declined(u);
          return send(res, 200, u);
        }
      }

      if (m === 'GET' && pathname === '/api/admin/settings') return send(res, 200, db.getSettings());
      if (m === 'PUT' && pathname === '/api/admin/settings') {
        const s = await readJSON(req), patch = {};
        const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
        if ('dailyMax' in s) { if (!int(s.dailyMax, 0, 50)) return fail(res, 422, 'Cars per day must be 0 to 50.'); patch.dailyMax = s.dailyMax; }
        if ('perSlot' in s) { if (!int(s.perSlot, 1, 10)) return fail(res, 422, 'Cars per time slot must be 1 to 10.'); patch.perSlot = s.perSlot; }
        if ('leadDays' in s) { if (!int(s.leadDays, 0, 30)) return fail(res, 422, 'Notice must be 0 to 30 days.'); patch.leadDays = s.leadDays; }
        if ('windowDays' in s) { if (!int(s.windowDays, 7, 180)) return fail(res, 422, 'Booking window must be 7 to 180 days.'); patch.windowDays = s.windowDays; }
        if ('slots' in s) {
          if (!Array.isArray(s.slots) || !s.slots.length || s.slots.length > 24 || !s.slots.every((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t))) return fail(res, 422, 'Times must look like 09:00, 13:30.');
          patch.slots = [...new Set(s.slots)].sort();
        }
        if ('openDays' in s) { if (!Array.isArray(s.openDays) || !s.openDays.every((d) => int(d, 0, 6))) return fail(res, 422, 'Bad open days.'); patch.openDays = [...new Set(s.openDays)].sort(); }
        if ('closedDates' in s) {
          if (!Array.isArray(s.closedDates) || s.closedDates.length > 400 || !s.closedDates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))) return fail(res, 422, 'Bad closed dates.');
          patch.closedDates = [...new Set(s.closedDates)].sort();
        }
        return send(res, 200, db.saveSettings(patch));
      }
    }

    return fail(res, 404, 'Not found.');
  } catch (e) {
    if (e.status) return fail(res, e.status, e.message);
    console.error(e);
    return fail(res, 500, 'Something went wrong. Call or text us to book.');
  }
}

module.exports = { handle };
