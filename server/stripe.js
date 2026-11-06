// Minimal Stripe REST client (no SDK): Checkout Sessions, refunds and webhook signatures.
const crypto = require('crypto');
const config = require('./config');

function form(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.join('&');
}

async function call(method, path, body, idempotencyKey) {
  const headers = { Authorization: `Bearer ${config.stripeKey}`, 'Stripe-Version': '2024-06-20' };
  if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(`https://api.stripe.com/v1${path}`, { method, headers, body: body ? form(body) : undefined });
  const json = await res.json();
  if (!res.ok) {
    const err = new Error(json.error?.message || `Stripe ${res.status}`);
    err.stripe = json.error;
    throw err;
  }
  return json;
}

function createDepositSession(b) {
  const pretty = new Date(`${b.date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  return call('POST', '/checkout/sessions', {
    mode: 'payment',
    client_reference_id: b.id,
    customer_email: b.email,
    metadata: { booking_id: b.id },
    payment_intent_data: { metadata: { booking_id: b.id }, description: `Deposit, ${b.service}, ${pretty}` },
    line_items: {
      0: {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: b.deposit_cents,
          product_data: { name: "Good Shepard Auto Body appointment deposit", description: `${b.service} · drop-off ${pretty} at ${b.time}. Applied to your total.` },
        },
      },
    },
    expires_at: Math.floor(b.hold_expires_at / 1000),
    success_url: `${config.siteUrl}/book.html?booking=${b.id}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.siteUrl}/book.html?booking=${b.id}&cancelled=1`,
  }, `deposit-${b.id}`);
}

const getSession = (id) => call('GET', `/checkout/sessions/${encodeURIComponent(id)}`);
const refund = (paymentIntent, bookingId) => call('POST', '/refunds', { payment_intent: paymentIntent, metadata: { booking_id: bookingId } }, `refund-${bookingId}`);

// https://docs.stripe.com/webhooks#verify-manually
function verifyWebhook(raw, header, toleranceSec = 300) {
  if (!config.stripeWebhookSecret || !header) return null;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')).filter((p) => p.length === 2 && p[0] !== 'v1'));
  const sigs = header.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return null;
  const expected = crypto.createHmac('sha256', config.stripeWebhookSecret).update(`${t}.${raw}`).digest('hex');
  const ok = sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  return ok ? JSON.parse(raw) : null;
}

module.exports = { createDepositSession, getSession, refund, verifyWebhook };
