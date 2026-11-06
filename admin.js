/* The shop's booking dashboard: review bookings, add its own, send codes, receipts and records, and set the schedule. */
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDay = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const fmtTime = (t) => { const [h, m] = t.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
  const digits = (p) => p.replace(/[^\d+]/g, '');
  const fmtPhone = (p) => {
    const d = String(p).replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p;
  };
  const money = (cents) => `$${(cents / 100).toFixed(2)}`;
  const dollars = (v) => { const n = Number(String(v).replace(/[^\d.]/g, '')); return Number.isFinite(n) ? n : 0; };
  const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const shortDay = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const PAY = { cash: 'cash', card: 'card', zelle: 'Zelle', venmo: 'Venmo', cashapp: 'Cash App', check: 'check', other: 'other' };
  const RECEIPT_METHODS = [['cash', 'Cash'], ['card', 'Card'], ['zelle', 'Zelle'], ['venmo', 'Venmo'], ['cashapp', 'Cash App'], ['check', 'Check'], ['other', 'Other']];
  const STATUS = {
    paid: ['Needs your OK', 'new'], confirmed: ['Confirmed', 'ok'], completed: ['Done', 'muted'],
    no_show: ['No-show', 'warn'], declined: ['Declined', 'muted'], pending_payment: ['Awaiting payment', 'muted'],
    expired: ['Expired', 'muted'], cancelled: ['Cancelled', 'muted'],
  };

  const api = async (url, opts = {}) => {
    const res = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json' } });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 && !url.endsWith('/login')) { showLogin(); throw new Error('Signed out'); }
    if (!res.ok) throw new Error(body.error || 'Something went wrong.');
    return body;
  };

  /* ---------- sign in ---------- */
  function showLogin() { $('#app').hidden = true; $('#login').hidden = false; $('#login-form').password.focus(); }
  let signingIn = false;
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (signingIn) return;
    const form = e.target, btn = form.querySelector('[type="submit"]');
    if (!form.password.value) { $('#login-err').textContent = 'Enter the password.'; form.password.focus(); return; }
    signingIn = true;
    btn.disabled = true; btn.textContent = 'Signing in…';
    $('#login-err').textContent = '';
    try {
      await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: form.password.value }) });
      form.reset();
      start();
    } catch (err) {
      $('#login-err').textContent = err.message;
      form.password.select();
    } finally {
      signingIn = false;
      btn.disabled = false; btn.textContent = 'Sign in';
    }
  });
  // Enter in the password field always signs in (some password managers swallow the implicit submit)
  $('#login-form').password.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); $('#login-form').requestSubmit(); }
  });
  $('#logout').addEventListener('click', async () => { await api('/api/admin/logout', { method: 'POST', body: '{}' }).catch(() => {}); showLogin(); });

  /* ---------- tabs ---------- */
  let tab = 'upcoming';
  let caps = { sms: false, stages: [] };
  document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
    tab = b.dataset.tab;
    document.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    $('#list').hidden = tab === 'settings';
    $('#settings').hidden = tab !== 'settings';
    $('#filter').hidden = true;
    $('#newb').hidden = true; $('#newb-done').hidden = true;
    if (tab === 'settings') loadSettings(); else loadList();
  }));

  /* ---------- bookings ---------- */
  const textBody = (b, kind) => {
    const first = b.name.split(' ')[0];
    return `Hi ${first}, this is Good Shepard Auto Body about your ${fmtDay(b.date)} appointment.`;
  };
  const smsTo = (phone, body) => `sms:${digits(phone)}?&body=${encodeURIComponent(body)}`;
  const smsHref = (b, kind) => smsTo(b.phone, textBody(b, kind));

  function actions(b) {
    const a = [];
    const decline = b.source === 'manual' || !b.deposit_cents ? 'Decline' : 'Decline &amp; refund';
    if (b.status === 'paid') a.push(`<button class="btn" data-act="confirm">Confirm &amp; text</button>`, `<button class="btn btn--ghost" data-act="decline">${decline}</button>`);
    if (b.status === 'confirmed') a.push(`<button class="btn btn--light" data-act="complete">Mark done</button>`, `<button class="btn btn--ghost" data-act="no_show">No-show</button>`, `<button class="btn btn--ghost" data-act="decline">${decline}</button>`);
    if (b.status === 'completed' || b.status === 'no_show') a.push(`<button class="btn btn--ghost" data-act="reopen">Undo</button>`);
    return a.join('');
  }

  // where the car is in the shop; what the customer sees on track.html
  function repair(b) {
    if (!['paid', 'confirmed', 'completed'].includes(b.status) || !b.code) return '';
    const chips = caps.stages.map((s) => `<label class="chip chip--stage"><input type="radio" name="stage-${esc(b.id)}" value="${s.id}"${s.id === b.stage ? ' checked' : ''}><span>${esc(s.label)}</span></label>`).join('');
    const now = caps.stages.find((s) => s.id === b.stage);
    return `<details class="rp" data-fold="rp"${open.has('rp:' + b.id) ? ' open' : ''}>
      <summary class="rp__sum"><span class="rp__sumlabel"><span class="rp__long">Repair </span>status</span><b>${esc(now ? now.label : 'Not set')}</b><span class="rp__sumcode">${esc(b.code)}</span></summary>
      <div class="rp__body">
      <div class="rp__head">
        <img class="rp__car" src="/api/track/${esc(b.code)}/car" alt="" width="96" height="64" loading="lazy">
        <div><p class="rp__code">Repair code <b>${esc(b.code)}</b></p><a class="rp__view" href="track.html?code=${esc(b.code)}" target="_blank" rel="noopener">See the customer's view</a></div>
        <button class="btn btn--ghost rp__send" type="button" data-act="send_code">Send code</button>
      </div>
      <fieldset class="rp__stages"><legend class="fld__label">Repair status</legend><div class="chips">${chips}</div></fieldset>
      <label class="rp__note"><span class="fld__label">Note the customer sees <i>Optional</i></span>
        <textarea rows="2" maxlength="300" placeholder="Like: Waiting on a CSF radiator, it should arrive Thursday.">${esc(b.stage_note)}</textarea></label>
      <label class="check rp__notify"><input type="checkbox" checked><span>${caps.sms ? 'Text the customer about this update' : 'Open a text to the customer after saving'}</span></label>
      <button class="btn" type="button" data-act="stage">Update status</button>
      </div>
    </details>`;
  }

  // receipts and files for this car; nothing reaches the customer until the shop hits Send
  const receiptLine = (desc = '', amount = '') => `<div class="rcpt__line">
      <input class="rcpt__desc" aria-label="Line description" placeholder="Front pads and rotors" maxlength="80" value="${esc(desc)}">
      <input class="rcpt__amt" aria-label="Price" inputmode="decimal" placeholder="0.00" value="${esc(amount)}">
      <button class="rcpt__rm" type="button" data-act="rcpt-rm" aria-label="Remove line">×</button>
    </div>`;
  function records(b) {
    if (!['paid', 'confirmed', 'completed'].includes(b.status)) return '';
    const recs = b.records || [];
    const unsent = recs.filter((r) => !r.sentAt).length;
    const rows = recs.map((r) => {
      const isImg = r.kind === 'file' && /^image\/(jpeg|png|webp)$/.test(r.mime);
      const icon = isImg ? `<img src="${esc(r.url)}" alt="" width="44" height="44" loading="lazy">` : `<svg aria-hidden="true"><use href="#i-${r.kind === 'receipt' ? 'receipt' : 'doc'}"/></svg>`;
      const what = r.kind === 'receipt'
        ? `Receipt · ${money(r.totals.total)}${r.totals.balance ? ` · ${money(r.totals.balance)} due` : ' · paid in full'}`
        : `${r.mime === 'application/pdf' ? 'PDF' : 'Photo'} · ${fmtSize(r.size)}`;
      return `<li class="rec__item" data-rec="${esc(r.id)}">
        <a class="rec__open" href="${esc(r.url)}" target="_blank" rel="noopener"><span class="rec__icon">${icon}</span><span><b>${esc(r.title)}</b>${what}</span></a>
        <span class="rec__state${r.sentAt ? ' is-sent' : ''}">${r.sentAt ? `Sent ${shortDay(r.sentAt)}` : 'Not sent'}</span>
        <button class="rec__rm" type="button" data-act="rec-rm" aria-label="Delete ${esc(r.title)}">Delete</button>
      </li>`;
    }).join('');
    const methods = RECEIPT_METHODS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    const deposit = b.paid_at && !b.refunded ? b.deposit_cents : 0;
    return `<details class="rp rec" data-fold="rec"${open.has('rec:' + b.id) ? ' open' : ''}>
      <summary class="rp__sum"><span class="rp__sumlabel">Receipts<span class="rp__long"> &amp; records</span></span><b>${recs.length ? `${recs.length} saved` : 'None yet'}</b>${unsent ? `<span class="rec__badge">${unsent} not sent</span>` : ''}</summary>
      <div class="rp__body">
        ${rows ? `<ul class="rec__list">${rows}</ul>` : '<p class="rec__empty">Write a receipt, or add invoice photos, inspection reports or before and after shots. They stay private until you send them.</p>'}
        <div class="rec__add">
          <button class="btn btn--ghost" type="button" data-act="rcpt-open">Write a receipt</button>
          <label class="btn btn--ghost rec__upload">Add photos or PDFs<input type="file" accept="image/*,application/pdf" multiple data-upload></label>
        </div>
        <div class="rcpt" hidden data-deposit="${deposit}">
          <p class="fld__label">Receipt</p>
          <div class="rcpt__lines">${receiptLine()}</div>
          <button class="adm__link rcpt__more" type="button" data-act="rcpt-line">+ Add a line</button>
          <dl class="rcpt__sum">
            <div><dt>Total</dt><dd data-r="total">$0.00</dd></div>
            ${deposit ? `<div><dt>Deposit already paid</dt><dd>−${money(deposit)}</dd></div>` : ''}
            <div class="rcpt__paidrow"><dt><label for="paid-${esc(b.id)}">Paid today</label></dt><dd><input id="paid-${esc(b.id)}" class="rcpt__paid" inputmode="decimal" placeholder="0.00"><select class="rcpt__method" aria-label="Paid by">${methods}</select></dd></div>
            <div class="rcpt__bal"><dt>Balance due</dt><dd data-r="balance">$0.00</dd></div>
          </dl>
          <label class="rp__note"><span class="fld__label">Note on the receipt <i>Optional</i></span><textarea class="rcpt__note" rows="2" maxlength="400" placeholder="Like: 12-month warranty on parts and labor."></textarea></label>
          <div class="rcpt__btns"><button class="btn" type="button" data-act="rcpt-save">Save receipt</button><button class="adm__link" type="button" data-act="rcpt-cancel">Cancel</button></div>
        </div>
        <p class="rec__status" role="status"></p>
        <button class="btn rec__send" type="button" data-act="send"${unsent ? '' : ' disabled'}>${unsent ? `Send to customer (${unsent})` : recs.length ? 'Everything is sent' : 'Send to customer'}</button>
        <p class="rec__how">${sendHow(b)}</p>
      </div>
    </details>`;
  }
  // how "Send" reaches the customer with what's connected today
  const sendHow = (b) => {
    const ways = [];
    if (caps.email && b.email) ways.push('emailed with the files attached');
    if (caps.sms) ways.push('texted a link');
    return ways.length
      ? `They're ${ways.join(' and ')}, and they show on the customer's repair page.`
      : "They show on the customer's repair page, and Messages opens with a link ready to text.";
  };
  const depositLine = (b) => {
    if (b.source === 'manual') {
      if (b.pay_method === 'none') return 'No deposit taken';
      if (b.pay_method === 'waived') return 'Deposit waived';
      return `Deposit $${(b.deposit_cents / 100).toFixed(0)} paid in person (${PAY[b.pay_method] || b.pay_method})`;
    }
    if (!b.deposit_cents) return `Free estimate, booked online ${b.paid_at ? new Date(b.paid_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}`;
    return `Deposit $${(b.deposit_cents / 100).toFixed(0)} ${b.paid_at ? 'paid ' + new Date(b.paid_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'not paid'}`;
  };

  function card(b) {
    const [label, tone] = STATUS[b.status] || [b.status, 'muted'];
    return `<article class="bk bk--${tone}" data-id="${esc(b.id)}">
      <div class="bk__time">${fmtTime(b.time)}</div>
      <div class="bk__main">
        <div class="bk__top"><h3>${esc(b.name)}</h3><span class="pill pill--${tone}">${label}</span>${b.source === 'manual' ? '<span class="pill pill--muted">Booked by you</span>' : ''}${b.refunded ? '<span class="pill pill--muted">Refunded</span>' : ''}</div>
        <p class="bk__what"><b>${esc(b.service)}</b> · ${esc(b.vehicle)}</p>
        ${b.details ? `<p class="bk__details">${esc(b.details)}</p>` : ''}
        <p class="bk__contact">
          <a href="tel:${esc(digits(b.phone))}" aria-label="Call ${esc(fmtPhone(b.phone))}"><svg aria-hidden="true"><use href="#i-phone"/></svg><span class="bk__lbl">Call</span><span class="bk__val">${esc(fmtPhone(b.phone))}</span></a>
          <a href="${esc(smsHref(b, 'hi'))}"><svg aria-hidden="true"><use href="#i-msg"/></svg><span>Text</span></a>
          ${b.email ? `<a href="mailto:${esc(b.email)}" aria-label="Email ${esc(b.email)}"><svg aria-hidden="true"><use href="#i-mail"/></svg><span class="bk__lbl">Email</span><span class="bk__val">${esc(b.email)}</span></a>` : ''}
        </p>
        <div class="bk__actions">${actions(b)}</div>
        ${repair(b)}
        ${records(b)}
        <details class="bk__note" data-fold="note"${b.admin_note || open.has('note:' + b.id) ? ' open' : ''}>
          <summary>Notes</summary>
          <textarea rows="2" maxlength="2000" placeholder="Private notes for this job">${esc(b.admin_note)}</textarea>
          <button class="adm__link" type="button" data-act="note">Save note</button>
        </details>
        <p class="bk__meta">${depositLine(b)}</p>
      </div>
    </article>`;
  }

  let bookings = [];
  let today = '';
  let filter = 'all';
  // which folded panels are open, so the minute refresh doesn't snap them shut
  const open = new Set();
  $('#list').addEventListener('toggle', (e) => {
    const d = e.target, el = d.closest?.('.bk');
    if (!d.dataset?.fold || !el) return;
    const key = d.dataset.fold + ':' + el.dataset.id;
    if (d.open) open.add(key); else open.delete(key);
  }, true);

  const FILTERS = [['all', 'All'], ['paid', 'Needs your OK'], ['confirmed', 'Confirmed']];
  function renderFilter() {
    const f = $('#filter');
    f.hidden = tab !== 'upcoming' || !bookings.length;
    if (f.hidden) return;
    const count = (k) => (k === 'all' ? bookings.length : bookings.filter((b) => b.status === k).length);
    f.innerHTML = FILTERS.map(([k, label]) => `<button type="button" data-filter="${k}" aria-pressed="${k === filter}">${label}<span>${count(k)}</span></button>`).join('');
  }
  function renderList() {
    const list = $('#list');
    renderFilter();
    if (!bookings.length) { list.innerHTML = `<p class="adm__empty">${tab === 'upcoming' ? 'No upcoming bookings yet.' : 'Nothing here yet.'}</p>`; return; }
    const shown = tab === 'upcoming' && filter !== 'all' ? bookings.filter((b) => b.status === filter) : bookings;
    if (!shown.length) { list.innerHTML = `<p class="adm__empty">${filter === 'paid' ? 'Nothing waiting for your OK.' : 'No confirmed bookings yet.'}</p>`; return; }
    const byDay = new Map();
    for (const b of shown) (byDay.get(b.date) || byDay.set(b.date, []).get(b.date)).push(b);
    list.innerHTML = [...byDay].map(([d, items]) => `
      <section class="day"><h2 class="day__title">${d === today ? 'Today · ' : ''}${fmtDay(d)}<span>${items.length} car${items.length > 1 ? 's' : ''}</span></h2>
      ${items.map(card).join('')}</section>`).join('');
  }
  $('#filter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    filter = b.dataset.filter;
    renderList();
  });

  async function loadList() {
    const list = $('#list');
    if (!caps.stages.length) await api('/api/admin/me').then((me) => (caps = me)).catch(() => {});
    try {
      const r = await api(`/api/admin/bookings?scope=${tab}`);
      bookings = r.bookings;
      today = r.today;
      const fresh = bookings.filter((b) => b.status === 'paid').length;
      $('#sub').textContent = tab === 'upcoming'
        ? (fresh ? `${fresh} new booking${fresh > 1 ? 's' : ''} waiting for your OK` : 'All caught up')
        : 'Last 200 jobs';
      document.title = `${fresh ? `(${fresh}) ` : ''}Bookings · Good Shepard Auto Body`;
      renderList();
    } catch (e) {
      if (e.message !== 'Signed out') list.innerHTML = `<p class="book__err">${esc(e.message)}</p>`;
    }
  }

  // destructive actions need a second tap instead of a popup
  const armed = new WeakMap();
  $('#list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const el = btn.closest('.bk'), id = el.dataset.id, act = btn.dataset.act;
    const b = bookings.find((x) => x.id === id);
    if ((act === 'decline' || act === 'no_show' || act === 'rec-rm') && !armed.get(btn)) {
      armed.set(btn, true);
      const old = btn.innerHTML;
      btn.innerHTML = act === 'rec-rm' ? 'Tap again' : act === 'decline' ? (b?.source === 'manual' ? 'Tap again to decline' : 'Tap again to decline &amp; refund') : 'Tap again: no-show';
      btn.classList.add('is-armed');
      setTimeout(() => { armed.delete(btn); btn.innerHTML = old; btn.classList.remove('is-armed'); }, 4000);
      return;
    }
    if (act.startsWith('rcpt-') || act === 'rec-rm' || act === 'send') return recordAction(act, btn, el, b);
    const body = { action: act };
    if (act === 'note') body.note = el.querySelector('.bk__note textarea').value;
    if (act === 'stage') {
      const pick = el.querySelector('.rp__stages input:checked');
      if (!pick) return alertIn(el, 'Pick a status first.');
      body.stage = pick.value;
      body.note = el.querySelector('.rp__note textarea').value;
      body.notify = el.querySelector('.rp__notify input').checked;
    }
    btn.disabled = true;
    try {
      const r = await api(`/api/admin/bookings/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify(body) });
      if (act === 'confirm' && b) location.href = smsTo(b.phone, r.text); // opens Messages with the confirmation filled in
      if (act === 'stage') {
        if (body.notify && !r.sms?.sent) {
          if (caps.sms) alertIn(el, `Saved, but the text didn't send (${r.sms?.reason || 'unknown error'}).`);
          else location.href = smsTo(b.phone, r.text); // no Twilio: hand the update to Messages
        }
      }
      if (act === 'note') { btn.textContent = 'Saved'; setTimeout(() => (btn.textContent = 'Save note'), 1500); btn.disabled = false; return; }
      if (act === 'send_code') {
        btn.disabled = false;
        if (r.sms?.sent || r.email?.sent) { btn.textContent = r.sms?.sent ? 'Code texted' : 'Code emailed'; setTimeout(() => (btn.textContent = 'Send code'), 2500); }
        else location.href = smsTo(b.phone, r.text); // nothing connected: Messages opens with the code written out
        return;
      }
      loadList();
    } catch (err) {
      btn.disabled = false;
      alertIn(el, err.message);
    }
  });
  $('#list').addEventListener('error', (e) => { if (e.target.classList?.contains('rp__car')) e.target.hidden = true; }, true);
  const alertIn = (el, msg) => {
    let p = el.querySelector('.bk__err');
    if (!p) { p = document.createElement('p'); p.className = 'book__err bk__err'; p.setAttribute('role', 'alert'); el.querySelector('.bk__main').append(p); }
    p.textContent = msg;
  };

  /* ---------- receipts and records ---------- */
  const status = (el, msg) => { const p = el.querySelector('.rec__status'); if (p) p.textContent = msg; };
  const rcptTotals = (box) => {
    const items = [...box.querySelectorAll('.rcpt__line')].map((l) => ({ desc: l.querySelector('.rcpt__desc').value.trim(), amount: dollars(l.querySelector('.rcpt__amt').value) }));
    const total = Math.round(items.reduce((a, i) => a + i.amount, 0) * 100);
    const deposit = Math.min(Number(box.dataset.deposit) || 0, total);
    const paidEl = box.querySelector('.rcpt__paid');
    if (!paidEl.dataset.touched) paidEl.value = total - deposit > 0 ? ((total - deposit) / 100).toFixed(2) : '';
    const paid = Math.round(dollars(paidEl.value) * 100);
    box.querySelector('[data-r="total"]').textContent = money(total);
    box.querySelector('[data-r="balance"]').textContent = money(Math.max(0, total - deposit - paid));
    return { items, paid: paid / 100 };
  };
  $('#list').addEventListener('input', (e) => {
    const box = e.target.closest('.rcpt');
    if (!box) return;
    if (e.target.classList.contains('rcpt__paid')) e.target.dataset.touched = '1';
    rcptTotals(box);
  });

  async function recordAction(act, btn, el, b) {
    const box = el.querySelector('.rcpt');
    if (act === 'rcpt-open') { box.hidden = false; box.querySelector('.rcpt__desc').focus(); return; }
    if (act === 'rcpt-cancel') { box.hidden = true; return; }
    if (act === 'rcpt-line') { box.querySelector('.rcpt__lines').insertAdjacentHTML('beforeend', receiptLine()); box.querySelector('.rcpt__line:last-child .rcpt__desc').focus(); return; }
    if (act === 'rcpt-rm') { const lines = box.querySelectorAll('.rcpt__line'); if (lines.length > 1) btn.closest('.rcpt__line').remove(); else lines[0].querySelectorAll('input').forEach((i) => (i.value = '')); rcptTotals(box); return; }
    btn.disabled = true;
    try {
      if (act === 'rcpt-save') {
        const { items, paid } = rcptTotals(box);
        await api(`/api/admin/bookings/${encodeURIComponent(b.id)}/receipt`, { method: 'POST', body: JSON.stringify({ items, paid, method: box.querySelector('.rcpt__method').value, note: box.querySelector('.rcpt__note').value }) });
        open.add('rec:' + b.id);
        return loadList();
      }
      if (act === 'rec-rm') {
        await api(`/api/admin/records/${encodeURIComponent(btn.closest('[data-rec]').dataset.rec)}`, { method: 'DELETE' });
        open.add('rec:' + b.id);
        return loadList();
      }
      if (act === 'send') {
        status(el, 'Sending…');
        const r = await api(`/api/admin/bookings/${encodeURIComponent(b.id)}/send`, { method: 'POST', body: '{}' });
        const done = [r.email?.sent && 'emailed', r.sms?.sent && 'texted'].filter(Boolean);
        open.add('rec:' + b.id);
        await loadList();
        const card = document.querySelector(`.bk[data-id="${CSS.escape(b.id)}"]`);
        if (done.length) status(card, `${r.sent === 1 ? 'It was' : `${r.sent} records were`} ${done.join(' and ')} to ${b.name.split(' ')[0]}, and ${r.sent === 1 ? "it's" : "they're"} on the repair page.`);
        else {
          status(card, 'Added to the repair page. Send the text that just opened in Messages.');
          location.href = smsTo(b.phone, r.text); // nothing connected: hand the link to Messages
        }
      }
    } catch (err) {
      btn.disabled = false;
      status(el, err.message);
    }
  }

  // uploads go one at a time, straight from the file picker
  $('#list').addEventListener('change', async (e) => {
    const input = e.target.closest('[data-upload]');
    if (!input || !input.files.length) return;
    const el = input.closest('.bk'), id = el.dataset.id, files = [...input.files];
    let ok = 0;
    for (const [i, f] of files.entries()) {
      if (f.size > 15 * 1024 * 1024) { status(el, `${f.name} is over 15 MB. Skipped.`); continue; }
      status(el, files.length > 1 ? `Uploading ${i + 1} of ${files.length}…` : 'Uploading…');
      try {
        const res = await fetch(`/api/admin/bookings/${encodeURIComponent(id)}/files`, { method: 'POST', body: f, headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(f.name), 'X-GS-Upload': '1' } });
        if (res.status === 401) return showLogin();
        if (!res.ok) { const j = await res.json().catch(() => ({})); status(el, `${f.name}: ${j.error || 'upload failed'}`); continue; }
        ok++;
      } catch { status(el, `${f.name}: upload failed. Check the connection and try again.`); }
    }
    input.value = '';
    open.add('rec:' + id);
    if (ok) { await loadList(); status(document.querySelector(`.bk[data-id="${CSS.escape(id)}"]`), `${ok} file${ok > 1 ? 's' : ''} added. Hit Send when you're ready.`); }
  });

  /* ---------- new booking (phone or walk-up) ---------- */
  const newb = $('#newb'), done = $('#newb-done');
  const showNew = () => {
    document.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-selected', 'false'));
    $('#list').hidden = true; $('#settings').hidden = true; $('#filter').hidden = true; done.hidden = true;
    newb.reset();
    newb.querySelectorAll('[data-err]').forEach((x) => (x.textContent = ''));
    $('#newb-err').textContent = '';
    newb.service.innerHTML = (caps.services || []).map((sv) => `<option>${esc(sv)}</option>`).join('');
    newb.date.value = caps.today || '';
    newb.time.value = (caps.slots || ['09:00'])[0];
    $('#newb-send-label').textContent = caps.sms ? 'Text the customer their tracking code' : 'Open a text with the tracking code after saving';
    newb.hidden = false;
    newb.name.focus();
  };
  const closeNew = () => { newb.hidden = true; done.hidden = true; document.querySelector('[data-tab="upcoming"]').click(); };
  $('#new-open').addEventListener('click', showNew);
  newb.querySelector('[data-newb-close]').addEventListener('click', closeNew);
  newb.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = newb, btn = f.querySelector('[type="submit"]');
    f.querySelectorAll('[data-err]').forEach((x) => (x.textContent = ''));
    $('#newb-err').textContent = '';
    const body = Object.fromEntries(['name', 'phone', 'email', 'service', 'year', 'make', 'model', 'date', 'time', 'details'].map((k) => [k, f[k].value]));
    body.payMethod = f.querySelector('[name="payMethod"]:checked')?.value || '';
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const res = await fetch('/api/admin/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const r = await res.json().catch(() => ({}));
      if (res.status === 401) return showLogin();
      if (!res.ok) {
        for (const [k, v] of Object.entries(r.fields || {})) { const p = f.querySelector(`[data-err="${k}"]`); if (p) p.textContent = v; }
        $('#newb-err').textContent = r.error || 'Something went wrong.';
        const first = Object.keys(r.fields || {})[0];
        if (first && f[first]?.focus) f[first].focus();
        return;
      }
      newb.hidden = true;
      done.innerHTML = `<div class="adm__donecard">
        <h2 class="adm__h2">Booked: ${esc(r.name)}</h2>
        <p>${esc(r.service)} · ${esc(r.vehicle)}<br>${esc(fmtDay(r.date))} at ${esc(fmtTime(r.time))}</p>
        <p class="adm__donecode">Tracking code <b>${esc(r.code)}</b></p>
        <p class="rec__status" role="status"></p>
        <div class="btn-row">
          <button class="btn" type="button" data-done="code">Send the code</button>
          <button class="btn btn--ghost" type="button" data-done="records">Add a receipt or files</button>
          <button class="adm__link" type="button" data-done="again">Book another</button>
        </div></div>`;
      done.hidden = false;
      done.dataset.id = r.id;
      done.dataset.phone = r.phone;
      done.dataset.text = r.text;
      if (f.sendCode.checked) sendNewCode();
    } catch { $('#newb-err').textContent = 'Could not save. Check the connection and try again.'; }
    finally { btn.disabled = false; btn.textContent = 'Save booking'; }
  });
  async function sendNewCode() {
    const msg = done.querySelector('.rec__status');
    try {
      const r = await api(`/api/admin/bookings/${encodeURIComponent(done.dataset.id)}`, { method: 'POST', body: JSON.stringify({ action: 'send_code' }) });
      if (r.sms?.sent || r.email?.sent) msg.textContent = `Code ${[r.sms?.sent && 'texted', r.email?.sent && 'emailed'].filter(Boolean).join(' and ')} to the customer.`;
      else { msg.textContent = 'Send the text that just opened in Messages.'; location.href = smsTo(done.dataset.phone, r.text); }
    } catch (err) { msg.textContent = err.message; }
  }
  done.addEventListener('click', (e) => {
    const k = e.target.closest('[data-done]')?.dataset.done;
    if (k === 'code') sendNewCode();
    if (k === 'again') showNew();
    if (k === 'records') {
      open.add('rec:' + done.dataset.id);
      closeNew();
      setTimeout(() => document.querySelector(`.bk[data-id="${CSS.escape(done.dataset.id)}"]`)?.scrollIntoView({ block: 'start' }), 600);
    }
  });

  /* ---------- settings ---------- */
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let closed = [];
  const renderClosed = () => {
    $('#closed-list').innerHTML = closed.length
      ? closed.map((d) => `<li><span>${fmtDay(d)}</span><button type="button" class="adm__link" data-rm="${d}">Reopen</button></li>`).join('')
      : '<li class="adm__empty">No closed dates.</li>';
  };
  async function loadSettings() {
    const s = await api('/api/admin/settings');
    const f = $('#settings');
    f.dailyMax.value = s.dailyMax; f.perSlot.value = s.perSlot; f.leadDays.value = s.leadDays; f.windowDays.value = s.windowDays;
    f.slots.value = s.slots.join(', ');
    $('#open-days').innerHTML = DAYS.map((d, i) => `<label class="chip"><input type="checkbox" value="${i}"${s.openDays.includes(i) ? ' checked' : ''}><span>${d}</span></label>`).join('');
    closed = s.closedDates.slice();
    renderClosed();
  }
  $('#closed-add').addEventListener('click', () => {
    const v = $('#closed-input').value;
    if (v && !closed.includes(v)) { closed.push(v); closed.sort(); renderClosed(); }
  });
  $('#closed-list').addEventListener('click', (e) => {
    const d = e.target.dataset.rm;
    if (d) { closed = closed.filter((x) => x !== d); renderClosed(); }
  });
  $('#settings').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    $('#set-err').textContent = '';
    const body = {
      dailyMax: Number(f.dailyMax.value), perSlot: Number(f.perSlot.value),
      leadDays: Number(f.leadDays.value), windowDays: Number(f.windowDays.value),
      slots: f.slots.value.split(',').map((t) => t.trim()).filter(Boolean).map((t) => (/^\d:\d\d$/.test(t) ? '0' + t : t)),
      openDays: [...document.querySelectorAll('#open-days input:checked')].map((i) => Number(i.value)),
      closedDates: closed,
    };
    try {
      await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(body) });
      $('#saved').hidden = false; setTimeout(() => ($('#saved').hidden = true), 2000);
      loadSettings();
    } catch (err) { $('#set-err').textContent = err.message; }
  });

  /* ---------- start ---------- */
  let timer = 0;
  async function start() {
    try {
      const me = await api('/api/admin/me');
      $('#login').hidden = true; $('#app').hidden = false;
      $('#demo-banner').hidden = !me.demo;
      caps = me;
      loadList();
      clearInterval(timer);
      // refresh every minute, but never while someone is typing a note
      timer = setInterval(() => { if (tab !== 'settings' && !$('#list').hidden && !document.hidden && !document.activeElement?.closest('#list') && !document.querySelector('#list .rcpt:not([hidden])')) loadList(); }, 60000);
      if (!start.wired) {
        start.wired = true;
        document.addEventListener('visibilitychange', () => { if (!document.hidden && tab !== 'settings' && !$('#app').hidden && !$('#list').hidden && !document.querySelector('#list .rcpt:not([hidden])')) loadList(); });
      }
    } catch { /* showLogin already ran */ }
  }
  start();
})();
