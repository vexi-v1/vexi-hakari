#!/usr/bin/env node
// Build step for web/plain/ (node, no dependencies, no network).
//  1. Facts: runs facts.js against ../squeeze/data.json; every number on the page comes from there.
//     Fails when a fact cannot be computed, when a claim behind a round number stops holding, when
//     D.hakari.weekend differs from gauge/data/hims-hook-replay.json, or when copy.json carries a digit
//     that is neither a {fact} nor on the allowlist below (with its source).
//  2. index.html: the region between <!-- gen:start --> and <!-- gen:end --> is rendered from copy.json,
//     both languages in the HTML (English shows without JavaScript), every number a <span data-fact>.
//  3. copy.js: window.PLAIN_COPY (chart labels, alt texts, titles) for plain.js.
//  4. ../dist/plain-artifact.html (git-ignored): a single-file Artifact bundle. No doctype/html/head/body,
//     <title> then <style> first, pruned data inline, only Google Fonts external, < 16 MB.
//
// Usage: node web/plain/build-plain.mjs [--no-bundle] [--out path.html]
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const PAGES = 'https://vexi-v1.github.io/vexi-hakari/web/';
const args = process.argv.slice(2);
const has = (k) => args.includes(k);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const rel = (p) => path.join(HERE, p);
const read = (p) => fs.readFileSync(p, 'utf8');
const fail = (msg) => { console.error('build-plain: ' + msg); process.exit(1); };
const problems = [];

// ---------------------------------------------------------------- inputs
const D = JSON.parse(read(path.join(HERE, '..', 'squeeze', 'data.json')));
const SOCIAL = JSON.parse(read(path.join(HERE, '..', 'squeeze', 'social.json')));
const REPLAY = JSON.parse(read(path.join(REPO, 'gauge', 'data', 'hims-hook-replay.json')));
let C;
try { C = JSON.parse(read(rel('copy.json'))); } catch (e) { fail('copy.json is not valid JSON: ' + e.message); }

const ctx = { globalThis: null }; ctx.globalThis = ctx; vm.createContext(ctx);
vm.runInContext(read(rel('facts.js')), ctx, { filename: 'facts.js' });
const PF = ctx.PLAIN_FACTS;
let computed;
try { computed = PF.compute(D); } catch (e) { fail('facts: ' + e.message); }
const F = computed.facts;
const fmt = PF.fmt;
for (const [what, ok] of computed.claims) if (!ok) problems.push('claim no longer holds: ' + what);
for (const k of Object.keys(D.hakari.weekend)) {
  if (JSON.stringify(D.hakari.weekend[k]) !== JSON.stringify(REPLAY.weekend[k])) problems.push(`D.hakari.weekend.${k} differs from gauge/data/hims-hook-replay.json`);
}

