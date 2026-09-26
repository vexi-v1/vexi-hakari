// SPDX-License-Identifier: MIT
import { calculateBand, units } from './band.mjs';
import { resolveLanguage, translate } from './i18n.mjs';
const $ = (id) => document.getElementById(id);
const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const repo = 'https://github.com/vexi-v1/vexi-hakari';
let savedLanguage;
try { savedLanguage = localStorage.getItem('hakari-language'); } catch { /* Storage is optional. */ }
let language = resolveLanguage(location.search, savedLanguage);
const t = (message, params) => translate(message, language, params);
// Capture only the initial static document. Dynamic evidence/logs are rendered separately, never translated.
const staticText = [];
const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
while (walker.nextNode()) {
  const node = walker.currentNode;
  if (!node.textContent.trim() || node.parentElement.closest('script,style,pre,code,noscript,[translate="no"]')) continue;
  staticText.push({ node, original: node.textContent, message: node.textContent.trim() });
}
const staticAttributes = [];
for (const node of document.querySelectorAll('[aria-label],[title],meta[name="description"]')) {
  if (node.closest('[translate="no"]')) continue;
  for (const attribute of ['aria-label', 'title', ...(node.matches('meta') ? ['content'] : [])]) {
    if (node.hasAttribute(attribute)) staticAttributes.push({ node, attribute, message: node.getAttribute(attribute) });
  }
}

