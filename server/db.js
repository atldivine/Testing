// Bookings + shop settings in a single SQLite file (data/shop.db), using Node's built-in sqlite.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new DatabaseSync(path.join(config.dataDir, 'shop.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    status TEXT NOT NULL,            -- pending_payment | paid | confirmed | declined | completed | no_show | expired | cancelled
    date TEXT NOT NULL,              -- YYYY-MM-DD, shop time
    time TEXT NOT NULL,              -- HH:MM drop-off
    service TEXT NOT NULL,
    vehicle TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT NOT NULL,
    deposit_cents INTEGER NOT NULL,
    hold_expires_at INTEGER,
    stripe_session_id TEXT,
    stripe_payment_intent TEXT,
    paid_at INTEGER,
    refunded INTEGER NOT NULL DEFAULT 0,
    admin_note TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS bookings_date ON bookings(date, status);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS repair_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    stage TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS repair_events_booking ON repair_events(booking_id, at);
  -- receipts the shop writes up and files it attaches (invoice photos, PDFs, inspection reports), shown on the tracker
  CREATE TABLE IF NOT EXISTS records (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    kind TEXT NOT NULL,              -- receipt | file
    title TEXT NOT NULL,
    file TEXT,                       -- files: stored name under <dataDir>/records/
    mime TEXT,
    size INTEGER,
    data TEXT,                       -- receipts: JSON { items: [{ desc, cents }], paidCents, method, note }
    sent_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS records_booking ON records(booking_id, created_at);
`);
const recordsDir = path.join(config.dataDir, 'records');
fs.mkdirSync(recordsDir, { recursive: true });

// repair tracking columns, added in place on older databases
const cols = new Set(db.prepare('PRAGMA table_info(bookings)').all().map((c) => c.name));
for (const [name, type] of [['code', 'TEXT'], ['stage', "TEXT NOT NULL DEFAULT 'booked'"], ['stage_note', "TEXT NOT NULL DEFAULT ''"],
  ['car_year', "TEXT NOT NULL DEFAULT ''"], ['car_make', "TEXT NOT NULL DEFAULT ''"], ['car_model', "TEXT NOT NULL DEFAULT ''"],
  // manual bookings: entered by the shop in the dashboard, deposit taken in person (cash, card...), not collected, or waived
  ['source', "TEXT NOT NULL DEFAULT 'online'"], ['pay_method', "TEXT NOT NULL DEFAULT ''"]]) {
  if (!cols.has(name)) db.exec(`ALTER TABLE bookings ADD COLUMN ${name} ${type}`);
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS bookings_code ON bookings(code)');

/* ---------- repair stages (what the customer sees on the tracker) ---------- */
const STAGES = [
  { id: 'booked', label: 'Booked', blurb: 'Your appointment is on the calendar.' },
  { id: 'diagnosing', label: 'Estimate', blurb: 'We are inspecting the damage and writing up the estimate.' },
  { id: 'waiting_parts', label: 'Approval & parts', blurb: 'Waiting on insurance or your approval, and on parts. Work starts as soon as both are in.' },
  { id: 'in_repair', label: 'Body & paint', blurb: 'Bodywork, refinishing and paint are underway.' },
  { id: 'ready', label: 'Ready for pickup', blurb: 'Repaired, cleaned and checked. Settle any balance and pick it up.' },
  { id: 'picked_up', label: 'Picked up', blurb: 'Thanks for trusting Good Shepard Auto Body with your car.' },
];
const STAGE_IDS = STAGES.map((s) => s.id);

// 6 characters from a set with no look-alikes (no 0/O, 1/I/L)
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newCode() {
  for (;;) {
    const bytes = crypto.randomBytes(6);
    const code = [...bytes].map((x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join('');
    if (!db.prepare('SELECT 1 FROM bookings WHERE code = ?').get(code)) return code;
  }
}
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// bookings made before repair tracking existed get a code and a starting timeline entry
for (const row of db.prepare("SELECT id, created_at, paid_at FROM bookings WHERE code IS NULL").all()) {
  db.prepare('UPDATE bookings SET code = ? WHERE id = ?').run(newCode(), row.id);
  if (row.paid_at && !db.prepare('SELECT 1 FROM repair_events WHERE booking_id = ?').get(row.id)) {
    db.prepare("INSERT INTO repair_events (booking_id, at, stage, note) VALUES (?, ?, 'booked', '')").run(row.id, row.paid_at);
  }
}

function addEvent(bookingId, stage, note = '') {
  db.prepare('INSERT INTO repair_events (booking_id, at, stage, note) VALUES (?, ?, ?, ?)').run(bookingId, Date.now(), stage, note);
}
const events = (bookingId) => db.prepare('SELECT stage, note, at FROM repair_events WHERE booking_id = ? ORDER BY at, id').all(bookingId);
const byCode = (code) => {
  const c = normCode(code);
  return c.length === 6 ? db.prepare('SELECT * FROM bookings WHERE code = ?').get(c) || null : null;
};

function setStage(id, stage, note) {
  if (!STAGE_IDS.includes(stage)) throw new Error('unknown stage');
  addEvent(id, stage, note);
  return update(id, { stage, stage_note: note });
}

const DEFAULTS = {
  dailyMax: 6, // estimate appointments per day
  slots: ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00'],
  perSlot: 1,
  openDays: [1, 2, 3, 4, 5], // Mon-Fri (0 = Sunday)
  closedDates: [],
  leadDays: 1, // earliest bookable day is tomorrow
  windowDays: 45,
};

function getSettings() {
  const s = { ...DEFAULTS };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    if (row.key in DEFAULTS) s[row.key] = JSON.parse(row.value);
  }
  return s;
}
// small stored values outside the schedule settings (Google place id, cached reviews)
const getValue = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
const setValue = (key, value) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

function saveSettings(patch) {
  const put = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(patch)) if (k in DEFAULTS) put.run(k, JSON.stringify(v));
  return getSettings();
}

/* ---------- dates in shop time ---------- */
function todayISO(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return p; // en-CA formats as YYYY-MM-DD
}
function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const weekday = (iso) => new Date(iso + 'T12:00:00Z').getUTCDay();

/* ---------- availability ---------- */
const HOLDING = `(status IN ('paid', 'confirmed', 'completed', 'no_show') OR (status = 'pending_payment' AND hold_expires_at > ?))`;

function takenFor(from, to) {
  const rows = db.prepare(`SELECT date, time, COUNT(*) AS n FROM bookings WHERE date BETWEEN ? AND ? AND ${HOLDING} GROUP BY date, time`).all(from, to, Date.now());
  const map = {};
  for (const r of rows) (map[r.date] ||= {})[r.time] = r.n;
  return map;
}

function availability(settings = getSettings()) {
  const first = addDays(todayISO(), settings.leadDays);
  const last = addDays(todayISO(), settings.windowDays);
  const taken = takenFor(first, last);
  const days = {};
  for (let d = first; d <= last; d = addDays(d, 1)) {
    const open = settings.openDays.includes(weekday(d)) && !settings.closedDates.includes(d);
    const used = taken[d] || {};
    const total = Object.values(used).reduce((a, b) => a + b, 0);
    const slots = {};
    if (open && total < settings.dailyMax) {
      for (const t of settings.slots) {
        const left = settings.perSlot - (used[t] || 0);
        if (left > 0) slots[t] = left;
      }
    }
    days[d] = Object.keys(slots);
  }
  return { first, last, days };
}

/* ---------- bookings ---------- */
const newId = () => crypto.randomBytes(12).toString('base64url');

// Claims a slot atomically, so two customers can't pay for the last spot at once.
function createHold(b) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const av = availability();
    if (!(av.days[b.date] || []).includes(b.time)) {
      db.exec('ROLLBACK');
      return null;
    }
    const now = Date.now();
    const row = {
      id: newId(), created_at: now, updated_at: now, status: 'pending_payment',
      date: b.date, time: b.time, service: b.service, vehicle: b.vehicle, details: b.details,
      name: b.name, phone: b.phone, email: b.email, deposit_cents: config.depositCents,
      hold_expires_at: now + config.holdMinutes * 60 * 1000,
      code: newCode(), stage: 'booked', car_year: b.year || '', car_make: b.make || '', car_model: b.model || '',
    };
    db.prepare(`INSERT INTO bookings (id, created_at, updated_at, status, date, time, service, vehicle, details, name, phone, email, deposit_cents, hold_expires_at, code, stage, car_year, car_make, car_model)
      VALUES (:id, :created_at, :updated_at, :status, :date, :time, :service, :vehicle, :details, :name, :phone, :email, :deposit_cents, :hold_expires_at, :code, :stage, :car_year, :car_make, :car_model)`).run(row);
    db.exec('COMMIT');
    return row;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// A booking the shop enters itself (phone call, walk-up): confirmed straight away, any day or time it picks.
function createManual(b) {
  const now = Date.now();
  const collected = !['none', 'waived'].includes(b.payMethod);
  const row = {
    id: newId(), created_at: now, updated_at: now, status: 'confirmed',
    date: b.date, time: b.time, service: b.service, vehicle: b.vehicle, details: b.details,
    name: b.name, phone: b.phone, email: b.email, deposit_cents: collected ? config.depositCents : 0,
    paid_at: collected ? now : null, code: newCode(), stage: 'booked',
    car_year: b.year || '', car_make: b.make || '', car_model: b.model || '', source: 'manual', pay_method: b.payMethod,
  };
  db.prepare(`INSERT INTO bookings (id, created_at, updated_at, status, date, time, service, vehicle, details, name, phone, email, deposit_cents, paid_at, code, stage, car_year, car_make, car_model, source, pay_method)
    VALUES (:id, :created_at, :updated_at, :status, :date, :time, :service, :vehicle, :details, :name, :phone, :email, :deposit_cents, :paid_at, :code, :stage, :car_year, :car_make, :car_model, :source, :pay_method)`).run(row);
  addEvent(row.id, 'booked');
  return get(row.id);
}

const get = (id) => db.prepare('SELECT * FROM bookings WHERE id = ?').get(id) || null;

function update(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return get(id);
  const set = keys.map((k) => `${k} = :${k}`).join(', ');
  db.prepare(`UPDATE bookings SET ${set}, updated_at = :updated_at WHERE id = :id`).run({ ...fields, updated_at: Date.now(), id });
  return get(id);
}

// Payment confirmed (webhook or redirect check). Idempotent.
function markPaid(id, { sessionId, paymentIntent }) {
  const b = get(id);
  if (!b) return null;
  if (b.status === 'pending_payment' || b.status === 'expired' || b.status === 'cancelled') {
    const late = b.status !== 'pending_payment';
    if (!events(id).length) addEvent(id, 'booked');
    return update(id, {
      status: 'paid', paid_at: Date.now(), hold_expires_at: null,
      stripe_session_id: sessionId || b.stripe_session_id,
      stripe_payment_intent: paymentIntent || b.stripe_payment_intent,
      // the hold lapsed before payment landed, so the slot may have gone to someone else
      admin_note: late ? `Paid after the 30-minute hold ran out. Check the ${b.time} slot isn't double-booked.` : b.admin_note,
    });
  }
  return b;
}

