'use strict';
// The 50/50 raffle, for Hermes' slash commands and the in-game plugin (ApolloNCC). The Raffle page on the site keeps
// the entries (raffle/<id>: patron, world, discord, tickets, takenBy, paid); this reads them, closes and reopens the
// raffle, and draws the winner.
//   night/raffle   {start, closed, closedAt, closedBy, winner}
//     start    gil already in the pot before any ticket is sold; the club takes its cut of ticket sales only
//     closed   no more tickets; only a closed raffle can be drawn
//     winner   {id, patron, world, discord, discordId, tickets, pot, at, by, byUid}, until the raffle is reopened or cleared
//   private/discord, raffleChannel   where Hermes announces the winner (set with /rafflechannel)
// Every ticket is one chance: someone with five tickets is five times as likely to win as someone with one.
// Only owners, co-owners and the administrator use any of this.

const isNum = v => typeof v === 'number' && !isNaN(v);
const gil = n => `${Math.round(n).toLocaleString('en-US')}g`;
const nref = db => db.doc('night/raffle');

async function read(db, cfg) {
  const [rows, n] = await Promise.all([db.collection('raffle').get(), nref(db).get()]);
  const night = n.exists ? n.data() : {};
  const price = isNum(cfg.raffleTicketPrice) ? cfg.raffleTicketPrice : 0, cut = isNum(cfg.raffleClubCut) ? cfg.raffleClubCut : 0;
  const entries = rows.docs.map(d => ({id: d.id, ...d.data()})).filter(r => isNum(r.tickets) && r.tickets > 0 && String(r.patron || '').trim());
  const tickets = entries.reduce((t, r) => t + r.tickets, 0), sales = tickets * price;
  const start = isNum(night.start) && night.start > 0 ? night.start : 0, club = sales * cut;
  return {entries, tickets, sales, start, total: start + sales, club, pot: start + sales - club, closed: !!night.closed, winner: night.winner || null,
    unpaid: entries.filter(r => !r.paid).length};
}

function statusText(s) {
  const lines = [`**50/50 raffle**: ${s.closed ? 'closed' : 'open'}`,
    `Pot: ${gil(s.total)}${s.start ? ` (${gil(s.start)} to start with)` : ''}. The winner takes ${gil(s.pot)}.`,
    `${s.tickets} ticket${s.tickets === 1 ? '' : 's'} sold to ${s.entries.length} ${s.entries.length === 1 ? 'person' : 'people'}${s.unpaid ? `; ${s.unpaid} not marked paid yet` : ''}.`];
  if (s.winner) lines.push(`Winner: **${s.winner.patron}**${s.winner.world ? ` (${s.winner.world})` : ''}, ${gil(s.winner.pot)}.`);
  return lines.join('\n');
}

async function close(db, now, by) {
  await nref(db).set({closed: true, closedAt: now, closedBy: by.name || ''}, {merge: true});
}
async function reopen(db) {
  await nref(db).set({closed: false, winner: null}, {merge: true});
}

// The Discord account to mention for an entry: what was typed is an id, a mention, or a name to look up in the server.
async function discordId(raw, members) {
  const v = String(raw || '').trim().replace(/^@/, '');
  if (!v) return '';
  const m = /^<@!?(\d{15,21})>$/.exec(v) || /^(\d{15,21})$/.exec(v);
  if (m) return m[1];
  if (!members) return '';
  const r = await members(v).catch(() => null), list = (r && r.ok && r.members) || [], low = v.toLowerCase();
  const hit = list.find(x => String(x.username || '').toLowerCase() === low) || list.find(x => String(x.name || '').toLowerCase() === low) || (list.length === 1 ? list[0] : null);
  return hit ? hit.id : '';
}