const instructions = {
  initial: ['Start with the wallet', 'The maker has 30 TSLA and 20,000 USDG. The buyer and spot taker are separate synthetic accounts. The book holds no tokens. Both options have a 400 USDG strike and one contract represents one TSLA.', ['Maker wallet', 'No escrow']],
  ship: ['Ship two strategies', 'Aqua records virtual balances for the option writer and the canonical SwapVM router. Both refer to the same wallet. Virtual allocations are not separate deposits and must not be added together as assets.', ['Maker', 'Aqua.ship', 'Writer.bind']],
  post: ['Promise, without moving funds', 'Ten covered calls promise 10 TSLA. Ten puts promise 4,000 USDG. Each fixed quote starts at 8 USDG per contract, with a deadline and a 5% original-price anchor.', ['Writer.post', 'Book.post', 'promised ↑']],
  spot: ['A guarded spot trade', 'The spot taker pays 400 USDG. The guard caps output inventory at 30 − 10 = 20 free TSLA and scales both virtual reserves. The canonical router executes the swap while preserving the option promise.', ['SwapVM', 'ExposureGuard', 'Aqua.pull / push']],
  buy: ['Promises become collateral', 'The buyer pays the band-adjusted premiums for 5 calls and 3 puts. Within each buy, Aqua pulls exactly 5 TSLA or 1,200 USDG into the book. Unfilled promises shrink; ERC-1155 long balances increase.', ['Book.buy', 'Band.ask', 'Writer.provide', 'Aqua.pull']],
  taper: ['Halfway to the edge', 'The reference pool is pushed to 2.5% above the rolling center. The per-call size cap falls to about half; the extra premium is about 5%. This step reads a quote without buying more options.', ['v4 reference swap', 'Band.status', 'Book.quotePremium']],
  pause: ['The book actually refuses', 'At +5.1%, a real buy reverts with Paused(OutsideBand). The assertion checks that the buyer keeps the same USDG balance and long position. The reference-pool swap is a separate test action.', ['Reference outside band', 'Book.buy', 'REVERT']],
  recover: ['Reference recovery', 'The reference returns to its earlier price. A one-contract quote becomes available again, provided the original deadline and anchor still pass. No new option is bought at this step.', ['Reference returns', 'Band open', 'Quote available']],
  expired: ['An open band is not enough', 'Time advances to the original quote deadline. The band is open, but a buy reverts with QuoteExpired. The buyer’s funds stay unchanged. Rolling TWAP recovery cannot extend a quote’s lifetime.', ['Band open', 'FixedPremium.ask', 'QuoteExpired']],
  renew: ['The maker explicitly renews', 'The maker writes new quote terms, including a fresh deadline and anchor. This is an explicit owner action; the pool and the band do not silently renew stale fixed premiums.', ['Maker', 'setAnchoredPremium', 'Quote available']],
  settle: ['Record the accepted window', 'At expiry, the five-minute TWAP lies within 5% of the fixed pre-expiry reference. The adapter records that price and both series settle. The put is in the money; the call is out of the money.', ['Hook observations', 'ExpiryPrice.record', 'Book.settle']],
  exercise: ['Physical put exercise', 'The buyer burns 3 put contracts, delivers 3 TSLA and receives 1,200 USDG at the strike. This is physical delivery, not a cash payment of the price difference.', ['Buyer: 3 TSLA', 'Book.exercise', 'Buyer: 1,200 USDG']],
  close: ['Return collateral and proceeds', 'After the 600-second exercise window, closing returns the 5 unexercised call TSLA plus 3 TSLA of put exercise proceeds through Aqua. Premiums are still in the book.', ['Book.close', 'Writer.onReturned', 'Aqua.push', 'Maker']],
  premium: ['Claim the premiums', 'A separate claim pushes each order’s earned premium through Aqua into the maker’s wallet and option strategy. The book’s token balances are now zero. A returned balance does not create a new promise.', ['Writer.claimPremium', 'Book', 'Aqua.push', 'Maker']],
  release: ['Make the inventory available again', 'The unfilled remainder of each expired order is cancelled and its promise removed. The out-of-the-money call long tokens may still exist, but their exercise window has ended.', ['Writer.release', 'Book.cancel', 'promised = 0']],
};
const fields = [
  ['Maker · TSLA', 'makerTsla', 18], ['Maker · USDG', 'makerUsdg', 6],
  ['Unfilled promise · TSLA', 'promisedTsla', 18], ['Unfilled promise · USDG', 'promisedUsdg', 6],
  ['Book · TSLA', 'bookTsla', 18], ['Book · USDG', 'bookUsdg', 6],
  ['Buyer · TSLA', 'buyerTsla', 18], ['Buyer · USDG', 'buyerUsdg', 6],
  ['Spot taker · TSLA', 'takerTsla', 18], ['Spot taker · USDG', 'takerUsdg', 6],
  ['Option virtual · TSLA', 'optionVirtualTsla', 18], ['Option virtual · USDG', 'optionVirtualUsdg', 6],
  ['Spot virtual · TSLA', 'spotVirtualTsla', 18], ['Spot virtual · USDG', 'spotVirtualUsdg', 6],
  ['Buyer call longs', 'callLong', 0], ['Buyer put longs', 'putLong', 0],
];
let evidence;
let lifecycle;
let position = 0;
let selectedCase = 0;
let loadError;
function fundCard(title, baseAmount, quoteAmount, note, labels = ['TSLA', 'USDG']) {
  return `<div class="fund-card"><h4>${escape(t(title))}</h4><div class="balance">${baseAmount}<small>${escape(t(labels[0]))}</small></div><div class="balance">${quoteAmount}<small>${escape(t(labels[1]))}</small></div><p>${escape(t(note))}</p></div>`;
}
function renderStep(index) {
  position = index;
  const s = lifecycle.steps[index];
  const before = lifecycle.steps[Math.max(0, index - 1)];
  const [title, copy, flow] = instructions[s.id];
  $('step-number').textContent = String(index + 1).padStart(2, '0');
  $('step-title').textContent = t(title);
  $('step-copy').textContent = t(copy);
  const seconds = Number(BigInt(s.timestamp) - BigInt(lifecycle.steps[0].timestamp));
  $('step-time').textContent = t('Test clock +{minutes}m {seconds}s', {minutes: Math.floor(seconds / 60), seconds: seconds % 60});
  $('flow').innerHTML = flow.map((f) => `<span>${escape(t(f))}</span>`).join('<b aria-hidden="true">→</b>');
  $('funds').innerHTML = fundCard('Maker wallet', units(s.makerTsla), units(s.makerUsdg, 6), 'Actual tokens; shared by both strategies')
    + fundCard('Unfilled promises', units(s.promisedTsla), units(s.promisedUsdg, 6), 'Inventory reserved by this writer’s open orders')
    + fundCard('Book token balances', units(s.bookTsla), units(s.bookUsdg, 6), 'Collateral, premiums and exercise proceeds')
    + fundCard('Buyer long positions', escape(s.callLong), escape(s.putLong), 'ERC-1155 units; one contract = one TSLA', ['CALLS', 'PUTS']);
  const afterExpiry = BigInt(s.timestamp) >= BigInt(lifecycle.expiry);
  $('quote-state').textContent = t(afterExpiry ? 'SERIES EXPIRED' : s.quoteAvailable ? '1-CONTRACT QUOTE AVAILABLE' : s.id === 'initial' || s.id === 'ship' ? 'NO ORDER YET' : 'QUOTE REFUSED');
  $('quote-state').classList.toggle('warn', !s.quoteAvailable && !afterExpiry && !['initial', 'ship'].includes(s.id));
  const deviation = Number(BigInt(s.current) - BigInt(s.center)) / Number(s.center) * 100;
  $('recorded-marker').style.left = `${Math.max(0, Math.min(100, (deviation + 7) / 14 * 100))}%`;
  $('recorded-marker').style.background = s.bandQuoting ? 'var(--green)' : 'var(--orange)';
  const metrics = [['TWAP / USDG', units(s.center, 18, 2)], ['Live / USDG', units(s.current, 18, 2)], ['Band cap / call', s.cap], ['1-contract ask', s.quoteAvailable ? `${units(s.quoteOne, 6)} USDG` : t('Unavailable')]];
  $('band-metrics').innerHTML = metrics.map(([label, value]) => `<div><span>${escape(t(label))}</span><b>${escape(value)}</b></div>`).join('');
  $('balance-table').querySelector('tbody').innerHTML = fields.map(([label, key, decimals]) => {
    const delta = BigInt(s[key]) - BigInt(before[key]);
    return `<tr><td>${escape(t(label))}</td><td>${units(before[key], decimals)}</td><td>${units(s[key], decimals)}</td><td>${delta > 0n ? '+' : ''}${units(delta, decimals)}</td></tr>`;
  }).join('');
  $('event-count').textContent = t('{count} logs', {count: s.logs.length});
  $('event-json').textContent = JSON.stringify({ timestamp: s.timestamp, quoteRefusal: s.quoteRefusal, logs: s.logs }, null, 2);
  $('previous').disabled = index === 0;
  $('next').disabled = index === lifecycle.steps.length - 1;
  $('step-position').textContent = `${index + 1} / ${lifecycle.steps.length}`;
  document.querySelectorAll('#steps button').forEach((b, i) => {
    if (index === i) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
  });
}
const cases = [
  ['anchor', 'A rolling center cannot renew an anchor', 'QuoteOffAnchor', 'A 6% move lasts long enough to become the new TWAP center. The band reopens. The original anchor remains unchanged and a real buy still refuses.', (s) => [t('Band open: {value}', {value: t(s.bandQuoting ? 'Yes' : 'No')}), t('Quote available: {value}', {value: t(s.quoteAvailable ? 'Yes' : 'No')}), t('Buyer USDG: {balance} · call longs: {longs}', {balance: units(s.buyerUsdg, 6), longs: s.callLong})]],
  ['unguarded', 'What happens without the inventory guard', 'SourceShort', 'An independent unguarded spot strategy sells 21 TSLA. Only 9 remain in the maker wallet, below the 10-call promise. A later buy refuses and the premium transfer rolls back.', (s) => [t('Maker TSLA: {balance} · promised: {promised}', {balance: units(s.makerTsla), promised: units(s.promisedTsla)}), t('Book TSLA: {balance}', {balance: units(s.bookTsla)}), t('Buyer USDG: {balance} · call longs: {longs}', {balance: units(s.buyerUsdg, 6), longs: s.callLong})]],
  ['delayed', 'A later window can be accepted', 'EXPERIMENTAL SETTLEMENT', 'The reference is held 6% higher over the last five minutes. Window 0 is rejected. After the price returns and another five minutes pass, window 1 is accepted. Someone must retry settlement; the later price changes the economic outcome.', (s) => [t('Call and put series settled in the test'), t('Recorded price: {price} USDG', {price: units(s.recordedPrice, 18, 4)}), t('Elapsed since expiry: {seconds} seconds', {seconds: BigInt(s.timestamp) - BigInt(evidence.scenarios.find(x => x.scenario === 'delayed').expiry)})]],
  ['refund', 'No accepted window means an unwind', 'EXPERIMENTAL SETTLEMENT', 'A persistent 10% gap rejects all six candidate windows. After the one-hour settlement grace, the maker closes and the holder refunds. Premiums are pooled per series and returned pro rata by contract count, not by each purchase price.', (s) => [t('Maker: {base} TSLA · {quote} USDG', {base: units(s.makerTsla), quote: units(s.makerUsdg, 6)}), t('Buyer USDG: {balance}', {balance: units(s.buyerUsdg, 6)}), t('Book USDG: {balance} · remaining promises: {promised} TSLA', {balance: units(s.bookUsdg, 6), promised: units(s.promisedTsla)})]],
];
function renderCase(index) {
  selectedCase = index;
  const [id, title, tag, copy, metrics] = cases[index];
  const scenario = evidence.scenarios.find((s) => s.scenario === id);
  const s = scenario.steps.at(-1);
  $('case-detail').innerHTML = `<span class="tag warn">${escape(t(tag))}</span><h3>${escape(t(title))}</h3><p>${escape(t(copy))}</p><ul>${metrics(s).map(x => `<li>${escape(x)}</li>`).join('')}</ul><details><summary>${escape(t('Inspect this scenario’s recorded steps'))}</summary><pre tabindex="0">${escape(JSON.stringify(scenario.steps.map(x => ({ step: x.id, timestamp: x.timestamp, bandQuoting: x.bandQuoting, quoteAvailable: x.quoteAvailable, refusal: x.quoteRefusal, settled: x.settled, settlementPrice: x.settlementPrice, makerTsla: x.makerTsla, makerUsdg: x.makerUsdg, bookTsla: x.bookTsla, bookUsdg: x.bookUsdg, buyerUsdg: x.buyerUsdg })), null, 2))}</pre></details>`;
  document.querySelectorAll('#case-buttons button').forEach((b, i) => b.setAttribute('aria-pressed', String(i === index)));
}
function renderLab() {
  const deviation = Number($('deviation').value);
  const r = calculateBand(deviation, $('expired-toggle').checked, $('anchor-toggle').checked);
  $('deviation-value').textContent = `${deviation > 0 ? '+' : ''}${(deviation / 100).toFixed(1)}%`;
  $('deviation').setAttribute('aria-valuetext', t('{percent} percent from the TWAP center', {percent: (deviation / 100).toFixed(1)}));
  $('lab-price').textContent = units(r.current, 18, 2);
  $('lab-cap').textContent = String(r.cap);
  $('lab-premium').textContent = r.premium === null ? '—' : units(r.premium, 6);
  $('lab-state').textContent = r.reason || t('QUOTE AVAILABLE');
  $('lab-state').classList.toggle('warn', !!r.reason);
  const marker = 30 + (deviation + 700) / 1400 * 500;
  $('lab-chart-marker').setAttribute('x1', marker);
  $('lab-chart-marker').setAttribute('x2', marker);
  const explanations = {
    OutsideBand: 'The band has no whole contract left to quote, or the live reference is beyond its edge. The buy would refuse before checking the inner quote.',
    QuoteExpired: 'The band still permits this size, but the fixed quote’s deadline has elapsed. The maker must explicitly publish new terms.',
    QuoteOffAnchor: 'The rolling band permits quoting, but the live reference is more than 5% away from the original anchor. A recovered TWAP cannot renew that anchor.',
  };
  $('lab-explanation').textContent = r.reason ? t(explanations[r.reason]) : t('The band adds {extra}% to the 8 USDG base premium and permits at most {cap} whole contracts per call. Other inventory and collateral checks still apply.', {extra: (Number(r.extraBps) / 100).toFixed(2), cap: r.cap});
}
function selectStep(index) {
  renderStep(index);
  const selected = document.querySelector('#steps button[aria-current="step"]');
  selected.scrollIntoView({block: 'nearest', inline: 'nearest'});
  $('replay-content').scrollIntoView({block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'});
}
$('previous').addEventListener('click', () => selectStep(Math.max(0, position - 1)));
$('next').addEventListener('click', () => selectStep(Math.min(lifecycle.steps.length - 1, position + 1)));
$('deviation').addEventListener('input', renderLab);
$('expired-toggle').addEventListener('change', renderLab);
$('anchor-toggle').addEventListener('change', renderLab);
document.querySelectorAll('[data-deviation]').forEach(b => b.addEventListener('click', () => { $('deviation').value = b.dataset.deviation; renderLab(); }));
$('copy-command').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText('python3 scripts/website-evidence.py'); $('copy-command').textContent = t('Copied'); }
  catch { $('copy-command').textContent = t('Select the command'); }
});
document.querySelectorAll('[data-language]').forEach(button => button.addEventListener('click', () => {
  language = button.dataset.language;
  try { localStorage.setItem('hakari-language', language); } catch { /* URL selection still works. */ }
  const url = new URL(location.href);
  url.searchParams.set('lang', language);
  history.replaceState(null, '', url);
  applyLanguage();
}));