function list({ scope = 'upcoming' } = {}) {
  const today = todayISO();
  const visible = `status NOT IN ('pending_payment', 'expired', 'cancelled')`;
  if (scope === 'past') return db.prepare(`SELECT * FROM bookings WHERE ${visible} AND date < ? ORDER BY date DESC, time DESC LIMIT 200`).all(today);
  if (scope === 'all') return db.prepare(`SELECT * FROM bookings ORDER BY created_at DESC LIMIT 300`).all();
  // upcoming drop-offs, plus any car still in the shop from an earlier day
  return db.prepare(`SELECT * FROM bookings WHERE ${visible} AND (date >= ? OR (status IN ('paid', 'confirmed') AND stage NOT IN ('picked_up')))
    ORDER BY date, time`).all(today);
}

// lapsed holds free their slot
function expireHolds() {
  db.prepare(`UPDATE bookings SET status = 'expired', updated_at = ? WHERE status = 'pending_payment' AND hold_expires_at <= ?`).run(Date.now(), Date.now());
}

/* ---------- receipts and records ---------- */
const recordPath = (r) => path.join(recordsDir, r.file);
const records = (bookingId) => db.prepare('SELECT * FROM records WHERE booking_id = ? ORDER BY created_at, id').all(bookingId);
const getRecord = (id) => db.prepare('SELECT * FROM records WHERE id = ?').get(id) || null;
function addRecord(bookingId, r) {
  const row = { id: newId(), booking_id: bookingId, created_at: Date.now(), kind: r.kind, title: r.title, file: r.file || null, mime: r.mime || null, size: r.size || null, data: r.data ? JSON.stringify(r.data) : null };
  db.prepare('INSERT INTO records (id, booking_id, created_at, kind, title, file, mime, size, data) VALUES (:id, :booking_id, :created_at, :kind, :title, :file, :mime, :size, :data)').run(row);
  return getRecord(row.id);
}
// stores an uploaded file and its record; the file name on disk is random, the title keeps what the shop uploaded
function addFile(bookingId, { title, mime, ext, buffer }) {
  const file = `${newId()}.${ext}`;
  fs.writeFileSync(path.join(recordsDir, file), buffer);
  return addRecord(bookingId, { kind: 'file', title, file, mime, size: buffer.length });
}
function deleteRecord(id) {
  const r = getRecord(id);
  if (!r) return false;
  if (r.file) fs.rmSync(recordPath(r), { force: true });
  db.prepare('DELETE FROM records WHERE id = ?').run(id);
  return true;
}
const markSent = (ids) => { const at = Date.now(); for (const id of ids) db.prepare('UPDATE records SET sent_at = ? WHERE id = ?').run(at, id); };

module.exports = {
  getValue, setValue, createManual, records, getRecord, addRecord, addFile, deleteRecord, markSent, recordPath, getSettings, saveSettings, availability, createHold, get, update, markPaid, list, expireHolds, todayISO, DEFAULTS, STAGES, STAGE_IDS, byCode, events, setStage, addEvent };
