'use strict';
// Apollo's Temple: the jobs Firebase runs by itself. `firebase deploy` publishes them along with the site.
//
//   hermesApplication     when someone sends an application, Hermes delivers it to Discord (webhook)
//   hermesTest            the Send a test message button in Settings > Discord
//   discordInfo           for the site: the bot, the server, its channels, roles and emojis
//   discordMembers        for the site: people in the server, by name, to mention in a post
//   eventPostsChanged     an event's Discord posts were edited on the site: look at them again
//   calendarEventChanged  an event changed on the Calendar: its posts and Discord Event follow
//   eventPostsTick        every minute: sends the posts that are due, pushes edits, keeps Discord Events in step,
//                         keeps Hermes' slash commands up to date in the server, and keeps discordInteractions awake
//   discordInteractions   Discord sends Hermes' slash commands here (/clockin, /clockout, /shift, /hrlink ...)
//   discordLinkCode       for the site: a one-time code that links someone's Discord to their login
//   discordUnlink         for the site: undoes that link
//   discordSetup          for the site (administrator): tells Discord about the slash commands again
//   pluginClock           for the in-game plugin (ApolloNCC): clock in and out, like the slash commands
//   listAccounts          for the site (administrator): everyone with an account, Mortals included
//
// The bot's token is a secret (DISCORD_BOT_TOKEN): the first deploy asks for it. BOT-SETUP.txt has the steps.

// Only the parts in use are loaded (not all of firebase-functions/v2), so the deploy's 10 second check stays short.
const {setGlobalOptions} = require('firebase-functions/v2/options');
const {onDocumentCreated, onDocumentWritten} = require('firebase-functions/v2/firestore');
const {onCall, onRequest, HttpsError} = require('firebase-functions/v2/https');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const {defineSecret} = require('firebase-functions/params');
const logger = require('firebase-functions/logger');

// A ceiling, so nothing can ever run up a bill: a handful at once is far more than the venue needs.
setGlobalOptions({maxInstances: 3, timeoutSeconds: 60, memory: '256MiB'});
const BOT_TOKEN = defineSecret('DISCORD_BOT_TOKEN', {description: 'The token of the Hermes bot, from the Discord Developer Portal (Bot > Reset Token).'});
const ADMIN_UID = '1CZiVZOMhMUIdhhJNwTelBrIeYb2';

// The database library is large. It is loaded the first time a function runs, not when this file is read: the
// deploy reads this file to see which functions there are, and gives up after 10 seconds.
let db = null;
function database() {
  if (!db) {
    const {initializeApp, getApps} = require('firebase-admin/app');
    // Firebase's own library sets up a helper of its own to check sign-ins before the site's questions are
    // answered, so look for the main one by name rather than for any at all.
    if (!getApps().some(a => a.name === '[DEFAULT]')) initializeApp();
    db = require('firebase-admin/firestore').getFirestore();
  }
  return db;
}
const fieldValue = () => require('firebase-admin/firestore').FieldValue;
const handlers = () => require('./handlers');
const posts = () => require('./eventposts');
const discord = () => require('./discordbot');
const clock = () => require('./clock');
// pictures and videos for the posts, in the project's storage
function media() {
  database();
  const name = (JSON.parse(process.env.FIREBASE_CONFIG || '{}').storageBucket) || 'apollohr-9b84f.firebasestorage.app';
  const bucket = require('firebase-admin/storage').getStorage().bucket(name);
  return {
    async download(path) {
      const f = bucket.file(path), [data] = await f.download(), [meta] = await f.getMetadata();
      return {data, type: meta.contentType || 'application/octet-stream', name: String(path).split('/').pop().replace(/^\d+-/, '')};
    },
    removeMedia: prefix => bucket.deleteFiles({prefix})
  };
}
// the site's owners, co-owners and the administrator
async function mustOwn(request) {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first.');
  if (uid === ADMIN_UID) return;
  const a = await database().doc('accounts/' + uid).get();
  if (!a.exists || !['owner', 'coowner'].includes(a.data().role)) throw new HttpsError('permission-denied', 'Only owners, co-owners and the administrator use this.');
}
async function settings() { const d = await database().doc('private/discord').get(); return d.exists ? d.data() : {}; }
async function guildId() { return (await settings()).guildId || ''; }

