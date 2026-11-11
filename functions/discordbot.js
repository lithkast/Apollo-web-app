'use strict';
// Talking to Discord as the Hermes bot. The bot's token is kept in Google's Secret Manager (DISCORD_BOT_TOKEN),
// never in the database or the site, and is passed in by index.js.

const API = 'https://discord.com/api/v10';
// What Hermes may do in the server: see channels, post (with pictures, videos and links), ping @everyone, use
// emojis from other servers, read back his own messages, and create and manage server events.
const PERMISSIONS = [10, 11, 14, 15, 16, 17, 18, 33, 44].reduce((n, bit) => n + 2n ** BigInt(bit), 0n).toString();
const inviteUrl = appId => `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot&permissions=${PERMISSIONS}`;
// the biggest file Discord takes in a server, by its boost level
const uploadLimit = tier => (tier >= 3 ? 100 : tier === 2 ? 50 : 20) * 1024 * 1024;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// One request to Discord. Returns {ok, status, data} or {ok: false, status, error, message}. A "slow down"
// from Discord is waited out (up to 3 tries).
async function call(token, method, path, body, files, fetchImpl) {
  const go = fetchImpl || fetch;
  if (!token) return {ok: false, status: 0, error: 'no-token'};
  for (let attempt = 0; attempt < 3; attempt++) {
    const init = {method, headers: {Authorization: 'Bot ' + token, 'User-Agent': 'DiscordBot (https://apolloncc.org, 1.0)'}};
    if (files && files.length) {
      const form = new FormData();
      form.append('payload_json', JSON.stringify({...body, attachments: files.map((f, i) => ({id: i, filename: f.name}))}));
      files.forEach((f, i) => form.append(`files[${i}]`, new Blob([f.data], {type: f.type || 'application/octet-stream'}), f.name));
      init.body = form;
    } else if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res;
    try { res = await go(API + path, {...init, signal: AbortSignal.timeout(60000)}); }
    catch (e) { return {ok: false, status: 0, error: 'network'}; }
    let data = null;
    const text = await res.text().catch(() => '');
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    if (res.status === 429) { await sleep(Math.min(10, Number(data && data.retry_after) || 1) * 1000); continue; }
    if (res.ok) return {ok: true, status: res.status, data};
    return {ok: false, status: res.status, error: 'discord-' + res.status + (data && data.code ? '-' + data.code : ''), message: (data && data.message) || ''};
  }
  return {ok: false, status: 429, error: 'discord-429'};
}

// Who the bot is, which servers it is in, and for the server in use: its channels, roles and emojis
async function info(token, guildId, fetchImpl) {
  const me = await call(token, 'GET', '/users/@me', undefined, null, fetchImpl);
  if (!me.ok) return {ok: false, error: me.status === 401 ? 'bad-token' : me.error};
  const bot = {id: me.data.id, name: me.data.global_name || me.data.username, avatar: me.data.avatar};
  const out = {ok: true, bot, invite: inviteUrl(me.data.id), guilds: [], guild: null};
  const gs = await call(token, 'GET', '/users/@me/guilds', undefined, null, fetchImpl);
  if (!gs.ok) return {...out, error: gs.error};
  out.guilds = (gs.data || []).map(g => ({id: g.id, name: g.name}));
  const gid = out.guilds.some(g => g.id === guildId) ? guildId : out.guilds.length === 1 ? out.guilds[0].id : '';
  if (!gid) return out;
  const [g, ch] = await Promise.all([call(token, 'GET', `/guilds/${gid}`, undefined, null, fetchImpl), call(token, 'GET', `/guilds/${gid}/channels`, undefined, null, fetchImpl)]);
  if (!g.ok) return {...out, error: g.error};
  const cats = new Map((ch.data || []).filter(c => c.type === 4).map(c => [c.id, c]));
  out.guild = {
    id: g.data.id, name: g.data.name, icon: g.data.icon, tier: g.data.premium_tier || 0, uploadLimit: uploadLimit(g.data.premium_tier || 0),
    roles: (g.data.roles || []).filter(r => r.name !== '@everyone' && !r.managed).sort((a, b) => b.position - a.position).map(r => ({id: r.id, name: r.name, color: r.color})),
    emojis: (g.data.emojis || []).filter(e => e.available !== false).map(e => ({id: e.id, name: e.name, animated: !!e.animated})),
    channels: (ch.data || []).filter(c => c.type === 0 || c.type === 5)
      .sort((a, b) => ((cats.get(a.parent_id) || {}).position ?? -1) - ((cats.get(b.parent_id) || {}).position ?? -1) || a.position - b.position)
      .map(c => ({id: c.id, name: c.name, group: (cats.get(c.parent_id) || {}).name || ''}))
  };
  return out;
}

// people in the server whose name starts with what was typed
async function members(token, guildId, query, fetchImpl) {
  const q = String(query || '').trim().slice(0, 32);
  if (!q) return {ok: true, members: []};
  const r = await call(token, 'GET', `/guilds/${guildId}/members/search?query=${encodeURIComponent(q)}&limit=10`, undefined, null, fetchImpl);
  if (!r.ok) return {ok: false, error: r.status === 403 ? 'members-intent' : r.error};
  return {ok: true, members: (r.data || []).map(m => ({id: m.user.id, name: m.nick || m.user.global_name || m.user.username, username: m.user.username, avatar: m.user.avatar}))};
}

// Is this message really from Discord? Discord signs each slash command with Hermes' key (Ed25519): the timestamp
// and the body, as they arrived.
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
function verify(keyHex, sigHex, timestamp, rawBody) {
  try {
    if (!keyHex || !sigHex || !timestamp || !rawBody || !/^[0-9a-f]{64}$/i.test(keyHex) || !/^[0-9a-f]{128}$/i.test(sigHex)) return false;
    const key = require('crypto').createPublicKey({key: Buffer.concat([ED25519_SPKI, Buffer.from(keyHex, 'hex')]), format: 'der', type: 'spki'});
    return require('crypto').verify(null, Buffer.concat([Buffer.from(String(timestamp)), Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody))]), key, Buffer.from(sigHex, 'hex'));
  } catch (e) { return false; }
}

module.exports = {call, info, members, verify, inviteUrl, uploadLimit, PERMISSIONS, API};
