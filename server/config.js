// Settings come from .env (see .env.example). Nothing secret is ever sent to the browser.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = (k, d = '') => (process.env[k] ?? d).trim();

module.exports = {
  root,
  // DATA_DIR points at a persistent disk in hosting (e.g. Render's disk at /data)
  dataDir: env('DATA_DIR') || path.join(root, 'data'),
  port: Number(env('PORT', '5510')),
  siteUrl: env('SITE_URL', 'http://localhost:5510').replace(/\/$/, ''),
  timeZone: 'America/New_York',
  // online estimate bookings are free by default; set DEPOSIT_DOLLARS (e.g. 50) to take a deposit through Stripe
  depositCents: Math.max(0, Math.round(Number(env('DEPOSIT_DOLLARS', '0')) * 100)) || 0,
  holdMinutes: 32, // Stripe Checkout sessions must stay open at least 30 min after creation

  stripeKey: env('STRIPE_SECRET_KEY'),
  stripeWebhookSecret: env('STRIPE_WEBHOOK_SECRET'),
  // without a Stripe key the deposit step is simulated so the flow can be tested end to end
  get demoPayments() { return !this.stripeKey; },
  get takesDeposit() { return this.depositCents > 0; },

  adminPassword: env('ADMIN_PASSWORD'),
  sessionSecret: env('SESSION_SECRET') || crypto.randomBytes(32).toString('hex'),

  // optional: Google reviews on the homepage, through the Places API (New). GOOGLE_PLACE_ID skips the one-time lookup.
  placesKey: env('GOOGLE_PLACES_KEY'),
  // Good Shepard Auto Body Inc.'s Google listing
  placeId: env('GOOGLE_PLACE_ID', 'ChIJez3DBQBB6IkRHQVdJwoE-I8'),

  // optional: studio car renders (transparent PNG) for the repair tracker
  imaginKey: env('IMAGIN_CUSTOMER_KEY'),

  // optional texts through Twilio: the repair code on booking, and status updates
  twilioSid: env('TWILIO_ACCOUNT_SID'),
  twilioToken: env('TWILIO_AUTH_TOKEN'),
  twilioFrom: env('TWILIO_FROM'), // +1631..., or a Messaging Service SID (MG...)
  get smsEnabled() { return !!(this.twilioSid && this.twilioToken && this.twilioFrom); },

  // optional email notifications through Resend (https://resend.com)
  resendKey: env('RESEND_API_KEY'),
  notifyFrom: env('NOTIFY_FROM'),
  notifyTo: env('NOTIFY_TO'),

  shopName: 'Good Shepard Auto Body',
  shopPhone: '+16314764665',
  shopPhoneDisplay: '(631) 476-4665',
  shopAddress: '15 Old Middle Country Rd, Coram, NY 11727',
};