exports.hermesApplication = onDocumentCreated({document: 'applications/{uid}', retry: true}, async event => {
  if (!event.data) return;
  const result = await handlers().newApplication({db: database(), uid: event.params.uid, app: event.data.data(), eventTime: event.time});
  logger.info('New application: ' + result, {uid: event.params.uid});
});

exports.hermesTest = onDocumentCreated('discordTests/{id}', async event => {
  if (!event.data) return;
  const result = await handlers().discordTest({db: database(), id: event.params.id, data: event.data.data()});
  logger.info('Test message: ' + result);
});

// Discord's answer is kept for a minute, so opening the editor again doesn't ask Discord again
let infoCache = null;
exports.discordInfo = onCall({secrets: [BOT_TOKEN]}, async request => {
  await mustOwn(request);
  const cfg = await settings(), g = cfg.guildId || '', fresh = request.data && request.data.fresh;
  let out = infoCache && infoCache.g === g && !fresh && Date.now() - infoCache.at < 60000 ? infoCache.out : null;
  if (!out) { out = await discord().info(BOT_TOKEN.value(), g); infoCache = out.ok ? {g, at: Date.now(), out} : null; }
  return {...out, eventsChannel: cfg.eventsChannel || ''};
});

exports.discordMembers = onCall({secrets: [BOT_TOKEN]}, async request => {
  await mustOwn(request);
  const g = await guildId();
  if (!g) return {ok: false, error: 'no-server'};
  return discord().members(BOT_TOKEN.value(), g, request.data && request.data.query);
});

exports.eventPostsChanged = onDocumentWritten('eventposts/{eid}', async event => {
  await posts().changed(database(), event.params.eid, fieldValue());
});

exports.calendarEventChanged = onDocumentWritten('events/{eid}', async event => {
  await posts().changed(database(), event.params.eid, fieldValue());
});

// Only ever one at a time, so a post can never be sent twice. Big videos need room, hence the memory.
exports.eventPostsTick = onSchedule({schedule: 'every 1 minutes', secrets: [BOT_TOKEN], maxInstances: 1, timeoutSeconds: 300, memory: '1GiB', retryCount: 0}, async () => {
  const done = await posts().tick({db: database(), token: BOT_TOKEN.value(), ...media()});
  if (done.length) logger.info('Event posts checked', {done});
  await Promise.all([
    ensureCommands(false).then(r => { if (r !== 'ok' && r !== 'waiting' && r !== 'no-server') logger.info('Slash commands: ' + r); }, e => logger.warn('Slash commands: ' + e.message)),
    clearOldCodes().catch(() => {}),
    // a look at discordInteractions, so it is awake when someone types a command (Discord waits only 3 seconds)
    fetch(interactionsUrl(), {signal: AbortSignal.timeout(8000)}).catch(() => {})
  ]);
});

