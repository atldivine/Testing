// Customer and shop notifications. Each channel is optional:
// - texts through Twilio (TWILIO_*), used for the repair code and status updates
// - emails through Resend (RESEND_API_KEY)
// With neither set, the dashboard's "Text" buttons open the shop phone's own Messages app with the same wording.
const config = require('./config');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const prettyDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
const shortDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const prettyTime = (t) => { const [h, m] = t.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const trackUrl = (code) => `${config.siteUrl}/track.html?code=${code}`;
const first = (b) => b.name.split(' ')[0];

/* ---------- message wording (shared by Twilio and the dashboard's sms: links) ---------- */
const texts = {
  booked: (b) => `Good Shepard Auto Body: you're booked for ${shortDate(b.date)} at ${prettyTime(b.time)}. Your repair code is ${b.code}. Follow your car's progress here: ${trackUrl(b.code)}`,
  confirmed: (b) => `Hi ${first(b)}, this is Good Shepard Auto Body. You're confirmed for ${shortDate(b.date)} at ${prettyTime(b.time)} (${b.service}). Your repair code is ${b.code}, and you can follow the car here: ${trackUrl(b.code)}`,
  stage: (b, label, note) => `Good Shepard Auto Body update on your ${b.vehicle}: ${label}.${note ? ` ${note}` : ''} Details: ${trackUrl(b.code)}`,
  // receipts and files the shop sends from the dashboard
  records: (b, recs) => `Good Shepard Auto Body: ${recs.length === 1 ? (recs[0].kind === 'receipt' ? 'your receipt' : 'a new file') : `${recs.length} new documents`} for your ${b.vehicle}${recs.length > 1 ? ` (${recs.map((r) => r.title).join(', ')})` : `: ${recs[0].title}`}. View or download: ${trackUrl(b.code)}`,
};

/* ---------- Twilio ---------- */
function e164(phone) {
  const d = String(phone).replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return String(phone).trim().startsWith('+') ? `+${d}` : null;
}
async function sms(phone, body) {
  if (!config.smsEnabled) return { sent: false, reason: 'off' };
  const to = e164(phone);
  if (!to) return { sent: false, reason: 'bad number' };
  const form = new URLSearchParams({ To: to, Body: body });
  form.set(config.twilioFrom.startsWith('MG') ? 'MessagingServiceSid' : 'From', config.twilioFrom);
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.twilioSid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${config.twilioSid}:${config.twilioToken}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    if (!res.ok) { const t = await res.text(); console.error('sms failed', res.status, t); return { sent: false, reason: `Twilio ${res.status}` }; }
    return { sent: true };
  } catch (e) {
    console.error('sms failed', e.message);
    return { sent: false, reason: e.message };
  }
}

/* ---------- Resend ---------- */
// attachments: [{ filename, content (base64) }]. Resolves to { sent, reason } so the dashboard can say what happened.
async function email(to, subject, html, attachments) {
  if (!config.resendKey || !config.notifyFrom) return { sent: false, reason: 'off' };
  if (!to) return { sent: false, reason: 'no email on file' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: config.notifyFrom, to, subject, html, ...(attachments?.length ? { attachments } : {}) }),
    });
    if (!res.ok) { console.error('email failed', res.status, await res.text()); return { sent: false, reason: `Resend ${res.status}` }; }
    return { sent: true };
  } catch (e) {
    console.error('email failed', e.message);
    return { sent: false, reason: e.message };
  }
}

const summary = (b) => `
  <p><b>${esc(b.service)}</b><br>${esc(b.vehicle)}<br>Drop-off ${esc(prettyDate(b.date))} at ${esc(prettyTime(b.time))}</p>
  ${b.details ? `<p>${esc(b.details)}</p>` : ''}`;
const codeBlock = (b) => `<p>Your repair code is <b style="font-size:20px;letter-spacing:3px">${esc(b.code)}</b>. <a href="${trackUrl(b.code)}">Follow your car's progress</a> any time.</p>`;

module.exports = {
  prettyDate, prettyTime, shortDate, texts, trackUrl, sms,
  // new booking (deposit received, or a free estimate request): the shop hears about it, the customer gets their code
  newBooking: async (b) => {
    email(config.notifyTo, `New booking: ${b.name}, ${prettyDate(b.date)} ${prettyTime(b.time)}`,
      `<p>${esc(b.name)} ${b.deposit_cents ? `paid the $${b.deposit_cents / 100} deposit` : 'booked an appointment online'}. Repair code ${esc(b.code)}.</p>${summary(b)}<p>${esc(b.phone)} · ${esc(b.email)}</p><p><a href="${config.siteUrl}/admin.html">Open the dashboard</a> to confirm.</p>`);
    email(b.email, "Your Good Shepard Auto Body appointment request", `<p>Hi ${esc(first(b))}, ${b.deposit_cents ? `your $${b.deposit_cents / 100} deposit went through` : 'we got your appointment request'}.</p>${summary(b)}${codeBlock(b)}<p>We will call or text you to confirm. Questions? Call or text ${config.shopPhoneDisplay}.</p>`);
    return sms(b.phone, texts.booked(b));
  },
  confirmed: (b) => email(b.email, "Your Good Shepard Auto Body appointment is confirmed",
    `<p>Hi ${esc(first(b))}, you're confirmed.</p>${summary(b)}${codeBlock(b)}${b.deposit_cents ? `<p>The $${b.deposit_cents / 100} deposit goes toward your total.</p>` : ''}<p>Questions? Call or text ${config.shopPhoneDisplay}.</p>`),
  declined: (b) => email(b.email, "About your Good Shepard Auto Body booking",
    `<p>Hi ${esc(first(b))}, we can't take your car on ${esc(prettyDate(b.date))}.${b.refunded ? ' Your deposit has been refunded.' : ''}</p><p>Call or text ${config.shopPhoneDisplay} and we'll find another day.</p>`),
  stage: (b, label, note) => sms(b.phone, texts.stage(b, label, note)),
  // the tracking code, for bookings the shop made itself or a customer who lost the text
  code: async (b) => {
    const mail = await email(b.email, `Your Good Shepard Auto Body repair code: ${b.code}`, `<p>Hi ${esc(first(b))},</p>${summary(b)}${codeBlock(b)}<p>Questions? Call or text ${config.shopPhoneDisplay}.</p>`);
    return { email: mail, sms: await sms(b.phone, texts.booked(b)) };
  },
  // receipts (as HTML in the body) and files (attached) in one email, plus a text with the tracker link
  records: async (b, recs, { receiptsHtml = '', attachments = [] } = {}) => {
    const list = recs.map((r) => `<li>${esc(r.title)}</li>`).join('');
    const mail = await email(b.email, `Your documents from Good Shepard Auto Body: ${b.vehicle}`,
      `<p>Hi ${esc(first(b))}, here are the documents for your ${esc(b.vehicle)}:</p><ul>${list}</ul>${receiptsHtml}
      <p>You can also view and download them any time on your <a href="${trackUrl(b.code)}">repair page</a> (code ${esc(b.code)}).</p>
      <p>Questions? Call or text ${config.shopPhoneDisplay}.</p>`, attachments);
    return { email: mail, sms: await sms(b.phone, texts.records(b, recs)) };
  },
};
