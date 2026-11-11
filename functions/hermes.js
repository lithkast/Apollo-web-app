'use strict';
// What Hermes says: the Discord message for a new application, in the style the old Google Form used.
// To change the wording, the emoji, or the short name an answer goes by, change it here and deploy again.

const SITE = 'https://apolloncc.org/';
const NAME = 'Hermes';
const GOLD = 0xD4AF37;

// Each position's emoji, and the short name each answer goes by (in the order the application asks them).
const POSITION_EMOJI = {
  'Bartender / Server': '🍸', 'Bouncer': '🛡️', 'Dancer': '💃', 'Dealer': '🃏',
  'Host / Hostess': '🎙️', 'Photographer': '📸', 'Receptionist': '🛎️'
};
const GENERAL = [
  ['theme', 'Dress According to Theme'], ['sunday', 'Sunday 9 PM–1 AM EST Availability'], ['rp', 'Enjoys Roleplay'],
  ['vip', 'VIP Prep at 8 PM EST'], ['adult', 'Adult-Themed RP'], ['pref', 'Preference']
];
const POSITION_ANSWERS = {
  'Bartender / Server': [['b1', 'Placing Items for RP'], ['b2', 'Engaging with Guests'], ['serve', 'Willing to Serve'], ['why', 'Concern About Serving'],
    ['sense', 'Server Duties Make Sense'], ['solo', 'Running the Bar Solo'], ['fast', 'Fast-Paced Service']],
  'Bouncer': [['comm', 'Communication Skills'], ['conf', 'Comfortable with Confrontation'], ['calm', 'Calm & Neutral Mediation'], ['press', 'Works Well Under Pressure'],
    ['glow', 'Owns a Glowing Weapon'], ['macro', 'Macros or Tells'], ['own', 'Has Own Macros'], ['share', 'Will Share Macros'], ['learn', 'Wants to Learn Macros']],
  'Dancer': [['dances', 'Dances Known'], ['talk', 'Communicates While Roleplaying'], ['priv', 'Private Dances'], ['erp', 'ERP'],
    ['bound', 'Expresses Boundaries'], ['firm', 'Firm About Boundaries']],
  'Dealer': [['d1', 'Spreadsheet Skills'], ['d2', 'Guest RP'], ['d3', 'Willing to Learn Games'], ['d4', 'Has an Astrologian']],
  'Host / Hostess': [['h1', 'Spreadsheet Skills'], ['h2', 'Staff Coordination'], ['h3', 'Patron / Staff RP'], ['h4', 'Yell / Shout Promotion'], ['h5', 'Hosting Events']],
  'Photographer': [['p1', 'Commission with Base Salary'], ['p2', 'Art Style'], ['p3', 'Art Samples / Carrd'], ['p4', 'Does Own Shouts'], ['p5', 'NSFW Requests']],
  'Receptionist': [['r1', 'Spreadsheet Skills'], ['r2', 'Greeting Guests in RP'], ['r3', 'Matching Guests with Dancers'], ['r4', 'Collecting Written Consent']]
};
// answers the applicant typed, rather than picked
const TYPED = ['clubs', 'rec', 'why', 'dances', 'p2', 'p3'];

// The made-up application the Send a test message button shows.
const SAMPLE = {
  name: 'Iris Example', discord: 'iris.example', email: 'iris@example.com', tz: 'EST', role: 'Host / Hostess',
  answers: {q18: 'Yes', exp: 'No', found: "I'm in the Discord, and I saw you had positions open", theme: 'Yes', sunday: 'Yes', rp: 'Yes',
    vip: 'Yes', adult: 'No', h1: 'Yes', h2: 'Yes', h3: 'Yes', h4: 'Yes', h5: 'Yes'}
};

// The questions on every application are the venue's to edit (on the site, Edit the application), and each
// application keeps a copy of the ones it answered (`asked`): {id, t: question, k: kind, h: section, s: name, empty
// for just the answer}. The top of the message always shows these, from the questions every application has:
const TOP = ['name', 'discord', 'tz', 'q18'];