// ---------------------------------------------------------------- digit allowlist (numbers typed in copy.json, not computed)
const ALLOW = {
  '28': 'date: Fri 28 Aug 2026 (reference.nyseCloseFri.ts)', '30': 'date: Sun 30 Aug; 30-minute window (hakari.parameters.primary.windowSec)',
  '31': 'date: Mon 31 Aug', '2026': 'year', '8': 'month (8/28); Taipei = UTC+8; 8 pm New York (reference.session24x5Reopen)',
  '9': 'Tokyo = UTC+9; about 9 % of the thinning from LP withdrawals (story.json roles[LPs in the HIMS/USDG pool].outcome)',
  '18': 'Sun 18:00 chart start; ordinary weekend of 2026-09-18 (README "Was HIMS a one-off?")',
  '18:00': 'chart domain start (Sun 18:00 UTC)', '19:40': 'grid minute 1788118800', '21:30': 'grid minute 1788125400',
  '22:00': 'grid minute 1788127200', '23:25': 'grid minute 1788132300 (events min-hims-dollar-pool / min-push-up)',
  '23:53': 'grid minute 1788133980', '00:00': 'reference.mintRuleClosed / session24x5Reopen', '00:37': 'grid minute 1788136620',
  '00:43:30': 'events[mint-first].ts', '01:59': 'grid minute 1788141540', '09:54': 'events[mints-by-0954]', '10:00': 'chart domain end (Mon 10:00 UTC)',
  '10': 'the measured push is +10 % (series.pushUp10CostUsdg); log gridlines ×10; "stayed within 10 %" after backTime (claim checked in facts.js)',
  '2': 'within 2 % (events premium-gone .amount = 1.61)', '1': 'per 1 USDG in the worked example (1.0001^ticks − 1 is per unit of exposure)',
  '1,000': 'payout size replayed (hakari.parameters.exposuresUsdg[0])', '10,000': 'payout size replayed (hakari.parameters.exposuresUsdg[1])',
  '100': 'claim checked in facts.js (cost1940 / cost2353 > 100)', '80': 'claim checked in facts.js (v0Max / nav between 1.75 and 1.8)',
  '25': 'shelf figure scale: one dot = 25 HIMS', '24': 'Robinhood\'s 24/5 session (story.json glossary)', '5': 'Robinhood\'s 24/5 session',
  '35': 'testnet demo pushes the price +35 % (README "On-chain, testnet 46630")', '1,000,000': 'testnet demo exposure (README)',
  '40': 'late buyers at 40–60 USDG (story.json roles[Late buyers of HIMS])', '60': 'same', '29': 'late buyers left near 29 (story.json roles); overview alt: flat near 29 (series.himsUsdg.close)',
  '132': 'the "$132" figure people saw (social.json findings[4])', '12': 'the 12 stock pools of the 2026-09-18 weekend (README)',
  '4663': 'Robinhood Chain mainnet chain id (D.chain.id)', '0.5': 'rounding step in a fact label', '2026-09-18': 'README weekend id',
  '133': 'the only trade above 124.70: a 0.52 HIMS router leg at 133.35 in a small pool (social.json findings[4])',
  '50': 'that small pool charged a 50 % fee (social.json findings[4])',
  '23:24:59': 'the swap that bought the last in-range HIMS (hakari.moments[sun-2325].label; notableSwaps)',
  '13': 'RoaringKitty post at 23:24:46 (social.json post 2094204712144773123 .ts) → the 23:24:59 swap',
  '58': 'anondeguerre post at 00:42:32 (social.json post 2094224283044393196 .ts) → events[mint-first] 00:43:30'
};
const SKIP_KEYS = new Set(['_about', '_merge', 'said', 'href', 'chapter', 'kind', 'level', 'id', 'mono']);
const seenDigits = new Map();
(function walk(o, where) {
  if (typeof o === 'string') {
    const s = o.replace(/\{[A-Za-z0-9]+\}/g, ' ').replace(/\]\([^)]*\)/g, ']').replace(/@\w+/g, ' ');
    for (const m of s.matchAll(/\d[\d,.:\-]*\d|\d/g)) {
      const tok = m[0].replace(/[.,:]$/, '');
      if (!ALLOW[tok]) problems.push(`copy.json ${where}: "${tok}" is neither a {fact} nor allowlisted`);
      else seenDigits.set(tok, (seenDigits.get(tok) || 0) + 1);
    }
    for (const m of o.matchAll(/\{([A-Za-z0-9]+)\}/g)) {
      if (!F[m[1]] && !['when', 'x'].includes(m[1])) problems.push(`copy.json ${where}: unknown fact {${m[1]}}`);
    }
    return;
  }
  if (Array.isArray(o)) { o.forEach((v, i) => walk(v, where + '[' + i + ']')); return; }
  if (o && typeof o === 'object') for (const k of Object.keys(o)) if (!SKIP_KEYS.has(k)) walk(o[k], where ? where + '.' + k : k);
})(C, '');

// Seconds typed into the plain X asides, checked against the post times and the chain
{
  const post = (id) => SOCIAL.posts.find((x) => String(x.id) === id);
  const lastInRange = (D.notableSwaps || []).find((x) => x.pool === 'himsUsdg' && /last .*HIMS/.test(x.note || ''));
  const fm = D.events.find((e) => e.id === 'mint-first');
  if (!lastInRange || lastInRange.ts - post('2094204712144773123').ts !== 13) problems.push('"13 seconds" (RoaringKitty → last in-range HIMS) no longer holds');
  if (fm.ts - post('2094224283044393196').ts !== 58) problems.push('"58 seconds" (anondeguerre → first new tokens) no longer holds');
  if (fmt.hms(lastInRange ? lastInRange.ts : 0) !== '23:24:59') problems.push('"23:24:59" is no longer the swap that bought the last in-range HIMS');
}

// Every string that carries a HAKARI replay number must say so in the same string (or sit under a label that does).
const REPLAY_WORDS = /replay|never had HAKARI|重播|沒裝|沒有裝|從未裝上/;
const replayFacts = Object.keys(F).filter((k) => /replay/.test(F[k].src));
(function walkReplay(o, where, covered) {
  if (typeof o === 'string') {
    const uses = [...o.matchAll(/\{([A-Za-z0-9]+)\}/g)].map((m) => m[1]).filter((k) => replayFacts.includes(k));
    if (uses.length && !covered && !REPLAY_WORDS.test(o)) problems.push(`copy.json ${where}: replay number(s) ${uses.join(', ')} without saying it is a replay`);
    return;
  }
  if (Array.isArray(o)) { o.forEach((v, i) => walkReplay(v, where + '[' + i + ']', covered)); return; }
  if (o && typeof o === 'object') {
    // the scale block's title and the safe figure's chip label everything inside them; chart strings only draw inside the chipped figure
    const cov = covered || (o.title && REPLAY_WORDS.test(JSON.stringify(o.title)) && o.terms) || (o.chip && REPLAY_WORDS.test(JSON.stringify(o.chip)));
    for (const k of Object.keys(o)) if (!SKIP_KEYS.has(k) && k !== 'factLabels') walkReplay(o[k], where ? where + '.' + k : k, cov || k === 'charts' || k === 'tables');
  }
})(C, '', false);