applyLanguage();
try {
  const response = await fetch(new URL('./evidence/demo.json', import.meta.url));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  evidence = await response.json();
  if (evidence.schemaVersion !== 1 || evidence.mode !== 'local-fork') throw new Error('Unsupported evidence format');
  lifecycle = evidence.scenarios.find(s => s.scenario === 'lifecycle');
  $('proof-count').textContent = String(evidence.passedTests);
  lifecycle.steps.forEach((s, i) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.innerHTML = `<span>${String(i + 1).padStart(2, '0')}</span>${escape(t(instructions[s.id][0]))}`;
    button.addEventListener('click', () => selectStep(i));
    li.append(button); $('steps').append(li);
  });
  cases.forEach(([id, title], i) => {
    const button = document.createElement('button');
    button.innerHTML = `${escape(t(title))}<span>↗</span>`;
    button.addEventListener('click', () => renderCase(i));
    $('case-buttons').append(button);
  });
  renderProvenance();
  $('load-status').hidden = true; $('replay-content').hidden = false;
  renderStep(0); renderCase(0);
} catch (error) {
  loadError = error.message;
  renderLoadError();
}

function renderProvenance() {
  const sourceRoot = `${repo}/blob/${evidence.sourceRevision}`;
  $('step-source').href = `${sourceRoot}/aqua/test/WebsiteEvidence.t.sol`;
  // The docs may evolve independently of the generated Solidity inputs.
  const provenance = [
    ['Execution', t('Foundry local EVM · 5 verified scenarios')],
    ['Fork', t('{chain} / block {block}', {chain: evidence.chainId, block: evidence.forkBlock.toLocaleString('en-US')})],
    ['Base revision', `<a href="${repo}/commit/${escape(evidence.sourceRevision)}">${escape(evidence.sourceRevision.slice(0, 12))} ↗</a>`],
    ['Source inputs', t(evidence.sourceInputsModified ? 'Modified from base revision; exact files in source.zip' : 'Match base revision; exact files in source.zip')],
    ['SHA-256', escape(evidence.sourceFingerprint)],
    ['Hook runtime', escape(lifecycle.hookCodeHash)],
    ['Trace', t('Local calls and EVM logs; no explorer transaction hashes')],
  ];
  $('provenance').innerHTML = provenance.map(([k, v]) => `<dt>${escape(t(k))}</dt><dd>${v}</dd>`).join('');
}
function renderLoadError() {
  $('load-status').hidden = false;
  $('replay-content').hidden = true;
  $('case-buttons').hidden = true;
  $('load-status').textContent = t('The evidence could not be loaded ({error}). Serve this directory over HTTP, or open the JSON and trace downloads directly.', {error: t(loadError)});
  $('proof-count').textContent = t('Unavailable');
  $('provenance').innerHTML = `<dt>${escape(t('Evidence'))}</dt><dd>${escape(t('Unavailable. Use the download links to inspect the committed artifacts.'))}</dd>`;
  $('case-detail').textContent = t('Recorded scenarios are unavailable until the evidence JSON loads.');
}
function applyLanguage() {
  document.documentElement.lang = language;
  document.title = t('HAKARI — One wallet. Two strategies.');
  for (const {node, original, message} of staticText) {
    if (node.isConnected) node.textContent = original.replace(message, t(message));
  }
  for (const {node, attribute, message} of staticAttributes) node.setAttribute(attribute, t(message));
  document.querySelectorAll('[data-language]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.language === language)));
  $('copy-command').textContent = t('Copy');
  if (lifecycle && !loadError) {
    document.querySelectorAll('#steps button').forEach((button, i) => {
      button.innerHTML = `<span>${String(i + 1).padStart(2, '0')}</span>${escape(t(instructions[lifecycle.steps[i].id][0]))}`;
    });
    document.querySelectorAll('#case-buttons button').forEach((button, i) => {
      button.innerHTML = `${escape(t(cases[i][1]))}<span>↗</span>`;
    });
    renderStep(position);
    renderCase(selectedCase);
    renderProvenance();
  }
  if (loadError) renderLoadError();
  renderLab();
}
