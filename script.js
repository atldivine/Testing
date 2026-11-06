/* Good Shepard Auto Body: shared page behaviour (nav, phone bar, FAQ, reveal, Google reviews, work gallery). */
// Mobile nav drawer
const nav = document.querySelector('.nav');
const toggle = document.querySelector('.nav__toggle');

toggle.addEventListener('click', () => {
  const open = nav.toggleAttribute('data-open');
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
});

nav.querySelectorAll('.nav__menu a').forEach((link) =>
  link.addEventListener('click', () => {
    nav.removeAttribute('data-open');
    toggle.setAttribute('aria-expanded', 'false');
  })
);

// Phones: the call / text / book bar slides up once the hero's own buttons scroll away
const mbar = document.querySelector('.mbar');
if (mbar) {
  const heroCta = document.querySelector('.gs-hero .btn-row');
  if (heroCta && 'IntersectionObserver' in window) {
    new IntersectionObserver(([e]) => mbar.classList.toggle('is-on', !e.isIntersecting && e.boundingClientRect.top < 0)).observe(heroCta);
  } else {
    mbar.classList.add('is-on');
  }
}

// Phones: back-to-top button once the visitor is a screen and a half down
const totop = document.querySelector('.totop');
if (totop) {
  let queued = false;
  const update = () => { queued = false; totop.classList.toggle('is-on', scrollY > innerHeight * 1.5); };
  addEventListener('scroll', () => { if (!queued) { queued = true; requestAnimationFrame(update); } }, { passive: true });
  update();
  totop.addEventListener('click', (e) => {
    scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    // keyboard users: the button hides at the top, so hand focus to the menu button
    if (e.detail === 0) document.querySelector('.nav__toggle')?.focus({ preventScroll: true });
  });
}

// FAQ: keep one answer open at a time
const items = document.querySelectorAll('.acc details');
items.forEach((item) =>
  item.addEventListener('toggle', () => {
    if (item.open) items.forEach((other) => other !== item && (other.open = false));
  })
);


const still = new URLSearchParams(location.search).has('still');

/* ---------- scroll reveal: card grids only, staggered within each grid ----------
   Headings and copy are simply there. Anything at or above the reveal line is
   shown, including content a nav jump skipped past, so nothing stays hidden. */
const revealGroups = ['.pillars > *', '.services > *', '.steps > li', '.locations > *'];
let pending = [];
const revealCheck = () => {
  const line = innerHeight * 0.92;
  pending = pending.filter((el) => {
    if (el.getBoundingClientRect().top > line) return true;
    el.classList.add('is-in');
    // drop the reveal class once done so hover/tilt transforms aren't delayed by it
    const delay = parseFloat(getComputedStyle(el).transitionDelay) * 1000 || 0;
    setTimeout(() => el.classList.remove('rv', 'is-in'), delay + 750);
    return false;
  });
  if (!pending.length) {
    removeEventListener('scroll', onScroll);
    removeEventListener('resize', onScroll);
  }
};
let revealQueued = false;
const onScroll = () => {
  if (revealQueued) return;
  revealQueued = true;
  requestAnimationFrame(() => {
    revealQueued = false;
    revealCheck();
  });
};
if (!still) {
  revealGroups.forEach((sel) => {
    document.querySelectorAll(sel).forEach((el, i) => {
      el.classList.add('rv');
      el.style.setProperty('--i', Math.min(i, 8));
      pending.push(el);
    });
  });
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onScroll, { passive: true });
  revealCheck();
}

