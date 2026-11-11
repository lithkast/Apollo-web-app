'use strict';
// The work behind each function, kept apart from index.js so it can be tried out without Firebase.
// `db` is the Firestore database (the administrator's settings and the delivery log live in it).
//
//   private/discord         the Discord settings from Settings > Discord: {applications: webhook, applicationsPing}
//                           (only the administrator, and these functions, can read it)
//   private/discordStatus   how the last delivery went, shown in Settings > Discord
//   discordLog/<uid>_<sent> one per application delivered, so a retry never posts the same one twice
//   discordTests/<id>       the Send a test message button: the page adds one, the function answers in it

const {applicationMessage, pingText, SAMPLE} = require('./hermes');

const WEBHOOK_RE = /^https:\/\/(?:ptb\.|canary\.)?(?:discord|discordapp)\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+$/;
const DAY = 86400000;
// Firebase tries a failed delivery again for a while; past this it gives up, rather than post a stale application
const GIVE_UP_AFTER = 6 * 3600000;

async function settings(db) {
  const snap = await db.doc('private/discord').get();
  const cfg = snap.exists ? snap.data() || {} : {};
  const hook = String(cfg.applications || '').trim();
  return {hook: WEBHOOK_RE.test(hook) ? hook : '', ping: pingText(cfg.applicationsPing)};
}

// one post to a Discord webhook; `retry` says whether trying again later could help
async function post(url, body, fetchImpl) {
  const go = fetchImpl || fetch;
  let res;
  try {
    res = await go(url + (url.includes('?') ? '&' : '?') + 'wait=true', {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body), signal: AbortSignal.timeout(15000)
    });
  } catch (e) {
    return {ok: false, error: 'network', retry: true};
  }
  if (res.ok) return {ok: true};
  return {ok: false, error: 'discord-' + res.status, retry: res.status === 429 || res.status >= 500};
}

// replaces the whole `applications` entry (a merge would keep an old error next to a new success)
function status(db, now, s) {
  return db.doc('private/discordStatus').set({applications: {...s, at: now}}, {mergeFields: ['applications']});
}

const alreadyExists = e => e && (e.code === 6 || e.code === 'already-exists' || /already exists/i.test(String(e.message)));

// A new application was saved. Returns what happened, for the function's log.
async function newApplication({db, uid, app, eventTime, now = Date.now(), fetchImpl}) {
  if (!app || app.status !== 'new') return 'not new';
  const who = {name: String(app.name || ''), role: String(app.role || '')};
  if (eventTime && now - Date.parse(eventTime) > GIVE_UP_AFTER) {
    await status(db, now, {ok: false, error: 'gave-up', ...who});
    return 'gave up';
  }
  const {hook, ping} = await settings(db);
  if (!hook) {
    await status(db, now, {ok: false, error: 'no-webhook', ...who});
    return 'no webhook';
  }
  // claim it first, so two deliveries of the same event can't both post
  const claim = db.doc('discordLog/' + uid + '_' + (Number(app.sent) || 0));
  try {
    await claim.create({uid, sent: Number(app.sent) || 0, at: now});
  } catch (e) {
    if (alreadyExists(e)) return 'already sent';
    throw e;
  }
  // the position's emoji, from the application as the venue has it now
  const form = await db.doc('appform/main').get(), positions = form.exists && Array.isArray((form.data() || {}).positions) ? form.data().positions : [];
  const emoji = (positions.find(p => p && p.name === app.role) || {}).emoji;
  const res = await post(hook, applicationMessage(app, {ping, emoji, id: uid}), fetchImpl);
  if (res.ok) {
    await status(db, now, {ok: true, ...who});
    return 'sent';
  }
  if (res.retry) {
    // let it go again: Firebase calls this function again a little later
    await claim.delete();
    await status(db, now, {ok: false, error: res.error, retrying: true, ...who});
    throw new Error('Discord did not take the message (' + res.error + '). Trying again later.');
  }
  await status(db, now, {ok: false, error: res.error, ...who});
  return res.error;
}

// The Send a test message button: posts the sample application, and answers in the same document.
async function discordTest({db, id, data, now = Date.now(), fetchImpl}) {
  const ref = db.doc('discordTests/' + id);
  let answer;
  if (!data || data.kind !== 'applications') answer = {result: 'error', error: 'bad-request'};
  else {
    const {hook} = await settings(db);
    if (!hook) answer = {result: 'error', error: 'no-webhook'};
    else {
      const res = await post(hook, applicationMessage({...SAMPLE, sent: now}, {test: true}), fetchImpl);
      answer = res.ok ? {result: 'sent'} : {result: 'error', error: res.error};
    }
  }
  await ref.update({...answer, doneAt: now});
  // tidy up: old tests, and delivery records nobody needs any more
  const oldTests = await db.collection('discordTests').where('at', '<', now - DAY).limit(50).get();
  const oldLog = await db.collection('discordLog').where('at', '<', now - 90 * DAY).limit(50).get();
  await Promise.all([...oldTests.docs, ...oldLog.docs].map(d => d.ref.delete()));
  return answer.result === 'sent' ? 'sent' : answer.error;
}

module.exports = {newApplication, discordTest, post, settings, WEBHOOK_RE, GIVE_UP_AFTER};
