/* Siteline — trips, favorite campsites, and booking links */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);

  // ---------- Firebase ----------
  const cfg = window.SITELINE_FIREBASE;
  if (!cfg || !cfg.apiKey || cfg.apiKey.indexOf('PASTE') === 0) {
    document.body.classList.remove('signed-out');
    $('#main').innerHTML = '<div class="setup-msg"><h1>Almost there</h1><p>Add your Firebase settings to <code>firebase-config.js</code>, then reload.</p></div>';
    return;
  }
  firebase.initializeApp(cfg);
  const auth = firebase.auth();
  const db = firebase.firestore();
  const FV = firebase.firestore.FieldValue;

  // ---------- Constants ----------
  const SYSTEMS = {
    rc: { label: 'ReserveCalifornia', url: 'https://www.reservecalifornia.com/' },
    rgov: { label: 'Recreation.gov', url: 'https://www.recreation.gov/' },
    other: { label: 'Other', url: '' }
  };
  const STATUSES = { booked: 'Booked', hoping: 'Hoping to book', done: 'Done', cancelled: 'Cancelled' };
  const HOOKUPS = { '': 'Not noted', none: 'No hookups', electric: 'Electric only', we: 'Water and electric', full: 'Full hookups' };
  // Booking windows, in Pacific time. Arrival dates open this many months ahead.
  const WINDOW_DEFAULTS = { rc: { months: 6, time: '08:00' }, rgov: { months: 6, time: '07:00' }, other: { months: 0, time: '' } };
  const SHADE = { '': 'Not noted', none: 'Full sun', some: 'Some shade', good: 'Good shade' };

  const ICON = {
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
    left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
    right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
    tree: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2 6 10h3l-4 6h4l-3 4h12l-3-4h4l-4-6h3z"/><path d="M12 20v2"/></svg>'
  };

  // ---------- State ----------
  const state = {
    user: null,
    settings: { rigLength: 26, rigName: '' },
    campgrounds: [],
    sites: [],
    trips: [],
    loaded: { cg: false, sites: false, trips: false },
    photos: {},
    calMonth: firstOfMonth(new Date()),
    route: { name: 'trips', id: null },
    unsub: []
  };

  // ---------- Helpers ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function safeUrl(u) {
    if (!u) return '';
    try {
      const x = new URL(u.trim());
      return /^https?:$/.test(x.protocol) ? x.href : '';
    } catch (e) { return ''; }
  }
  function firstOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  // Dates are stored as local "YYYY-MM-DD" strings. Never use toISOString() for these.
  function parseDate(s) { const p = String(s).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
  function fmtKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function todayKey() { return fmtKey(new Date()); }
  function addDays(key, n) { const d = parseDate(key); d.setDate(d.getDate() + n); return fmtKey(d); }
  function daysBetween(a, b) { return Math.round((parseDate(b) - parseDate(a)) / 86400000); }
  function dayLabel(key) { return parseDate(key).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }); }
  function rangeLabel(a, b) { return a === b ? dayLabel(a) : dayLabel(a) + ' – ' + dayLabel(b); }
  function tsMs(x) { return x && x.toMillis ? x.toMillis() : Date.now(); }
  function bySiteNumber(a, b) { return String(a.siteNumber).localeCompare(String(b.siteNumber), undefined, { numeric: true }); }

  // ---------- Booking windows ----------
  function windowFor(cg) {
    if (!cg) return null;
    const d = WINDOW_DEFAULTS[cg.system] || WINDOW_DEFAULTS.other;
    const months = cg.windowMonths != null && cg.windowMonths !== '' ? Number(cg.windowMonths) : d.months;
    const time = cg.windowTime || d.time;
    return months > 0 && time ? { months, time } : null;
  }
  function shiftMonths(key, n) {
    const a = parseDate(key);
    const y = a.getFullYear(), m = a.getMonth() + n;
    const last = new Date(y, m + 1, 0).getDate();
    return fmtKey(new Date(y, m, Math.min(a.getDate(), last)));
  }
  function tzOffsetLA(ms) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(new Date(ms));
    const g = t => Number(parts.find(p => p.type === t).value);
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - ms;
  }
  // The exact moment a Pacific wall-clock time happens, wherever the phone is.
  function pacificMoment(key, hhmm) {
    const [y, m, d] = key.split('-').map(Number);
    const [hh, mm] = hhmm.split(':').map(Number);
    const wall = Date.UTC(y, m - 1, d, hh, mm);
    let ms = wall;
    for (let i = 0; i < 2; i++) ms = wall - tzOffsetLA(ms);
    return new Date(ms);
  }
  function timeLabel(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    return (h % 12 || 12) + ':' + String(m).padStart(2, '0') + (h < 12 ? ' a.m.' : ' p.m.');
  }
  function opensFor(cg, arrival) {
    const w = windowFor(cg);
    if (!w || !arrival) return null;
    const key = shiftMonths(arrival, -w.months);
    return { key, at: pacificMoment(key, w.time), time: w.time, months: w.months };
  }
  function countdownText(at) {
    const diff = at.getTime() - Date.now();
    if (diff <= 0) return 'Open now';
    const mins = Math.ceil(diff / 60000);
    if (mins < 60) return 'In ' + mins + ' min';
    if (mins < 6 * 60) return 'In ' + Math.floor(mins / 60) + ' hr ' + (mins % 60) + ' min';
    const today = todayKey(), k = fmtKey(at);
    if (k === today) return 'Today';
    if (k === addDays(today, 1)) return 'Tomorrow';
    return 'In ' + daysBetween(today, k) + ' days';
  }
  function icsStamp(d) { return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }
  function reminderLink(t, o, cg) {
    const sites = t.siteId && siteById(t.siteId) ? [siteById(t.siteId)] : sitesFor(cg.id);
    const siteTxt = sites.length ? 'Sites to try: ' + sites.map(s => s.siteNumber).join(', ') + '. ' : '';
    const sys = SYSTEMS[cg.system] || SYSTEMS.other;
    const p = new URLSearchParams({
      start: icsStamp(o.at),
      title: 'Book ' + (cg.shortName || cg.name),
      desc: 'Booking opens at ' + timeLabel(o.time) + ' Pacific for arrival ' + dayLabel(t.startDate) + '. ' + siteTxt + 'Be signed in before it opens.',
      url: safeUrl(cg.bookingUrl) || sys.url || '',
      uid: 'trip-' + t.id + '-' + o.key
    });
    return '/.netlify/functions/ics?' + p.toString();
  }

  function cgById(id) { return state.campgrounds.find(c => c.id === id) || null; }
  function siteById(id) { return state.sites.find(s => s.id === id) || null; }
  function tripById(id) { return state.trips.find(t => t.id === id) || null; }
  function sitesFor(cgId) { return state.sites.filter(s => s.campgroundId === cgId).sort(bySiteNumber); }
  function placeName(t) { const cg = cgById(t.campgroundId); return cg ? cg.name : (t.placeName || 'Somewhere'); }
  function shortPlace(t) { const cg = cgById(t.campgroundId); return cg ? (cg.shortName || cg.name) : (t.placeName || 'Trip'); }
  function locationLine(cg) { return [cg.area, cg.state].filter(Boolean).join(', '); }

  const userRef = () => db.collection('users').doc(state.user.uid);
  const col = name => userRef().collection(name);

  let toastTimer;
  function toast(msg, sticky) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // Lock both html and body so iOS doesn't scroll the page behind sheets.
  let lockCount = 0, savedY = 0;
  function lockScroll() {
    if (lockCount++ === 0) {
      savedY = window.scrollY;
      document.documentElement.classList.add('is-locked');
      document.body.style.top = '-' + savedY + 'px';
    }
  }
  function unlockScroll() {
    if (--lockCount <= 0) {
      lockCount = 0;
      document.documentElement.classList.remove('is-locked');
      document.body.style.top = '';
      window.scrollTo(0, savedY);
    }
  }

  async function runOps(ops) {
    for (let i = 0; i < ops.length; i += 400) {
      const b = db.batch();
      ops.slice(i, i + 400).forEach(fn => fn(b));
      await b.commit();
    }
  }

  // ---------- Auth ----------
  auth.onAuthStateChanged(async user => {
    state.unsub.forEach(u => u());
    state.unsub = [];
    state.user = user;
    state.campgrounds = []; state.sites = []; state.trips = []; state.photos = {};
    state.loaded = { cg: false, sites: false, trips: false };

    if (!user) { renderSignIn(); return; }

    document.body.classList.remove('signed-out');
    try {
      const snap = await userRef().get();
      if (snap.exists) Object.assign(state.settings, (snap.data() || {}).settings || {});
      else await userRef().set({ settings: state.settings, createdAt: FV.serverTimestamp() });
    } catch (err) {
      console.error('Settings load failed', err);
    }
    listen();
    route();
  });

  async function signIn() {
    const provider = new firebase.auth.GoogleAuthProvider();
    const errEl = $('#signin-error');
    if (errEl) errEl.hidden = true;
    try {
      await auth.signInWithPopup(provider);
    } catch (err) {
      if (err.code === 'auth/popup-blocked' || err.code === 'auth/operation-not-supported-in-this-environment') {
        return auth.signInWithRedirect(provider);
      }
      if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') return;
      console.error(err);
      if (errEl) { errEl.textContent = 'Sign-in did not finish (' + err.code + '). Try again.'; errEl.hidden = false; }
    }
  }

  function renderSignIn() {
    document.body.classList.add('signed-out');
    $('#topbar').innerHTML = '';
    $('#main').innerHTML = `
      <div class="welcome">
        <img class="welcome-mark" src="logo-mark.svg" alt="">
        <h1 class="welcome-title">Siteline</h1>
        <p class="welcome-tag">Campground reservations &amp; availability</p>
        <p>Your trips, favorite sites, and booking links in one place.</p>
        <button class="btn btn-primary btn-lg" data-action="sign-in">Sign in with Google</button>
        <p class="form-error" id="signin-error" hidden></p>
      </div>`;
  }

  // ---------- Data listeners ----------
  function listen() {
    const rows = snap => snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
    const onErr = which => err => {
      console.error(which + ' listener failed', err);
      state.loaded[which] = true;
      toast(err.code === 'permission-denied'
        ? 'Firestore blocked the request. Check that the security rules are published.'
        : 'Could not load your data. Check your connection.');
      render();
    };
    state.unsub.push(col('campgrounds').onSnapshot(s => {
      state.campgrounds = rows(s).sort((a, b) => String(a.name).localeCompare(String(b.name)));
      state.loaded.cg = true; render();
    }, onErr('cg')));
    state.unsub.push(col('sites').onSnapshot(s => {
      state.sites = rows(s).sort(bySiteNumber);
      state.loaded.sites = true; render();
    }, onErr('sites')));
    state.unsub.push(col('trips').onSnapshot(s => {
      state.trips = rows(s).sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
      state.loaded.trips = true; render();
    }, onErr('trips')));
  }

  // ---------- Routing ----------
  function route() {
    const parts = (location.hash.slice(1) || '/trips').split('/').filter(Boolean);
    state.route = { name: parts[0] || 'trips', id: parts[1] || null };
    renderNow();
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', () => { if (state.user) route(); });

  let renderQueued = false;
  function render() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; renderNow(); });
  }

  function renderNow() {
    if (!state.user) return;
    const r = state.route;
    const ready = state.loaded.cg && state.loaded.sites && state.loaded.trips;
    let view;
    if (!ready) view = { title: 'Siteline', html: '<p class="loading">Loading your trips…</p>' };
    else if (r.name === 'places') view = placesView();
    else if (r.name === 'place') view = placeView(r.id);
    else if (r.name === 'site') view = siteView(r.id);
    else if (r.name === 'settings') view = settingsView();
    else view = tripsView();

    $('#topbar').innerHTML =
      (view.back ? `<a class="icon-btn back" href="${view.back}" aria-label="Back">${ICON.back}</a>` : '<img class="brand-mark" src="icon.svg" alt="">') +
      `<h1 class="topbar-title${view.back ? '' : ' is-root'}">${esc(view.title)}</h1>` +
      `<div class="topbar-actions">${view.actions || ''}</div>`;
    $('#main').innerHTML = view.html;

    const tab = (r.name === 'place' || r.name === 'site') ? 'places' : (['places', 'settings'].includes(r.name) ? r.name : 'trips');
    document.querySelectorAll('.tab').forEach(a => {
      const on = a.dataset.tab === tab;
      a.classList.toggle('is-active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    if (view.after) view.after();
  }

  function notFound(back) {
    return { title: 'Not found', back, html: '<p class="empty">This was deleted or never saved. Go back to see what you have.</p>' };
  }

  // ---------- Trips view ----------
  function tripsView() {
    const today = todayKey();
    const upcoming = state.trips.filter(t => t.endDate >= today && t.status !== 'cancelled');
    const past = state.trips.filter(t => t.endDate < today || t.status === 'cancelled').reverse();
    const m = state.calMonth;
    const isThisMonth = m.getFullYear() === new Date().getFullYear() && m.getMonth() === new Date().getMonth();

    const html = `
      <section class="cal" aria-label="Trip calendar">
        <div class="cal-head">
          <button class="icon-btn" data-action="cal-prev" aria-label="Previous month">${ICON.left}</button>
          <h2 class="cal-title">${m.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h2>
          <button class="icon-btn" data-action="cal-next" aria-label="Next month">${ICON.right}</button>
        </div>
        <div class="cal-week" aria-hidden="true">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(d => `<span>${d}</span>`).join('')}</div>
        <div class="cal-grid">${calendarCells()}</div>
        <div class="cal-key" aria-hidden="true"><span><i></i>Booked</span><span><i class="s-hoping"></i>Hoping to book</span><span><i class="s-done"></i>Done</span><span><i class="dot"></i>Booking opens</span></div>
        ${isThisMonth ? '' : '<button class="link-btn" data-action="cal-today">Back to this month</button>'}
      </section>

      ${windowsSection()}

      <section class="block">
        <div class="block-head">
          <h2>Coming up</h2>
          <button class="btn btn-primary btn-sm" data-action="new-trip">Add trip</button>
        </div>
        ${upcoming.length
          ? `<div class="trip-list">${upcoming.map(tripRow).join('')}</div>`
          : '<p class="empty">No trips on the books. Add your next stay, or tap a day on the calendar.</p>'}
      </section>

      ${past.length ? `<details class="past"><summary>Past and cancelled (${past.length})</summary><div class="trip-list">${past.map(tripRow).join('')}</div></details>` : ''}`;
    return { title: 'Trips', html };
  }

  function windowItems() {
    const today = todayKey();
    return state.trips
      .filter(t => t.status === 'hoping' && t.startDate >= today)
      .map(t => ({ t, cg: cgById(t.campgroundId) }))
      .map(x => Object.assign(x, { o: opensFor(x.cg, x.t.startDate) }))
      .filter(x => x.o)
      .sort((a, b) => a.o.at - b.o.at);
  }

  function windowsSection() {
    const items = windowItems();
    if (!items.length) return '';
    const cards = items.map(({ t, cg, o }) => {
      const open = o.at.getTime() <= Date.now();
      const nights = daysBetween(t.startDate, t.endDate);
      const site = siteById(t.siteId);
      const favs = sitesFor(cg.id);
      const siteTxt = site ? 'site ' + site.siteNumber : (favs.length ? 'favorites ' + favs.map(s => s.siteNumber).join(', ') : '');
      let meta = 'Arrive ' + dayLabel(t.startDate);
      if (nights > 0) meta += ', ' + nights + (nights === 1 ? ' night' : ' nights');
      if (siteTxt) meta += ', ' + siteTxt;
      return `
        <article class="window-card${open ? ' is-open' : ''}">
          <div class="window-when">
            <span class="window-count">${esc(countdownText(o.at))}</span>
            <span class="window-at">${open ? 'Opened ' : ''}${esc(dayLabel(o.key))} at ${esc(timeLabel(o.time))}</span>
          </div>
          <div class="window-trip">
            <span class="window-place">${esc(cg.name)}</span>
            <span class="window-meta">${esc(meta)}</span>
          </div>
          <div class="window-actions">
            ${bookingLink(cg, 'btn-sm')}
            ${open ? '' : `<a class="btn btn-ghost btn-sm" href="${esc(reminderLink(t, o, cg))}" target="_blank" rel="noopener">Add calendar reminder</a>`}
            <button class="text-btn" data-action="edit-trip" data-id="${t.id}">Edit trip</button>
          </div>
        </article>`;
    }).join('');
    return `
      <section class="block">
        <div class="block-head"><h2>Booking windows</h2></div>
        <div class="window-list">${cards}</div>
      </section>`;
  }

  function calendarCells() {
    const m = state.calMonth, y = m.getFullYear(), mo = m.getMonth();
    const first = new Date(y, mo, 1);
    const daysInMonth = new Date(y, mo + 1, 0).getDate();
    const weeks = Math.ceil((first.getDay() + daysInMonth) / 7);
    const today = todayKey();
    const active = state.trips.filter(t => t.status !== 'cancelled' && t.startDate && t.endDate);
    const opens = {};
    windowItems().forEach(x => { (opens[x.o.key] = opens[x.o.key] || []).push(x); });
    let out = '';

    for (let i = 0; i < weeks * 7; i++) {
      const d = new Date(y, mo, 1 - first.getDay() + i);
      const key = fmtKey(d);
      const here = active.filter(t => t.startDate <= key && key <= t.endDate);
      const bars = here.slice(0, 2).map(t => {
        const isStart = t.startDate === key, isEnd = t.endDate === key;
        let label = '';
        if (isStart || d.getDay() === 0) {
          const len = Math.min(daysBetween(key, t.endDate) + 1, 7 - d.getDay());
          label = `<span class="bar-label" style="width:calc(${len * 100}% - 10px)">${esc(shortPlace(t))}</span>`;
        }
        return `<span class="bar s-${t.status}${isStart ? ' is-start' : ''}${isEnd ? ' is-end' : ''}" data-action="edit-trip" data-id="${t.id}">${label}</span>`;
      }).join('');
      const more = here.length > 2 ? `<span class="more">+${here.length - 2}</span>` : '';
      const opening = opens[key] || [];
      const aria = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) +
        (here.length ? ', ' + here.map(shortPlace).join(', ') : '') +
        (opening.length ? ', booking opens for ' + opening.map(x => shortPlace(x.t)).join(', ') : '');
      out += `<button class="day${d.getMonth() !== mo ? ' is-out' : ''}${key === today ? ' is-today' : ''}" data-action="new-trip" data-date="${key}" aria-label="${esc(aria)}"><span class="day-num">${d.getDate()}</span>${opening.length ? '<span class="open-dot" aria-hidden="true"></span>' : ''}<span class="bars">${bars}${more}</span></button>`;
    }
    return out;
  }

  function tripRow(t) {
    const site = siteById(t.siteId);
    const siteTxt = site ? 'site ' + site.siteNumber : (t.siteLabel ? 'site ' + t.siteLabel : '');
    const nights = t.startDate && t.endDate ? daysBetween(t.startDate, t.endDate) : 0;
    const d = parseDate(t.startDate);
    let meta = rangeLabel(t.startDate, t.endDate);
    if (nights > 0) meta += ', ' + nights + (nights === 1 ? ' night' : ' nights');
    if (siteTxt) meta += ', ' + siteTxt;
    return `
      <button class="trip-row s-${esc(t.status)}" data-action="edit-trip" data-id="${t.id}">
        <span class="trip-date"><span class="trip-mo">${d.toLocaleDateString(undefined, { month: 'short' })}</span><span class="trip-dd">${d.getDate()}</span></span>
        <span class="trip-main"><span class="trip-place">${esc(placeName(t))}</span><span class="trip-meta">${esc(meta)}</span></span>
        <span class="chip chip-${esc(t.status)}">${STATUSES[t.status] || ''}</span>
      </button>`;
  }

  // ---------- Places views ----------
  function placesView() {
    const cards = state.campgrounds.map(cg => {
      const n = sitesFor(cg.id).length;
      const sys = SYSTEMS[cg.system] || SYSTEMS.other;
      const sub = [n ? n + (n === 1 ? ' favorite site' : ' favorite sites') : 'No sites saved yet', cg.system && cg.system !== 'other' ? sys.label : ''].filter(Boolean).join(', ');
      return `
        <a class="place-card" href="#/place/${cg.id}">
          <span class="place-photo">${cg.coverThumb ? `<img src="${cg.coverThumb}" alt="">` : ICON.tree}</span>
          <span class="place-body">
            <span class="place-name">${esc(cg.name)}</span>
            ${locationLine(cg) ? `<span class="place-meta">${esc(locationLine(cg))}</span>` : ''}
            <span class="place-sub">${esc(sub)}</span>
          </span>
        </a>`;
    }).join('');

    const html = `
      <div class="page-intro">
        <p>Campgrounds you go back to, and the sites you want.</p>
        <button class="btn btn-primary btn-sm" data-action="new-place">Add campground</button>
      </div>
      ${state.campgrounds.length
        ? `<div class="place-list">${cards}</div>`
        : '<p class="empty" style="margin-top:16px">Add a campground you love, like Doheny State Beach, then save your favorite sites under it.</p>'}`;
    return { title: 'Places', html };
  }

  function bookingLink(cg, size) {
    const sys = SYSTEMS[cg.system] || SYSTEMS.other;
    const url = safeUrl(cg.bookingUrl) || sys.url;
    if (!url) return '';
    const label = cg.system && cg.system !== 'other' ? 'Book on ' + sys.label : 'Booking site';
    return `<a class="btn btn-primary${size ? ' ' + size : ''}" href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a>`;
  }

  function placeView(id) {
    const cg = cgById(id);
    if (!cg) return notFound('#/places');
    const sites = sitesFor(id);
    const today = todayKey();
    const trips = state.trips.filter(t => t.campgroundId === id && t.endDate >= today && t.status !== 'cancelled');
    const info = safeUrl(cg.infoUrl);

    const html = `
      ${cg.coverThumb ? `<div class="hero-photo"><img src="${cg.coverThumb}" alt=""></div>` : ''}
      <div class="place-head">
        <h2 class="place-title">${esc(cg.name)}</h2>
        ${locationLine(cg) ? `<p class="muted">${esc(locationLine(cg))}</p>` : ''}
      </div>
      <div class="btn-row">
        ${bookingLink(cg)}
        ${info ? `<a class="btn btn-ghost" href="${esc(info)}" target="_blank" rel="noopener">Park info</a>` : ''}
        <button class="btn btn-ghost" data-action="new-trip" data-cg="${id}">Add trip</button>
      </div>
      ${cg.notes ? `<p class="notes">${esc(cg.notes)}</p>` : ''}

      <section class="block">
        <div class="block-head"><h3>Favorite sites</h3><button class="btn btn-ghost btn-sm" data-action="new-site" data-cg="${id}">Add site</button></div>
        ${sites.length
          ? `<div class="site-list">${sites.map(siteRow).join('')}</div>`
          : '<p class="empty">Save the sites you like here, with photos, so you know exactly which ones to grab.</p>'}
      </section>

      ${plannerSection(cg)}

      ${trips.length ? `<section class="block"><div class="block-head"><h3>Upcoming here</h3></div><div class="trip-list">${trips.map(tripRow).join('')}</div></section>` : ''}

      <section class="block">
        <div class="block-head"><h3>Photos</h3><button class="btn btn-ghost btn-sm" data-action="add-photo" data-type="campground" data-id="${id}">Add photos</button></div>
        <div class="photo-grid" id="photos-campground-${id}">${photoGridHTML('campground', id)}</div>
      </section>`;

    return {
      title: cg.shortName || cg.name,
      back: '#/places',
      actions: `<button class="text-btn" data-action="edit-place" data-id="${id}">Edit</button>`,
      html,
      after: () => loadPhotos('campground', id)
    };
  }

  function plannerSection(cg) {
    const w = windowFor(cg);
    if (!w) return '';
    const today = todayKey();
    const todayOpen = pacificMoment(today, w.time).getTime() <= Date.now();
    // The furthest arrival you can book right now
    const reachable = shiftMonths(todayOpen ? today : addDays(today, -1), w.months);
    const firstNotOpen = addDays(reachable, 1);
    let fri = parseDate(firstNotOpen);
    fri.setDate(fri.getDate() + ((5 - fri.getDay() + 7) % 7));
    const rows = [];
    for (let i = 0; i < 4; i++) {
      const arrive = fmtKey(new Date(fri.getFullYear(), fri.getMonth(), fri.getDate() + i * 7));
      const o = opensFor(cg, arrive);
      rows.push(`
        <li class="plan-row">
          <span class="plan-arrive">Arrive ${esc(dayLabel(arrive))}</span>
          <span class="plan-opens">Book ${esc(dayLabel(o.key))}, ${esc(timeLabel(o.time))}</span>
          <button class="btn btn-ghost btn-sm" data-action="new-trip" data-cg="${cg.id}" data-date="${arrive}" data-status="hoping">Plan it</button>
        </li>`);
    }
    return `
      <section class="block">
        <div class="block-head"><h3>Booking window</h3></div>
        <p class="plan-rule">Arrival dates open ${w.months} months ahead at ${esc(timeLabel(w.time))} Pacific. Right now you can book arrivals through ${esc(dayLabel(reachable))}.</p>
        <ul class="plan-list">${rows.join('')}</ul>
      </section>`;
  }

  function fitsBadge(s) {
    const rig = Number(state.settings.rigLength) || 0;
    const max = Number(s.maxLength) || 0;
    if (!rig || !max) return '';
    return max >= rig
      ? `<span class="badge badge-fit">Fits ${rig} ft</span>`
      : `<span class="badge badge-warn">Max ${max} ft</span>`;
  }

  function siteBadges(s) {
    return [
      fitsBadge(s),
      s.hookups ? `<span class="badge">${esc(HOOKUPS[s.hookups] || '')}</span>` : '',
      s.shade ? `<span class="badge">${esc(SHADE[s.shade] || '')}</span>` : ''
    ].join('');
  }

  function siteRow(s) {
    return `
      <a class="site-row" href="#/site/${s.id}">
        <span class="post" aria-hidden="true">${esc(s.siteNumber)}</span>
        <span class="site-info">
          <span class="site-title">Site ${esc(s.siteNumber)}${s.loop ? `<span class="muted">, ${esc(s.loop)}</span>` : ''}</span>
          <span class="badges">${siteBadges(s)}</span>
        </span>
        ${s.coverThumb ? `<img class="site-thumb" src="${s.coverThumb}" alt="">` : ''}
      </a>`;
  }

  function siteView(id) {
    const s = siteById(id);
    if (!s) return notFound('#/places');
    const cg = cgById(s.campgroundId);
    const trips = state.trips.filter(t => t.siteId === id).slice().reverse();

    const html = `
      ${s.coverThumb ? `<div class="hero-photo"><img src="${s.coverThumb}" alt=""></div>` : ''}
      <div class="site-hero">
        <span class="post post-lg" aria-hidden="true">${esc(s.siteNumber)}</span>
        <div>
          ${cg ? `<p><a href="#/place/${cg.id}">${esc(cg.name)}</a></p>` : ''}
          <h2 class="place-title">Site ${esc(s.siteNumber)}</h2>
          ${s.loop ? `<p class="muted">${esc(s.loop)}</p>` : ''}
        </div>
      </div>
      <div class="badges">${siteBadges(s)}</div>
      <dl class="facts">
        <dt>Max length</dt><dd>${s.maxLength ? esc(s.maxLength) + ' ft' : 'Not noted'}</dd>
        <dt>Hookups</dt><dd>${esc(HOOKUPS[s.hookups || ''])}</dd>
        <dt>Shade</dt><dd>${esc(SHADE[s.shade || ''])}</dd>
      </dl>
      ${s.notes ? `<p class="notes">${esc(s.notes)}</p>` : ''}
      <div class="btn-row">
        ${cg ? bookingLink(cg) : ''}
        <button class="btn btn-ghost" data-action="new-trip" data-site="${id}">Add trip here</button>
      </div>

      <section class="block">
        <div class="block-head"><h3>Photos</h3><button class="btn btn-ghost btn-sm" data-action="add-photo" data-type="site" data-id="${id}">Add photos</button></div>
        <div class="photo-grid" id="photos-site-${id}">${photoGridHTML('site', id)}</div>
      </section>

      <section class="block">
        <div class="block-head"><h3>Trips at this site</h3></div>
        ${trips.length ? `<div class="trip-list">${trips.map(tripRow).join('')}</div>` : '<p class="empty">No trips logged here yet.</p>'}
      </section>`;

    return {
      title: 'Site ' + s.siteNumber,
      back: cg ? '#/place/' + cg.id : '#/places',
      actions: `<button class="text-btn" data-action="edit-site" data-id="${id}">Edit</button>`,
      html,
      after: () => loadPhotos('site', id)
    };
  }

  // ---------- Settings ----------
  function settingsView() {
    const st = state.settings;
    const html = `
      <section class="panel">
        <h2>Your rig</h2>
        <form class="form" id="settings-form">
          <label class="field"><span>Name or description</span><input name="rigName" value="${esc(st.rigName || '')}" placeholder="e.g. 26 ft travel trailer"></label>
          <label class="field"><span>Length in feet <span class="hint">Used to flag which sites fit</span></span><input name="rigLength" type="number" inputmode="numeric" min="0" max="60" value="${esc(st.rigLength || '')}"></label>
          <button class="btn btn-primary" type="submit">Save rig</button>
        </form>
      </section>
      <section class="panel">
        <h2>Account</h2>
        <p class="muted">Signed in as ${esc(state.user.email || state.user.displayName || 'you')}</p>
        <button class="btn btn-ghost" data-action="sign-out">Sign out</button>
      </section>
      <p class="muted small" style="margin-top:20px">Siteline 1.1</p>`;
    return {
      title: 'Settings',
      html,
      after: () => {
        $('#settings-form').addEventListener('submit', async e => {
          e.preventDefault();
          const f = e.target;
          const settings = { rigName: f.rigName.value.trim(), rigLength: Number(f.rigLength.value) || 0 };
          try {
            await userRef().set({ settings }, { merge: true });
            state.settings = settings;
            toast('Rig saved');
          } catch (err) {
            console.error(err);
            toast('Rig did not save. Check your connection.');
          }
        });
      }
    };
  }

  // ---------- Sheets ----------
  function openSheet(title, html, mount) {
    const wrap = document.createElement('div');
    wrap.className = 'sheet-backdrop';
    wrap.innerHTML = `
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
        <div class="sheet-head"><h2 id="sheet-title">${esc(title)}</h2><button type="button" class="text-btn" data-close>Cancel</button></div>
        <div class="sheet-body">${html}</div>
      </div>`;
    document.body.appendChild(wrap);
    lockScroll();
    const onKey = e => { if (e.key === 'Escape') close(); };
    function close() {
      if (!wrap.isConnected) return;
      wrap.remove();
      unlockScroll();
      document.removeEventListener('keydown', onKey);
    }
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('click', e => {
      if (e.target === wrap || e.target.closest('[data-close]')) close();
    });
    if (mount) mount(wrap.querySelector('.sheet-body'), close);
    return close;
  }

  function showFormError(form, msg) {
    const el = form.querySelector('.form-error');
    el.textContent = msg;
    el.hidden = false;
  }

  // ---------- Trip form ----------
  function openTripForm(trip, preset) {
    preset = preset || {};
    let cgId = trip ? (trip.campgroundId || '') : (preset.cg || '');
    let siteId = trip ? (trip.siteId || '') : (preset.site || '');
    if (siteId && !cgId) { const s = siteById(siteId); if (s) cgId = s.campgroundId; }
    const start = trip ? trip.startDate : (preset.date || '');
    const end = trip ? trip.endDate : (preset.date ? addDays(preset.date, 2) : '');
    const status = trip ? trip.status : (preset.status || 'booked');
    const t = trip || {};

    const cgOpts = state.campgrounds.map(c => `<option value="${c.id}"${c.id === cgId ? ' selected' : ''}>${esc(c.name)}</option>`).join('') +
      `<option value=""${cgId ? '' : ' selected'}>Somewhere else</option>`;
    const statusOpts = Object.keys(STATUSES).map(k => `<option value="${k}"${k === status ? ' selected' : ''}>${STATUSES[k]}</option>`).join('');

    const html = `
      <form class="form" id="trip-form" novalidate>
        <label class="field"><span>Campground</span><select name="campgroundId">${cgOpts}</select></label>
        <label class="field" data-part="place"><span>Place name</span><input name="placeName" value="${esc(t.placeName || '')}" placeholder="e.g. Pismo Coast Village"></label>
        <label class="field" data-part="site-select"><span>Site</span><select name="siteId"></select></label>
        <label class="field" data-part="site-text"><span>Site number <span class="hint">Leave blank if not picked yet</span></span><input name="siteLabel" value="${esc(t.siteLabel || '')}"></label>
        <div class="field-row">
          <label class="field"><span>Arrive</span><input type="date" name="startDate" value="${esc(start)}"></label>
          <label class="field"><span>Leave</span><input type="date" name="endDate" value="${esc(end)}"></label>
        </div>
        <p class="window-hint" data-part="window" hidden></p>
        <label class="field"><span>Status</span><select name="status">${statusOpts}</select></label>
        <div class="field-row">
          <label class="field"><span>Confirmation number</span><input name="confirmation" value="${esc(t.confirmation || '')}" autocapitalize="characters"></label>
          <label class="field"><span>Cost</span><input name="cost" inputmode="decimal" value="${esc(t.cost || '')}" placeholder="$"></label>
        </div>
        <label class="field"><span>Notes</span><textarea name="notes" rows="3">${esc(t.notes || '')}</textarea></label>
        <p class="form-error" role="alert" hidden></p>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">${trip ? 'Save trip' : 'Add trip'}</button>
          ${trip ? '<button type="button" class="btn btn-danger-ghost" data-del>Delete trip</button>' : ''}
        </div>
      </form>`;

    openSheet(trip ? 'Edit trip' : 'New trip', html, (body, close) => {
      const f = $('#trip-form', body);
      const partPlace = $('[data-part="place"]', body);
      const partSiteSel = $('[data-part="site-select"]', body);
      const partSiteText = $('[data-part="site-text"]', body);

      function syncSites(keepSite) {
        const c = f.campgroundId.value;
        partPlace.hidden = !!c;
        const sites = c ? sitesFor(c) : [];
        const wanted = keepSite || '';
        f.siteId.innerHTML = sites.map(s => `<option value="${s.id}">Site ${esc(s.siteNumber)}${s.loop ? ', ' + esc(s.loop) : ''}</option>`).join('') +
          `<option value="">${sites.length ? 'Another site, or not picked yet' : 'Not picked yet'}</option>`;
        f.siteId.value = sites.some(s => s.id === wanted) ? wanted : '';
        partSiteSel.hidden = !c || !sites.length;
        partSiteText.hidden = !!(c && f.siteId.value);
      }
      const partWindow = $('[data-part="window"]', body);
      function syncWindow() {
        const o = opensFor(cgById(f.campgroundId.value), f.startDate.value);
        partWindow.hidden = !o;
        if (!o) return;
        partWindow.textContent = o.at.getTime() <= Date.now()
          ? 'Booking for this arrival opened ' + dayLabel(o.key) + '.'
          : 'Booking for this arrival opens ' + dayLabel(o.key) + ' at ' + timeLabel(o.time) + ' Pacific.';
      }
      syncSites(siteId);
      syncWindow();
      f.campgroundId.addEventListener('change', () => { syncSites(''); syncWindow(); });
      f.startDate.addEventListener('change', syncWindow);
      f.siteId.addEventListener('change', () => { partSiteText.hidden = !!f.siteId.value; });
      f.startDate.addEventListener('change', () => {
        if (f.startDate.value && (!f.endDate.value || f.endDate.value < f.startDate.value)) f.endDate.value = addDays(f.startDate.value, 2);
      });

      f.addEventListener('submit', async e => {
        e.preventDefault();
        const c = f.campgroundId.value;
        const sid = c ? f.siteId.value : '';
        const data = {
          campgroundId: c || null,
          placeName: c ? '' : f.placeName.value.trim(),
          siteId: sid || null,
          siteLabel: sid ? '' : f.siteLabel.value.trim(),
          startDate: f.startDate.value,
          endDate: f.endDate.value,
          status: f.status.value,
          confirmation: f.confirmation.value.trim(),
          cost: f.cost.value.trim(),
          notes: f.notes.value.trim(),
          updatedAt: FV.serverTimestamp()
        };
        if (!c && !data.placeName) return showFormError(f, 'Pick a campground or type the place name.');
        if (!data.startDate || !data.endDate) return showFormError(f, 'Add both an arrive date and a leave date.');
        if (data.endDate < data.startDate) return showFormError(f, 'The leave date needs to be on or after the arrive date.');
        const btn = f.querySelector('[type="submit"]');
        btn.disabled = true;
        try {
          if (trip) await col('trips').doc(trip.id).update(data);
          else { data.createdAt = FV.serverTimestamp(); await col('trips').add(data); }
          close();
          toast(trip ? 'Trip saved' : 'Trip added');
          const sd = parseDate(data.startDate);
          if (!trip && state.route.name === 'trips') { state.calMonth = firstOfMonth(sd); render(); }
        } catch (err) {
          console.error(err);
          btn.disabled = false;
          showFormError(f, 'The trip did not save. Check your connection and try again.');
        }
      });

      const del = $('[data-del]', body);
      if (del) del.addEventListener('click', async () => {
        if (!confirm('Delete this trip?')) return;
        try {
          await col('trips').doc(trip.id).delete();
          close();
          toast('Trip deleted');
        } catch (err) {
          console.error(err);
          showFormError(f, 'The trip did not delete. Check your connection and try again.');
        }
      });
    });
  }

  // ---------- Campground form ----------
  function openPlaceForm(cg) {
    const c = cg || { state: 'CA', system: 'rc' };
    const sysOpts = Object.keys(SYSTEMS).map(k => `<option value="${k}"${k === (c.system || 'other') ? ' selected' : ''}>${SYSTEMS[k].label}</option>`).join('');
    const html = `
      <form class="form" id="place-form" novalidate>
        <label class="field"><span>Campground name</span><input name="name" value="${esc(c.name || '')}" placeholder="e.g. Doheny State Beach"></label>
        <label class="field"><span>Short name <span class="hint">Shown on the calendar</span></span><input name="shortName" value="${esc(c.shortName || '')}" placeholder="e.g. Doheny"></label>
        <div class="field-row">
          <label class="field"><span>Town or area</span><input name="area" value="${esc(c.area || '')}" placeholder="e.g. Dana Point"></label>
          <label class="field" style="flex:0 0 90px"><span>State</span><input name="state" value="${esc(c.state || '')}" maxlength="2" autocapitalize="characters"></label>
        </div>
        <label class="field"><span>Reservation system</span><select name="system">${sysOpts}</select></label>
        <div class="field-row">
          <label class="field"><span>Booking opens <span class="hint">Months ahead</span></span><input name="windowMonths" type="number" inputmode="numeric" min="0" max="24" value="${esc(windowFor(c) ? windowFor(c).months : '')}"></label>
          <label class="field"><span>At <span class="hint">Pacific time</span></span><input name="windowTime" type="time" value="${esc(windowFor(c) ? windowFor(c).time : '')}"></label>
        </div>
        <label class="field"><span>Booking link <span class="hint">The page you book this campground on</span></span><input name="bookingUrl" type="url" inputmode="url" value="${esc(c.bookingUrl || '')}" placeholder="https://"></label>
        <label class="field"><span>Park info link</span><input name="infoUrl" type="url" inputmode="url" value="${esc(c.infoUrl || '')}" placeholder="https://"></label>
        <label class="field"><span>Notes</span><textarea name="notes" rows="4" placeholder="Check-in time, gate codes, which loops to avoid">${esc(c.notes || '')}</textarea></label>
        <p class="form-error" role="alert" hidden></p>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">${cg ? 'Save campground' : 'Add campground'}</button>
          ${cg ? '<button type="button" class="btn btn-danger-ghost" data-del>Delete campground</button>' : ''}
        </div>
      </form>`;

    openSheet(cg ? 'Edit campground' : 'New campground', html, (body, close) => {
      const f = $('#place-form', body);
      f.system.addEventListener('change', () => {
        const d = WINDOW_DEFAULTS[f.system.value] || WINDOW_DEFAULTS.other;
        f.windowMonths.value = d.months || '';
        f.windowTime.value = d.time;
      });
      f.addEventListener('submit', async e => {
        e.preventDefault();
        const data = {
          name: f.name.value.trim(),
          shortName: f.shortName.value.trim(),
          area: f.area.value.trim(),
          state: f.state.value.trim().toUpperCase(),
          system: f.system.value,
          bookingUrl: f.bookingUrl.value.trim(),
          infoUrl: f.infoUrl.value.trim(),
          windowMonths: f.windowMonths.value === '' ? 0 : Number(f.windowMonths.value),
          windowTime: f.windowTime.value,
          notes: f.notes.value.trim(),
          updatedAt: FV.serverTimestamp()
        };
        if (!data.name) return showFormError(f, 'Give the campground a name.');
        if (data.bookingUrl && !safeUrl(data.bookingUrl)) return showFormError(f, 'The booking link needs to start with https://');
        if (data.infoUrl && !safeUrl(data.infoUrl)) return showFormError(f, 'The park info link needs to start with https://');
        const btn = f.querySelector('[type="submit"]');
        btn.disabled = true;
        try {
          if (cg) {
            await col('campgrounds').doc(cg.id).update(data);
            close(); toast('Campground saved');
          } else {
            data.createdAt = FV.serverTimestamp();
            const ref = await col('campgrounds').add(data);
            close(); toast('Campground added');
            location.hash = '#/place/' + ref.id;
          }
        } catch (err) {
          console.error(err);
          btn.disabled = false;
          showFormError(f, 'The campground did not save. Check your connection and try again.');
        }
      });
      const del = $('[data-del]', body);
      if (del) del.addEventListener('click', async () => {
        if (!confirm(`Delete ${cg.name}, its saved sites, and their photos? Trips stay on your calendar.`)) return;
        del.disabled = true;
        try {
          await deleteCampground(cg);
          close();
          location.hash = '#/places';
          toast('Campground deleted');
        } catch (err) {
          console.error(err);
          del.disabled = false;
          showFormError(f, 'The campground did not delete. Check your connection and try again.');
        }
      });
    });
  }

  async function photoDeleteOps(type, id, ops) {
    const snap = await col('photos').where('ownerType', '==', type).where('ownerId', '==', id).get();
    snap.docs.forEach(d => {
      ops.push(b => b.delete(d.ref));
      ops.push(b => b.delete(col('photoFull').doc(d.id)));
    });
  }

  async function deleteCampground(cg) {
    const sites = sitesFor(cg.id);
    const ops = [];
    await photoDeleteOps('campground', cg.id, ops);
    for (const s of sites) {
      await photoDeleteOps('site', s.id, ops);
      ops.push(b => b.delete(col('sites').doc(s.id)));
    }
    // Keep trip history readable after the campground is gone.
    state.trips.filter(t => t.campgroundId === cg.id).forEach(t => {
      const s = siteById(t.siteId);
      ops.push(b => b.update(col('trips').doc(t.id), {
        campgroundId: null, placeName: cg.name, siteId: null, siteLabel: s ? String(s.siteNumber) : (t.siteLabel || '')
      }));
    });
    ops.push(b => b.delete(col('campgrounds').doc(cg.id)));
    await runOps(ops);
  }

  // ---------- Site form ----------
  function openSiteForm(site, cgId) {
    const s = site || { campgroundId: cgId };
    const cg = cgById(s.campgroundId);
    const opts = (map, val) => Object.keys(map).map(k => `<option value="${k}"${k === (val || '') ? ' selected' : ''}>${map[k]}</option>`).join('');
    const html = `
      <form class="form" id="site-form" novalidate>
        ${cg ? `<p class="muted" style="margin:0">${esc(cg.name)}</p>` : ''}
        <div class="field-row">
          <label class="field"><span>Site number</span><input name="siteNumber" value="${esc(s.siteNumber || '')}" placeholder="e.g. 22" autocapitalize="characters"></label>
          <label class="field"><span>Max length (ft)</span><input name="maxLength" type="number" inputmode="numeric" min="0" max="80" value="${esc(s.maxLength || '')}"></label>
        </div>
        <label class="field"><span>Loop or area</span><input name="loop" value="${esc(s.loop || '')}" placeholder="e.g. Beachfront row"></label>
        <div class="field-row">
          <label class="field"><span>Hookups</span><select name="hookups">${opts(HOOKUPS, s.hookups)}</select></label>
          <label class="field"><span>Shade</span><select name="shade">${opts(SHADE, s.shade)}</select></label>
        </div>
        <label class="field"><span>Notes</span><textarea name="notes" rows="4" placeholder="Ocean view, how level it is, distance to restrooms">${esc(s.notes || '')}</textarea></label>
        <p class="form-error" role="alert" hidden></p>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">${site ? 'Save site' : 'Add site'}</button>
          ${site ? '<button type="button" class="btn btn-danger-ghost" data-del>Delete site</button>' : ''}
        </div>
      </form>`;

    openSheet(site ? 'Edit site' : 'New favorite site', html, (body, close) => {
      const f = $('#site-form', body);
      f.addEventListener('submit', async e => {
        e.preventDefault();
        const data = {
          campgroundId: s.campgroundId,
          siteNumber: f.siteNumber.value.trim(),
          maxLength: Number(f.maxLength.value) || null,
          loop: f.loop.value.trim(),
          hookups: f.hookups.value,
          shade: f.shade.value,
          notes: f.notes.value.trim(),
          updatedAt: FV.serverTimestamp()
        };
        if (!data.siteNumber) return showFormError(f, 'Add the site number.');
        const btn = f.querySelector('[type="submit"]');
        btn.disabled = true;
        try {
          if (site) {
            await col('sites').doc(site.id).update(data);
            close(); toast('Site saved');
          } else {
            data.createdAt = FV.serverTimestamp();
            const ref = await col('sites').add(data);
            close(); toast('Site added');
            location.hash = '#/site/' + ref.id;
          }
        } catch (err) {
          console.error(err);
          btn.disabled = false;
          showFormError(f, 'The site did not save. Check your connection and try again.');
        }
      });
      const del = $('[data-del]', body);
      if (del) del.addEventListener('click', async () => {
        if (!confirm(`Delete site ${site.siteNumber} and its photos? Trips stay on your calendar.`)) return;
        del.disabled = true;
        try {
          const ops = [];
          await photoDeleteOps('site', site.id, ops);
          state.trips.filter(t => t.siteId === site.id).forEach(t => {
            ops.push(b => b.update(col('trips').doc(t.id), { siteId: null, siteLabel: String(site.siteNumber) }));
          });
          ops.push(b => b.delete(col('sites').doc(site.id)));
          await runOps(ops);
          close();
          location.hash = '#/place/' + site.campgroundId;
          toast('Site deleted');
        } catch (err) {
          console.error(err);
          del.disabled = false;
          showFormError(f, 'The site did not delete. Check your connection and try again.');
        }
      });
    });
  }

  // ---------- Photos ----------
  // Photos live in Firestore (no Firebase Storage needed, so the project can stay on the free plan).
  // photos/{id} holds a small image for grids and covers; photoFull/{id} holds the larger one for the viewer.
  const photoKey = (type, id) => type + ':' + id;

  function photoGridHTML(type, id) {
    const list = state.photos[photoKey(type, id)];
    if (list === undefined || list === 'loading') return '<p class="muted small">Loading photos…</p>';
    if (!list.length) return '<p class="empty">No photos yet. Add a few so you remember what this one looks like.</p>';
    return list.map(p => `<button class="photo-tile" data-action="open-photo" data-type="${type}" data-owner="${id}" data-id="${p.id}" aria-label="Open photo"><img src="${p.thumb}" alt="" loading="lazy"></button>`).join('');
  }

  function refreshGrid(type, id) {
    const el = document.getElementById('photos-' + type + '-' + id);
    if (el) el.innerHTML = photoGridHTML(type, id);
  }

  async function loadPhotos(type, id, force) {
    const k = photoKey(type, id);
    if (!force && state.photos[k] !== undefined) return;
    state.photos[k] = 'loading';
    try {
      const snap = await col('photos').where('ownerType', '==', type).where('ownerId', '==', id).get();
      state.photos[k] = snap.docs.map(d => Object.assign({ id: d.id }, d.data())).sort((a, b) => tsMs(a.createdAt) - tsMs(b.createdAt));
    } catch (err) {
      console.error(err);
      state.photos[k] = [];
      toast('Photos did not load. Check your connection.');
    }
    refreshGrid(type, id);
  }

  function ownerOf(type, id) {
    return type === 'campground' ? cgById(id) : siteById(id);
  }
  function ownerRef(type, id) {
    return col(type === 'campground' ? 'campgrounds' : 'sites').doc(id);
  }

  async function loadImage(file) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    try { await img.decode(); } catch (e) { URL.revokeObjectURL(url); throw e; }
    return { img, done: () => URL.revokeObjectURL(url) };
  }
  function toJpeg(img, maxDim, quality) {
    const w0 = img.naturalWidth, h0 = img.naturalHeight;
    const scale = Math.min(1, maxDim / Math.max(w0, h0));
    const c = document.createElement('canvas');
    c.width = Math.round(w0 * scale);
    c.height = Math.round(h0 * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
  }
  async function processPhoto(file) {
    const { img, done } = await loadImage(file);
    try {
      let full = '';
      for (const [dim, q] of [[1600, 0.78], [1400, 0.7], [1200, 0.65], [1000, 0.6], [800, 0.55]]) {
        full = toJpeg(img, dim, q);
        if (full.length < 900000) break; // Firestore documents max out at 1 MB
      }
      const thumb = toJpeg(img, 800, 0.66);
      return { full, thumb };
    } finally { done(); }
  }

  let pendingOwner = null;
  const photoInput = $('#photo-input');
  photoInput.addEventListener('change', async () => {
    const files = Array.from(photoInput.files || []);
    photoInput.value = '';
    const owner = pendingOwner;
    pendingOwner = null;
    if (!owner || !files.length) return;
    const { type, id } = owner;
    const k = photoKey(type, id);
    if (!Array.isArray(state.photos[k])) await loadPhotos(type, id, true);
    let hasCover = !!(ownerOf(type, id) || {}).coverPhotoId;
    let added = 0;
    toast(files.length === 1 ? 'Adding photo…' : `Adding ${files.length} photos…`, true);
    for (const file of files) {
      try {
        const { full, thumb } = await processPhoto(file);
        const ref = col('photos').doc();
        const b = db.batch();
        b.set(ref, { ownerType: type, ownerId: id, thumb, createdAt: FV.serverTimestamp() });
        b.set(col('photoFull').doc(ref.id), { data: full });
        if (!hasCover) b.update(ownerRef(type, id), { coverPhotoId: ref.id, coverThumb: thumb });
        await b.commit();
        hasCover = true;
        added++;
        if (Array.isArray(state.photos[k])) state.photos[k].push({ id: ref.id, ownerType: type, ownerId: id, thumb, createdAt: null });
        refreshGrid(type, id);
      } catch (err) {
        console.error('Photo failed', err);
      }
    }
    if (added === files.length) toast(added === 1 ? 'Photo added' : added + ' photos added');
    else toast(`${added} of ${files.length} photos added. Try the others again.`);
  });

  function openPhoto(type, ownerId, photoId) {
    const k = photoKey(type, ownerId);
    const list = Array.isArray(state.photos[k]) ? state.photos[k] : [];
    const p = list.find(x => x.id === photoId);
    if (!p) return;
    const owner = ownerOf(type, ownerId);
    const isCover = owner && owner.coverPhotoId === photoId;

    const el = document.createElement('div');
    el.className = 'viewer';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Photo');
    el.innerHTML = `
      <div class="viewer-bar">
        <button class="viewer-btn" data-v="close">Close</button>
        <div class="viewer-actions">
          ${isCover ? '<span class="viewer-note">Cover photo</span>' : '<button class="viewer-btn" data-v="cover">Use as cover</button>'}
          <button class="viewer-btn danger" data-v="delete">Delete</button>
        </div>
      </div>
      <div class="viewer-stage"><img src="${p.thumb}" alt=""></div>`;
    document.body.appendChild(el);
    lockScroll();

    const onKey = e => { if (e.key === 'Escape') close(); };
    function close() {
      if (!el.isConnected) return;
      el.remove();
      unlockScroll();
      document.removeEventListener('keydown', onKey);
    }
    document.addEventListener('keydown', onKey);

    el.addEventListener('click', async e => {
      if (e.target.classList.contains('viewer-stage')) return close();
      const btn = e.target.closest('[data-v]');
      if (!btn) return;
      const v = btn.dataset.v;
      if (v === 'close') return close();
      if (v === 'cover') {
        try {
          await ownerRef(type, ownerId).update({ coverPhotoId: p.id, coverThumb: p.thumb });
          close(); toast('Cover photo updated');
        } catch (err) { console.error(err); toast('Cover did not update. Check your connection.'); }
      }
      if (v === 'delete') {
        if (!confirm('Delete this photo?')) return;
        try {
          const b = db.batch();
          b.delete(col('photos').doc(p.id));
          b.delete(col('photoFull').doc(p.id));
          const o = ownerOf(type, ownerId);
          if (o && o.coverPhotoId === p.id) {
            const next = list.find(x => x.id !== p.id);
            b.update(ownerRef(type, ownerId), next
              ? { coverPhotoId: next.id, coverThumb: next.thumb }
              : { coverPhotoId: FV.delete(), coverThumb: FV.delete() });
          }
          await b.commit();
          state.photos[k] = list.filter(x => x.id !== p.id);
          refreshGrid(type, ownerId);
          close(); toast('Photo deleted');
        } catch (err) { console.error(err); toast('Photo did not delete. Check your connection.'); }
      }
    });

    col('photoFull').doc(p.id).get().then(snap => {
      if (snap.exists && el.isConnected) $('.viewer-stage img', el).src = snap.data().data;
    }).catch(err => console.error(err));
  }

  // ---------- Click handling ----------
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const a = el.dataset.action;
    const id = el.dataset.id;
    switch (a) {
      case 'sign-in': signIn(); break;
      case 'sign-out':
        if (confirm('Sign out of Siteline?')) auth.signOut();
        break;
      case 'cal-prev':
        state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() - 1, 1); renderNow(); break;
      case 'cal-next':
        state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + 1, 1); renderNow(); break;
      case 'cal-today':
        state.calMonth = firstOfMonth(new Date()); renderNow(); break;
      case 'new-trip':
        openTripForm(null, { date: el.dataset.date, cg: el.dataset.cg, site: el.dataset.site, status: el.dataset.status }); break;
      case 'edit-trip': {
        const t = tripById(id);
        if (t) openTripForm(t);
        break;
      }
      case 'new-place': openPlaceForm(null); break;
      case 'edit-place': { const cg = cgById(id); if (cg) openPlaceForm(cg); break; }
      case 'new-site': openSiteForm(null, el.dataset.cg); break;
      case 'edit-site': { const s = siteById(id); if (s) openSiteForm(s); break; }
      case 'add-photo':
        pendingOwner = { type: el.dataset.type, id };
        photoInput.click();
        break;
      case 'open-photo': openPhoto(el.dataset.type, el.dataset.owner, id); break;
    }
  });

  // Keep countdowns current
  setInterval(() => {
    if (state.user && !document.hidden && (state.route.name === 'trips' || state.route.name === 'place')) render();
  }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.user) render(); });

  // ---------- Service worker ----------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(err => console.error('Service worker failed', err));
    });
  }
})();
