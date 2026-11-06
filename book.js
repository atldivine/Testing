/* Online booking: service, car, time slot, contact. Free estimate requests by default; with DEPOSIT_DOLLARS set, a deposit through Stripe Checkout. */
(() => {
  const form = document.getElementById('book-form');
  if (!form) return;
  const flow = document.getElementById('book-flow');
  const result = document.getElementById('book-result');
  const servicesEl = document.getElementById('service-list');
  const calGrid = document.querySelector('.cal__grid');
  const calMonth = document.querySelector('.cal__month');
  const slotsEl = document.getElementById('slots');
  const payBtn = form.querySelector('.book__pay');
  const formErr = form.querySelector('.book__err--form');
  const params = new URLSearchParams(location.search);

  const state = { service: '', date: '', time: '', days: {}, first: '', last: '', month: '', deposit: 0 };
  const goLabel = () => (state.deposit ? `Pay $${state.deposit} deposit` : 'Request appointment');

  /* ---------- formatting ---------- */
  const dateObj = (iso) => new Date(iso + 'T12:00:00');
  const fmtDay = (iso, opts = { weekday: 'long', month: 'long', day: 'numeric' }) => dateObj(iso).toLocaleDateString('en-US', opts);
  const fmtTime = (t) => { const [h, m] = t.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
  const monthKey = (iso) => iso.slice(0, 7);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const api = async (url, opts = {}) => {
    const res = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || 'Something went wrong.'), { body, status: res.status });
    return body;
  };

  /* ---------- summary ---------- */
  const sum = (k, v) => { form.closest('main').querySelector(`[data-sum="${k}"]`).textContent = v; };
  const carText = () => [form.year.value, form.make.value.trim(), form.model.value.trim()].filter(Boolean).join(' ');
  const updateSummary = () => {
    sum('service', state.service || 'Not picked yet');
    sum('vehicle', carText() || 'Not entered yet');
    sum('when', state.date ? `${fmtDay(state.date, { weekday: 'short', month: 'short', day: 'numeric' })}${state.time ? ', ' + fmtTime(state.time) : ''}` : 'Not picked yet');
    updateBar();
  };
  /* ---------- phone bar: what's picked so far, with the next step in thumb reach ---------- */
  const bar = document.getElementById('bookbar');
  const barGo = bar && bar.querySelector('.bookbar__go');
  const onPhone = matchMedia('(max-width: 1023px)');
  const smooth = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  const stepOf = (key) => {
    const el = form.elements[key];
    const target = el && !el.tagName && el.length !== undefined ? el[0] : el;
    return (target || form.querySelector(`[data-err="${key}"]`))?.closest('.book__step') || null;
  };
  const nextKey = () => Object.keys(problems(readForm()))[0];
  function updateBar() {
    if (!bar) return;
    bar.querySelector('[data-bar="service"]').textContent = state.service || 'Pick a service';
    bar.querySelector('[data-bar="when"]').textContent = state.date
      ? `${fmtDay(state.date, { weekday: 'short', month: 'short', day: 'numeric' })}${state.time ? ', ' + fmtTime(state.time) : ', pick a time'}`
      : 'Then a day and time';
    if (!barGo.disabled) barGo.textContent = nextKey() ? 'Continue' : goLabel();
  }
  if (bar) {
    barGo.addEventListener('click', () => {
      const key = nextKey();
      if (!key) return form.requestSubmit();
      stepOf(key)?.scrollIntoView({ block: 'start', behavior: smooth });
      const field = form.elements[key];
      if (field && field.tagName && field.type !== 'checkbox') setTimeout(() => field.focus({ preventScroll: true }), 350);
    });
    // the bar steps aside while the real pay button is on screen
    if ('IntersectionObserver' in window) new IntersectionObserver(([e]) => bar.classList.toggle('is-off', e.isIntersecting)).observe(payBtn);
    form.addEventListener('input', updateBar);
    form.addEventListener('change', updateBar);
  }

  ['year', 'make', 'model'].forEach((n) => form[n].addEventListener('input', updateSummary));
  form.year.addEventListener('change', updateSummary);
  // newest model years first
  for (let y = new Date().getFullYear() + 1; y >= 1960; y--) form.year.add(new Option(String(y), String(y)));

  /* ---------- errors ---------- */
  const setErr = (k, msg) => {
    const el = form.querySelector(`[data-err="${k}"]`);
    if (el) el.textContent = msg || '';
    const input = form.elements[k];
    if (input && input.setAttribute) input.setAttribute('aria-invalid', msg ? 'true' : 'false');
  };
  const clearErrs = () => { form.querySelectorAll('[data-err]').forEach((e) => (e.textContent = '')); formErr.textContent = ''; };
  form.addEventListener('input', (e) => { if (e.target.name) setErr(e.target.name, ''); });

  /* ---------- services ---------- */
  const renderServices = (list) => {
    servicesEl.innerHTML = list.map((s, i) => `
      <label class="chip"><input type="radio" name="service" value="${esc(s)}"${i === 0 ? '' : ''}><span>${esc(s)}</span></label>`).join('');
    servicesEl.addEventListener('change', (e) => { state.service = e.target.value; setErr('service', ''); updateSummary(); });
  };

  /* ---------- calendar ---------- */
  const renderMonth = () => {
    const [y, m] = state.month.split('-').map(Number);
    const first = new Date(y, m - 1, 1);
    calMonth.textContent = first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const cells = [];
    for (let i = 0; i < first.getDay(); i++) cells.push('<span class="cal__pad"></span>');
    const daysInMonth = new Date(y, m, 0).getDate();
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = `${state.month}-${String(d).padStart(2, '0')}`;
      const inRange = iso >= state.first && iso <= state.last;
      const open = inRange && (state.days[iso] || []).length > 0;
      const full = inRange && !open && state.days[iso] !== undefined;
      const label = `${fmtDay(iso)}${open ? `, ${state.days[iso].length} times open` : full ? ', unavailable' : ''}`;
      cells.push(`<button type="button" class="cal__day${open ? '' : ' is-off'}${iso === state.date ? ' is-sel' : ''}" data-date="${iso}" ${open ? '' : 'disabled'} aria-pressed="${iso === state.date}" aria-label="${label}">${d}</button>`);
    }
    calGrid.innerHTML = cells.join('');
    const prev = document.querySelector('.cal__nav[data-step="-1"]'), next = document.querySelector('.cal__nav[data-step="1"]');
    prev.disabled = state.month <= monthKey(state.first);
    next.disabled = state.month >= monthKey(state.last);
  };
  document.querySelectorAll('.cal__nav').forEach((b) => b.addEventListener('click', () => {
    const [y, m] = state.month.split('-').map(Number);
    const d = new Date(y, m - 1 + Number(b.dataset.step), 1);
    state.month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    renderMonth();
  }));
  calGrid.addEventListener('click', (e) => {
    const b = e.target.closest('.cal__day');
    if (!b || b.disabled) return;
    state.date = b.dataset.date;
    state.time = '';
    setErr('date', '');
    renderMonth();
    renderSlots();
    updateSummary();
    // on a phone the open times render below the calendar: bring them into view
    if (onPhone.matches) slotsEl.scrollIntoView({ block: 'nearest', behavior: smooth });
  });

  const renderSlots = () => {
    if (!state.date) { slotsEl.innerHTML = '<p class="slots__hint">Pick a day to see open times.</p>'; return; }
    const times = state.days[state.date] || [];
    slotsEl.innerHTML = `<p class="slots__label">${esc(fmtDay(state.date))}</p><div class="slots__grid" role="radiogroup" aria-label="Appointment time">${times.map((t) =>
      `<label class="chip chip--time"><input type="radio" name="time" value="${t}"${t === state.time ? ' checked' : ''}><span>${fmtTime(t)}</span></label>`).join('')}</div>`;
  };
  slotsEl.addEventListener('change', (e) => { state.time = e.target.value; setErr('time', ''); updateSummary(); });

  const loadOptions = async () => {
    const o = await api('/api/booking/options');
    state.days = o.days; state.first = o.first; state.last = o.last;
    if (!state.month || state.month < monthKey(o.first)) {
      const firstOpen = Object.keys(o.days).find((d) => o.days[d].length) || o.first;
      state.month = monthKey(firstOpen);
    }
    state.deposit = o.deposit || 0;
    if (state.deposit) {
      payBtn.textContent = goLabel();
      form.closest('main').querySelector('[data-sum="due"]').textContent = `$${state.deposit} deposit`;
      form.querySelector('[data-policy]').textContent = `I understand the $${state.deposit} deposit is non-refundable and goes toward my total. Missed appointments may lose the deposit. Any balance not covered by insurance is paid before the car is released.`;
      document.getElementById('pay-note').textContent = o.demo ? "Demo mode: Stripe isn't connected yet, so no card is charged. Your time is held for 30 minutes while you pay." : 'Secure checkout by Stripe. Your time is held for 30 minutes while you pay.';
    }
    return o;
  };

  /* ---------- submit ---------- */
  const readForm = () => ({
    service: state.service, date: state.date, time: state.time,
    year: form.year.value, make: form.make.value, model: form.model.value, details: form.details.value,
    name: form.name.value, phone: form.phone.value, email: form.email.value,
    agree: form.agree.checked,
  });
  // field name -> message, in the order the steps appear
  const problems = (data) => {
    const local = {};
    if (!data.service) local.service = 'Pick a service.';
    if (!data.year) local.year = 'Pick the year.';
    if (data.make.trim().length < 2) local.make = 'Enter the make, like Toyota.';
    if (!data.model.trim()) local.model = 'Enter the model, like Camry.';
    if (!data.date) local.date = 'Pick a day.';
    else if (!data.time) local.time = 'Pick a time.';
    if (data.name.trim().length < 2) local.name = 'Enter your name.';
    if (data.phone.replace(/\D/g, '').length < 10) local.phone = 'Enter a phone number we can text.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email.trim())) local.email = 'Enter a valid email for your confirmation.';
    if (!data.agree) local.agree = state.deposit ? 'Please accept the deposit policy.' : 'Please accept the appointment policy.';
    return local;
  };
  const setPaying = (on) => {
    payBtn.disabled = on;
    payBtn.textContent = on ? (state.deposit ? 'Opening secure checkout…' : 'Sending…') : goLabel();
    if (barGo) { barGo.disabled = on; if (on) barGo.textContent = state.deposit ? 'Opening checkout…' : 'Sending…'; else updateBar(); }
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrs();
    const data = readForm();
    const local = problems(data);
    if (Object.keys(local).length) return showErrors(local);

    setPaying(true);
    try {
      const r = await api('/api/bookings', { method: 'POST', body: JSON.stringify(data) });
      location.href = r.url;
    } catch (err) {
      setPaying(false);
      formErr.textContent = err.message;
      if (err.body?.fields) showErrors(err.body.fields, false);
      if (err.status === 409) { // slot got taken: refresh what's open
        state.time = '';
        await loadOptions().catch(() => {});
        renderMonth(); renderSlots(); updateSummary();
      }
    }
  });
  function showErrors(fields, announce = true) {
    for (const [k, v] of Object.entries(fields)) setErr(k, v);
    if (announce) formErr.textContent = 'Check the highlighted fields.';
    const firstKey = Object.keys(fields)[0];
    const target = form.elements[firstKey]?.length ? form.elements[firstKey][0] : form.elements[firstKey];
    const anchor = (target && target.focus ? target : form.querySelector(`[data-err="${firstKey}"]`))?.closest('.book__step');
    anchor?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    if (target && target.focus) setTimeout(() => target.focus({ preventScroll: true }), 300);
  }

  /* ---------- returning from checkout ---------- */
  const card = (html) => { flow.hidden = true; result.hidden = false; result.innerHTML = html; if (bar) bar.hidden = true; window.scrollTo(0, 0); };
  const detailRows = (b) => `
    <dl class="sum sum--result">
      <div><dt>Service</dt><dd>${esc(b.service)}</dd></div>
      <div><dt>Car</dt><dd>${esc(b.vehicle)}</dd></div>
      <div><dt>When</dt><dd>${esc(fmtDay(b.date))}, ${fmtTime(b.time)}</dd></div>
      ${b.deposit ? `<div><dt>Deposit</dt><dd>$${b.deposit} ${b.refunded ? 'refunded' : 'paid'}</dd></div>` : ''}
    </dl>`;
  const callLine = '<p class="book__call">Questions? Call <a href="tel:+16314764665">(631) 476-4665</a>.</p>';
  const codeLine = (b) => b.code ? `
    <div class="code-card">
      <p class="code-card__label">Your repair code</p>
      <p class="code-card__code">${esc(b.code)}</p>
      <p>Use it to follow your car from estimate to pickup. It is in your confirmation too.</p>
      <a class="btn" href="track.html?code=${encodeURIComponent(b.code)}">Track your repair</a>
    </div>` : '';

  async function showBooking(id) {
    const sid = params.get('session_id') || '';
    if (params.get('cancelled')) {
      await api(`/api/bookings/${encodeURIComponent(id)}/release`, { method: 'POST', body: '{}' }).catch(() => {});
      card(`<div class="result result--warn"><h2 class="h2">Payment cancelled</h2><p>No deposit was taken and your time was released. You can pick a time again whenever you're ready.</p>
        <div class="btn-row"><a class="btn" href="book.html">Book again</a><a class="btn btn--light" href="tel:+16314764665">Call instead</a></div></div>`);
      return;
    }
    card('<div class="result"><h2 class="h2">Checking your booking…</h2><p>This takes a few seconds.</p></div>');
    let b;
    for (let i = 0; i < 8; i++) { // the webhook can land a moment after the redirect
      b = await api(`/api/bookings/${encodeURIComponent(id)}?session_id=${encodeURIComponent(sid)}`).catch(() => null);
      if (!b || b.status !== 'pending_payment') break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!b) return card(`<div class="result result--warn"><h2 class="h2">We couldn't find that booking</h2><p>Call us and we'll sort it out.</p>${callLine}</div>`);
    const first = esc(b.firstName);
    if (b.status === 'paid') return card(`<div class="result result--ok"><h2 class="h2">Request received, ${first}</h2>
      <p>${b.deposit ? `Your $${b.deposit} deposit went through and your time is held.` : 'Your time is held.'} We review every request and will call or text you to confirm.</p>${codeLine(b)}${detailRows(b)}
      <ol class="result__next"><li>Watch for our call or text confirming the appointment.</li><li>Bring the car at your time, with your insurance card and claim number if you have one.</li><li>We inspect the damage and walk you through the estimate.</li></ol>${callLine}</div>`);
    if (b.status === 'confirmed' || b.status === 'completed') return card(`<div class="result result--ok"><h2 class="h2">You're confirmed, ${first}</h2><p>See you then.</p>${codeLine(b)}${detailRows(b)}${callLine}</div>`);
    if (b.status === 'declined') return card(`<div class="result result--warn"><h2 class="h2">This booking was declined</h2><p>We can't take the car at that time.${b.refunded ? ' Your deposit was refunded.' : ''} Call us to find another day.</p>${callLine}</div>`);
    if (b.status === 'pending_payment') return card(`<div class="result result--warn"><h2 class="h2">Still waiting on the payment</h2><p>Stripe hasn't confirmed your deposit yet. Refresh in a minute. If you were charged and this doesn't update, call or text us.</p>${callLine}</div>`);
    return card(`<div class="result result--warn"><h2 class="h2">This time slot was released</h2><p>The deposit wasn't completed within 30 minutes, so the time went back on the calendar. No charge was made.</p>
      <div class="btn-row"><a class="btn" href="book.html">Book again</a></div>${callLine}</div>`);
  }

  /* ---------- start ---------- */
  const bookingId = params.get('booking');
  if (bookingId) { showBooking(bookingId); return; }
  loadOptions().then((o) => {
    renderServices(o.services);
    const pre = params.get('service');
    if (pre) { const r = servicesEl.querySelector(`input[value="${CSS.escape(pre)}"]`); if (r) { r.checked = true; state.service = pre; } }
    renderMonth(); renderSlots(); updateSummary();
    if (bar) bar.hidden = false;
  }).catch(() => {
    flow.innerHTML = `<div class="result result--warn"><h2 class="h2">Online booking is down right now</h2><p>Call <a href="tel:+16314764665">(631) 476-4665</a> and we'll get you scheduled.</p></div>`;
  });
})();