// ---------------------------------------------------------------- rendering helpers
const LANGS = ['en', 'zh'];
const LA = { en: 'en', zh: 'zh-Hant-TW' };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const attr = esc;
const isExt = (h) => /^https?:/.test(h);
const aTag = (href, inner, cls) => `<a${cls ? ` class="${cls}"` : ''} href="${attr(href)}"${isExt(href) ? ' target="_blank" rel="noopener"' : ''}>${inner}</a>`;
function factSpan(id) {
  if (!F[id]) fail('unknown fact {' + id + '}');
  return `<span data-fact="${id}">${esc(F[id].text)}</span>`;
}
// copy mini-markup: {fact}, **bold**, [label](href); params fill {when}-style slots first
function md(s, params) {
  if (s == null) return '';
  let out = String(s);
  if (params) out = out.replace(/\{(\w+)\}/g, (m, k) => (k in params ? params[k] : m));
  out = esc(out);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => aTag(href.replace(/&amp;/g, '&'), label));
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\{([A-Za-z0-9]+)\}/g, (m, k) => factSpan(k));
  return out;
}
// plain text of a copy string, facts filled (alt texts, aria-labels)
const plain = (s) => String(s).replace(/\{([A-Za-z0-9]+)\}/g, (m, k) => (F[k] ? F[k].text : m)).replace(/\*\*/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
function pair(field, tag = 'span', cls = '', params) {
  if (!field) return '';
  if (typeof field === 'string') return `<${tag}${cls ? ` class="${cls}"` : ''}>${md(field, params)}</${tag}>`;
  return LANGS.map((l) => `<${tag} class="t${cls ? ' ' + cls : ''}" lang="${LA[l]}">${md(field[l], params)}</${tag}>`).join('');
}
function paras(field, cls = '') {
  if (!field) return '';
  return LANGS.map((l) => (field[l] || []).map((p) => `<p class="t${cls ? ' ' + cls : ''}" lang="${LA[l]}">${md(p)}</p>`).join('\n')).join('\n');
}
const DAYS = C.ui.days;
const dayTime = (ts, l) => DAYS[l][new Date(ts * 1000).getUTCDay()] + ' ' + fmt.hm(ts);
const dayTimeSec = (ts, l) => DAYS[l][new Date(ts * 1000).getUTCDay()] + ' ' + fmt.hms(ts);
const pairText = (fn) => LANGS.map((l) => `<span class="t" lang="${LA[l]}">${esc(fn(l))}</span>`).join('');

// ---------------------------------------------------------------- data access for tables and static figures
const S = D.series, T0 = D.t[0], TS = PF.TS;
const at = (ts) => { const i = Math.round((ts - T0) / 60); if (D.t[i] !== ts) fail('no grid minute ' + ts); return i; };
const bound = (i) => (S.hakari.gapBoundUsdg[i] != null ? S.hakari.gapBoundUsdg[i] : S.hakari.maxSafeUsdg[i]);

function table(head, rows) {
  const th = head.map((h, i) => `<th scope="col"${i ? ' class="n"' : ''}>${pair(h)}</th>`).join('');
  const tr = rows.map((r) => '<tr>' + r.map((c, i) => (i === 0 ? `<th scope="row">${c}</th>` : `<td class="n">${c}</td>`)).join('') + '</tr>').join('\n');
  return `<details class="nums"><summary>${pair(C.ui.showNumbers)}</summary><div class="tablewrap"><table><thead><tr>${th}</tr></thead><tbody>\n${tr}\n</tbody></table></div></details>`;
}
const TB = C.tables;
const tblCount = () => {
  const burns = D.events.filter((e) => e.kind === 'burn');
  let s = S.himsSupply[0];
  const rows = [[pairText((l) => dayTime(TS.fri1800, l)), esc(fmt.int(s)), '']];
  burns.forEach((b) => { s -= b.amount; rows.push([pairText((l) => dayTimeSec(b.ts, l)), esc(fmt.int(s)), '−' + esc(fmt.int(b.amount))]); });
  rows.push([pairText((l) => dayTime(TS.sat0000, l) + ' → ' + dayTimeSec(F.firstMint.v, l)), factSpan('float'), pair(TB.frozen)]);
  const fm = D.events.find((e) => e.id === 'mint-first');
  rows.push([pairText((l) => dayTimeSec(fm.ts, l)), esc(fmt.int(F.float.v + fm.amount)), '+' + factSpan('firstMintAmt')]);
  return table([TB.time, TB.tokens, TB.change], rows);
};
const tblShelf = () => table([TB.time, TB.himsPool, TB.usdgPool], [TS.sun1940, TS.sun2130, TS.sun2200, TS.sun2325].map((ts) => {
  const i = at(ts), h = S.himsInHimsUsdg[i];
  return [pairText((l) => dayTime(ts, l)), esc(h >= 100 ? fmt.int(h) : fmt.fix(h, 2)), esc(fmt.int(S.usdgInHimsUsdg[i]))];
}));
const tblPrice = () => {
  const rows = [TS.sun1940, TS.sun2200, TS.sun2325, F.peakTime.v, TS.sun2353].map((ts) => {
    const c = S.himsUsdg.close[at(ts)];
    return [pairText((l) => dayTime(ts, l)) + (ts === F.peakTime.v ? ' · ' + pair(TB.peakRow) : ''), esc(fmt.fix(c, 2)), esc(fmt.fix(c / F.nav.v, 2) + '×')];
  });
  const m = D.hakari.moments.find((x) => x.id === 'mon-004330');
  rows.push([pairText((l) => dayTimeSec(m.ts, l)) + ' · ' + pair(TB.firstMintRow), esc(fmt.fix(m.usdgPerHims, 2)), esc(fmt.fix(m.usdgPerHims / F.nav.v, 2) + '×')]);
  return table([TB.time, TB.price, TB.times], rows);
};
const COST_ROWS = [['cost1940', TS.sun1940], ['costMin', TS.sun2325], ['cost2353', TS.sun2353], ['cost0159', TS.mon0159]];
const tblCost = () => table([TB.time, TB.cost], COST_ROWS.map(([id, ts]) => [pairText((l) => dayTime(ts, l)), esc(fmt.fix(S.pushUp10CostUsdg[at(ts)], 2))]));
const tblRestock = () => {
  // first row: the pool at the first new tokens (hakari.moments[mon-004330], the same row as the price table) and the count just after them
  const m = D.hakari.moments.find((x) => x.id === 'mon-004330');
  const first = [pairText((l) => dayTimeSec(m.ts, l)) + ' · ' + pair(TB.firstMintRow), esc(fmt.fix(m.usdgPerHims, 2)), esc(fmt.int(F.float.v + F.firstMintAmt.v))];
  return table([TB.time, TB.price, TB.tokens], [first].concat([TS.mon0100, F.backTime.v, TS.mon0300, TS.mon0600, TS.mon0954].map((ts) => {
    const i = at(ts);
    return [pairText((l) => dayTime(ts, l)), esc(fmt.fix(S.himsUsdg.close[i], 2)), esc(fmt.int(S.himsSupply[i]))];
  })));
};
const tblSafe = () => table([TB.time, TB.safe, TB.payout], [TS.sun1940, TS.sun2200, TS.sun2325, TS.sun2353, TS.mon0043, TS.mon0159].map((ts) => {
  const i = at(ts), dec = S.hakari.decision.e1000[i];
  const verdict = dec === 0 ? `<span class="verdict no"><i aria-hidden="true">✕</i> ${pair(C.charts.refused)}</span>` : `<span class="verdict yes"><i aria-hidden="true">✓</i> ${pair(C.charts.paid)}</span>`;
  return [pairText((l) => dayTime(ts, l)), esc(fmt.amount(bound(i))), verdict];
}));

// ---------------------------------------------------------------- static figures
const lockSvg = '<svg class="lock" viewBox="0 0 10 12" width="10" height="12" aria-hidden="true"><path d="M2.5 5V3.5a2.5 2.5 0 0 1 5 0V5" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="0.7" y="5" width="8.6" height="6.3" rx="1.2" fill="currentColor"/></svg>';

function figRoute(fig) {
  const node = (k, n) => `<div class="node n-${k}"><p class="node-t">${pair(n.title)}</p><p class="node-s">${pair(n.sub)}</p></div>`;
  const edge = (k, e) => `<div class="edge e-${k}"><div class="wire" aria-hidden="true"></div><div class="e-text"><p class="e-label"><i class="key key-${k}" aria-hidden="true"></i>${pair(e.label)}</p><p class="e-sub">${pair(e.sub)}</p><p class="e-when">${pair(e.when)}</p></div></div>`;
  return `<div class="route">
<div class="factory"><p class="node-t">${pair(fig.factory.title)}</p><p class="node-s">${pair(fig.factory.sub)}</p></div>
<div class="gate"><div class="gate-wire" aria-hidden="true"><i class="gate-bar"></i></div><p class="gate-t">${lockSvg}${pair(fig.factory.gate)}</p></div>
${node('usdg', fig.nodes.usdg)}
${edge('usd', fig.edges.usd)}
${node('hims', fig.nodes.hims)}
${edge('boner', fig.edges.boner)}
${node('boner', fig.nodes.boner)}
</div>`;
}
function figShelf(fig) {
  const shelves = [['pool1940', TS.sun1940], ['pool2200', TS.sun2200], ['poolMin', TS.sun2325]].map(([id, ts], si) => {
    const v = S.himsInHimsUsdg[at(ts)], dots = v / 25, full = Math.floor(dots), frac = dots - full;
    let slots = '';
    for (let r = 0; r < 9; r++) for (let c = 0; c < 12; c++) {
      const idx = (8 - r) * 12 + c;
      if (idx < full) slots += '<i class="s f"></i>';
      else if (idx === full && frac > 0.001) slots += `<i class="s p" style="--f:${Math.sqrt(frac).toFixed(3)}"></i>`;
      else slots += '<i class="s"></i>';
    }
    return `<div class="shelf"><div class="slots" aria-hidden="true">${slots}</div><p class="sh-time">${pairText((l) => dayTime(ts, l))}</p><p class="sh-val">${factSpan(id)}</p>${si === 2 ? `<p class="sh-note">${pair(fig.lessThanDot)}</p>` : ''}</div>`;
  }).join('\n');
  return `<p class="shelf-key"><i class="dot" aria-hidden="true"></i>${pair(fig.key)}</p>
<div class="shelves" role="img" aria-label="${attr(plain(fig.alt.en))}" data-alt-zh="${attr(plain(fig.alt.zh))}">
${shelves}
</div>`;
}
function figCost(fig) {
  const max = 1400;
  const rows = COST_ROWS.map(([id, ts]) => {
    const v = F[id].v, w = (v / max * 100).toFixed(3);
    const note = fig.notes[id] ? ' · ' + pair(fig.notes[id]) : '';
    return `<div class="bar-row" tabindex="0" data-ts="${ts}" data-fact-ref="${id}">
<p class="bar-time">${pairText((l) => dayTime(ts, l))}${note}</p>
<div class="bar-track"><i class="bar" style="--w:${w}%"></i><span class="bar-val" style="--w:${w}%">${factSpan(id)}</span></div>
</div>`;
  }).join('\n');
  const ticks = [0, 500, 1000].map((t) => `<span class="tick" style="--x:${(t / max * 100).toFixed(3)}%">${esc(fmt.int(t))}${t === 1000 ? ' USDG' : ''}</span>`).join('');
  const grid = [500, 1000].map((t) => `<i class="gl" style="--x:${(t / max * 100).toFixed(3)}%"></i>`).join('');
  return `<div class="bars"><div class="bars-in">${grid}
${rows}
<div class="bar-axis" aria-hidden="true">${ticks}</div>
</div></div>`;
}
function figReaders(fig) {
  const cards = fig.cards.map((c) => `<li class="app"><p class="app-t">${pair(c.title)}</p><p class="app-s">${pair(c.text)}</p></li>`).join('\n');
  return `<div class="readers">
<div class="src"><p class="src-label">${pair(fig.pill)}</p><p class="src-num">${factSpan('peakClose')}</p><i class="key key-bar" aria-hidden="true"></i><p class="src-ref"><i class="key key-dash" aria-hidden="true"></i>${pair(fig.pillRef)}</p></div>
<div class="join" aria-hidden="true"></div>
<div class="apps"><p class="apps-above">${pair(fig.above)}</p><ul>
${cards}
</ul></div>
</div>`;
}

function figure(sec) {
  const fig = sec.figure; if (!fig) return '';
  const id = sec.id, tid = `fig-${id}-t`;
  const chip = fig.chip ? `<p class="chip"><i class="chip-dot" aria-hidden="true"></i>${pair(fig.chip)}</p>` : '';
  const head = `<div class="fig-head"><p class="fig-title" id="${tid}">${pair(fig.title)}</p>${chip}<p class="fig-unit">${pair(fig.unit)}</p></div>`;
  let body = '', tbl = '';
  const plot = (kind) => `<div class="plot" data-plot="${kind}" tabindex="0" role="img" aria-label="${attr(plain(fig.alt.en))}" data-alt-zh="${attr(plain(fig.alt.zh))}"></div>`;
  switch (fig.kind) {
    case 'count': body = `<p class="stat"><span class="stat-num">${factSpan('float')}</span><span class="stat-label">${pair(fig.stat)}</span></p>` + plot('count'); tbl = tblCount(); break;
    case 'route': body = figRoute(fig); break;
    case 'shelf': body = figShelf(fig); tbl = tblShelf(); break;
    case 'price': body = plot('price'); tbl = tblPrice(); break;
    case 'cost': body = figCost(fig); tbl = tblCost(); break;
    case 'restock': body = plot('restock'); tbl = tblRestock(); break;
    case 'readers': body = figReaders(fig); break;
    case 'safe': body = plot('safe'); tbl = tblSafe(); break;
    default: fail('unknown figure kind ' + fig.kind);
  }
  return `<figure class="viz viz-${fig.kind}" data-in="0" aria-labelledby="${tid}">
${head}
${body}
<figcaption>${pair(fig.caption)}</figcaption>
${tbl}
</figure>`;
}

// X asides: the post's paraphrase from social.json (shared with the detailed replay), or the row's own
// plain-language retelling (saidPlain) when the shared wording is too technical for this page.
function said(postId, plainText) {
  if (!postId) return '';
  const p = SOCIAL.posts.find((x) => String(x.id) === String(postId));
  if (!p) fail('social.json has no post ' + postId);
  const who = p.author.displayI18n || { en: p.author.display, zh: p.author.display };
  const meta = LANGS.map((l) => `<span class="t" lang="${LA[l]}">${md(C.ui.onX[l], { when: esc(dayTime(p.ts, l)) })} · ${esc(who[l])} · ${esc(C.ui.paraphrased[l])}</span>`).join('');
  return `<aside class="said"><p class="said-meta">${meta}</p><p class="said-text">${pair(plainText || p.paraphrase)}</p><p class="said-link">${aTag(p.url, pair(C.ui.thePost))}</p></aside>`;
}
function scale(sc) {
  if (!sc) return '';
  const term = (num, label, cls) => `<div class="term${cls ? ' ' + cls : ''}"><p class="term-n">${num}</p><p class="term-l">${pair(label)}</p></div>`;
  return `<div class="scale"><p class="scale-t">${pair(sc.title)}</p>
<div class="eq" aria-hidden="true">${term(factSpan('fakeCost') + ' <small>USDG</small>', sc.terms.cost)}<div class="eq-g"><span class="op">÷</span>${term(factSpan('fakeGain'), sc.terms.gain)}</div><div class="eq-g"><span class="op">≈</span>${term(factSpan('safeMin') + ' <small>USDG</small>', sc.terms.safe, 'result')}</div></div>
${paras(sc.text ? { en: [sc.text.en], zh: [sc.text.zh] } : null, 'scale-p')}</div>`;
}
function sourcesTable(src) {
  const rows = Object.keys(F).map((k) => {
    const lab = C.factLabels[k];
    if (!lab) problems.push('copy.json factLabels has no label for fact ' + k);
    return `<tr><td class="n">${factSpan(k)}</td><td>${lab ? pair(lab) : ''}</td><td><code>${esc(F[k].src)}</code></td></tr>`;
  }).join('\n') + '\n' + Object.keys(ALLOW).filter((k) => seenDigits.has(k)).map((k) =>
    `<tr class="typed"><td class="n">${esc(k)}</td><td>${pair(src.typed)}</td><td>${esc(ALLOW[k])}</td></tr>`).join('\n');
  return `<details class="facts" id="numbers"><summary>${pair(src.title)}</summary>
<p class="facts-intro">${pair(src.intro)}</p>
<div class="tablewrap"><table><thead><tr><th scope="col" class="n">${pair(src.cols.value)}</th><th scope="col">${pair(src.cols.what)}</th><th scope="col">${pair(src.cols.key)}</th></tr></thead><tbody>
${rows}
</tbody></table></div></details>`;
}

function row(sec) {
  const h = sec.level === 3 ? 'h3' : 'h2';
  const kicker = `<p class="kicker">${pair(sec.kicker)}</p>`;
  const head = `<${h} class="${h}">${pair(sec.headline)}</${h}>`;
  const ta = `<div class="ta">${kicker}${head}\n${paras(sec.lead)}</div>`;
  const myth = sec.myth ? `<aside class="myth"><p class="myth-t">${pair(sec.myth.title)}</p>${pair(sec.myth.text, 'p', 'myth-p')}</aside>` : '';
  const take = sec.takeaway ? `<p class="take">${pair(sec.takeaway)}</p>` : '';
  const cur = sec.curious ? `<details class="curious"><summary>${pair(C.ui.curious)}</summary>${pair(sec.curious, 'p')}</details>` : '';
  const more = sec.more ? `<p class="more">${aTag('../squeeze/#' + sec.more.chapter, pair(sec.more.label))}</p>` : '';
  if (sec.id === 'see') {
    const cards = sec.cards.map((c, i) => `<li>${aTag(c.href, `<span class="card-t">${pair(c.title)}</span><span class="card-s">${pair(c.text)}</span>${c.mono ? `<code class="card-m">${esc(c.mono)}</code>` : ''}`, 'card' + (i === 0 ? ' primary' : ''))}</li>`).join('\n');
    return `<section class="row row-see" id="${sec.id}">
${ta}
<div class="tb">${paras(sec.body)}${take}</div>
<ul class="cards">
${cards}
</ul>
${sourcesTable(sec.sources)}
</section>`;
  }
  return `<section class="row" id="${sec.id}">
${ta}
${figure(sec)}
<div class="tb">${scale(sec.scale)}${paras(sec.body)}${myth}${take}${cur}${said(sec.said, sec.saidPlain)}${more}</div>
</section>`;
}

function page() {
  const H = C.hero, U = C.ui;
  const header = `<a class="skip" href="#token">${pair(U.skip)}</a>
<header class="hdr"><div class="wrap hdr-in">
<a class="back" href="../index.html">${pair(U.back)}</a>
<p class="hdr-title">${pair(U.headerTitle)}</p>
<div class="seg" role="group" aria-label="${attr(U.langGroup.en)}"><button type="button" id="lang-en" lang="en" aria-pressed="true">EN</button><button type="button" id="lang-zh" lang="zh-Hant-TW" aria-pressed="false">繁中</button></div>
<a class="hdr-replay" href="../squeeze/"><span class="long">${pair(U.replayLong)}</span><span class="short">${pair(U.replayShort)}</span></a>
</div></header>`;
  const hero = `<section class="hero" id="top"><div class="wrap hero-in">
<p class="kicker">${pair(H.kicker)}</p>
<h1 class="h1">${pair(H.h1)}</h1>
<p class="dek">${pair(H.dek)}</p>
<div class="pair">
<div class="big"><p class="big-num">${factSpan('peakClose')}</p><i class="key key-pool" aria-hidden="true"></i><p class="big-label">${pair(H.peakLabel)}</p></div>
<div class="big"><p class="big-num">${factSpan('nav')}</p><i class="key key-ref" aria-hidden="true"></i><p class="big-label">${pair(H.navLabel)}</p></div>
</div>
<figure class="overview"><div class="plot" data-plot="overview" role="img" aria-label="${attr(plain(H.overviewAlt.en))}" data-alt-zh="${attr(plain(H.overviewAlt.zh))}"></div></figure>
<div class="hero-foot">
<div class="short"><h2 class="h-short">${pair(H.shortTitle)}</h2>
${paras(H.short)}
<p class="unit-note">${pair(H.unitNote)}</p></div>
<div class="start"><a class="btn" href="#token">${pair(H.start)}</a><a class="skipto" href="#hakari">${pair(H.skipToHakari)}</a></div>
</div>
</div></section>`;
  const rows = C.sections.map(row).join('\n\n');
  const Ft = C.footer;
  const footer = `<footer class="foot"><div class="wrap foot-in">
<div><h2 class="foot-h">${pair(Ft.sourcesTitle)}</h2>${pair(Ft.sources, 'p')}</div>
<div><h2 class="foot-h">${pair(Ft.replayTitle)}</h2>${pair(Ft.replay, 'p')}${pair(Ft.units, 'p')}</div>
<p class="foot-line">${pair(Ft.line)}</p>
</div></footer>`;
  return `${header}
<main id="main">
${hero}
<div class="wrap rows">
${rows}
</div>
</main>
${footer}
<div class="tip" id="tip" role="tooltip" hidden></div>
<div class="sr-only" id="live" aria-live="polite"></div>`;
}

// ---------------------------------------------------------------- 2. index.html
const GEN_A = '<!-- gen:start -->', GEN_B = '<!-- gen:end -->';
let html = read(rel('index.html'));
const gi = html.indexOf(GEN_A), gj = html.indexOf(GEN_B);
if (gi < 0 || gj < gi) fail('index.html has no <!-- gen:start --> / <!-- gen:end --> region');
const generated = page();
html = html.slice(0, gi + GEN_A.length) + '\n' + generated + '\n' + html.slice(gj);
html = html.replace(/<title>[^<]*<\/title>/, `<title>${esc(C.meta.docTitle.en)}</title>`)
  .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${attr(C.meta.description.en)}">`);

// fact check on the HTML as written (both languages)
let factSpans = 0;
for (const m of html.matchAll(/<span data-fact="([A-Za-z0-9]+)">([^<]*)<\/span>/g)) {
  factSpans++;
  if (!F[m[1]]) problems.push('index.html: unknown fact ' + m[1]);
  else if (m[2] !== esc(F[m[1]].text)) problems.push(`index.html: fact ${m[1]} reads "${m[2]}", data says "${F[m[1]].text}"`);
}
if (problems.length) { console.error('build-plain: checks failed:\n - ' + problems.join('\n - ')); process.exit(1); }
fs.writeFileSync(rel('index.html'), html);

// ---------------------------------------------------------------- 3. copy.js
const pub = Object.fromEntries(Object.entries(C).filter(([k]) => !k.startsWith('_')));
fs.writeFileSync(rel('copy.js'), '/* generated by build-plain.mjs from copy.json; do not edit */\nwindow.PLAIN_COPY = ' + JSON.stringify(pub) + ';\n');
console.log(`facts     ${Object.keys(F).length} computed, ${factSpans} spans in index.html, ${computed.claims.length} claims hold, replay parity ok`);
console.log(`copy      ${C.sections.length} rows + hero, ${[...seenDigits.keys()].length} allowlisted literal numbers; copy.js written`);
if (has('--no-bundle')) process.exit(0);

// ---------------------------------------------------------------- 4. the Artifact bundle
const between = (a, b) => {
  const i = html.indexOf(a), j = html.indexOf(b);
  if (i < 0 || j < 0 || j < i) fail(`markers ${a} / ${b} not found in index.html`);
  return html.slice(i + a.length, j).trim();
};
const title = C.meta.docTitle.en;
const headLinks = between('<!-- bundle:head-start -->', '<!-- bundle:head-end -->');
let body = between('<!-- bundle:body-start -->', '<!-- bundle:body-end -->');
body = body.replace(/href="\.\.\/index\.html"/g, `href="${PAGES}"`)
  .replace(/href="\.\.\/squeeze\/(#[\w-]+)?"/g, (m, h) => `href="${PAGES}squeeze/${h || ''}" target="_blank" rel="noopener"`)
  .replace(/href="\.\.\/#measure-live"/g, `href="${PAGES}#measure-live" target="_blank" rel="noopener"`)
  .replace(/href="\.\.\/(live|vexi)\/"/g, (m, d) => `href="${PAGES}${d}/" target="_blank" rel="noopener"`);
if (/href="\.\.\//.test(body)) fail('bundle body still has a relative ../ link');
const scriptList = [...between('<!-- bundle:scripts-start -->', '<!-- bundle:scripts-end -->').matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);

// pruned data: only what facts.js and plain.js read
function prune(D) {
  const keepEvents = new Set(['peak-close', 'min-hims-dollar-pool', 'max-hims-boner-pool', 'min-push-up', 'peak-swap', 'premium-gone', 'mints-by-0954', 'mint-first', 'arb-1', 'arb-2']);
  const s = D.series;
  return {
    version: D.version, generatedAt: D.generatedAt, chain: { id: D.chain.id, name: D.chain.name },
    window: D.window, reference: D.reference, t: D.t,
    series: {
      himsUsdg: { close: s.himsUsdg.close }, himsInHimsUsdg: s.himsInHimsUsdg, usdgInHimsUsdg: s.usdgInHimsUsdg,
      himsInBonerHims: s.himsInBonerHims, himsSupply: s.himsSupply, pushUp10CostUsdg: s.pushUp10CostUsdg,
      hakari: { maxSafeUsdg: s.hakari.maxSafeUsdg, gapBoundUsdg: s.hakari.gapBoundUsdg, decision: { e1000: s.hakari.decision.e1000 }, rawTick: { w1800: s.hakari.rawTick.w1800 } }
    },
    events: D.events.filter((e) => keepEvents.has(e.id) || e.kind === 'mint' || e.kind === 'burn'),
    hakari: { counterfactual: D.hakari.counterfactual, parameters: D.hakari.parameters, encoding: D.hakari.encoding, moments: D.hakari.moments, weekend: D.hakari.weekend, derived: D.hakari.derived, caveats: D.hakari.caveats }
  };
}
const pruned = prune(D);
try { PF.compute(JSON.parse(JSON.stringify(pruned))); } catch (e) { fail('pruned data no longer computes the facts: ' + e.message); }
const safeInline = (s) => s.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
const css = read(rel('plain.css'));
const parts = [`<title>${esc(title)}</title>`, `<style>\n${css}\n</style>`, headLinks, body];
for (const s of scriptList) {
  let js;
  if (s === '../squeeze/data.js') js = 'window.SQUEEZE_DATA = ' + JSON.stringify(pruned) + ';\n';
  else js = read(rel(s));
  parts.push(`<script>/* ${s} */\n${safeInline(js)}\n</script>`);
}
const out = parts.join('\n') + '\n';

const bp = [];
const bytes = Buffer.byteLength(out);
if (bytes > 16 * 1024 * 1024) bp.push(`bundle is ${(bytes / 1048576).toFixed(2)} MB (limit 16 MB)`);
if (/<!doctype/i.test(out)) bp.push('contains <!doctype>');
if (/<html[\s>]/i.test(out) || /<\/html>/i.test(out)) bp.push('contains <html>');
if (/<body[\s>]/i.test(out) || /<\/body>/i.test(out)) bp.push('contains <body>');
if (/<head[\s>]/i.test(out)) bp.push('contains <head>');
const tIdx = out.indexOf('<title>');
if (tIdx !== 0 || out.indexOf('</title>') > 8192) bp.push('<title> is not at the top / within the first 8 KB');
if (out.indexOf('<style>') !== out.indexOf('</title>') + '</title>'.length + 1) bp.push('<style> does not follow <title> directly');
const allowed = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com', 'cdn.jsdelivr.net'];
const requests = [];
for (const m of out.matchAll(/<(script|link|img|iframe|source|video|audio)\b[^>]*\b(src|href)="(https?:)?\/\/([^/"]+)[^"]*"/gi)) {
  const tag = m[1].toLowerCase();
  if (tag === 'link' && !/rel="(stylesheet|preconnect|preload)"/.test(m[0])) continue;
  requests.push(m[4]);
}
for (const m of out.matchAll(/url\(\s*['"]?(https?:)?\/\/([^/'")]+)/gi)) requests.push(m[2]);
for (const m of out.matchAll(/\.href\s*=\s*'https:\/\/([^/']+)/g)) requests.push(m[1]);
const bad = [...new Set(requests)].filter((h) => !allowed.includes(h));
if (bad.length) bp.push('external requests to non-allowed hosts: ' + bad.join(', '));
if (/<script[^>]+type="module"/i.test(out)) bp.push('contains an ES module script');
if (/\bfetch\(/.test(out)) bp.push('contains fetch(');
if (bp.length) { console.error('bundle checks failed:\n - ' + bp.join('\n - ')); process.exit(1); }
fs.mkdirSync(path.join(HERE, '..', 'dist'), { recursive: true });
const outPath = opt('--out') ? path.resolve(opt('--out')) : path.join(HERE, '..', 'dist', 'plain-artifact.html');
fs.writeFileSync(outPath, out);
console.log(`bundle    ${path.relative(process.cwd(), outPath)}  ${(bytes / 1048576).toFixed(2)} MB  title@${tIdx}  hosts: ${[...new Set(requests)].join(', ') || 'none'}`);