function applicationMessage(app, opts) {
  const o = opts || {}, ans = app.answers && typeof app.answers === 'object' ? app.answers : {};
  const role = String(app.role || ''), emoji = o.emoji || POSITION_EMOJI[role] || '📜', shown = clip(role.replace(/ \/ /g, '/'), 60);
  const heard = [clip(ans.found, 200)];
  if (ans.rec) heard.push(line('rec', 'Recommended By', ans.rec));
  const exp = [line('exp', 'Previous Venue Experience', ans.exp)];
  if (ans.clubs) exp.push(line('clubs', 'Clubs', ans.clubs, 600));
  const ping = o.test ? '' : o.ping || '';
  return {
    username: NAME,
    content: o.test ? '🧪 **Test message.** This is how Hermes will deliver new applications from apolloncc.org.' : ping || undefined,
    allowed_mentions: {parse: ping ? ['roles', 'users', 'everyone'] : []},
    embeds: [{
      title: '🪽 Hermes Delivers a New Application',
      // v2.18: the title opens this application on the site (or Access denied, for someone who may not review it)
      url: o.id ? SITE + 'applications/' + encodeURIComponent(o.id) : SITE,
      color: GOLD,
      description: '**' + clip(app.name, 60) + '** petitions to join the staff of **Apollo** as a ' + emoji + ' **' + shown + '**.\n\n'
        + '*Word has arrived from the mortal realm for your consideration.*',
      fields: [
        field('👤 Character', clip(app.name, 100), true),
        field('💬 Discord', clip(app.discord, 100), true),
        field('📧 Email', clip(app.email, 120), true),
        field(emoji + ' Position', shown, true),
        field('🕐 Time Zone', clip(app.tz, 100), true),
        field('🔞 18+ Verified', mark(ans.q18) + ' ' + clip(ans.q18 || 'Yes', 20), true),
        ...(Array.isArray(app.asked) && app.asked.length ? sections(app.asked, ans) : [
          // sent before the questions could be edited: the original layout
          field('🪽 How They Heard of Apollo', heard.join('\n')),
          field('📜 Previous Venue Experience', exp.join('\n')),
          field('🏛️ General Qualifications', lines(GENERAL, ans)),
          field(emoji + ' ' + shown + ' Application', lines(POSITION_ANSWERS[role] || [], ans))])
      ].filter(x => x.value).slice(0, 25),
      footer: {text: o.test ? "Test message · Apollo's Temple" : "Apollo's Temple · Read it under HR > Applications"},
      timestamp: new Date(Number(app.sent) || Date.now()).toISOString()
    }]
  };
}

// The answers below the top of the message, one part per section, in the order they were asked. Discord allows
// 25 parts and about 6000 characters in all, so a very long application has its typed answers shortened.
function sections(asked, ans) {
  const parts = [];
  for (const q of asked) {
    if (!q || TOP.includes(q.id)) continue;
    const v = ans[q.id];
    if (v == null || String(v).trim() === '') continue;
    const name = String(q.h || 'Answers').slice(0, 250), last = parts[parts.length - 1];
    const part = last && last.name === name ? last : (parts.push({name, items: []}), parts[parts.length - 1]);
    part.items.push(q);
  }
  for (const max of [300, 150, 60]) {
    const out = parts.slice(0, 19).map(p => field(p.name, p.items.map(q => {
      const typed = q.k === 'text' || q.k === 'para';
      if (q.s === '') return clip(ans[q.id], max);
      return (typed ? '📝' : mark(ans[q.id])) + ' **' + plain(q.s) + ':** ' + clip(ans[q.id], typed ? max : 200);
    }).join('\n')));
    if (out.reduce((n, f) => n + f.name.length + f.value.length, 0) < 4500 || max === 60) return out;
  }
}
// a name the venue chose, shown as written but without starting bold or links
const plain = s => String(s || '').replace(/[*_`~|]/g, '').trim().slice(0, 80) || '-';

// ✅ for yes, ❌ for no, 🔸 for any other choice, 📝 for something typed
function mark(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s === 'yes' ? '✅' : s === 'no' ? '❌' : '🔸';
}
function line(id, label, v, max) {
  return (TYPED.includes(id) ? '📝' : mark(v)) + ' **' + label + ':** ' + clip(v, max || 300);
}
function lines(list, ans) {
  return list.filter(([id]) => ans[id] != null && String(ans[id]).trim() !== '').map(([id, label]) => line(id, label, ans[id])).join('\n');
}
// Discord takes up to 1024 characters in each part of the message
function field(name, value, inline) {
  const v = String(value || '');
  return {name, value: v.length > 1024 ? v.slice(0, 1020) + ' …' : v, inline: !!inline};
}
// what the applicant typed, kept short and shown as typed (no bold, links or pings)
function clip(v, n) {
  let s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  if (s.length > n) s = s.slice(0, n - 1).trim() + '…';
  return s ? s.replace(/([\\*_~`|>#[\]()@])/g, '\\$1') : '-';
}

// Who to ping, from Settings: role IDs (the number from Copy Role ID), role or user mentions, @here or @everyone,
// separated by spaces or commas. Anything else is left out.
function pingText(raw) {
  return String(raw || '').split(/[\s,]+/).map(p => {
    if (/^\d{17,20}$/.test(p)) return '<@&' + p + '>';
    if (/^<@[&!]?\d{17,20}>$/.test(p) || p === '@here' || p === '@everyone') return p;
    return '';
  }).filter(Boolean).join(' ');
}

module.exports = {applicationMessage, sections, pingText, clip, SAMPLE, NAME, POSITION_EMOJI, POSITION_ANSWERS};