// ── Hermes' slash commands ──
const projectId = () => process.env.GCLOUD_PROJECT || (JSON.parse(process.env.FIREBASE_CONFIG || '{}').projectId) || 'apollohr-9b84f';
const interactionsUrl = () => `https://us-central1-${projectId()}.cloudfunctions.net/discordInteractions`;
// who Hermes is (his application id) and the key Discord signs its messages with; asked of Discord once an hour
let appCache = null;
async function application() {
  if (appCache && Date.now() - appCache.at < 3600000) return appCache;
  const r = await discord().call(BOT_TOKEN.value(), 'GET', '/applications/@me');
  if (!r.ok) throw new Error('Discord did not say who Hermes is (' + r.error + ')');
  appCache = {id: r.data.id, key: r.data.verify_key, at: Date.now()};
  return appCache;
}
// Tells Discord about the commands in Hermes' server when they change (or the server does). Every minute this is one
// read of private/discord; after a failure it tries again an hour later. force: the Settings button.
async function ensureCommands(force) {
  const db = database(), dref = db.doc('private/discord'), snap = await dref.get(), d = snap.exists ? snap.data() : {};
  const C = clock(), have = d.commands || {}, token = BOT_TOKEN.value();
  let guild = d.guildId || '';
  if (!force && have.version === C.COMMANDS_VERSION && have.guildId && (!guild || have.guildId === guild) && !have.error) return 'ok';
  if (!force && have.error && Date.now() - (have.at || 0) < 3600000) return 'waiting';
  if (!guild) { const gs = await discord().call(token, 'GET', '/users/@me/guilds'); if (gs.ok && (gs.data || []).length === 1) guild = gs.data[0].id; }
  if (!guild) return 'no-server';
  const app = await application(), r = await discord().call(token, 'PUT', `/applications/${app.id}/guilds/${guild}/commands`, C.COMMANDS);
  await dref.set({commands: {version: C.COMMANDS_VERSION, guildId: guild, at: Date.now(), error: r.ok ? '' : r.error, message: r.ok ? '' : String(r.message || '').slice(0, 200)}}, {merge: true});
  return r.ok ? 'registered' : r.error;
}
async function clearOldCodes() {
  const old = await database().collection('linkCodes').where('expires', '<', Date.now()).limit(50).get();
  await Promise.all(old.docs.map(d => d.ref.delete()));
  // banned patrons the plugin saw in the venue: yesterday's are no use to anyone
  const seen = await database().collection('sightings').where('at', '<', Date.now() - 86400000).limit(50).get();
  await Promise.all(seen.docs.map(d => d.ref.delete()));
}

// Discord sends each slash command here, signed with Hermes' key. The reply goes back in the answer when it is ready
// within 2 seconds (Discord waits 3); otherwise Hermes first says he is on it, then edits that message with the reply.
exports.discordInteractions = onRequest({secrets: [BOT_TOKEN], timeoutSeconds: 60, memory: '256MiB', maxInstances: 5}, async (req, res) => {
  if (req.method === 'GET') {
    // the every-minute look: get ready (the key, the database) so the next command is quick
    try { await application(); database(); } catch (e) { /* answered anyway */ }
    res.status(200).send('Hermes is awake.'); return;
  }
  if (req.method !== 'POST') { res.status(405).end(); return; }
  const cold = !appCache;
  let app;
  try { app = await application(); } catch (e) { logger.error(e.message); res.status(500).end(); return; }
  if (!discord().verify(app.key, req.get('X-Signature-Ed25519'), req.get('X-Signature-Timestamp'), req.rawBody)) { res.status(401).send('invalid request signature'); return; }
  const body = req.body || {};
  if (body.type === 1) { res.json({type: 1}); return; }
  // 2: a slash command; 3: a button pressed under one of Hermes' replies (the /pfclockin question), which then
  // changes that reply in place
  if (body.type !== 2 && body.type !== 3) { res.status(400).end(); return; }
  const button = body.type === 3, what = button ? 'button ' + String((body.data && body.data.custom_id) || '').split(':').slice(0, 2).join(':') : body.data && body.data.name;
  const token = BOT_TOKEN.value(), callback = () => discord().call(token, 'POST', `/interactions/${body.id}/${body.token}/callback`, button ? {type: 6} : {type: 5, data: {flags: clock().PRIVATE}});
  let acked = cold ? callback() : null;
  const timer = cold ? null : setTimeout(() => { acked = callback(); }, 2000);
  let result;
  try { result = await (button ? clock().press : clock().handle)({db: database(), now: Date.now()}, body); }
  catch (e) { logger.error('Command failed', {command: what, error: e.message}); result = 'Something went wrong on my side. Try again in a moment, or use the HR page.'; }
  clearTimeout(timer);
  const reply = result && typeof result === 'object' ? result : {content: result}, allowed = {parse: []};
  // a button's answer replaces the question, buttons and all
  const msg = {content: String(reply.content).slice(0, 1900), allowed_mentions: allowed, ...(reply.components ? {components: reply.components} : button ? {components: []} : {})};
  logger.info('Slash command', {command: what, deferred: !!acked});
  if (!acked) { res.json(button ? {type: 7, data: msg} : {type: 4, data: {...msg, flags: clock().PRIVATE}}); return; }
  await acked;
  const r = await discord().call(token, 'PATCH', `/webhooks/${app.id}/${body.token}/messages/@original`, msg);
  if (!r.ok) logger.warn('Could not edit the reply', {error: r.error});
  res.status(204).end();
});

