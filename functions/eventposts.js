'use strict';
// Hermes' posts for the Calendar's events. For each event, owners and co-owners write two posts on the site:
//   announce  the morning announcement, at 10:00 AM venue time on the event's day
//   open      "we're open", when the doors open (the event's start time)
// Either time can be changed per event. A post goes out only once it is scheduled ("ready") on the site.
//
//   eventposts/<event id>       what the owners wrote: {announce: {on, ready, text, time, media}, open: {...}, listEvent}
//   eventpostState/<event id>   what happened, written only here: {announce: {status, due, messageId, channelId,
//                               sentText, sentMedia, error, ...}, open: {...}, event: {id, sig, error}, due, rev}
//
// Only the every-minute check (tick) talks to Discord, one event at a time, so a post can never go out twice.
// Saving a post or changing an event just marks it to be looked at (due 0) by the next check.

const bot = require('./discordbot');

const KINDS = ['announce', 'open'];
const ANNOUNCE_AT = 10 * 3600;           // 10:00 AM, venue time
const MENTIONS = {parse: ['everyone', 'roles', 'users']};
const RETRY = e => e === 'network' || e === 'discord-429' || /^discord-5/.test(e || '');
const isNum = v => typeof v === 'number' && !isNaN(v);

// ── venue time ──
function zoneOf(cfg) {
  const z = (cfg && cfg.timeZone) || 'America/New_York';
  try { new Intl.DateTimeFormat('en-US', {timeZone: z}); return z; } catch (e) { return 'America/New_York'; }
}
function venueParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', {timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'});
  const p = {}; for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  return {y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second};
}
// the moment a venue date and time of day falls on, whatever the daylight-saving offset is that day
function venueInstant(iso, sec, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); if (!m) return null;
  const want = Date.UTC(+m[1], +m[2] - 1, +m[3]) + (sec || 0) * 1000; let t = want;
  for (let i = 0; i < 3; i++) { const p = venueParts(t, tz); t += want - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s); }
  return t;
}
const hhmm = s => { const m = /^(\d{1,2}):(\d{2})/.exec(String(s || '')); return m ? (+m[1]) * 3600 + (+m[2]) * 60 : null; };
function eventTimes(ev, cfg) {
  const tz = zoneOf(cfg), startSec = isNum(ev.start) ? ev.start : (hhmm(cfg && cfg.startTime) ?? 21 * 3600);
  const start = venueInstant(ev.date, startSec, tz);
  let end = null;
  if (isNum(ev.end) && start != null) { end = venueInstant(ev.date, ev.end, tz); if (end <= start) end += 86400000; }
  return {start, end, tz};
}
// when a post goes out
function postTime(kind, post, ev, cfg) {
  const tz = zoneOf(cfg), own = hhmm(post && post.time);
  if (own != null) return venueInstant(ev.date, own, tz);
  return kind === 'announce' ? venueInstant(ev.date, ANNOUNCE_AT, tz) : eventTimes(ev, cfg).start;
}

// ── the text ──
// {event} {start} {date} {starttime} {end} {countdown} {where} {details} become the event's own details; the
// times become Discord timestamps, which every reader sees on their own clock.
const stamp = (ms, f) => `<t:${Math.floor(ms / 1000)}:${f}>`;
function fill(text, ev, cfg) {
  const {start, end} = eventTimes(ev, cfg);
  const map = {
    event: String(ev.title || '').trim(), where: String(ev.where || '').trim(), details: String(ev.notes || '').trim(),
    start: start != null ? stamp(start, 'F') : '', date: start != null ? stamp(start, 'D') : '', starttime: start != null ? stamp(start, 't') : '',
    end: end != null ? stamp(end, 't') : '', countdown: start != null ? stamp(start, 'R') : ''
  };
  return String(text || '').replace(/\{(event|where|details|start|date|starttime|end|countdown)\}/g, (_, k) => map[k]).trim();
}
function locationOf(cfg) {
  const l = (cfg && cfg.location) || {};
  return [l.dc, l.world, l.district, l.ward ? 'Ward ' + l.ward : '', l.plot ? 'Plot ' + l.plot : ''].map(x => String(x || '').trim()).filter(Boolean).join(' | ') || 'Apollo Night Club & Casino';
}
const mediaKey = m => (m && m.path) || '';

