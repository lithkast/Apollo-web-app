'use strict';
// Hermes' slash commands in Discord (the link one is /hrlink, as other bots, like the birthday bot, have a /link): clocking in and out on the HR page, and linking a Discord account to a login.
//   /hrlink code     ties this Discord account to the login whose profile made the code. Once: a login and a
//                    Discord account each link to one other, until the person unlinks on their profile.
//   /clockin         ticks Clock in on your HR row, stamped like the site does (to the quarter hour)
//   /clockout        ticks Clock out
//   /shift           your hours and pay so far tonight
//   /onshift         who is clocked in right now
//   /pfclockin       start promoting Apollo (Sundays' party finders and shouts): Hermes asks which, with buttons
//   /pfclockout      stop; the time goes on the HR row and is paid at the rates in Settings (promoPay)
//   /help
// Every reply is private (only the person who typed the command sees it). Owners and co-owners (and the
// administrator) can add member:@someone to /clockin and /clockout to fix someone else's clock.
// Clocking in well before doors open or after closing, clocking out well after closing, and every fix by an owner
// are added to clockReviews, for the owners to look over on the HR page. The limits are in Settings (clockRules).
//
//   discordLinks/<uid>          {discordId, name, at}    the person's own link: they and the administrator read it
//   discordUsers/<discord id>   {uid, at}                the same link the other way round: only read here
//   linkCodes/<code>            {uid, expires}           a code from someone's profile, good once, for 10 minutes
//   clockReviews/<id>           {kind, uid, hrId, name, job, at, stamp, open, close, minutes, by, byUid}
//   hr/<id> promotion fields    promoKind ('pf', 'shout' or 'both' while promoting, else ''), promoIn (when they
//                               started, venue seconds, to the quarter hour), promoAt (when Hermes or the site last
//                               changed them), promoPf and promoShout (hours of each so far tonight)

const DEFAULTS = require('./defaults.json');
const {venueInstant, venueParts, zoneOf, hhmm} = require('./eventposts');

const ADMIN_UID = '1CZiVZOMhMUIdhhJNwTelBrIeYb2';
const isNum = v => typeof v === 'number' && !isNaN(v);
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LIFE = 10 * 60000;
// a clock-in Hermes stamped more than this long ago is last night's, left when nobody started a new night
const STALE = 16 * 3600000;
const PRIVATE = 64;

// the commands, as Discord is told about them. Raise the version when they change, and the next check updates them.
const COMMANDS_VERSION = 4;    // 2: /link became /hermeslink; 3: then /hrlink; 4: /pfclockin and /pfclockout
const member = verb => ({type: 6, name: 'member', description: `Owners and co-owners only: clock someone else ${verb}`, required: false});
const COMMANDS = [
  {name: 'hrlink', description: 'Link your Discord to your Apollo\'s Temple login, with the code from your profile', options: [{type: 3, name: 'code', description: 'The code from the Discord box on your profile', required: true, min_length: 8, max_length: 12}]},
  {name: 'clockin', description: 'Clock in on the HR page', options: [member('in')]},
  {name: 'clockout', description: 'Clock out on the HR page', options: [member('out')]},
  {name: 'shift', description: 'Your hours and pay so far tonight (only you see it)'},
  {name: 'onshift', description: 'Who is clocked in right now'},
  {name: 'pfclockin', description: 'Start party finders or shouts for Apollo (I ask which)', options: [member('in for party finders or shouts')]},
  {name: 'pfclockout', description: 'Finish party finders or shouts', options: [member('out of party finders or shouts')]},
  {name: 'help', description: 'What Hermes can do'}
];
const HELP = [
  '**Hermes, at your service**',
  '`/clockin`: clock in when your shift starts',
  '`/clockout`: clock out when you finish',
  '`/shift`: your hours and pay so far tonight',
  '`/onshift`: who is clocked in right now',
  '`/pfclockin`: start party finders or shouts (I ask which), and `/pfclockout` when you stop. Paid by the hour on top of your shift.',
  '`/hrlink`: link your Discord to the site, with the code from your profile (only once)',
  'Owners and co-owners can add `member:` to `/clockin`, `/clockout`, `/pfclockin` and `/pfclockout` to fix someone else\'s clock.',
  'Only you see my replies.'
].join('\n');
const NOT_LINKED = 'Your Discord isn\'t linked to Apollo\'s Temple yet. On apolloncc.org, open your profile, click **Get a link code** in the Discord box, then type `/hrlink` here with that code.';