/* ---------- Google reviews: loaded when the section gets close ---------- */
const reviewsEl = document.getElementById('reviews');
if (reviewsEl) {
  const escR = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const stars = (n) => `<span class="rev__stars" role="img" aria-label="${n} out of 5 stars">${Array.from({ length: 5 }, (_, i) => `<svg class="${i < Math.round(n) ? 'is-on' : ''}" aria-hidden="true"><use href="#i-star"/></svg>`).join('')}</span>`;
  const card = (r) => `<figure class="rev">
      ${stars(r.rating || 5)}
      <blockquote class="rev__text"><p>${escR(r.text)}</p></blockquote>
      <button class="rev__more" type="button" hidden>Read more</button>
      <figcaption class="rev__by">
        ${r.photo ? `<img src="${escR(r.photo)}" alt="" width="40" height="40" loading="lazy" referrerpolicy="no-referrer">` : `<span class="rev__initial" aria-hidden="true">${escR(r.author.charAt(0))}</span>`}
        <span><b>${r.authorUrl ? `<a href="${escR(r.authorUrl)}" target="_blank" rel="noopener">${escR(r.author)}</a>` : escR(r.author)}</b>${escR(r.when)} · <a href="${escR(r.url)}" target="_blank" rel="noopener">on Google</a></span>
      </figcaption>
    </figure>`;
  const showReviews = async () => {
    let d;
    try { d = await (await fetch('/api/reviews', { headers: { Accept: 'application/json' } })).json(); } catch { return; }
    if (d.url) reviewsEl.querySelectorAll('#reviews-all, #reviews-score').forEach((a) => (a.href = d.url));
    if (d.writeUrl) reviewsEl.querySelector('#reviews-write').href = d.writeUrl;
    // the score and what reviewers mention show either way; the cards need the live Google feed
    const score = reviewsEl.querySelector('#reviews-score');
    if (d.rating) {
      score.innerHTML = `<b>${d.rating.toFixed(1)}</b>${stars(d.rating)}<span>${d.count} Google review${d.count === 1 ? '' : 's'}</span>`;
      score.setAttribute('aria-label', `Rated ${d.rating.toFixed(1)} out of 5 from ${d.count} Google reviews. Read them on Google.`);
      score.hidden = false;
    }
    if (d.topics && d.topics.length) {
      const topics = reviewsEl.querySelector('#reviews-topics');
      topics.querySelector('ul').innerHTML = d.topics.map((t) => `<li>${escR(t)}</li>`).join('');
      topics.hidden = false;
    }
    if (!d.reviews || !d.reviews.length) return;
    const list = reviewsEl.querySelector('#reviews-list');
    list.innerHTML = d.reviews.map(card).join('');
    reviewsEl.classList.add('has-reviews');
    reviewsEl.querySelector('#reviews-hint').hidden = d.reviews.length < 2;
    // long reviews fold to a few lines with a button to open them
    list.querySelectorAll('.rev').forEach((f) => {
      const t = f.querySelector('.rev__text'), more = f.querySelector('.rev__more');
      if (t.scrollHeight > t.clientHeight + 4) {
        more.hidden = false;
        more.addEventListener('click', () => { const open = f.classList.toggle('is-open'); more.textContent = open ? 'Show less' : 'Read more'; });
      }
    });
  };
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { io.disconnect(); showReviews(); } }, { rootMargin: '800px 0px' });
    io.observe(reviewsEl);
  } else showReviews();
}


/* ---------- Our work: the shop's own photos first, then its Google listing photos ----------
   Own photos: drop images in assets/work/ and list them in assets/work/work.json as
   [{ "src": "assets/work/civic-after.jpg", "before": "assets/work/civic-before.jpg", "title": "2019 Civic", "text": "Rear bumper and quarter panel" }]
   ("before" is optional). Google photos appear once GOOGLE_PLACES_KEY is set on the server. */
const galleryEl = document.getElementById('gallery');
if (galleryEl) {
  const escG = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const box = document.getElementById('lightbox');
  const open = (src, cap) => {
    if (!box || typeof box.showModal !== 'function') { window.open(src, '_blank', 'noopener'); return; }
    box.querySelector('img').src = src;
    box.querySelector('.gs-lightbox__cap').textContent = cap || '';
    box.showModal();
  };
  if (box) {
    box.querySelector('.gs-lightbox__close').addEventListener('click', () => box.close());
    box.addEventListener('click', (e) => { if (e.target === box) box.close(); });
  }
  const tile = (p, i) => {
    const cap = [p.title, p.text].filter(Boolean).join(' · ');
    const credit = p.author ? `<span class="gs-tile__credit">Photo: ${escG(p.author)} · Google</span>` : '';
    const before = p.before ? `<img class="gs-tile__before" src="${escG(p.before)}" alt="Before: ${escG(p.title || 'repair')}" loading="lazy"><span class="gs-tile__badge">Before / after</span>` : '';
    return `<figure class="gs-tile${p.before ? ' gs-tile--pair' : ''}" style="--i:${Math.min(i, 8)}">
      <button type="button" data-src="${escG(p.src)}" data-cap="${escG(cap)}" aria-label="Open photo${cap ? ': ' + escG(cap) : ''}">
        ${before}<img src="${escG(p.src)}" alt="${escG(p.title ? 'After: ' + p.title : 'Repair by Good Shepard Auto Body')}" loading="lazy" referrerpolicy="no-referrer">
      </button>
      ${p.title || p.text ? `<figcaption><b>${escG(p.title || '')}</b>${escG(p.text || '')}</figcaption>` : ''}${credit}
    </figure>`;
  };
  const load = async () => {
    const own = await fetch('assets/work/work.json').then((r) => (r.ok ? r.json() : [])).catch(() => []);
    const g = await fetch('/api/reviews', { headers: { Accept: 'application/json' } }).then((r) => r.json()).catch(() => ({}));
    const google = (g.photos || []).map((p) => ({ src: p.url, author: p.author }));
    const all = [...(Array.isArray(own) ? own : []), ...google].filter((p) => p && p.src);
    if (!all.length) { document.getElementById('gallery-empty').hidden = false; return; }
    galleryEl.innerHTML = all.map(tile).join('');
    galleryEl.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-src]');
      if (b) open(b.dataset.src, b.dataset.cap);
    });
  };
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { io.disconnect(); load(); } }, { rootMargin: '800px 0px' });
    io.observe(galleryEl);
  } else load();
}
