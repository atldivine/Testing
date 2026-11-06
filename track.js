/* Repair tracker: look up a booking by its 6-character code and show where the car is. */
(() => {
  const find = document.getElementById('find');
  const view = document.getElementById('view');
  const err = document.getElementById('find-err');
  if (!find) return;
  const input = find.code;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDay = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const fmtTime = (t) => { const [h, m] = t.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
  const fmtWhen = (ms) => new Date(ms).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const clean = (v) => v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

  // drawn stand-in when no picture of the model is found
  const SILHOUETTE = `<svg class="trk__sil" viewBox="0 0 640 240" aria-hidden="true"><path d="M62 170c-14 0-22-8-22-20v-26c0-12 8-20 22-24l78-20c30-34 70-52 128-56 70-4 128 10 178 52l70 10c34 6 52 20 56 46v18c0 12-8 20-22 20h-36" fill="none" stroke="currentColor" stroke-width="6" stroke-linejoin="round"/><path d="M160 82h296M236 34l-16 48M392 40l20 42" fill="none" stroke="currentColor" stroke-width="4" opacity=".5"/><circle cx="160" cy="174" r="40" fill="none" stroke="currentColor" stroke-width="6"/><circle cx="160" cy="174" r="14" fill="currentColor" opacity=".5"/><circle cx="486" cy="174" r="40" fill="none" stroke="currentColor" stroke-width="6"/><circle cx="486" cy="174" r="14" fill="currentColor" opacity=".5"/><path d="M200 172h246" stroke="currentColor" stroke-width="6"/></svg>`;

  function progress(d) {
    const steps = d.stages.filter((s) => s.id !== 'picked_up');
    const order = d.stages.map((s) => s.id);
    const now = order.indexOf(d.stage);
    const seen = new Set(d.events.map((e) => e.stage));
    const items = steps.map((s, i) => {
      let state = i < now ? 'done' : i === now ? 'now' : 'todo';
      if (d.stage === 'picked_up') state = 'done';
      // parts were never needed if the car went straight from diagnosis to repair
      const skipped = s.id === 'waiting_parts' && state === 'done' && !seen.has('waiting_parts');
      if (skipped) state = 'skip';
      const note = state === 'skip' ? 'Not needed' : state === 'now' ? 'Now' : '';
      return `<li class="prog__step is-${state}"${state === 'now' ? ' aria-current="step"' : ''}>
        <span class="prog__dot" aria-hidden="true"></span>
        <span class="prog__label">${esc(s.label)}</span>
        ${note ? `<span class="prog__note">${note}</span>` : ''}
      </li>`;
    }).join('');
    const pct = d.stage === 'picked_up' ? 100 : Math.max(0, Math.min(100, (now / (steps.length - 1)) * 100));
    return `<div class="prog" role="group" aria-label="Repair progress: ${esc(d.stages[Math.max(0, now)]?.label || '')}">
      <div class="prog__track" aria-hidden="true"><span class="prog__fill" style="--pct:${pct.toFixed(1)}%"></span></div>
      <ol class="prog__steps">${items}</ol>
    </div>`;
  }

  // receipts, invoices and photos the shop has sent for this car
  function records(d) {
    if (!d.records || !d.records.length) return "";
    const kind = (r) => (r.kind === "receipt" ? "Receipt" : r.mime === "application/pdf" ? "PDF" : "Photo");
    const items = d.records.map((r) => {
      const thumb = r.kind === "file" && /^image\/(jpeg|png|webp)$/.test(r.mime) ? `<img src="${esc(r.url)}" alt="" width="56" height="56" loading="lazy">` : `<span class="trk__recicon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="${r.kind === "receipt" ? "M6 3h12v18l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5L6 21Z M9 8h6 M9 12h6 M9 16h3" : "M6 3h8l4 4v14H6Z M14 3v4h4 M9 12h6 M9 16h6"}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></span>`;
      return `<li><a href="${esc(r.url)}" target="_blank" rel="noopener">${thumb}<span><b>${esc(r.title)}</b>${kind(r)} · ${esc(fmtWhen(r.at))}</span><span class="trk__recopen">Open</span></a></li>`;
    }).join("");
    return `<section class="trk__recs" aria-labelledby="recs-title"><h3 id="recs-title">Receipts &amp; records</h3><ul>${items}</ul></section>`;
  }

  function render(d) {
    const current = d.stages.find((s) => s.id === d.stage) || d.stages[0];
    let headline = current.label, blurb = current.blurb;
    if (d.status === 'declined') { headline = 'Booking declined'; blurb = "We couldn't take this booking. Call us to set up another day."; }
    if (d.status === 'no_show') { headline = 'Missed appointment'; blurb = 'This appointment was missed. Call us to book a new time.'; }
    const live = d.status !== 'declined' && d.status !== 'no_show';
    const pic = d.image
      ? `<img src="${esc(d.image.url)}" alt="${esc(d.vehicle)}" width="1200" height="800" decoding="async">`
      : SILHOUETTE;
    // stock photos are CC-licensed and show the model, not this exact car
    const creditUrl = d.image?.credit?.url || 'https://commons.wikimedia.org/';
    const credit = d.image?.kind === 'photo'
      ? `<figcaption>Example photo of a ${esc(d.make)} ${esc(d.model)}, via <a href="${esc(creditUrl)}" target="_blank" rel="noopener">Wikipedia</a></figcaption>`
      : !d.image ? '<figcaption>Picture coming soon</figcaption>' : '';
    const log = [...d.events].reverse().map((e) => `
      <li><time datetime="${new Date(e.at).toISOString()}">${esc(fmtWhen(e.at))}</time><b>${esc(e.label)}</b>${e.note ? `<p>${esc(e.note)}</p>` : ''}</li>`).join('');

    view.innerHTML = `
      <div class="trk__grid">
        <figure class="trk__car trk__car--${d.image ? d.image.kind : 'none'}">${pic}${credit}</figure>
        <div class="trk__info">
          <h2 class="h2 trk__title">${esc(d.vehicle)}</h2>
          <dl class="trk__meta">
            <div><dt>Code</dt><dd class="trk__code">${esc(d.code)}</dd></div>
            <div><dt>Service</dt><dd>${esc(d.service)}</dd></div>
            <div><dt>Appointment</dt><dd>${esc(fmtDay(d.date))}, ${fmtTime(d.time)}</dd></div>
          </dl>
          <div class="trk__now${live ? '' : ' trk__now--warn'}${d.stage === 'ready' ? ' trk__now--ready' : ''}">
            <p class="trk__stage">${esc(headline)}</p>
            <p>${esc(blurb)}</p>
            ${live && d.note ? `<blockquote class="trk__note"><p>${esc(d.note)}</p><cite>Good Shepard Auto Body</cite></blockquote>` : ''}
          </div>
        </div>
      </div>
      ${live ? progress(d) : ''}
      ${records(d)}
      <div class="trk__lower">
        <section class="trk__log" aria-labelledby="log-title">
          <h3 id="log-title">Updates</h3>
          <ol>${log || '<li><p>No updates yet.</p></li>'}</ol>
        </section>
        <aside class="trk__contact">
          <h3>Questions about your car?</h3>
          <p>Call the shop at ${esc(d.shopPhone)}. Mention code ${esc(d.code)}.</p>
          <div class="btn-row"><a class="btn" href="tel:+16314764665">Call the shop</a></div>
          <p class="trk__refresh">This page refreshes on its own every minute.</p>
        </aside>
      </div>`;
    view.hidden = false;
    document.title = `${d.vehicle}: ${headline} · Good Shepard Auto Body`;
  }

  let code = '', timer = 0, lastJSON = '';
  async function load(c, { quiet = false } = {}) {
    err.textContent = '';
    try {
      const res = await fetch(`/api/track/${encodeURIComponent(c)}`, { headers: { Accept: 'application/json' } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Something went wrong. Try again in a minute.');
      const json = JSON.stringify(body);
      if (json !== lastJSON) { lastJSON = json; render(body); } // no flicker when nothing changed
      code = c;
      find.classList.add('is-compact');
      clearInterval(timer);
      timer = setInterval(() => { if (!document.hidden) load(code, { quiet: true }); }, 60000);
    } catch (e) {
      if (quiet) return;
      view.hidden = true;
      err.textContent = e.message;
      input.setAttribute('aria-invalid', 'true');
    }
  }

  input.addEventListener('input', () => { const v = clean(input.value); if (v !== input.value) input.value = v; input.removeAttribute('aria-invalid'); });
  find.addEventListener('submit', (e) => {
    e.preventDefault();
    const c = clean(input.value);
    if (c.length !== 6) { err.textContent = 'Codes are 6 letters and numbers.'; input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
    history.replaceState(null, '', `?code=${c}`);
    load(c);
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && code) load(code, { quiet: true }); });

  const start = clean(new URLSearchParams(location.search).get('code') || '');
  if (start) { input.value = start; load(start); } else input.focus({ preventScroll: true });
})();
