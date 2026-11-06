// Receipts the shop writes up in the dashboard: the math, a printable page for the tracker, and an email-safe copy.
const config = require('./config');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (cents) => `$${(cents / 100).toFixed(2)}`;
const day = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: config.timeZone });
const METHODS = { cash: 'Cash', card: 'Card', zelle: 'Zelle', venmo: 'Venmo', cashapp: 'Cash App', check: 'Check', other: 'Other' };

// the deposit counts toward the bill only if it was actually taken and not refunded
const depositCents = (b) => (b.paid_at && !b.refunded ? b.deposit_cents : 0);

function totals(b, data) {
  const total = data.items.reduce((a, i) => a + i.cents, 0);
  const deposit = Math.min(depositCents(b), total);
  const paid = data.paidCents;
  return { total, deposit, paid, balance: Math.max(0, total - deposit - paid) };
}

// shared rows, styled inline so they survive email clients
function rows(b, r) {
  const data = JSON.parse(r.data);
  const t = totals(b, data);
  const line = (label, value, strong) => `<tr><td style="padding:6px 0;${strong ? 'font-weight:700;' : ''}">${label}</td><td style="padding:6px 0;text-align:right;${strong ? 'font-weight:700;' : ''}">${value}</td></tr>`;
  const items = data.items.map((i) => line(esc(i.desc), money(i.cents))).join('');
  return `<table style="width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums">
    ${items}
    <tr><td colspan="2" style="border-top:1px solid #ccc;padding:0"></td></tr>
    ${line('Total', money(t.total), true)}
    ${t.deposit ? line('Deposit already paid', `−${money(t.deposit)}`) : ''}
    ${t.paid ? line(`Paid ${day(r.created_at)}${data.method ? ` (${esc(METHODS[data.method] || data.method)})` : ''}`, `−${money(t.paid)}`) : ''}
    ${line(t.balance ? 'Balance due' : 'Paid in full', t.balance ? money(t.balance) : money(0), true)}
  </table>${data.note ? `<p style="margin:14px 0 0">${esc(data.note)}</p>` : ''}`;
}

const emailHtml = (b, r) => `<div style="margin:18px 0;padding:16px;border:1px solid #ddd;max-width:520px">
  <p style="margin:0 0 4px;font-weight:700">${esc(r.title)}</p>
  <p style="margin:0 0 10px;color:#555">${esc(b.vehicle)} · ${esc(b.service)} · code ${esc(b.code)}</p>${rows(b, r)}</div>`;

// standalone page the customer opens from the tracker (and the shop from the dashboard); prints cleanly
const page = (b, r) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(r.title)} · Good Shepard Auto Body</title>
<style>
  body{margin:0;background:#f4f4f6;color:#16161c;font:15px/1.5 system-ui,-apple-system,sans-serif}
  main{width:min(620px,calc(100% - 32px));margin:24px auto;background:#fff;border:1px solid #ddd;padding:28px 26px}
  header{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;border-bottom:3px solid #2463d6;padding-bottom:14px;margin-bottom:18px}
  h1{margin:0;font-size:22px;letter-spacing:.5px;text-transform:uppercase} .shop{margin:2px 0 0;color:#555;font-size:13px}
  .num{text-align:right;font-size:13px;color:#555} .num b{display:block;color:#16161c;font-size:15px}
  dl{display:grid;grid-template-columns:auto 1fr;gap:4px 16px;margin:0 0 18px} dt{color:#666} dd{margin:0}
  button{margin-top:22px;padding:12px 18px;border:0;background:#2463d6;color:#fff;font:600 14px system-ui;cursor:pointer}
  @media print{body{background:#fff}main{border:0;margin:0;width:auto;padding:0}button{display:none}}
</style></head><body><main>
  <header><div><h1>Good Shepard Auto Body Inc.</h1><p class="shop">${esc(config.shopAddress)} · ${esc(config.shopPhoneDisplay)}</p></div>
    <p class="num">${esc(r.title)}<b>${esc(day(r.created_at))}</b>No. ${esc(r.id.slice(0, 8).toUpperCase())}</p></header>
  <dl><dt>Customer</dt><dd>${esc(b.name)}</dd><dt>Vehicle</dt><dd>${esc(b.vehicle)}</dd><dt>Service</dt><dd>${esc(b.service)}</dd><dt>Repair code</dt><dd>${esc(b.code)}</dd></dl>
  ${rows(b, r)}
  <button type="button" onclick="print()">Print or save as PDF</button>
</main></body></html>`;

module.exports = { totals, emailHtml, page, METHODS, depositCents };