// ── settings and venue time ──
async function settings(db) { const d = await db.doc('config/main').get(); return {...DEFAULTS, ...(d.exists ? d.data() : {})}; }
const rules = cfg => {
  const r = (cfg && cfg.clockRules) || {}, n = (v, d) => isNum(v) && v >= 0 ? v : d;
  return {early: n(r.early, 60), lateOut: n(r.lateOut, 30)};
};
const venueSec = (ms, tz) => { const p = venueParts(ms, tz); return p.h * 3600 + p.mi * 60 + p.s; };
// the 7-minute rule, as on the site: 8:52 is 8:45, 8:54 is 9:00, 9:07 is 9:00 and 9:08 is 9:15
function roundToQuarter(sec) { const m = Math.floor(sec / 60), r = m % 15; return ((r <= 7 ? m - r : m + 15 - r) * 60) % 86400; }
const pad = n => String(n).padStart(2, '0');
const isoOf = (y, mo, d) => { const t = new Date(Date.UTC(y, mo - 1, d)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; };
function tzShort(ms, tz) { try { return new Intl.DateTimeFormat('en-US', {timeZone: tz, timeZoneName: 'short'}).formatToParts(new Date(ms)).find(p => p.type === 'timeZoneName').value; } catch (e) { return ''; } }
const fmtSec = sec => { const h = Math.floor(sec / 3600) % 24, m = Math.floor(sec / 60) % 60; return `${((h + 11) % 12) + 1}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`; };
const fmtAt = (ms, tz) => new Intl.DateTimeFormat('en-US', {timeZone: tz, hour: 'numeric', minute: '2-digit'}).format(new Date(ms));
const gil = n => n === Infinity ? 'Infinite' : `${Math.round(n).toLocaleString('en-US')}g`;
const hoursText = h => `${(Math.round(h * 100) / 100).toFixed(2).replace(/\.?0+$/, '')} hour${h === 1 ? '' : 's'}`;
const minutesText = m => { m = Math.round(m); const h = Math.floor(m / 60), r = m % 60; return h ? `${h} hr${r ? ` ${r} min` : ''}` : `${r} min`; };

// The night a moment belongs to (noon to noon), and its hours: the Calendar's event that night if it has one,
// otherwise doors open to close from Settings.
async function shiftWindow(db, now, cfg) {
  const tz = zoneOf(cfg), p = venueParts(now, tz), sec = p.h * 3600 + p.mi * 60 + p.s;
  const date = sec < 12 * 3600 ? isoOf(p.y, p.mo, p.d - 1) : isoOf(p.y, p.mo, p.d);
  const open0 = hhmm(cfg.startTime) ?? 21 * 3600, close0 = hhmm(cfg.closeTime) ?? 3600;
  const span = (((close0 - open0) % 86400) + 86400) % 86400 || 86400;
  const evs = (await db.collection('events').where('date', '==', date).get()).docs.map(d => d.data()).filter(e => isNum(e.start))
    .sort((a, b) => a.start - b.start);
  const ev = evs[0];
  const open = venueInstant(date, ev ? ev.start : open0, tz);
  let close = ev && isNum(ev.end) ? venueInstant(date, ev.end, tz) : open + span * 1000;
  if (close <= open) close += 86400000;
  return {date, open, close, event: ev ? String(ev.title || '').trim() : ''};
}

// ── pay, the way the HR page works it out ──
const round1000 = x => Math.round(x / 1000) * 1000;
const jobOf = (name, cfg) => (cfg.jobs || []).find(j => j.name === name) || null;
function basePay(job, cfg) {
  const j = jobOf(job, cfg);
  if (!j || !j.pay || j.pay === 'none') return null;
  if (j.pay === 'infinite') return Infinity;
  const v = (cfg.payGrades || [])[Number(j.pay) - 1];
  return isNum(v) ? v : null;
}
const spanHours = (a, b) => ((((b - a) % 86400) + 86400) % 86400) / 3600;
function shiftPay(row, cfg, mult, outSec) {
  const j = jobOf(row.job, cfg);
  if (j && j.pay === 'flat') return isNum(j.flat) ? j.flat : null;
  const b = basePay(row.job, cfg);
  if (b == null || !isNum(row.timeIn) || !isNum(outSec)) return null;
  return b === Infinity ? Infinity : round1000(b * mult * spanHours(row.timeIn, outSec));
}
function receptionTotal(r, cfg) {
  if (!r.rpType || !isNum(r.duration) || !isNum(r.guests)) return null;
  const extra = Math.max(r.guests - 1, 0);
  let base;
  if (r.rpType === 'Public') base = cfg.rpPrice * r.duration + extra * cfg.guestRatePublic;
  else if (r.rpType === 'Private') base = cfg.erpPrice * r.duration + extra * cfg.guestRatePrivate;
  else if (r.rpType === 'No Staff') base = cfg.roomRental * r.duration + extra * cfg.guestRatePublic;
  else return null;
  return r.vip ? base * cfg.vipDiscount : base;
}
function dealerPool(gross, cfg) {
  if (!isNum(gross)) return null;
  if (gross <= 0) return 0;
  let prev = 0, pool = 0;
  for (const b of cfg.casinoBrackets || []) { const cap = isNum(b.upTo) ? b.upTo : Infinity; if (gross > prev) pool += (Math.min(gross, cap) - prev) * b.rate; prev = cap; }
  return pool;
}
async function payMult(db, cfg) {
  const c = await db.doc('night/collab').get(), on = c.exists && c.data().on === true;
  return {on, mult: on ? (isNum(cfg.collabRate) && cfg.collabRate >= 1 ? cfg.collabRate : 1.5) : 1};
}
// what someone has made tonight besides their shift pay: booking fees, the reception bonus, bar buyouts, the dealer pool
async function extras(db, cfg, name) {
  const norm = x => String(x || '').trim().toLowerCase(), me = norm(name), is = x => !!me && norm(x) === me;
  const read = async p => { const d = await db.doc(p).get(); return d.exists ? d.data() : {}; };
  const [rec, buys, nrec, casino] = await Promise.all([db.collection('reception').get(), db.collection('buyouts').get(), read('night/reception'), read('night/casino')]);
  const out = {bookings: 0, bonus: 0, bar: 0, dealer: 0};
  let all = 0;
  for (const d of rec.docs) { const r = d.data(), t = receptionTotal(r, cfg); if (!isNum(t)) continue; all += t; if (r.employee && is(r.employee)) out.bookings += t; }
  if (nrec.receptionist && is(nrec.receptionist)) out.bonus = all * (cfg.receptionBonus || 0);
  for (const d of buys.docs) { const b = d.data(); if (isNum(b.each) && (b.bartenders || []).some(is)) out.bar += b.each; }
  for (const k of [1, 2]) { const ds = casino['s' + k + 'Dealers'] || [], pool = dealerPool(casino['s' + k + 'Gross'], cfg), mine = ds.filter(is).length; if (isNum(pool) && mine) out.dealer += pool / ds.length * mine; }
  for (const k of Object.keys(out)) out[k] = Math.round(out[k]);
  return out;
}

// ── who is who ──
async function whoIs(db, discordId) {
  if (!discordId) return null;
  const d = await db.doc('discordUsers/' + discordId).get();
  return d.exists && d.data().uid ? {uid: d.data().uid} : null;
}
async function isOwner(db, uid) {
  if (uid === ADMIN_UID) return true;
  const a = await db.doc('accounts/' + uid).get();
  return a.exists && ['owner', 'coowner'].includes(a.data().role);
}
async function loginName(db, uid) {
  const [p, a] = await Promise.all([db.doc('people/' + uid).get(), db.doc('accounts/' + uid).get()]);
  const pd = p.exists ? p.data() : {}, ad = a.exists ? a.data() : {};
  return String(pd.username || '').trim() || String(ad.name || pd.name || '').trim() || (uid === ADMIN_UID ? 'the administrator' : 'someone');
}
// the person's row on the HR roster: the one tied to their login (the administrator's is picked in Settings)
async function rowFor(db, uid, cfg) {
  if (uid === ADMIN_UID && cfg.adminRoster) { const d = await db.doc('hr/' + cfg.adminRoster).get(); if (d.exists) return {id: d.id, ref: db.doc('hr/' + d.id), data: d.data()}; }
  const q = await db.collection('hr').where('login', '==', uid).limit(1).get();
  return q.docs.length ? {id: q.docs[0].id, ref: q.docs[0].ref, data: q.docs[0].data()} : null;
}
const isStale = (r, now) => isNum(r.clockedAt) && now - r.clockedAt > STALE;
const onClock = (r, now) => !!r.clockIn && !r.clockOut && !isStale(r, now);

async function review(db, now, kind, row, extra) {
  const id = now.toString(36) + Math.random().toString(36).slice(2, 8);
  await db.doc('clockReviews/' + id).set({kind, uid: extra.uid, hrId: row.id, name: row.data.name || '', job: row.data.job || '', at: now, ...extra});
  return id;
}

// ── the commands ──
async function link(ctx, user, raw) {
  const {db, now} = ctx;
  const code = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const bad = 'That code isn\'t right, or it has run out. Codes work once, for 10 minutes. Get a new one from the Discord box on your profile at apolloncc.org.';
  if (!/^[A-Z0-9]{8}$/.test(code)) return bad;
  const cref = db.doc('linkCodes/' + code), c = await cref.get();
  if (!c.exists || !isNum(c.data().expires) || c.data().expires < now) return bad;
  const uid = c.data().uid;
  const result = await db.runTransaction(async tx => {
    const du = await tx.get(db.doc('discordUsers/' + user.id)), dl = await tx.get(db.doc('discordLinks/' + uid));
    if (du.exists && du.data().uid === uid) { tx.delete(cref); return 'same'; }
    if (du.exists) return 'taken-discord';
    if (dl.exists) return 'taken-login';
    tx.set(db.doc('discordUsers/' + user.id), {uid, at: now});
    tx.set(db.doc('discordLinks/' + uid), {discordId: user.id, name: String(user.global_name || user.username || '').slice(0, 80), username: String(user.username || '').slice(0, 40), at: now});
    tx.delete(cref);
    return 'linked';
  });
  if (result === 'taken-discord') return 'This Discord account is already linked to another login. Unlink it from that login\'s profile first.';
  if (result === 'taken-login') return 'That login is already linked to a different Discord account. Unlink it from the Discord box on the profile first.';
  const name = await loginName(db, uid), cfg = await settings(db), row = await rowFor(db, uid, cfg);
  return `${result === 'same' ? 'Already linked:' : 'Linked!'} Your Discord is tied to **${name}** on Apollo's Temple. Use \`/clockin\` when your shift starts and \`/clockout\` when you finish.`
    + (row ? '' : '\nYour login isn\'t on the HR roster yet, so ask the administrator to tie it before you clock in.');
}

async function clockIn(ctx, uid, cfg, by) {
  const {db, now} = ctx, tz = zoneOf(cfg), row = await rowFor(db, uid, cfg);
  if (!row) return `${by ? 'Their' : 'Your'} login isn't on the HR roster, so there is nothing to clock ${by ? 'them' : 'you'} in on. The administrator ties logins to the roster in Settings.`;
  const r = row.data, who = by ? `**${r.name || 'They'}**` : 'You', stale = isStale(r, now);
  if (r.status === 'LOA' && !by) return 'You\'re on leave (LOA) on the roster. Ask an owner or co-owner to change your status first.';
  if (r.clockIn && !stale) return r.clockOut ? `${who} already clocked out tonight${isNum(r.timeOut) ? ` at ${fmtSec(r.timeOut)}` : ''}. ${by ? 'Change their times on the HR page if they\'re back on.' : 'If you\'re back on, ask an owner or co-owner.'}`
    : `${who} ${by ? 'is' : 'are'} already clocked in${isNum(r.timeIn) ? `, since ${fmtSec(r.timeIn)}` : ''}.`;
  const stamp = roundToQuarter(venueSec(now, tz)), timeIn = !stale && isNum(r.timeIn) ? r.timeIn : stamp;
  await row.ref.update({clockIn: true, timeIn, clockOut: false, timeOut: null, ...(stale ? {paid: false} : {}), clockedAt: now, clockedOutAt: null});
  const w = await shiftWindow(db, now, cfg), lim = rules(cfg), flags = [];
  if (now < w.open - lim.early * 60000) flags.push(['early', (w.open - now) / 60000]);
  else if (now > w.close) flags.push(['afterclose', (now - w.close) / 60000]);
  if (by) flags.push(['fix-in', 0]);
  for (const [kind, minutes] of flags) await review(db, now, kind, row, {uid, stamp: timeIn, open: w.open, close: w.close, minutes: Math.round(minutes), event: w.event, by: by ? by.name : '', byUid: by ? by.uid : ''});
  return `${by ? `Clocked **${r.name}** in` : 'Clocked in'} at ${fmtSec(timeIn)} ${tzShort(now, tz)}.${by ? ' It\'s listed for review on the HR page.' : ' Have a good shift!'}`;
}

async function clockOut(ctx, uid, cfg, by) {
  const {db, now} = ctx, tz = zoneOf(cfg), row = await rowFor(db, uid, cfg);
  if (!row) return `${by ? 'Their' : 'Your'} login isn't on the HR roster, so there is nothing to clock out. The administrator ties logins to the roster in Settings.`;
  const r = row.data, who = by ? `**${r.name || 'They'}**` : 'You';
  if (!r.clockIn || isStale(r, now)) return `${who} ${by ? 'isn\'t' : 'aren\'t'} clocked in.`;
  if (r.clockOut) return `${who} already clocked out${isNum(r.timeOut) ? ` at ${fmtSec(r.timeOut)}` : ''}.`;
  const stamp = roundToQuarter(venueSec(now, tz)), timeOut = isNum(r.timeOut) ? r.timeOut : stamp;
  await row.ref.update({clockOut: true, timeOut, clockedOutAt: now});
  // the night they clocked in on (Hermes notes when; a tick on the site does not, so then it is now)
  const w = await shiftWindow(db, isNum(r.clockedAt) ? r.clockedAt : now, cfg), lim = rules(cfg), flags = [];
  if (now > w.close + lim.lateOut * 60000) flags.push(['lateout', (now - w.close) / 60000]);
  if (by) flags.push(['fix-out', 0]);
  for (const [kind, minutes] of flags) await review(db, now, kind, row, {uid, stamp: timeOut, open: w.open, close: w.close, minutes: Math.round(minutes), event: w.event, by: by ? by.name : '', byUid: by ? by.uid : ''});
  const {mult} = await payMult(db, cfg), pay = shiftPay({...r, timeOut}, cfg, mult, timeOut), hrs = isNum(r.timeIn) ? spanHours(r.timeIn, timeOut) : null;
  const worked = hrs != null ? ` ${by ? 'They' : 'You'} worked ${hoursText(hrs)}${pay != null ? `, ${gil(pay)} in shift pay` : ''}.` : '';
  return `${by ? `Clocked **${r.name}** out` : 'Clocked out'} at ${fmtSec(timeOut)} ${tzShort(now, tz)}.${worked}${by ? ' It\'s listed for review on the HR page.' : ' `/shift` shows everything you made tonight.'}`;
}

async function shift(ctx, uid, cfg) {
  const {db, now} = ctx, tz = zoneOf(cfg), row = await rowFor(db, uid, cfg);
  if (!row) return 'Your login isn\'t on the HR roster yet, so there is no shift to show. The administrator ties logins to the roster in Settings.';
  const r = row.data, onShiftTonight = !!r.clockIn && !isStale(r, now), pOn = promoOn(r, now), rates = promoRates(cfg), ph = promoHours(r, now);
  // promotion still running counts up to now, to the quarter hour
  if (pOn) { const so = spanHours(r.promoIn, roundToQuarter(venueSec(now, tz))); if (r.promoKind !== 'shout') ph.pf = round2(ph.pf + so); if (r.promoKind !== 'pf') ph.shout = round2(ph.shout + so); }
  const promoed = pOn || ph.pf > 0 || ph.shout > 0;
  if (!onShiftTonight && !promoed) return 'You\'re not clocked in tonight. Use `/clockin` when your shift starts, or `/pfclockin` for party finders and shouts.';
  const out = r.clockOut && isNum(r.timeOut) ? r.timeOut : roundToQuarter(venueSec(now, tz));
  const [{on, mult}, ex] = await Promise.all([payMult(db, cfg), extras(db, cfg, r.name)]);
  const pay = onShiftTonight ? shiftPay(r, cfg, mult, out) : null, j = jobOf(r.job, cfg), hrs = onShiftTonight && isNum(r.timeIn) ? spanHours(r.timeIn, out) : null;
  const lines = [`**Tonight, ${r.name || 'you'}**${r.job ? ` (${r.job})` : ''}${on ? ` · collab night, hourly pay ×${mult}` : ''}`];
  if (onShiftTonight) {
    lines.push(`Clocked in ${isNum(r.timeIn) ? fmtSec(r.timeIn) : ''}${r.clockOut ? `, out ${fmtSec(out)}` : ', still on the clock'}`);
    if (hrs != null) lines.push(`Hours: ${hoursText(hrs)}${r.clockOut ? '' : ' so far'}`);
    lines.push(`${j && j.pay === 'flat' ? 'Nightly pay' : 'Shift pay'}: ${pay == null ? 'none set for your job' : gil(pay)}`);
  } else lines.push('Not clocked in for a shift.');
  const promo = promoed ? promoPay(ph, rates) : 0;
  if (ph.pf) lines.push(`Party finders: ${hoursText(ph.pf)}, ${gil(round1000(ph.pf * rates.pf))}`);
  if (ph.shout) lines.push(`Shouts: ${hoursText(ph.shout)}, ${gil(round1000(ph.shout * rates.shout))}`);
  if (pOn) lines.push(`Still promoting (${PROMO[r.promoKind].toLowerCase()}) since ${fmtSec(r.promoIn)}`);
  const parts = [['bookings', 'Booking fees'], ['bonus', 'Reception bonus'], ['bar', 'Bar buyout share'], ['dealer', 'Dealer share']].filter(([k]) => ex[k]);
  for (const [k, l] of parts) lines.push(`${l}: ${gil(ex[k])}`);
  const done = (!onShiftTonight || r.clockOut) && !pOn;
  if (pay !== Infinity) lines.push(`**${done ? 'Total' : 'Total so far'}: ${gil((pay || 0) + promo + parts.reduce((t, [k]) => t + ex[k], 0))}**`);
  lines.push('Times are rounded to the quarter hour, as on the HR page.');
  return lines.join('\n');
}

async function onShift(ctx, cfg) {
  const {db, now} = ctx;
  const all = (await db.collection('hr').get()).docs.map(d => d.data()).filter(r => r.name);
  const order = new Map((cfg.jobs || []).map((j, i) => [j.name, i])), k = r => order.has(r.job) ? order.get(r.job) : 1e6, by = (a, b) => k(a) - k(b) || String(a.name).localeCompare(String(b.name));
  const on = all.filter(r => onClock(r, now)).sort(by), promo = all.filter(r => promoOn(r, now)).sort(by);
  if (!on.length && !promo.length) return 'Nobody is clocked in right now.';
  const out = on.length ? [`**On the clock (${on.length})**`, ...on.map(r => `• ${r.name}${r.job ? ` (${r.job})` : ''}${isNum(r.timeIn) ? `, since ${fmtSec(r.timeIn)}` : ''}`)] : ['Nobody is on the clock for a shift right now.'];
  if (promo.length) out.push(`**Promoting Apollo (${promo.length})**`, ...promo.map(r => `• ${r.name}: ${PROMO[r.promoKind].toLowerCase()}, since ${fmtSec(r.promoIn)}`));
  return out.join('\n');
}

// ── promoting Apollo: party finders and shouts, paid by the hour on top of the shift ──
const PROMO = {pf: 'Party finder', shout: 'Shouts', both: 'Party finder and shouts'};
const PROMO_ASK = 15 * 60000;
function promoRates(cfg) {
  const p = (cfg && cfg.promoPay) || {}, n = (v, d) => isNum(v) && v >= 0 ? v : d;
  return {pf: n(p.pf, 60000), shout: n(p.shout, 140000)};
}
const rateOf = (kind, rates) => (kind === 'pf' || kind === 'both' ? rates.pf : 0) + (kind === 'shout' || kind === 'both' ? rates.shout : 0);
// promotion time belongs to tonight while it was last touched within the last 16 hours
const promoFresh = (r, now) => isNum(r.promoAt) && now - r.promoAt <= STALE;
const promoOn = (r, now) => !!PROMO[r.promoKind] && isNum(r.promoIn) && promoFresh(r, now);
const promoHours = (r, now) => promoFresh(r, now) ? {pf: isNum(r.promoPf) ? r.promoPf : 0, shout: isNum(r.promoShout) ? r.promoShout : 0} : {pf: 0, shout: 0};
const promoPay = (h, rates) => round1000(h.pf * rates.pf + h.shout * rates.shout);
const round2 = x => Math.round(x * 100) / 100;
// /pfclockin: the question, with a button for each answer. The answer comes back to press() below.
async function pfAsk(ctx, uid, cfg, by, discordId) {
  const {db, now} = ctx, row = await rowFor(db, uid, cfg);
  if (!row) return `${by ? 'Their' : 'Your'} login isn't on the HR roster, so there is nothing to clock ${by ? 'them' : 'you'} in on. The administrator or an owner ties logins to the roster in Account management.`;
  const r = row.data, who = by ? `**${r.name || 'They'}**` : 'You';
  if (r.status === 'LOA' && !by) return 'You\'re on leave (LOA) on the roster. Ask an owner or co-owner to change your status first.';
  if (promoOn(r, now)) return `${who} ${by ? 'is' : 'are'} already clocked in for ${PROMO[r.promoKind].toLowerCase()}, since ${fmtSec(r.promoIn)}. Use \`/pfclockout\` first.`;
  const rates = promoRates(cfg), id = kind => ['pf', kind, discordId, by ? uid : '', now.toString(36)].join(':');
  return {content: `${by ? `What is **${r.name}** doing?` : 'What are you doing to promote Apollo?'}\nParty finder ${gil(rates.pf)} an hour · Shouts ${gil(rates.shout)} an hour · Both ${gil(rates.pf + rates.shout)} an hour`,
    components: [{type: 1, components: [{type: 2, style: 1, label: 'Party finder', custom_id: id('pf')}, {type: 2, style: 1, label: 'Shouts', custom_id: id('shout')}, {type: 2, style: 3, label: 'Both', custom_id: id('both')}]}]};
}
async function pfStart(ctx, uid, cfg, by, kind) {
  const {db, now} = ctx, tz = zoneOf(cfg), row = await rowFor(db, uid, cfg);
  if (!row) return `${by ? 'Their' : 'Your'} login isn't on the HR roster.`;
  const r = row.data, who = by ? `**${r.name || 'They'}**` : 'You';
  if (r.status === 'LOA' && !by) return 'You\'re on leave (LOA) on the roster. Ask an owner or co-owner to change your status first.';
  if (promoOn(r, now)) return `${who} ${by ? 'is' : 'are'} already clocked in for ${PROMO[r.promoKind].toLowerCase()}, since ${fmtSec(r.promoIn)}.`;
  const stamp = roundToQuarter(venueSec(now, tz)), fresh = promoFresh(r, now);
  // the first promotion of a new night starts its hours from nothing
  await row.ref.update({promoKind: kind, promoIn: stamp, promoAt: now, ...(fresh ? {} : {promoPf: 0, promoShout: 0})});
  if (by) await review(db, now, 'pf-fix-in', row, {uid, stamp, promo: kind, by: by.name, byUid: by.uid});
  const rate = rateOf(kind, promoRates(cfg));
  return `${by ? `Clocked **${r.name}** in for ${PROMO[kind].toLowerCase()}` : `Clocked in for ${PROMO[kind].toLowerCase()}`} at ${fmtSec(stamp)} ${tzShort(now, tz)}, at ${gil(rate)} an hour.${by ? ' It\'s listed for review on the HR page.' : ' Use `/pfclockout` when you stop.'}`;
}
async function pfClockOut(ctx, uid, cfg, by) {
  const {db, now} = ctx, tz = zoneOf(cfg), row = await rowFor(db, uid, cfg);
  if (!row) return `${by ? 'Their' : 'Your'} login isn't on the HR roster, so there is nothing to clock out.`;
  const r = row.data, who = by ? `**${r.name || 'They'}**` : 'You';
  if (!promoOn(r, now)) return `${who} ${by ? 'isn\'t' : 'aren\'t'} clocked in for party finders or shouts.`;
  const stamp = roundToQuarter(venueSec(now, tz)), hrs = spanHours(r.promoIn, stamp), kind = r.promoKind, rates = promoRates(cfg), h = promoHours(r, now);
  if (kind === 'pf' || kind === 'both') h.pf = round2(h.pf + hrs);
  if (kind === 'shout' || kind === 'both') h.shout = round2(h.shout + hrs);
  await row.ref.update({promoKind: '', promoIn: null, promoAt: now, promoPf: h.pf, promoShout: h.shout});
  if (by) await review(db, now, 'pf-fix-out', row, {uid, stamp, promo: kind, by: by.name, byUid: by.uid});
  return `${by ? `Clocked **${r.name}** out of ${PROMO[kind].toLowerCase()}` : `Clocked out of ${PROMO[kind].toLowerCase()}`} at ${fmtSec(stamp)} ${tzShort(now, tz)}: ${hoursText(hrs)}, ${gil(round1000(hrs * rateOf(kind, rates)))}.`
    + ` Promotion pay tonight: ${gil(promoPay(h, rates))}.${by ? ' It\'s listed for review on the HR page.' : ''}`;
}
// a button under the /pfclockin question was pressed
async function press(ctx, body) {
  const {db, now} = ctx, user = (body.member && body.member.user) || body.user || {};
  const [tag, kind, asker, target, ts] = String((body.data || {}).custom_id || '').split(':');
  if (tag !== 'pf' || !PROMO[kind]) return 'That button doesn\'t do anything any more.';
  if (asker !== user.id) return 'That question was for someone else.';
  if (!(now - parseInt(ts, 36) <= PROMO_ASK)) return 'That question has run out. Type `/pfclockin` again.';
  const me = await whoIs(db, user.id);
  if (!me) return NOT_LINKED;
  if (me.uid !== ADMIN_UID && !(await db.doc('accounts/' + me.uid).get()).exists) return 'The login your Discord is linked to no longer has staff access.';
  const cfg = await settings(db);
  if (cfg.maintenance && me.uid !== ADMIN_UID) return 'The site is in maintenance mode, so the HR page can\'t be changed right now. Try again once it\'s over.';
  let uid = me.uid, by = null;
  if (target && target !== me.uid) {
    if (!(await isOwner(db, me.uid))) return 'Only owners and co-owners can clock someone else in.';
    uid = target; by = {uid: me.uid, name: await loginName(db, me.uid)};
  }
  return pfStart(ctx, uid, cfg, by, kind);
}

// One command from Discord. Returns the text of the (private) reply, or {content, components} for a reply with
// buttons (the /pfclockin question).
// ctx: {db, now}
async function handle(ctx, body) {
  const {db} = ctx, data = body.data || {}, cmd = data.name, user = (body.member && body.member.user) || body.user || {};
  const opt = n => ((data.options || []).find(o => o.name === n) || {}).value;
  if (cmd === 'help') return HELP;
  if (cmd === 'hrlink' || cmd === 'hermeslink' || cmd === 'link') return link(ctx, user, opt('code'));
  const me = await whoIs(db, user.id);
  if (!me) return NOT_LINKED;
  if (me.uid !== ADMIN_UID && !(await db.doc('accounts/' + me.uid).get()).exists) return 'The login your Discord is linked to no longer has staff access. Ask the administrator if that\'s a mistake.';
  const cfg = await settings(db);
  if (cmd === 'onshift') return onShift(ctx, cfg);
  if (cmd === 'shift') return shift(ctx, me.uid, cfg);
  if (cmd === 'clockin' || cmd === 'clockout' || cmd === 'pfclockin' || cmd === 'pfclockout') {
    const other = opt('member'), verb = cmd.endsWith('in') ? 'in' : 'out';
    let target = me.uid, by = null;
    if (other && other !== user.id) {
      if (!(await isOwner(db, me.uid))) return 'Only owners and co-owners can clock someone else in or out.';
      const t = await whoIs(db, other), u = ((data.resolved || {}).users || {})[other] || {};
      if (!t) return `**${u.global_name || u.username || 'That person'}** hasn't linked their Discord yet, so clock them ${verb} on the HR page instead.`;
      target = t.uid; by = {uid: me.uid, name: await loginName(db, me.uid)};
    }
    if (cfg.maintenance && me.uid !== ADMIN_UID) return 'The site is in maintenance mode, so the HR page can\'t be changed right now. Try again once it\'s over.';
    if (cmd === 'pfclockin') return pfAsk(ctx, target, cfg, by, user.id);
    if (cmd === 'pfclockout') return pfClockOut(ctx, target, cfg, by);
    return cmd === 'clockin' ? clockIn(ctx, target, cfg, by) : clockOut(ctx, target, cfg, by);
  }
  return 'I don\'t know that one. `/help` lists what I can do.';
}

// a link code for someone's profile: 8 letters and numbers that are hard to mix up, good once for 10 minutes
function newCode(randomInt) {
  let c = ''; for (let i = 0; i < 8; i++) c += CODE_CHARS[randomInt(CODE_CHARS.length)];
  return c;
}

module.exports = {handle, press, COMMANDS, COMMANDS_VERSION, HELP, PRIVATE, CODE_LIFE, newCode, shiftWindow, roundToQuarter, rules, ADMIN_UID};
