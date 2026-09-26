/* HAKARI · web/plain/plain.js — one classic script, no modules, no fetch, no libraries (file:// safe).
   Reads window.SQUEEZE_DATA (../squeeze/data.js), window.PLAIN_COPY (copy.js) and window.PLAIN_FACTS (facts.js).
   Does four things: the EN / 繁中 switch, refilling every [data-fact] from the data, drawing the SVG charts
   (overview, count, price, restock, safe) with a crosshair tooltip, and the one scroll-in fade.
   All text is already in the HTML; charts draw their labels in the current language. */
(function () {
  'use strict';
  var D = window.SQUEEZE_DATA, C = window.PLAIN_COPY, PF = window.PLAIN_FACTS;
  var doc = document, root = doc.documentElement;
  var NS = 'http://www.w3.org/2000/svg';
  var LANG_KEY = 'hakari.squeeze.lang'; // shared with web/squeeze, so a choice made here carries over
  var lang = root.getAttribute('data-lang') === 'zh' ? 'zh' : 'en';
  var F = null, dataOk = false;
  var $ = function (id) { return doc.getElementById(id); };
  var tip = $('tip'), live = $('live');
  if (!C || !PF) return; // copy.js or facts.js missing: the static HTML still reads in English

  // ------------------------------------------------------------------ small helpers
  var store = {
    get: function () { try { return window.localStorage.getItem(LANG_KEY); } catch (e) { return null; } },
    set: function (v) { try { window.localStorage.setItem(LANG_KEY, v); } catch (e) { /* storage blocked */ } }
  };
  function L(field) { return field == null ? '' : (typeof field === 'string' ? field : (field[lang] != null ? field[lang] : field.en)); }
  function fill(s, params) {
    return String(s).replace(/\{(\w+)\}/g, function (m, k) {
      if (params && Object.prototype.hasOwnProperty.call(params, k)) return params[k];
      if (F && F[k]) return F[k].text;
      return m;
    }).replace(/\*\*/g, '');
  }
  function lt(field, params) { return fill(L(field), params); }
  var fmt = PF.fmt;
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function dayName(ts) { return C.ui.days[lang][new Date(ts * 1000).getUTCDay()]; }
  function dayHM(ts) { return dayName(ts) + ' ' + fmt.hm(ts); }

  function S(tag, attrs, parent) {
    var n = doc.createElementNS(NS, tag);
    if (attrs) for (var k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function T(parent, x, y, text, cls, anchor) {
    var t = S('text', { x: x.toFixed(1), y: y.toFixed(1), 'class': cls || '', 'text-anchor': anchor || 'start' }, parent);
    t.textContent = text;
    return t;
  }
  function H(parent, x1, y1, x2, y2, cls) { return S('line', { x1: x1.toFixed(1), y1: y1.toFixed(1), x2: x2.toFixed(1), y2: y2.toFixed(1), 'class': cls }, parent); }
  function lin(d0, d1, r0, r1) { var k = (r1 - r0) / (d1 - d0); var f = function (v) { return r0 + (v - d0) * k; }; f.inv = function (p) { return d0 + (p - r0) / k; }; return f; }
  function iOf(ts) { return Math.round((ts - D.t[0]) / 60); }
  function linePath(i0, i1, xs, ys, arr, step) {
    var d = '', pen = false;
    for (var i = i0; i <= i1; i++) {
      var v = arr[i];
      if (v == null || !isFinite(v)) { pen = false; continue; }
      var X = xs(D.t[i]).toFixed(1), Y = ys(v).toFixed(1);
      if (!pen) { d += 'M' + X + ' ' + Y; pen = true; } else if (step) d += 'H' + X + 'V' + Y; else d += 'L' + X + ' ' + Y;
    }
    return d;
  }
  function svgFor(plot, W, Hh) {
    plot.textContent = '';
    return S('svg', { width: W, height: Hh, viewBox: '0 0 ' + W + ' ' + Hh, 'aria-hidden': 'true', focusable: 'false' }, plot);
  }
  // horizontal y gridlines + tick labels
  function yAxis(g, ys, ticks, l, r, W, label, fmtTick) {
    ticks.forEach(function (v) {
      var y = ys(v);
      H(g, l, y, W - r, y, v === ticks[0] ? 'base' : 'gridl');
      T(g, l - 8, y + 4, fmtTick ? fmtTick(v) : fmt.int(v), 'ax', 'end');
    });
    if (label) T(g, 0, 14, label, 'ax');
  }
  // hour ticks with a day row under the first tick of each day, "UTC" at the right end when there is room
  function timeAxis(g, xs, from, to, yBase, stepH) {
    var step = stepH * 3600, first = Math.ceil(from / step) * step, lastDay = null, lastDayX = -1e9;
    var x0 = xs(from), x1 = xs(to);
    for (var t = first; t <= to + 1; t += step) {
      var X = xs(t), anchor = X - x0 < 18 ? 'start' : x1 - X < 18 ? 'end' : 'middle';
      T(g, X, yBase + 16, fmt.hm(t), 'ax', anchor);
      var day = Math.floor(t / 86400);
      if (day !== lastDay) { T(g, X, yBase + 31, dayName(t), 'ax', anchor); lastDay = day; lastDayX = X; }
    }
    if (x1 - lastDayX > 46) T(g, x1, yBase + 31, 'UTC', 'ax', 'end');
  }
  // day separators and centred day names (whole-weekend charts)
  function dayAxis(g, xs, from, to, top, bottom, yText) {
    var d0 = Math.ceil(from / 86400) * 86400, edges = [from];
    for (var d = d0; d < to; d += 86400) { edges.push(d); H(g, xs(d), top, xs(d), bottom, 'gridl'); }
    edges.push(to);
    for (var i = 0; i < edges.length - 1; i++) {
      var a = xs(edges[i]), b = xs(edges[i + 1]);
      if (b - a > 22) T(g, (a + b) / 2, yText, dayName(edges[i] + 60), 'ax', 'middle');
      // a last day too short to centre a name in (the count chart ends Mon 00:43): name it at the right edge
      else if (i === edges.length - 2 && i > 0) T(g, b, yText, dayName(edges[i] + 60), 'ax', 'end');
    }
  }
  function band(g, xs, from, to, top, bottom, label, atBottom) {
    S('rect', { x: xs(from).toFixed(1), y: top, width: Math.max(0, xs(to) - xs(from)).toFixed(1), height: bottom - top, 'class': 'band' }, g);
    H(g, xs(to), top, xs(to), bottom, 'band-edge');
    if (label) T(g, xs(from) + 6, atBottom ? bottom - 7 : top + 14, label, 'band-t');
  }
  function refLine(g, ys, l, r, W, label) {
    var y = ys(F.nav.v);
    S('line', { x1: l, y1: y.toFixed(1), x2: W - r, y2: y.toFixed(1), 'class': 'refl' }, g);
    if (label) T(g, l + 6, y + 16, label, 'lab lab-2'); // below the dashed line: the price sits above it until the squeeze
  }
  function marker(g, x, y, kind, ring) {
    if (ring) S('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: 14, 'class': 'ring ' + kind + '-r' }, g);
    return S('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: 4, 'class': 'dot-' + kind }, g);
  }
  function crossLayer(svg, top, bottom, kinds) {
    var g = S('g', { 'class': 'crossg', visibility: 'hidden' }, svg);
    var ln = H(g, 0, top, 0, bottom, 'cross');
    var dots = kinds.map(function (k) { return S('circle', { r: 4, 'class': 'dot-' + k }, g); });
    return function (x, ys) {
      if (x == null) { g.setAttribute('visibility', 'hidden'); return; }
      g.setAttribute('visibility', 'visible');
      ln.setAttribute('x1', x.toFixed(1)); ln.setAttribute('x2', x.toFixed(1));
      dots.forEach(function (d, j) {
        if (ys[j] == null) { d.setAttribute('visibility', 'hidden'); return; }
        d.setAttribute('visibility', 'visible'); d.setAttribute('cx', x.toFixed(1)); d.setAttribute('cy', ys[j].toFixed(1));
      });
    };
  }

  // ------------------------------------------------------------------ charts
  var TS = PF.TS, CH = function (k, p) { return lt(C.charts[k], p); };
  var charts = {};

  charts.overview = function (plot) {
    var W = plot.clientWidth, Hh = plot.clientHeight || 100, m = { t: 20, r: 8, b: 22, l: 8 };
    var svg = svgFor(plot, W, Hh), g = S('g', null, svg);
    var from = D.t[0], to = D.t[D.t.length - 1];
    var xs = lin(from, to, m.l, W - m.r), ys = lin(0, 80, Hh - m.b, m.t);
    band(g, xs, TS.sat0000, F.firstMint.v, m.t - 14, Hh - m.b, CH('noNewTokens'));
    dayAxis(g, xs, from, to, m.t - 14, Hh - m.b, Hh - 6);
    H(g, m.l, ys(0), W - m.r, ys(0), 'base');
    refLine(g, ys, m.l, m.r, W, null);
    S('path', { d: linePath(0, D.t.length - 1, xs, ys, D.series.himsUsdg.close), 'class': 'usd', style: 'stroke-width:1.5px' }, g);
    var px = xs(F.peakTime.v), py = ys(F.peakClose.v);
    S('circle', { cx: px.toFixed(1), cy: py.toFixed(1), r: 3.5, 'class': 'dot-usd' }, g);
    var right = W - m.r - px > 60;
    T(g, right ? px + 8 : px - 8, py + 4, F.peakClose.text, 'lab lab-v', right ? 'start' : 'end');
    return null;
  };

  charts.count = function (plot) {
    var W = plot.clientWidth, Hh = plot.clientHeight || 140, m = { t: 16, r: 16, b: 36, l: 56 };
    var svg = svgFor(plot, W, Hh), g = S('g', null, svg);
    var from = TS.fri1800, to = F.firstMint.v, i0 = iOf(from), i1 = iOf(TS.mon0043);
    var xs = lin(from, to, m.l, W - m.r), ys = lin(0, 20000, Hh - m.b, m.t);
    band(g, xs, TS.sat0000, to, m.t, Hh - m.b, CH('noNewTokens'), true);
    yAxis(g, ys, [0, 10000, 20000], m.l, m.r, W, null);
    dayAxis(g, xs, from, to, m.t, Hh - m.b, Hh - m.b + 20);
    var sup = D.series.himsSupply;
    S('path', { d: linePath(i0, i1, xs, ys, sup, true) + 'H' + xs(to).toFixed(1), 'class': 'ink' }, g);
    var yl = ys(F.float.v);
    var burns = D.events.filter(function (e) { return e.kind === 'burn'; });
    burns.forEach(function (b) { H(g, xs(b.ts), yl - 5, xs(b.ts), yl + 6, 'ink'); });
    T(g, xs(burns[0].ts) - 2, yl + 20, CH('burn'), 'lab', 'start');
    // the lock at the right end: first new tokens
    var lx = xs(to);
    var lock = S('g', { transform: 'translate(' + (lx - 12).toFixed(1) + ',' + (yl - 22).toFixed(1) + ')', 'class': 'lock' }, g);
    S('path', { d: 'M2.5 5V3.5a2.5 2.5 0 0 1 5 0V5', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4 }, lock);
    S('rect', { x: 0.7, y: 5, width: 8.6, height: 6.3, rx: 1.2, fill: 'currentColor' }, lock);
    T(g, lx - 2, yl + 36, CH('countEnd'), 'lab', 'end');
    var cross = crossLayer(svg, m.t, Hh - m.b, ['ink']);
    return {
      from: from, to: to, i0: i0, i1: i1, xs: xs, key: TS.sat0000 + 12 * 3600,
      cross: function (i) { cross(i == null ? null : xs(D.t[i]), [ys(sup[i])]); },
      readout: function (i) { return { rows: [{ v: fmt.int(sup[i]), label: CH('tipTokens'), key: 'var(--text-primary)' }], time: dayHM(D.t[i]) + ' UTC' }; }
    };
  };

  charts.price = function (plot) {
    var W = plot.clientWidth, Hh = plot.clientHeight || 280, m = { t: 28, r: 16, b: 40, l: 56 };
    var svg = svgFor(plot, W, Hh), g = S('g', null, svg);
    var from = TS.sun1800, to = F.firstMint.v, i0 = iOf(from), i1 = iOf(TS.mon0043);
    var xs = lin(from, to, m.l, W - m.r), ys = lin(0, 80, Hh - m.b, m.t);
    band(g, xs, from, to, m.t, Hh - m.b, CH('noNewTokens'));
    yAxis(g, ys, [0, 20, 40, 60, 80], m.l, m.r, W, CH('yPrice'));
    timeAxis(g, xs, from, to, Hh - m.b, 2);
    refLine(g, ys, m.l, m.r, W, CH('refLong'));
    var close = D.series.himsUsdg.close;
    S('path', { d: linePath(i0, i1, xs, ys, close), 'class': 'usd' }, g);
    var px = xs(F.peakTime.v), py = ys(F.peakClose.v);
    marker(g, px, py, 'usd', true);
    T(g, px - 9, py + 4, CH('peak'), 'lab lab-v', 'end');
    T(g, W - m.r, 14, CH('newNext'), 'ax', 'end');
    var cross = crossLayer(svg, m.t, Hh - m.b, ['usd']);
    return {
      from: from, to: to, i0: i0, i1: i1, xs: xs, key: F.peakTime.v,
      cross: function (i) { cross(i == null ? null : xs(D.t[i]), [ys(close[i])]); },
      readout: function (i) {
        return { rows: [{ v: fmt.fix(close[i], 2), label: CH('tipPrice'), key: 'var(--pool-usd)' }],
          time: dayHM(D.t[i]) + ' UTC · ' + CH('tipTimes', { x: fmt.fix(close[i] / F.nav.v, 2) }) };
      }
    };
  };

  charts.restock = function (plot) {
    var W = plot.clientWidth, Hh = plot.clientHeight || 360, m = { t: 28, r: 16, b: 40, l: 56 }, gap = 20;
    var svg = svgFor(plot, W, Hh), g = S('g', null, svg);
    var from = TS.sun1800, to = TS.mon1000, i0 = iOf(from), i1 = iOf(to);
    var inner = Hh - m.t - m.b - gap, h1 = Math.round(inner * 0.58), top2 = m.t + h1 + gap;
    var xs = lin(from, to, m.l, W - m.r);
    var y1 = lin(0, 80, m.t + h1, m.t), y2 = lin(0, 40000, Hh - m.b, top2);
    band(g, xs, from, F.firstMint.v, m.t, m.t + h1, CH('noNewTokens'));
    band(g, xs, from, F.firstMint.v, top2, Hh - m.b, null);
    yAxis(g, y1, [0, 40, 80], m.l, m.r, W, CH('yPrice'));
    yAxis(g, y2, [0, 20000, 40000], m.l, m.r, W, null);
    timeAxis(g, xs, from, to, Hh - m.b, W < 480 ? 4 : 2);
    refLine(g, y1, m.l, m.r, W, null);
    var mx = xs(F.firstMint.v);
    H(g, mx, m.t - 4, mx, Hh - m.b, 'mintl');
    S('circle', { cx: mx.toFixed(1), cy: m.t - 4, r: 14, 'class': 'ring ink-r' }, g);
    T(g, mx + 5, 14, CH('firstNew'), 'lab', 'start');
    var close = D.series.himsUsdg.close, sup = D.series.himsSupply;
    S('path', { d: linePath(i0, i1, xs, y1, close), 'class': 'usd' }, g);
    S('path', { d: linePath(i0, i1, xs, y2, sup, true), 'class': 'ink' }, g);
    var bx = xs(F.backTime.v), by = y1(F.backPrice.v);
    marker(g, bx, by, 'usd', false);
    T(g, bx + 6, by - 12, CH('back'), 'lab', 'start');
    T(g, m.l + 6, y2(F.float.v) - 7, CH('floatAll'), 'lab', 'start');
    var ex = xs(TS.mon0954), ey = y2(F.supply0954.v);
    marker(g, ex, ey, 'ink', false);
    T(g, ex - 8, ey - 9, CH('supplyEnd'), 'lab', 'end');
    var cross = crossLayer(svg, m.t, Hh - m.b, ['usd', 'ink']);
    return {
      from: from, to: to, i0: i0, i1: i1, xs: xs, key: F.backTime.v,
      cross: function (i) { cross(i == null ? null : xs(D.t[i]), [y1(close[i]), y2(sup[i])]); },
      readout: function (i) {
        return { rows: [{ v: fmt.fix(close[i], 2), label: CH('tipPrice'), key: 'var(--pool-usd)' }, { v: fmt.int(sup[i]), label: CH('tipTokens'), key: 'var(--text-primary)' }],
          time: dayHM(D.t[i]) + ' UTC' };
      }
    };
  };

  charts.safe = function (plot) {
    var W = plot.clientWidth, Hh = plot.clientHeight || 280, m = { t: 28, r: 16, b: 40, l: 56 };
    var svg = svgFor(plot, W, Hh), g = S('g', null, svg);
    var from = TS.sun1800, to = TS.mon1000, i0 = iOf(from), i1 = iOf(to);
    var xs = lin(from, to, m.l, W - m.r);
    var ly = lin(1, 4, Hh - m.b, m.t), ys = function (v) { return ly(Math.log(clamp(v, 10, 10000)) / Math.LN10); };
    var hk = D.series.hakari, dec = hk.decision.e1000;
    var b = function (i) { return hk.gapBoundUsdg[i] != null ? hk.gapBoundUsdg[i] : hk.maxSafeUsdg[i]; };
    // refused minutes, one rect per run (each minute ±30 s)
    var runs = [], cur = null;
    for (var i = i0; i <= i1; i++) {
      if (dec[i] === 0) { if (cur) cur[1] = i; else { cur = [i, i]; runs.push(cur); } } else cur = null;
    }
    runs.forEach(function (r) {
      var a = xs(D.t[r[0]] - 30), z = xs(D.t[r[1]] + 30);
      S('rect', { x: a.toFixed(1), y: m.t, width: (z - a).toFixed(1), height: Hh - m.b - m.t, 'class': 'refuse' }, g);
    });
    yAxis(g, ys, [10, 100, 1000, 10000], m.l, m.r, W, CH('yUsdg'));
    timeAxis(g, xs, from, to, Hh - m.b, W < 480 ? 4 : 2);
    var mx = xs(F.firstMint.v);
    H(g, mx, m.t - 4, mx, Hh - m.b, 'mintl');
    T(g, mx + 5, 14, CH('firstNew'), 'lab', 'start');
    var y1000 = ys(1000);
    H(g, m.l, y1000, W - m.r, y1000, 'l1000');
    T(g, W - m.r, y1000 - 7, CH('line1000'), 'lab', 'end');
    var vals = []; for (var k = 0; k <= i1; k++) vals[k] = k >= i0 ? b(k) : null;
    S('path', { d: linePath(i0, i1, xs, ys, vals), 'class': 'hk' }, g);
    // label over the longest run, inside the plot, clear of the line (every value in the run is below 1,000)
    var longest = runs.reduce(function (a, r) { return !a || r[1] - r[0] > a[1] - a[0] ? r : a; }, null);
    if (longest) {
      var cx = (xs(D.t[longest[0]]) + xs(D.t[longest[1]])) / 2, ty = m.t + 30;
      var lab = T(g, cx, ty, '', 'lab lab-v', 'middle');
      var x1 = S('tspan', { 'class': 'x-icon' }, lab); x1.textContent = '✕ ';
      var w = S('tspan', null, lab); w.textContent = CH('refused');
    }
    var a1 = xs(TS.sun1940), b1 = ys(vals[iOf(TS.sun1940)]);
    marker(g, a1, b1, 'hk', false);
    T(g, a1 + 7, b1 - 9, CH('m1940'), 'lab lab-v', 'start');
    var a2 = xs(TS.sun2325), b2 = ys(vals[iOf(TS.sun2325)]);
    marker(g, a2, b2, 'hk', true);
    T(g, a2 + 8, b2 + 15, CH('m2325'), 'lab lab-v', 'start');
    var cross = crossLayer(svg, m.t, Hh - m.b, ['hk']);
    return {
      from: from, to: to, i0: i0, i1: i1, xs: xs, key: TS.sun2325,
      cross: function (i) { cross(i == null ? null : xs(D.t[i]), [vals[i] == null ? null : ys(vals[i])]); },
      readout: function (i) {
        var v = vals[i], refused = dec[i] === 0;
        return { rows: [{ v: fmt.amount(v), label: CH('tipSafe'), key: 'var(--hakari)' }],
          verdict: dec[i] == null ? null : { no: refused, label: CH('tipPayout'), word: refused ? CH('refused') : CH('paid') },
          time: dayHM(D.t[i]) + ' UTC' };
      }
    };
  };

  // ------------------------------------------------------------------ tooltip
  var liveT = 0, hideT = 0;
  function span(cls, text) { var s = doc.createElement('span'); if (cls) s.className = cls; if (text != null) s.textContent = text; return s; }
  function tipShow(ro, cx, cy) {
    tip.textContent = '';
    var said = [];
    ro.rows.forEach(function (r) {
      var d = doc.createElement('div'); d.className = 'tip-row';
      if (r.key) { var k = span('tip-key'); k.style.background = r.key; d.appendChild(k); }
      d.appendChild(span('tip-v', r.v)); d.appendChild(span('', r.label));
      tip.appendChild(d); said.push(r.v + ' ' + r.label);
    });
    if (ro.verdict) {
      var vd = doc.createElement('div'); vd.className = 'tip-row';
      vd.appendChild(span('', ro.verdict.label));
      vd.appendChild(span(ro.verdict.no ? 'no' : 'yes', ro.verdict.no ? '✕' : '✓'));
      vd.appendChild(span('', ro.verdict.word));
      tip.appendChild(vd); said.push(ro.verdict.label + ' ' + ro.verdict.word);
    }
    var tm = doc.createElement('div'); tm.className = 'tip-time'; tm.textContent = ro.time; tip.appendChild(tm);
    said.push(ro.time);
    tip.hidden = false;
    var r = tip.getBoundingClientRect(), vw = root.clientWidth, vh = window.innerHeight;
    var x = cx + 16, y = cy + 16;
    if (x + r.width > vw - 8) x = Math.max(8, cx - 16 - r.width);
    if (y + r.height > vh - 8) y = Math.max(8, cy - 16 - r.height);
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
    var now = Date.now();
    if (live && now - liveT > 250) { liveT = now; live.textContent = said.join(' · '); }
  }
  function tipHide() { if (tip) tip.hidden = true; }

  function wirePlot(plot) {
    if (plot._wired) return; plot._wired = true;
    var curI = null;
    function idxAt(clientX) {
      var c = plot._chart; if (!c) return null;
      var r = plot.getBoundingClientRect();
      var ts = clamp(c.xs.inv(clientX - r.left), c.from, c.to);
      return clamp(iOf(ts), c.i0, c.i1);
    }
    function showAt(i, cx, cy) {
      var c = plot._chart; if (!c || i == null) return;
      curI = i; c.cross(i);
      if (cx == null) { var r = plot.getBoundingClientRect(); cx = r.left + c.xs(D.t[i]); cy = r.top + 24; }
      tipShow(c.readout(i), cx, cy);
    }
    function hide() { var c = plot._chart; if (c) c.cross(null); tipHide(); curI = null; }
    plot._hide = hide;
    plot._reshow = function () { if (curI != null) showAt(curI); };
    plot.addEventListener('pointermove', function (e) {
      clearTimeout(hideT);
      showAt(idxAt(e.clientX), e.clientX, e.clientY);
      if (e.pointerType === 'touch') hideT = setTimeout(hide, 1500);
    });
    plot.addEventListener('pointerleave', function (e) { if (e.pointerType !== 'touch') hide(); });
    plot.addEventListener('pointerup', function (e) { if (e.pointerType === 'touch') { clearTimeout(hideT); hideT = setTimeout(hide, 1500); } });
    plot.addEventListener('focus', function () { var c = plot._chart; if (c) showAt(iOf(c.key)); });
    plot.addEventListener('blur', hide);
    plot.addEventListener('keydown', function (e) {
      var c = plot._chart; if (!c) return;
      var i = curI == null ? iOf(c.key) : curI, step = e.shiftKey ? 60 : 5;
      if (e.key === 'ArrowRight') i += step; else if (e.key === 'ArrowLeft') i -= step;
      else if (e.key === 'Home') i = c.i0; else if (e.key === 'End') i = c.i1;
      else if (e.key === 'Escape') { hide(); return; } else return;
      e.preventDefault();
      showAt(clamp(i, c.i0, c.i1));
    });
  }
  // cost bars: HTML rows, one tooltip each
  function wireBars() {
    Array.prototype.forEach.call(doc.querySelectorAll('.bar-row'), function (row) {
      function show(cx, cy) {
        if (!F) return;
        var id = row.getAttribute('data-fact-ref'), ts = +row.getAttribute('data-ts');
        if (cx == null) { var r = row.getBoundingClientRect(); cx = r.left + 40; cy = r.top; }
        tipShow({ rows: [{ v: F[id].text, label: CH('tipCost'), key: 'var(--hakari)' }], time: dayHM(ts) + ' UTC' }, cx, cy);
      }
      row._reshow = function () { show(); };
      row.addEventListener('pointermove', function (e) { show(e.clientX, e.clientY); });
      row.addEventListener('pointerleave', tipHide);
      row.addEventListener('focus', function () { show(); });
      row.addEventListener('blur', tipHide);
    });
  }

  // ------------------------------------------------------------------ render all charts
  var plots = Array.prototype.slice.call(doc.querySelectorAll('.plot[data-plot]'));
  function renderAll() {
    tipHide();
    plots.forEach(function (plot) {
      if (plot.getAttribute('data-alt-en') == null) plot.setAttribute('data-alt-en', plot.getAttribute('aria-label') || '');
      plot.setAttribute('aria-label', lang === 'zh' ? plot.getAttribute('data-alt-zh') : plot.getAttribute('data-alt-en'));
      if (!dataOk) {
        plot.textContent = '';
        var p = doc.createElement('p'); p.className = 'nodata'; p.textContent = L(C.ui.noData); plot.appendChild(p);
        plot.removeAttribute('tabindex');
        return;
      }
      var kind = plot.getAttribute('data-plot');
      if (!charts[kind] || plot.clientWidth < 40) return;
      try { plot._chart = charts[kind](plot); } catch (e) { plot._chart = null; if (window.console) console.error('plain: chart ' + kind + ' failed: ' + e.message); }
      if (plot._chart) wirePlot(plot); else plot.removeAttribute('tabindex');
    });
    // HTML diagrams carry their own alt pairs
    Array.prototype.forEach.call(doc.querySelectorAll('.shelves[data-alt-zh]'), function (el) {
      if (el.getAttribute('data-alt-en') == null) el.setAttribute('data-alt-en', el.getAttribute('aria-label') || '');
      el.setAttribute('aria-label', lang === 'zh' ? el.getAttribute('data-alt-zh') : el.getAttribute('data-alt-en'));
    });
  }

  // ------------------------------------------------------------------ language
  var notoLoaded = false;
  function loadNoto() {
    if (notoLoaded) return; notoLoaded = true;
    var l = doc.createElement('link'); l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700&display=swap';
    (doc.head || doc.body).appendChild(l);
  }
  function setLang(l, initial) {
    lang = l === 'zh' ? 'zh' : 'en';
    root.setAttribute('data-lang', lang);
    root.lang = lang === 'zh' ? 'zh-Hant-TW' : 'en';
    ['en', 'zh'].forEach(function (k) { var b = $('lang-' + k); if (b) b.setAttribute('aria-pressed', k === lang ? 'true' : 'false'); });
    if (C.meta && C.meta.docTitle) doc.title = L(C.meta.docTitle);
    if (lang === 'zh') loadNoto();
    if (!initial) {
      store.set(lang);
      if (!location.hash || /^#(en|zh)$/.test(location.hash)) { try { history.replaceState(null, '', '#' + lang); } catch (e) { /* sandboxed */ } }
      renderAll();
    }
  }
  function langFromHash() { var h = location.hash; return h === '#zh' ? 'zh' : h === '#en' ? 'en' : null; }

  // ------------------------------------------------------------------ init
  function init() {
    var hl = langFromHash(), st = store.get();
    if (hl) store.set(hl); // arriving by a #en / #zh link: keep that language when the reader moves to the detailed page
    setLang(hl || (st === 'zh' || st === 'en' ? st : 'en'), true);
    var gone = PF.missing(D);
    if (!gone.length) {
      try { F = PF.compute(D).facts; dataOk = true; } catch (e) { if (window.console) console.error('plain: ' + e.message); }
    }
    root.classList.toggle('no-data', !dataOk);
    if (dataOk) {
      var off = 0;
      Array.prototype.forEach.call(doc.querySelectorAll('[data-fact]'), function (el) {
        var f = F[el.getAttribute('data-fact')];
        if (!f) return;
        if (el.textContent !== f.text) { off++; el.textContent = f.text; }
      });
      if (off && window.console) console.warn('plain: ' + off + ' number(s) in the HTML were stale and were refilled from data.js; run build-plain.mjs');
    }
    renderAll();
    wireBars();
    var en = $('lang-en'), zh = $('lang-zh');
    if (en) en.addEventListener('click', function () { setLang('en'); });
    if (zh) zh.addEventListener('click', function () { setLang('zh'); });
    window.addEventListener('hashchange', function () { var l = langFromHash(); if (l && l !== lang) setLang(l); });
    // re-render on width change only
    var lastW = root.clientWidth, raf = 0;
    function onResize() {
      if (raf) return;
      raf = requestAnimationFrame(function () { raf = 0; var w = root.clientWidth; if (w === lastW) return; lastW = w; renderAll(); });
    }
    if (window.ResizeObserver) new ResizeObserver(onResize).observe(root); else window.addEventListener('resize', onResize);
    // a pointer tooltip goes away on scroll; a keyboard one follows its focused plot or bar
    window.addEventListener('scroll', function () {
      if (tip.hidden) return;
      var a = doc.activeElement;
      if (a && a._reshow) { a._reshow(); return; }
      tipHide(); plots.forEach(function (p) { if (p._hide) p._hide(); });
    }, { passive: true });
    // the one scroll-in: each figure fades up the first time it enters, then its key marker rings once
    var figs = doc.querySelectorAll('.viz[data-in]');
    var done = function (el) { el.setAttribute('data-in', '1'); setTimeout(function () { el.setAttribute('data-rung', '1'); }, 800); };
    if (window.IntersectionObserver) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) { if (en.isIntersecting) { done(en.target); io.unobserve(en.target); } });
      }, { threshold: 0.2 });
      Array.prototype.forEach.call(figs, function (f) { io.observe(f); });
    } else Array.prototype.forEach.call(figs, done);
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init); else init();
  window.PLAIN = { setLang: setLang, render: renderAll, facts: function () { return F; } };
})();