// Draws the winner. ctx: {db, now, cfg, randomInt, members(query), post(channelId, message)}; the last two talk to
// Discord and may be left out. Returns {ok, winner, announced} or {ok: false, why}.
async function pick(ctx, by) {
  const {db, now, cfg} = ctx, s = await read(db, cfg);
  if (!s.closed) return {ok: false, why: 'Close the raffle first, so no more tickets are sold while it is drawn.'};
  if (s.winner) return {ok: false, why: `The winner is already drawn: ${s.winner.patron}. Reopen the raffle to draw again.`};
  if (!s.entries.length) return {ok: false, why: 'Nobody has a ticket yet.'};
  let n = ctx.randomInt(s.tickets), won = s.entries[s.entries.length - 1];
  for (const e of s.entries) { if (n < e.tickets) { won = e; break; } n -= e.tickets; }
  const id = await discordId(won.discord, ctx.members);
  const winner = {id: won.id, patron: String(won.patron).trim(), world: String(won.world || ''), discord: String(won.discord || ''), discordId: id,
    tickets: won.tickets, pot: Math.round(s.pot), at: now, by: by.name || '', byUid: by.uid || ''};
  // only if nobody drew in the meantime
  const saved = await db.runTransaction(async tx => {
    const d = await tx.get(nref(db)), cur = d.exists ? d.data() : {};
    if (!cur.closed || cur.winner) return false;
    tx.set(nref(db), {winner}, {merge: true});
    return true;
  });
  if (!saved) return {ok: false, why: 'Someone else just drew or reopened the raffle. Look at the Raffle page.'};
  let announced = false;
  if (ctx.post) {
    const d = await db.doc('private/discord').get(), dc = d.exists ? d.data() : {}, channel = dc.raffleChannel || dc.eventsChannel || '';
    if (channel) {
      const who = id ? `<@${id}>` : `**${winner.patron}**`;
      const r = await ctx.post(channel, {content: `🎟️ **50/50 raffle** 🎟️\nThe winner is ${who}${id ? ` (${winner.patron})` : ''}, with ${winner.tickets} ticket${winner.tickets === 1 ? '' : 's'}! They take home **${gil(winner.pot)}**. Congratulations!`,
        allowed_mentions: {parse: [], users: id ? [id] : []}}).catch(() => null);
      announced = !!(r && r.ok);
    }
  }
  return {ok: true, winner, announced};
}

// Hermes' slash commands: /raffle, /raffleclose, /rafflereopen, /rafflepick, /rafflechannel
async function handle(ctx, cmd, by, body) {
  const {db, now, cfg} = ctx;
  if (cmd === 'raffle') return statusText(await read(db, cfg));
  if (cfg.maintenance && !by.admin) return 'The site is in maintenance mode, so the raffle can\'t be changed right now.';
  if (cmd === 'raffleclose') { await close(db, now, by); return 'The raffle is closed: no more tickets. `/rafflepick` draws the winner, `/rafflereopen` opens it again.'; }
  if (cmd === 'rafflereopen') { await reopen(db); return 'The raffle is open again. Any winner drawn before is forgotten.'; }
  if (cmd === 'rafflechannel') {
    const ch = String((body && body.channel_id) || '');
    if (!ch) return 'I couldn\'t tell which channel this is.';
    await db.doc('private/discord').set({raffleChannel: ch}, {merge: true});
    return `I'll announce raffle winners in <#${ch}> from now on.`;
  }
  if (cmd === 'rafflepick') {
    const r = await pick(ctx, by);
    if (!r.ok) return r.why;
    return `The winner is **${r.winner.patron}**${r.winner.world ? ` (${r.winner.world})` : ''}: ${gil(r.winner.pot)}.`
      + (r.announced ? ' I\'ve announced it.' : ' I couldn\'t announce it: use `/rafflechannel` in the channel where winners should be posted.')
      + ' If you have the plugin open in game, it yells the winner for you.';
  }
  return 'I don\'t know that one. `/help` lists what I can do.';
}

const COMMANDS = [
  {name: 'raffle', description: 'Owners and co-owners: the 50/50 raffle so far'},
  {name: 'raffleclose', description: 'Owners and co-owners: stop selling raffle tickets'},
  {name: 'rafflereopen', description: 'Owners and co-owners: open the raffle again'},
  {name: 'rafflepick', description: 'Owners and co-owners: draw the raffle winner and announce it'},
  {name: 'rafflechannel', description: 'Owners and co-owners: announce raffle winners in this channel'}
];

module.exports = {read, statusText, close, reopen, pick, handle, discordId, COMMANDS};
