/* HIMS weekend float squeeze: data access, scales, DOM and path helpers.
   Classic script (no modules: they fail from file://). Attaches to window.SQZ. No d3: the data is a
   uniform 60 s grid, so a bisect is Math.round((ts - t0) / step). */
(function (S) {
  'use strict';
  var SVGNS = 'http://www.w3.org/2000/svg';

  S.D = window.SQUEEZE_DATA || null;
  S.ST = window.SQUEEZE_STORY || null;
  S.SO = (window.SQUEEZE_SOCIAL && typeof window.SQUEEZE_SOCIAL === 'object') ? window.SQUEEZE_SOCIAL : null;
  S.OV = window.SQUEEZE_OVERLAY || null;

  S.clamp = function (v, a, b) { return v < a ? a : (v > b ? b : v); };
  S.isNum = function (v) { return typeof v === 'number' && isFinite(v); };

  // ---------- storage (per-viewer conveniences only; the page is correct without it) ----------
  S.store = {
    get: function (k) { try { return window.localStorage.getItem('hakari.squeeze.' + k); } catch (e) { return null; } },
    set: function (k, v) { try { window.localStorage.setItem('hakari.squeeze.' + k, v); } catch (e) { /* storage blocked */ } },
    getJSON: function (k) { try { return JSON.parse(window.localStorage.getItem('hakari.squeeze.' + k) || 'null'); } catch (e) { return null; } },
    setJSON: function (k, v) { try { window.localStorage.setItem('hakari.squeeze.' + k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } }
  };

  // ---------- data ----------
  S.initData = function () {
    var D = S.D;
    S.t = D.t;
    S.N = D.t.length;
    S.t0 = D.t[0];
    S.step = (D.window && D.window.stepSec) || (D.t[1] - D.t[0]) || 60;
    S.W0 = (D.window && D.window.fromTs) || D.t[0];
    S.W1 = (D.window && D.window.toTs) || D.t[S.N - 1];
    var ref = D.reference || {};
    function ts(x) { return x == null ? null : (typeof x === 'number' ? x : (x.ts != null ? x.ts : (x.fromTs != null ? x.fromTs : null))); }
    S.NAV = (ref.nyseCloseFri && S.isNum(ref.nyseCloseFri.price)) ? ref.nyseCloseFri.price : 28.84;
    S.nyseCloseTs = ts(ref.nyseCloseFri) || 1787947200;
    S.fenceFrom = ref.mintRuleClosed && ref.mintRuleClosed.fromTs != null ? ref.mintRuleClosed.fromTs : 1787961600;
    S.fenceTo = ref.mintRuleClosed && ref.mintRuleClosed.toTs != null ? ref.mintRuleClosed.toTs : 1788134400;
    S.reopenTs = ts(ref.session24x5Reopen) || S.fenceTo;
    S.nyseOpenTs = ts(ref.nyseOpenMon) || 1788183000;
    S.silenceFrom = ref.observedMintSilence && ref.observedMintSilence.fromTs;
    S.silenceTo = ref.observedMintSilence && ref.observedMintSilence.toTs;
    var ev = (D.events || []).slice().sort(function (a, b) { return a.ts - b.ts; });
    S.events = ev;
    var mint = ev.filter(function (e) { return e.kind === 'mint'; })[0];
    S.firstMintTs = mint ? mint.ts : (S.silenceTo || null);
    if (S.firstMintTs == null) {
      var m = S.ser('himsMinted');
      if (m) for (var i = 0; i < S.N; i++) if (m[i] > 0) { S.firstMintTs = S.t[i]; break; }
    }
    // At-rest cursor: the highest minute close of HIMS/USDG (a 'peak' event priced in USDG/HIMS; prefer the
    // minute-close one over a single-swap print), else the max close.
    var peaks = ev.filter(function (e) { return e.kind === 'peak' && (!e.unit || /USDG\/HIMS/.test(e.unit)); });
    var peak = peaks.filter(function (e) { return /close/i.test(e.id || ''); })[0] || peaks[0];
    S.pricePeaks = peaks;
    if (peak) S.peakTs = peak.ts;
    else {
      var c = S.ser('himsUsdg.close'), best = -Infinity, bi = 0;
      if (c) for (var j = 0; j < S.N; j++) if (c[j] != null && c[j] > best) { best = c[j]; bi = j; }
      S.peakTs = S.t[bi];
    }
    S.peakEvent = peak || null;
    // Baseline = the fence chapter's focus (Sun 19:40): the last quiet minute before the squeeze.
    var fence = S.ST && S.ST.chapters ? S.ST.chapters.filter(function (c) { return c.id === 'fence'; })[0] : null;
    S.baseTs = fence ? fence.focusTs : 1788118800;
    S.baseI = S.idx(S.baseTs);
    var bnav = S.ser('bonerUsdAtNav');
    S.bonerRef = (bnav && bnav[S.baseI] != null) ? bnav[S.baseI] : 0.00239;
    S.chapters = (S.ST && S.ST.chapters) ? S.ST.chapters.slice() : [];
    // Supply frozen from the last burn before the first mint (or the observed silence start) to the first mint.
    var burns = ev.filter(function (e) { return e.kind === 'burn' && (!S.firstMintTs || e.ts < S.firstMintTs); });
    S.frozenFrom = burns.length ? burns[burns.length - 1].ts : Math.max(S.silenceFrom || S.W0, S.W0);
    S.firstMintEvent = mint || null;
  };

  S.idx = function (ts) { return S.clamp(Math.round((ts - S.t0) / S.step), 0, S.N - 1); };
  // The last grid point at or before ts: the state as it was at ts (use for "since <ts>" baselines and for
  // posts/anchors, where the nearest minute can already include what happened after them).
  S.idxFloor = function (ts) { return S.clamp(Math.floor((ts - S.t0) / S.step + 1e-9), 0, S.N - 1); };
  var serCache = {};
  // Dotted path into data.series (e.g. 'himsUsdg.close'); null when missing or the wrong length.
  S.ser = function (key) {
    if (serCache[key] !== undefined) return serCache[key];
    var o = S.D && S.D.series, parts = key.split('.');
    for (var i = 0; i < parts.length && o != null; i++) o = o[parts[i]];
    if (o && !Array.isArray(o) && Array.isArray(o.close)) o = o.close;
    var ok = Array.isArray(o) && o.length === S.N;
    if (!ok && o != null) try { console.warn('[squeeze] series has the wrong length:', key); } catch (e) { /* no console */ }
    serCache[key] = ok ? o : null;
    return serCache[key];
  };
  S.val = function (key, i) { var a = S.ser(key); return a ? a[i] : null; };
  S.sumRange = function (key, i0, i1) {
    var a = S.ser(key); if (!a) return null;
    var s = 0; for (var i = Math.max(0, i0); i <= i1 && i < S.N; i++) if (a[i] != null) s += a[i];
    return s;
  };

  S.chapterAt = function (ts) {
    var ch = S.chapters;
    for (var i = 0; i < ch.length; i++) {
      var last = i === ch.length - 1;
      if (ts >= ch[i].fromTs && (ts < ch[i].toTs || (last && ts <= ch[i].toTs))) return ch[i];
    }
    return null;
  };
  S.chapterIndex = function (id) { for (var i = 0; i < S.chapters.length; i++) if (S.chapters[i].id === id) return i; return -1; };
  S.chapterDomain = function (ch) {
    var span = ch.toTs - ch.fromTs, pad = span * 0.04;
    return [Math.max(S.W0, ch.fromTs - pad), Math.min(S.W1, ch.toTs + pad)];
  };

  // ---------- scales ----------
  S.linear = function (d0, d1, r0, r1) {
    var k = (r1 - r0) / ((d1 - d0) || 1);
    var f = function (v) { return r0 + (v - d0) * k; };
    f.inv = function (r) { return d0 + (r - r0) / k; };
    f.d = [d0, d1]; f.r = [r0, r1]; f.type = 'linear';
    return f;
  };
  S.log = function (d0, d1, r0, r1) {
    var l0 = Math.log(d0), l1 = Math.log(d1), k = (r1 - r0) / ((l1 - l0) || 1);
    var f = function (v) { return v > 0 ? r0 + (Math.log(v) - l0) * k : NaN; };
    f.inv = function (r) { return Math.exp(l0 + (r - r0) / k); };
    f.d = [d0, d1]; f.r = [r0, r1]; f.type = 'log';
    return f;
  };
  S.niceStep = function (span, count) {
    var raw = span / Math.max(1, count), mag = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / mag;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  };
  S.niceCeil = function (v) {
    if (!(v > 0)) return 1;
    var mag = Math.pow(10, Math.floor(Math.log10(v))), n = v / mag;
    var steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    for (var i = 0; i < steps.length; i++) if (n <= steps[i] + 1e-9) return steps[i] * mag;
    return 10 * mag;
  };
  S.linTicks = function (d0, d1, count) {
    var st = S.niceStep(d1 - d0, count), out = [];
    for (var v = Math.ceil(d0 / st) * st; v <= d1 + st * 1e-6; v += st) out.push(Math.abs(v) < st * 1e-9 ? 0 : v);
    return out;
  };
  // 1-2-5 floor/ceil and ticks for log axes.
  S.floor125 = function (v) { var m = Math.pow(10, Math.floor(Math.log10(v))), n = v / m; return (n >= 5 ? 5 : n >= 2 ? 2 : 1) * m; };
  S.ceil125 = function (v) { var m = Math.pow(10, Math.floor(Math.log10(v))), n = v / m; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * m; };
  S.ticks125 = function (d0, d1, maxN) {
    var out = [], seq = [1, 2, 5];
    for (var e = Math.floor(Math.log10(d0)) - 1; e <= Math.ceil(Math.log10(d1)); e++)
      for (var j = 0; j < 3; j++) { var v = seq[j] * Math.pow(10, e); if (v >= d0 * 0.999 && v <= d1 * 1.001) out.push(v); }
    if (maxN && out.length > maxN) out = out.filter(function (v) { var n = v / Math.pow(10, Math.floor(Math.log10(v) + 1e-9)); return Math.abs(n - 1) < 1e-6; });
    return out;
  };
  S.extent = function (arrs, i0, i1, positiveOnly) {
    var lo = Infinity, hi = -Infinity;
    for (var a = 0; a < arrs.length; a++) {
      var s = arrs[a]; if (!s) continue;
      for (var i = i0; i <= i1; i++) { var v = s[i]; if (v == null || !isFinite(v) || (positiveOnly && v <= 0)) continue; if (v < lo) lo = v; if (v > hi) hi = v; }
    }
    return lo === Infinity ? null : [lo, hi];
  };

  // Time ticks by view span (seconds): <=2h 10 min, <=6h 30 min, <=24h 2h, else 6h.
  S.timeTicks = function (d0, d1, width) {
    var span = d1 - d0, st;
    if (span <= 2 * 3600) st = 600; else if (span <= 6 * 3600) st = 1800; else if (span <= 24 * 3600) st = 7200; else st = 6 * 3600;
    while (width && (span / st) * 46 > width) st *= 2;
    var off = S.tz === 'jst' ? 9 * 3600 : 0, out = [];
    for (var v = Math.ceil((d0 + off) / st) * st - off; v <= d1; v += st) out.push(v);
    return { ticks: out, step: st };
  };

  // ---------- DOM ----------
  S.el = function (tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (attrs[k] == null || attrs[k] === false) continue;
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'cls') e.className = attrs[k];
      else if (k.slice(0, 2) === 'on' && typeof attrs[k] === 'function') e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    }
    if (kids) S.append(e, kids);
    return e;
  };
  S.append = function (e, kids) {
    if (!Array.isArray(kids)) kids = [kids];
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i]; if (c == null || c === false) continue;
      e.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return e;
  };
  S.svg = function (tag, attrs, parent) {
    var e = document.createElementNS(SVGNS, tag);
    if (attrs) for (var k in attrs) {
      if (attrs[k] == null) continue;
      if (k === 'text') e.textContent = attrs[k]; else if (k === 'cls') e.setAttribute('class', attrs[k]); else e.setAttribute(k, attrs[k]);
    }
    if (parent) parent.appendChild(e);
    return e;
  };
  S.clear = function (e) { while (e && e.firstChild) e.removeChild(e.firstChild); return e; };
  S.$ = function (id) { return document.getElementById(id); };
  // Story text may carry **bold**: parse into text nodes and <strong>, never innerHTML.
  S.rich = function (s) {
    var frag = document.createDocumentFragment(), parts = String(s || '').split('**');
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      if (i % 2) frag.appendChild(S.el('strong', { text: parts[i] })); else frag.appendChild(document.createTextNode(parts[i]));
    }
    return frag;
  };
  // Short form of an event label for tight rows: the text before ':' (max 44 chars).
  S.shortLabel = function (s) {
    s = String(s || ''); var k = s.indexOf(': '); if (k > 8) s = s.slice(0, k);
    return s.length > 44 ? s.slice(0, 42) + '…' : s;
  };
  // Events worth a glyph: everything except the individual Monday mints (the first mint stays; the rest are a rug + clusters).
  S.glyphEvents = function () {
    return S.events.filter(function (e) { return e.kind !== 'mint' || e === S.firstMintEvent; });
  };
  S.shortHash = function (h) { return h ? h.slice(0, 6) + '…' + h.slice(-5) : ''; };
  S.txUrl = function (h) { return S.D.chain.explorer.replace(/\/$/, '') + '/tx/' + h; };
  S.blockUrl = function (b) { return S.D.chain.explorer.replace(/\/$/, '') + '/block/' + b; };
  S.addrUrl = function (a, kind) { return S.D.chain.explorer.replace(/\/$/, '') + '/' + (kind || 'address') + '/' + a; };
  // Repo-relative links in story.json resolve against web/squeeze/; the artifact bundle rewrites them (window.SQZ_LINKBASE).
  S.resolveUrl = function (u) {
    if (!u) return null;
    if (/^https?:/.test(u) || u.charAt(0) === '#') return u;
    if (window.SQZ_LINKBASE) {
      var rel = u.replace(/^(\.\.\/)+/, ''), hash = '';
      var hi = rel.indexOf('#'); if (hi >= 0) { hash = rel.slice(hi); rel = rel.slice(0, hi); }
      return window.SQZ_LINKBASE + rel + hash;
    }
    return u;
  };
  S.link = function (href, text, cls) {
    var u = S.resolveUrl(href);
    var a = S.el('a', { href: u, cls: cls || null, text: text });
    if (/^https?:/.test(u)) { a.target = '_blank'; a.rel = 'noopener'; }
    return a;
  };

  // ---------- paths ----------
  // Line through series a (index space) inside [i0, i1]; per-pixel min/max decimation (M4) when > 2 points per px.
  // Nulls break the line. getY maps value -> px (NaN = skip).
  S.linePath = function (a, i0, i1, x, y, clampY) {
    if (!a) return '';
    var n = i1 - i0 + 1, px = Math.abs(x(S.t[i1]) - x(S.t[i0])) || 1, out = [], pen = false;
    function yy(v) { var r = y(v); if (clampY) r = S.clamp(r, clampY[0], clampY[1]); return r; }
    if (n <= px * 2) {
      for (var i = i0; i <= i1; i++) {
        var v = a[i];
        if (v == null || !isFinite(y(v))) { pen = false; continue; }
        out.push((pen ? 'L' : 'M') + x(S.t[i]).toFixed(1) + ',' + yy(v).toFixed(1)); pen = true;
      }
      return out.join('');
    }
    var col = -1, f = null, l = null, mn = null, mx = null;
    function flush() {
      if (f == null) { pen = false; return; }
      var ids = [f, mn, mx, l].filter(function (v, k, arr) { return arr.indexOf(v) === k; }).sort(function (p, q) { return p - q; });
      for (var k = 0; k < ids.length; k++) { out.push((pen ? 'L' : 'M') + x(S.t[ids[k]]).toFixed(1) + ',' + yy(a[ids[k]]).toFixed(1)); pen = true; }
    }
    for (var j = i0; j <= i1; j++) {
      var c = Math.floor(x(S.t[j]));
      if (c !== col) { flush(); col = c; f = l = mn = mx = null; }
      var w = a[j];
      if (w == null || !isFinite(y(w))) { if (f != null) { flush(); f = l = mn = mx = null; } pen = false; continue; }
      if (f == null) { f = l = mn = mx = j; continue; }
      l = j; if (w < a[mn]) mn = j; if (w > a[mx]) mx = j;
    }
    flush();
    return out.join('');
  };
  // Area between lo(i) and hi(i) (functions), sampled per pixel column (min of lo, max of hi).
  S.bandPath = function (lo, hi, i0, i1, x, y) {
    var top = [], bot = [], segs = [], col = -1, cl = null, ch = null, cx = null;
    var px = Math.abs(x(S.t[i1]) - x(S.t[i0])) || 1, dense = (i1 - i0 + 1) > px * 1.5;
    function push() {
      if (cl == null) return;
      top.push(cx.toFixed(1) + ',' + y(ch).toFixed(1)); bot.push(cx.toFixed(1) + ',' + y(cl).toFixed(1));
    }
    function close() { if (top.length) segs.push('M' + top.join('L') + 'L' + bot.reverse().join('L') + 'Z'); top = []; bot = []; }
    for (var i = i0; i <= i1; i++) {
      var a = lo(i), b = hi(i), xi = x(S.t[i]);
      if (a == null || b == null || !isFinite(y(a)) || !isFinite(y(b))) { if (dense) { push(); cl = ch = null; col = -1; } close(); continue; }
      if (!dense) { top.push(xi.toFixed(1) + ',' + y(b).toFixed(1)); bot.push(xi.toFixed(1) + ',' + y(a).toFixed(1)); continue; }
      var c = Math.floor(xi);
      if (c !== col) { push(); col = c; cl = a; ch = b; cx = xi; } else { if (a < cl) cl = a; if (b > ch) ch = b; cx = xi; }
    }
    if (dense) push();
    close();
    return segs.join('');
  };

  // ---------- one floating tooltip ----------
  S.tip = {
    el: null,
    show: function (x, y, build, pinned) {
      var t = this.el; if (!t) return;
      S.clear(t); build(t);
      t.hidden = false; t.classList.toggle('pinned', !!pinned);
      var r = t.getBoundingClientRect(), vw = document.documentElement.clientWidth, vh = window.innerHeight;
      var left = x + 14, top = y + 14;
      if (left + r.width > vw - 8) left = Math.max(8, x - r.width - 14);
      if (top + r.height > vh - 8) top = Math.max(8, y - r.height - 14);
      t.style.left = left + 'px'; t.style.top = top + 'px';
    },
    hide: function () { if (this.el) { this.el.hidden = true; this.el.classList.remove('pinned'); } }
  };
  S.tipRow = function (color, value, label, dash) {
    var row = S.el('div', { cls: 'tip-row' });
    if (color) row.appendChild(S.el('i', { cls: 'key-line' + (dash ? ' dash' : ''), style: dash ? null : 'background:var(--' + color + ')' }));
    row.appendChild(S.el('strong', { text: value }));
    if (label) row.appendChild(S.el('span', { text: label }));
    return row;
  };

  S.reducedMotion = function () {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  };
  S.ease = function (p) { return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; };
})(window.SQZ = window.SQZ || {});