// Look at one event: send what is due, push edits, remove what was switched off, keep its Discord Event in step.
// ctx: {db, token, now, fetchImpl, download(path) -> {data, type, name}, removeMedia(prefix)}
async function processEvent(ctx, eid) {
  const {db, token, now = Date.now(), fetchImpl} = ctx;
  const sref = db.doc('eventpostState/' + eid);
  const s0snap = await sref.get(), s0 = s0snap.exists ? s0snap.data() : {}, rev0 = s0.rev || 0;
  const read = async p => { const x = await db.doc(p).get(); return x.exists ? x.data() : null; };
  const [posts, ev, cfg, dc] = await Promise.all([read('eventposts/' + eid), read('events/' + eid), read('config/main'), read('private/discord')]);
  const guild = (dc && dc.guildId) || '', channel = (dc && dc.eventsChannel) || '';
  const call = (method, path, body, files) => bot.call(token, method, path, body, files, fetchImpl);
  const save = kinds => sref.set(kinds, {mergeFields: Object.keys(kinds)});

  // the event, or its posts, are gone: nothing more goes out; an upcoming Discord Event goes too
  if (!ev || !posts) {
    const se = s0.event || {};
    if (se.id && guild && !(se.start && se.start <= now)) await call('DELETE', `/guilds/${guild}/scheduled-events/${se.id}`);
    if (!ev) {
      if (posts) await db.doc('eventposts/' + eid).delete();
      if (ctx.removeMedia) await ctx.removeMedia('eventmedia/' + eid + '/').catch(() => {});
    }
    await sref.delete();
    return 'gone';
  }

  let next = null, retryAt = null;
  const later = t => { next = next == null ? t : Math.min(next, t); };
  for (const k of KINDS) {
    const p = posts[k] || {}, s = {...(s0[k] || {})}, due = postTime(k, p, ev, cfg), text = fill(p.text, ev, cfg);
    const fail = (error, extra) => { const out = {status: 'failed', due, error, failedAt: now, ...(extra || {})}; if (RETRY(error) && (s.tries || 0) < 5) { out.tries = (s.tries || 0) + 1; out.status = 'scheduled'; retryAt = now + 120000; } return out; };
    let result = null;
    if (s.status === 'sent') {
      if (!p.on) {
        const r = await call('DELETE', `/channels/${s.channelId}/messages/${s.messageId}`);
        result = r.ok || r.status === 404 ? {status: 'removed', removedAt: now} : {...s, editError: r.error};
      } else if (mediaKey(p.media) !== (s.sentMedia || '')) {
        // a new picture or video means a new post: the old one is taken down first
        await call('DELETE', `/channels/${s.channelId}/messages/${s.messageId}`);
        s.status = 'removed';
      } else if (text !== s.sentText) {
        const r = await call('PATCH', `/channels/${s.channelId}/messages/${s.messageId}`, {content: text, allowed_mentions: MENTIONS});
        // deleted by hand in Discord: not posted again unless the owners ask for it (Post it again)
        result = r.ok ? {...s, sentText: text, editedAt: now, editError: ''} : r.status === 404 ? {...s, status: 'gone', goneTry: p.retry || 0, editError: ''} : {...s, editError: r.error};
        if (!r.ok && RETRY(r.error)) retryAt = now + 120000;
      } else result = s;
    }
    if (!result) {
      if (!p.on || !p.ready) result = {status: 'draft', due};
      else if (s.status === 'gone' && (s.goneTry || 0) === (p.retry || 0)) result = s;
      else if (!text) result = {status: 'failed', due, error: 'empty'};
      else if (text.length > 2000) result = {status: 'failed', due, error: 'too-long'};
      else if (!token) result = {status: 'failed', due, error: 'no-token'};
      else if (!channel) result = {status: 'failed', due, error: 'no-channel'};
      else if (due > now) { result = {status: 'scheduled', due}; later(due); }
      // a failure that trying again won't fix waits for a change, or for Try again on the site
      else if (s.status === 'failed' && !RETRY(s.error) && s.failedText === text && s.failedMedia === mediaKey(p.media) && s.channel === channel && (s.failedTry || 0) === (p.retry || 0)) result = s;
      else {
        let files = null;
        if (p.media && p.media.path) {
          try { files = [await ctx.download(p.media.path)]; }
          catch (e) { result = fail('no-media', {failedText: text, failedMedia: mediaKey(p.media), channel, failedTry: p.retry || 0}); }
        }
        if (!result) {
          const r = await call('POST', `/channels/${channel}/messages`, {content: text, allowed_mentions: MENTIONS}, files);
          result = r.ok
            ? {status: 'sent', due, messageId: r.data.id, channelId: channel, guildId: guild, sentAt: now, sentText: text, sentMedia: mediaKey(p.media), error: ''}
            : fail(r.status === 413 || r.error === 'discord-400-40005' ? 'too-big' : r.error, {failedText: text, failedMedia: mediaKey(p.media), channel, failedTry: p.retry || 0});
        }
      }
    }
    // written straight away, so a post that went out is never sent again even if something below fails
    await save({[k]: result});
  }

  // its entry in the server's Events tab
  const {start, end} = eventTimes(ev, cfg), se = {...(s0.event || {})};
  const want = !!posts.listEvent && !!String(ev.title || '').trim() && KINDS.some(k => posts[k] && posts[k].on && posts[k].ready) && start != null && start > now;
  if (guild && token) {
    if (want) {
      const body = {name: String(ev.title).trim().slice(0, 100), privacy_level: 2, entity_type: 3, entity_metadata: {location: locationOf(cfg).slice(0, 100)},
        scheduled_start_time: new Date(start).toISOString(), scheduled_end_time: new Date(end || start + 4 * 3600000).toISOString(), description: String(ev.notes || '').slice(0, 1000)};
      const sig = JSON.stringify(body);
      if (!se.id || se.sig !== sig) {
        let r = se.id ? await call('PATCH', `/guilds/${guild}/scheduled-events/${se.id}`, body) : null;
        if (!r || r.status === 404) r = await call('POST', `/guilds/${guild}/scheduled-events`, body);
        Object.assign(se, r.ok ? {id: r.data.id, sig, start, error: ''} : {error: r.error});
        if (!r.ok && RETRY(r.error)) retryAt = now + 120000;
      }
    } else if (se.id && start != null && start > now) {
      const r = await call('DELETE', `/guilds/${guild}/scheduled-events/${se.id}`);
      if (r.ok || r.status === 404) { se.id = ''; se.sig = ''; se.error = ''; }
    }
  } else if (want) se.error = !token ? 'no-token' : 'no-server';
  if (retryAt) later(retryAt);

  // when to look again: the next post due, unless the owners changed something meanwhile (then right away)
  await db.runTransaction(async t => {
    const cur = await t.get(sref), rev = cur.exists ? cur.data().rev || 0 : 0;
    t.set(sref, {event: se, due: rev !== rev0 ? 0 : next == null ? null : next, checkedAt: now}, {merge: true});
  });
  return 'checked';
}

// the every-minute check: each event with something due
async function tick(ctx) {
  const now = ctx.now || Date.now();
  const due = await ctx.db.collection('eventpostState').where('due', '<=', now).limit(20).get();
  const done = [];
  for (const d of due.docs) done.push([d.id, await processEvent({...ctx, now}, d.id).catch(e => 'error: ' + e.message)]);
  return done;
}

// a post or an event changed on the site: the next check looks at it
async function changed(db, eid, FieldValue) {
  const exists = (await db.doc('eventposts/' + eid).get()).exists || (await db.doc('eventpostState/' + eid).get()).exists;
  if (!exists) return false;
  await db.doc('eventpostState/' + eid).set({due: 0, rev: FieldValue.increment(1)}, {merge: true});
  return true;
}

module.exports = {processEvent, tick, changed, fill, postTime, eventTimes, venueInstant, venueParts, zoneOf, hhmm, locationOf, KINDS};