// a one-time code for the Discord box on someone's profile (staff logins only)
exports.discordLinkCode = onCall(async request => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first.');
  const db = database(), C = clock();
  if (uid !== ADMIN_UID && !(await db.doc('accounts/' + uid).get()).exists) throw new HttpsError('permission-denied', 'Only staff logins link a Discord account.');
  if ((await db.doc('discordLinks/' + uid).get()).exists) return {linked: true};
  const old = await db.collection('linkCodes').where('uid', '==', uid).get();
  await Promise.all(old.docs.map(d => d.ref.delete()));
  const {randomInt} = require('crypto');
  for (let i = 0; i < 5; i++) {
    const code = C.newCode(randomInt), expires = Date.now() + C.CODE_LIFE;
    try { await db.doc('linkCodes/' + code).create({uid, expires}); return {code, expires}; }
    catch (e) { if (e.code !== 6) throw e; }
  }
  throw new HttpsError('unavailable', 'Try again in a moment.');
});
// unlinking: the person themselves, or the administrator for anyone
exports.discordUnlink = onCall(async request => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first.');
  const target = uid === ADMIN_UID && request.data && request.data.uid ? String(request.data.uid) : uid;
  const db = database(), l = await db.doc('discordLinks/' + target).get();
  if (!l.exists) return {ok: true, was: false};
  const id = l.data().discordId;
  if (id) { const u = await db.doc('discordUsers/' + id).get(); if (u.exists && u.data().uid === target) await db.doc('discordUsers/' + id).delete(); }
  await db.doc('discordLinks/' + target).delete();
  return {ok: true, was: true};
});
// Account management (the administrator, owners and co-owners): every account that can sign in, from Firebase
// Authentication, so any Mortal can be made staff, even one no longer on the list of sign-ups. Their staff logins
// and sign-ups are read on the site. `admin` marks the administrator's own account.
exports.listAccounts = onCall(async request => {
  await mustOwn(request);
  database();
  const auth = require('firebase-admin/auth').getAuth(), users = [];
  let token;
  do {
    const page = await auth.listUsers(1000, token);
    for (const u of page.users) users.push({uid: u.uid, email: u.email || '', name: u.displayName || '', disabled: !!u.disabled, admin: u.uid === ADMIN_UID,
      created: Date.parse((u.metadata || {}).creationTime) || null, lastIn: Date.parse((u.metadata || {}).lastSignInTime) || null});
    token = page.pageToken;
  } while (token && users.length < 5000);
  return {users};
});

// The in-game plugin signs in as the person, with their own email and password, and clocks only them. The work
// and the wording are Hermes' own (clock.js).
exports.pluginClock = onCall(async request => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first.');
  const d = request.data || {};
  return {message: await clock().direct({db: database(), now: Date.now()}, uid, String(d.action || ''), String(d.kind || ''))};
});

// Settings: tell Discord about the commands again now (they are also kept up to date by the every-minute check)
exports.discordSetup = onCall({secrets: [BOT_TOKEN]}, async request => {
  if (!request.auth || request.auth.uid !== ADMIN_UID) throw new HttpsError('permission-denied', 'Only the administrator does this.');
  return {result: await ensureCommands(true)};
});
