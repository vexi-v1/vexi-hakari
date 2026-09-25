/* HIMS weekend float squeeze: the flow triangle (three pools, one frozen token), the pools +
   float panel and the cost hero. Built once per layout/language, updated per cursor frame
   (attributes and text only, no rebuilds). Classic script, attaches to window.SQZ. */
(function (S) {
  'use strict';
  var tr = S.tr, T = S.tri = {};

  // Ribbon ends: [pool, token, series key, reference price]
  function units(i) {
    var nav = S.NAV, b = S.bonerRef;
    function g(k) { var v = S.val(k, i); return v == null ? 0 : v; }
    return {
      usd: [g('usdgInHimsUsdg'), g('himsInHimsUsdg') * nav],            // USDG end, HIMS end
      boner: [g('himsInBonerHims') * nav, g('bonerInBonerHims') * b],    // HIMS end, BONER end
      direct: [g('usdgInBonerUsdg'), g('bonerInBonerUsdg') * b]         // USDG end, BONER end
    };
  }
  T.prepare = function () {
    // maxUnits = the max over all t of all six ends (computed once).
    var max = 0, all = [];
    for (var i = 0; i < S.N; i += 1) {
      var u = units(i);
      [u.usd[0], u.usd[1], u.boner[0], u.boner[1], u.direct[0], u.direct[1]].forEach(function (v) { if (v > max) max = v; if (i % 5 === 0) all.push(v); });
    }
    T.maxUnits = max; T.capped = false;
    var b = units(S.baseI);
    // Overflow guard: if the dollar pool's ends at the baseline would draw under 4 px, cap at the 98th percentile.
    if (Math.min(b.usd[0], b.usd[1]) / max * 40 < 4) {
      all.sort(function (p, q) { return p - q; });
      T.maxUnits = all[Math.floor(all.length * 0.98)] || max; T.capped = true;
    }
  };

  T.build = function () {
    var host = S.$('tri-svg-host'); S.clear(host);
    var mode = S.layout.mode, W = host.clientWidth || 480;
    // desk: 380 px, less on short screens so the price lane stays in the first frame
    var H = mode === 'desk' ? S.clamp(window.innerHeight - 520, 320, 380) : (mode === 'tab' ? 360 : S.clamp(Math.round(W * 0.82), 300, 340));
    if (S.state.presenting && S.presTriH) H = S.presTriH;
    var phone = mode === 'phone';
    var r = phone ? 20 : 24, gateTop = 10, boxW = phone ? 150 : 176, boxH = 36, conn = phone ? 46 : (H < 350 ? 40 : 60);
    var apex = { x: W / 2, y: gateTop + boxH + conn + r };
    var baseY = H - (phone ? 62 : 70), h = baseY - apex.y;
    var halfBase = phone ? Math.min(0.95 * h, W / 2 - 50) : Math.min(1.0 * h, W / 2 - 100);
    var P = { hims: apex, usdg: { x: W / 2 - halfBase, y: baseY }, boner: { x: W / 2 + halfBase, y: baseY } };
    T.geo = { W: W, H: H, r: r, P: P, phone: phone, maxW: mode === 'desk' ? 40 : (mode === 'tab' ? 34 : 26), gateTop: gateTop, boxW: boxW, boxH: boxH };
    var svg = S.svg('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, role: 'img', cls: 'tri-svg' }, host);
    T.svg = svg;
    var gR = S.svg('g', { cls: 'ribbons' }, svg), gG = S.svg('g', { cls: 'ghosts' }, svg), gC = S.svg('g', { cls: 'chevrons' }, svg);
    var gN = S.svg('g', { cls: 'nodes' }, svg), gL = S.svg('g', { cls: 'tri-labels' }, svg), gP = S.svg('g', { cls: 'pills' }, svg);
    // edges: a -> b in route order
    T.edges = {
      usd: { a: P.usdg, b: P.hims, color: 'pool-usd', ta: 'USDG', tb: 'HIMS' },
      boner: { a: P.hims, b: P.boner, color: 'pool-boner', ta: 'HIMS', tb: 'BONER' },
      direct: { a: P.usdg, b: P.boner, color: 'pool-direct', ta: 'USDG', tb: 'BONER' }
    };
    var C = { x: (P.hims.x + P.usdg.x + P.boner.x) / 3, y: (P.hims.y + P.usdg.y + P.boner.y) / 3 };
    T.centroid = C;
    Object.keys(T.edges).forEach(function (k) {
      var e = T.edges[k], dx = e.b.x - e.a.x, dy = e.b.y - e.a.y, len = Math.sqrt(dx * dx + dy * dy);
      e.u = { x: dx / len, y: dy / len }; e.n = { x: -e.u.y, y: e.u.x }; e.len = len;
      var mid = { x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 };
      if ((C.x - mid.x) * e.n.x + (C.y - mid.y) * e.n.y > 0) e.n = { x: -e.n.x, y: -e.n.y }; // n points outward
      // price pills sit a little below the midpoint on the slanted edges, clear of the HIMS apex labels
      var f = k === 'usd' ? (phone ? 0.3 : 0.42) : (k === 'boner' ? (phone ? 0.7 : 0.58) : 0.5);
      e.f = f;
      e.mid = { x: e.a.x + (e.b.x - e.a.x) * f, y: e.a.y + (e.b.y - e.a.y) * f };
      e.s = { x: e.a.x + e.u.x * (r + 6), y: e.a.y + e.u.y * (r + 6) };
      e.e = { x: e.b.x - e.u.x * (r + 6), y: e.b.y - e.u.y * (r + 6) };
      e.poly = S.svg('polygon', { fill: 'var(--' + e.color + ')', 'fill-opacity': 0.9 }, gR);
      e.ghost = S.svg('polygon', { cls: 'ghost' }, gG);
      e.notchA = S.svg('path', { cls: 'notch', d: '' }, gR); e.notchB = S.svg('path', { cls: 'notch', d: '' }, gR);
      // end labels: outside for the two slanted edges, inside for the base
      var inside = k === 'direct';
      e.labA = S.svg('text', { cls: 'end-label halo' }, gL); e.labB = S.svg('text', { cls: 'end-label halo' }, gL);
      e.labInside = inside;
      // price pill
      var pg = S.svg('g', { cls: 'pill' }, gP);
      e.pill = pg;
      e.pillRect = S.svg('rect', { rx: 6 }, pg);
      e.pillKey = S.svg('rect', { width: 10, height: 3, rx: 1, fill: 'var(--' + e.color + ')' }, pg);
      e.pv = S.svg('text', { cls: 'pill-v' }, pg);
      e.pu = S.svg('text', { cls: 'pill-u' }, pg);
      e.ps = S.svg('text', { cls: 'pill-s' }, pg);
      // chevrons (three along the centre line)
      e.chev = [0.34, 0.5, 0.66].map(function (f, j) { return S.svg('path', { cls: 'chev', d: 'M-3,-4.5L2.5,0L-3,4.5', style: 'animation-delay:' + (j * 0.2) + 's' }, gC); });
      e.chevAt = [0.34, 0.5, 0.66];
    });
    // nodes
    [['hims', 'HIMS'], ['usdg', 'USDG'], ['boner', 'BONER']].forEach(function (nd) {
      var p = P[nd[0]];
      S.svg('circle', { cls: 'node', cx: p.x, cy: p.y, r: r }, gN);
      var t = S.svg('text', { cls: 'node-sym', x: p.x, y: p.y + 4.5, 'text-anchor': 'middle' }, gN); t.textContent = nd[1];
    });
    // HIMS sub-labels mirror the gate pill: left of the barrier, right-aligned
    var byL = gateTop + boxH + Math.round(conn / 2);
    T.subHims1 = S.svg('text', { cls: 'node-sub', x: W / 2 - 34, y: byL - 3, 'text-anchor': 'end' }, gL);
    T.subHims2 = S.svg('text', { cls: 'node-sub', x: W / 2 - 34, y: byL + 12, 'text-anchor': 'end' }, gL);
    T.subUsdg = S.svg('text', { cls: 'node-sub', x: P.usdg.x, y: P.usdg.y + r + 16, 'text-anchor': 'middle' }, gL);
    T.subBoner = S.svg('text', { cls: 'node-sub', x: P.boner.x, y: P.boner.y + r + 16, 'text-anchor': 'middle' }, gL);
    // gate
    var gx = W / 2, gg = S.svg('g', { cls: 'gate' }, svg);
    S.svg('rect', { cls: 'issuer', x: gx - boxW / 2, y: gateTop, width: boxW, height: boxH, rx: 8 }, gg);
    T.issuer1 = S.svg('text', { cls: 'issuer-t', x: gx, y: gateTop + 15, 'text-anchor': 'middle' }, gg);
    T.issuer2 = S.svg('text', { cls: 'issuer-s', x: gx, y: gateTop + 29, 'text-anchor': 'middle' }, gg);
    var by = gateTop + boxH + Math.round(conn / 2);
    T.barrierY = by;
    T.connTop = S.svg('line', { cls: 'conn', x1: gx, x2: gx, y1: gateTop + boxH, y2: by }, gg);
    T.connBot = S.svg('line', { cls: 'conn', x1: gx, x2: gx, y1: by, y2: P.hims.y - r }, gg);
    S.svg('rect', { cls: 'post', x: gx - 23, y: by - 6, width: 2, height: 12 }, gg);
    S.svg('rect', { cls: 'post', x: gx + 21, y: by - 6, width: 2, height: 12 }, gg);
    T.bar = S.svg('line', { cls: 'bar', x1: gx - 22, x2: gx + 30, y1: by, y2: by }, gg);
    T.bar.style.transformOrigin = (gx - 22) + 'px ' + by + 'px';
    // raised = rotated -80° about its left post and shortened so it never crosses the issuer box above it
    var room = by - (gateTop + boxH) - 4, sc = S.clamp(room / (52 * Math.sin(80 * Math.PI / 180)), 0.2, 1);
    T.barRaised = 'rotate(-80deg) scale(' + sc.toFixed(3) + ', 1)';
    T.gatePill = S.svg('g', { cls: 'gate-pill' }, gg);
    T.gatePillRect = S.svg('rect', { rx: 6, x: gx + 34, y: by - 17, height: 34 }, T.gatePill);
    T.gateIcon = S.svg('path', { cls: 'gate-icon' }, T.gatePill);
    T.gate1 = S.svg('text', { cls: 'gate-t', x: gx + 56, y: by - 3 }, T.gatePill);
    T.gate2 = S.svg('text', { cls: 'gate-s', x: gx + 56, y: by + 11 }, T.gatePill);
    T.pulse = S.svg('circle', { cls: 'pulse', cx: gx, cy: gateTop + boxH, r: 3, opacity: 0 }, gg);
    T.pulse.style.setProperty('--conn', (P.hims.y - r - gateTop - boxH) + 'px');
    T.pulseLabel = S.svg('text', { cls: 'pulse-label', x: gx - 12, y: by + 22, 'text-anchor': 'end' }, gg);
    // centroid caption (desk/tab); phone uses the HTML line under the figure
    T.flow = S.svg('text', { cls: 'flow-cap', x: C.x, y: C.y - 4, 'text-anchor': 'middle' }, svg);
    T.flow1 = S.svg('tspan', { x: C.x, dy: 0 }, T.flow);
    T.flow2 = S.svg('tspan', { x: C.x, dy: 15 }, T.flow);
    T.flow3 = S.svg('tspan', { x: C.x, dy: 15 }, T.flow);
    var squat = h < 150 || halfBase < 150;
    var htmlFlow = !S.state.presenting && (phone || squat);
    T.flow.style.display = htmlFlow || squat ? 'none' : '';
    T.flowHtml = S.$('tri-flow');
    T.flowHtml.hidden = !htmlFlow;
    // phone: the three pool prices move to an HTML row under the figure (the edges are too short for pills)
    var rowMode = phone || h < 170;
    gP.style.display = rowMode ? 'none' : '';
    var row = S.$('tri-prices'); S.clear(row); row.hidden = !rowMode; T.priceCells = null;
    if (rowMode) T.priceCells = ['usd', 'boner', 'direct'].map(function (k) {
      var v0 = S.el('strong'), u0 = S.el('span', { cls: 'tp-u' }), s0 = S.el('span', { cls: 'tp-s' });
      row.appendChild(S.el('li', null, [S.el('i', { cls: 'key-line', style: 'background:var(--' + T.edges[k].color + ')', 'aria-hidden': 'true' }), v0, u0, s0]));
      return { k: k, v: v0, u: u0, s: s0 };
    });
    T.texts();
    T.lastLabel = 0;
  };

  T.texts = function () {
    if (!T.svg) return;
    T.issuer1.textContent = tr('gate.issuer') + ' · ' + tr('gate.mintRedeem');
    T.issuer2.textContent = tr('gate.hours');
    T.subUsdg.textContent = tr('tri.usdg');
    var cap = S.$('tri-caption');
    if (cap) cap.textContent = tr('tri.caption', { t: S.fmtWdHM(S.baseTs) + ' ' + S.zoneLabel() });
    var note = S.$('tri-note'); if (note) note.textContent = tr('tri.note', { b: S.fmtSig(S.bonerRef, 3) });
    T.pillW = {};
    Object.keys(T.edges).forEach(function (k) {
      var e = T.edges[k];
      e.pu.textContent = tr(k === 'usd' ? 'tri.perHims' : (k === 'boner' ? 'tri.perBonerH' : 'tri.perBonerU'));
    });
    var tt = S.$('tri-table-title'); if (tt) tt.textContent = tr('tri.numbers');
  };

  function poly(e, wa, wb) {
    var n = e.n, s = e.s, t = e.e;
    return [s.x + n.x * wa / 2, s.y + n.y * wa / 2, t.x + n.x * wb / 2, t.y + n.y * wb / 2, t.x - n.x * wb / 2, t.y - n.y * wb / 2, s.x - n.x * wa / 2, s.y - n.y * wa / 2]
      .map(function (v) { return v.toFixed(1); }).join(' ');
  }
  function widthOf(u) { return Math.max(1, Math.min(T.geo.maxW, T.geo.maxW * u / T.maxUnits)); }
  function placeEndLabel(e, which, w, text) {
    var el = which === 'a' ? e.labA : e.labB, node = which === 'a' ? e.a : e.b, dir = which === 'a' ? 1 : -1, r = T.geo.r;
    if (node === T.geo.P.hims) {
      // the two HIMS ends sit beside the HIMS disc, on the side of their ribbon (clear of ribbons and pills)
      var left = (e.a === node ? e.b : e.a).x < node.x;
      el.setAttribute('x', (node.x + (left ? -(r + 8) : r + 8)).toFixed(1));
      el.setAttribute('y', (node.y + 2).toFixed(1));
      el.setAttribute('text-anchor', left ? 'end' : 'start');
      el.textContent = text;
      var lx = node.x + (left ? -(r + 8) : r + 8), lw = estW(text, 11);
      if (text) T.labBoxes.push({ x0: left ? lx - lw : lx, x1: left ? lx : lx + lw, y0: node.y - 9, y1: node.y + 5 });
      return;
    }
    var along = r + 14, off = w / 2 + 8, sgn = e.labInside ? -1 : 1;
    var px = node.x + e.u.x * along * dir + e.n.x * off * sgn, py = node.y + e.u.y * along * dir + e.n.y * off * sgn;
    var nx = e.n.x * sgn, ny = e.n.y * sgn;
    var ly = py + (ny > 0.3 ? 11 : (ny < -0.3 ? -2 : 4)), anchor = e.labInside ? (which === 'a' ? 'start' : 'end') : (nx > 0.3 ? 'start' : (nx < -0.3 ? 'end' : 'middle'));
    el.setAttribute('x', px.toFixed(1));
    el.setAttribute('y', ly.toFixed(1));
    el.setAttribute('text-anchor', anchor);
    el.textContent = text;
    if (text) { var tw = estW(text, 11), bx = anchor === 'start' ? px : (anchor === 'end' ? px - tw : px - tw / 2); T.labBoxes.push({ x0: bx, x1: bx + tw, y0: ly - 9, y1: ly + 3 }); }
  }
  // Text width estimate (CJK glyphs are full-width): avoids a forced layout per frame.
  function estW(s, px) { var w = 0; for (var k = 0; k < s.length; k++) w += s.charCodeAt(k) > 0x2e80 ? px : px * 0.58; return w; }
  S.estW = estW;
  // Does a pill box touch any end label or node disc drawn this frame?
  function hitsSomething(b) {
    var P = T.geo.P, r = T.geo.r + 3;
    var nodes = [P.hims, P.usdg, P.boner].map(function (p) { return { x0: p.x - r, x1: p.x + r, y0: p.y - r, y1: p.y + r }; });
    return T.labBoxes.concat(nodes).some(function (q) { return !(b.x1 + 4 <= q.x0 || b.x0 >= q.x1 + 4 || b.y1 + 3 <= q.y0 || b.y0 >= q.y1 + 3); });
  }
  function placePill(e, wmid) {
    var vw = Math.max(estW(e.pv.textContent, 13) + 14, estW(e.pu.textContent, 11), estW(e.ps.textContent, 11)) + 18;
    var hh = e.ps.textContent ? 50 : 36, hw = vw;
    var ext = Math.abs(e.n.x) * hw / 2 + Math.abs(e.n.y) * hh / 2;
    // keep the pill clear of the along-edge end labels (the HIMS ends sit beside the disc instead)
    var extA = Math.abs(e.u.x) * hw / 2 + Math.abs(e.u.y) * hh / 2;
    var ka = ((e.a === T.geo.P.hims ? 12 : 52) + T.geo.r + extA) / e.len, kb = ((e.b === T.geo.P.hims ? 12 : 52) + T.geo.r + extA) / e.len;
    var f = ka <= 1 - kb ? S.clamp(e.f, ka, 1 - kb) : (ka + 1 - kb) / 2;
    function at(ff) {
      var mx = e.a.x + (e.b.x - e.a.x) * ff, my = e.a.y + (e.b.y - e.a.y) * ff;
      var cx = mx + e.n.x * (wmid / 2 + 10 + ext), cy = my + e.n.y * (wmid / 2 + 10 + ext);
      cx = S.clamp(cx, hw / 2 + 2, T.geo.W - hw / 2 - 2); cy = S.clamp(cy, hh / 2 + 2, T.geo.H - hh / 2 - 2);
      return { x0: cx - hw / 2, y0: cy - hh / 2, x1: cx + hw / 2, y1: cy + hh / 2 };
    }
    // if it touches an end label (e.g. the HIMS count beside the disc) or a node, slide it along the edge to the
    // nearest free spot, anywhere between the two discs
    var box = at(f);
    if (hitsSomething(box)) {
      var lim = (T.geo.r + 6 + extA) / e.len;
      for (var g = 1; g <= 40; g++) {
        var f1 = f + g * 0.02, f0 = f - g * 0.02, b1 = f1 <= 1 - lim ? at(f1) : null, b0 = f0 >= lim ? at(f0) : null;
        if (b1 && !hitsSomething(b1)) { box = b1; break; }
        if (b0 && !hitsSomething(b0)) { box = b0; break; }
        if (!b1 && !b0) break;
      }
    }
    var x0 = box.x0, y0 = box.y0;
    e.pillRect.setAttribute('x', x0.toFixed(1)); e.pillRect.setAttribute('y', y0.toFixed(1));
    e.pillRect.setAttribute('width', hw.toFixed(1)); e.pillRect.setAttribute('height', hh);
    e.pillKey.setAttribute('x', (x0 + 8).toFixed(1)); e.pillKey.setAttribute('y', (y0 + 10).toFixed(1));
    e.pv.setAttribute('x', (x0 + 22).toFixed(1)); e.pv.setAttribute('y', (y0 + 15).toFixed(1));
    e.pu.setAttribute('x', (x0 + 8).toFixed(1)); e.pu.setAttribute('y', (y0 + 30).toFixed(1));
    e.ps.setAttribute('x', (x0 + 8).toFixed(1)); e.ps.setAttribute('y', (y0 + 44).toFixed(1));
  }
  function setChev(e, dirSign, on) {
    e.chev.forEach(function (c, j) {
      if (!on) { c.style.display = 'none'; return; }
      c.style.display = '';
      var f = e.chevAt[j], px = e.a.x + (e.b.x - e.a.x) * f, py = e.a.y + (e.b.y - e.a.y) * f;
      var ang = Math.atan2(e.u.y, e.u.x) * 180 / Math.PI + (dirSign < 0 ? 180 : 0);
      c.setAttribute('transform', 'translate(' + px.toFixed(1) + ',' + py.toFixed(1) + ') rotate(' + ang.toFixed(1) + ')');
    });
  }
  var ICON = {
    lock: 'M-4,-1h8v7h-8zM-2.5,-1v-3a2.5,2.5 0 0 1 5,0v3',
    open: 'M-4,-1h8v7h-8zM-2.5,-1v-3a2.5,2.5 0 0 1 5,0',
    glass: 'M-4,-6h8M-4,6h8M-3,-6c0,4 6,4 6,12M3,-6c0,4 -6,4 -6,12',
    plus: 'M0,-5v10M-5,0h10'
  };

  T.update = function (i) {
    if (!T.svg || !S.tri.edges) return;
    T.labBoxes = [];
    var ts = S.state.cursorTs, u = units(i), b = S.baseI, ub = units(b), phone = T.geo.phone;
    var keys = ['usd', 'boner', 'direct'];
    keys.forEach(function (k) {
      var e = T.edges[k], wa = widthOf(u[k][0]), wb = widthOf(u[k][1]);
      e.poly.setAttribute('points', poly(e, wa, wb));
      e.ghost.setAttribute('points', poly(e, widthOf(ub[k][0]), widthOf(ub[k][1])));
      e.wa = wa; e.wb = wb;
      e.notchA.setAttribute('d', T.capped && u[k][0] > T.maxUnits ? 'M' + e.s.x + ',' + e.s.y + 'm-2,-2h4v4h-4z' : '');
      e.notchB.setAttribute('d', T.capped && u[k][1] > T.maxUnits ? 'M' + e.e.x + ',' + e.e.y + 'm-2,-2h4v4h-4z' : '');
    });
    // end labels: native counts
    var E = T.edges, v = function (k) { return S.val(k, i); };
    var wider = function (k, j) { return T.capped && u[k][j] > T.maxUnits ? ' ▸' : ''; };
    placeEndLabel(E.usd, 'a', E.usd.wa, phone ? '' : S.fmtUsdg(v('usdgInHimsUsdg')) + ' USDG' + wider('usd', 0));
    placeEndLabel(E.usd, 'b', E.usd.wb, S.fmtHims(v('himsInHimsUsdg')) + ' HIMS' + wider('usd', 1));
    placeEndLabel(E.boner, 'a', E.boner.wa, S.fmtHims(v('himsInBonerHims')) + ' HIMS' + wider('boner', 0));
    placeEndLabel(E.boner, 'b', E.boner.wb, phone ? '' : S.fmtCompact(v('bonerInBonerHims')) + ' BONER' + wider('boner', 1));
    placeEndLabel(E.direct, 'a', E.direct.wa, phone ? '' : S.fmtUsdg(v('usdgInBonerUsdg')) + ' USDG' + wider('direct', 0));
    placeEndLabel(E.direct, 'b', E.direct.wb, phone ? '' : S.fmtCompact(v('bonerInBonerUsdg')) + ' BONER' + wider('direct', 1));
    // pills
    var c = v('himsUsdg.close'), bh = S.val('bonerHims.close', i), bhb = S.val('bonerHims.close', b), dr = S.val('bonerUsdgDirect.close', i);
    E.usd.pv.textContent = c == null ? '—' : S.fmtUsdg2(c);
    E.usd.ps.textContent = c == null ? tr('tri.noTrade') : tr('tri.vsNav', { p: S.fmtPct(S.val('himsPremiumPct', i) != null ? S.val('himsPremiumPct', i) : (c / S.NAV - 1) * 100) });
    E.boner.pv.textContent = bh == null ? '—' : S.fmtSig(bh, 3);
    E.boner.ps.textContent = bh == null ? tr('tri.noTrade') : (bhb ? tr(ts < S.baseTs - 30 ? 'tri.vsBase' : 'tri.sinceBase', { x: S.fmtChange(bh, bhb), t: S.fmtWdHM(S.baseTs) }) : '');
    E.direct.pv.textContent = dr == null ? '—' : S.fmtSig(dr, 3);
    E.direct.ps.textContent = dr == null ? tr('tri.noTrade') : tr('tri.routeGap', { p: S.fmtPct(v('routeGapPct')) });
    if (T.priceCells) T.priceCells.forEach(function (c0) { var e = E[c0.k]; c0.v.textContent = e.pv.textContent; c0.u.textContent = e.pu.textContent; c0.s.textContent = e.ps.textContent; });
    else keys.forEach(function (k) { var e = E[k]; placePill(e, (e.wa + e.wb) / 2); });
    // node sub-labels
    T.subHims1.textContent = tr('tri.supply', { v: S.fmtSupply(v('himsSupply')) });
    T.subHims2.textContent = tr('tri.pm', { v: S.fmtHims(v('himsInPoolManager')) });
    T.subBoner.textContent = phone ? '' : tr('tri.bonerVia', { v: S.fmtSig(v('bonerUsdgViaHims'), 3) });
    // gate
    var st = S.gateState(ts), gx = T.geo.W / 2, by = T.barrierY;
    var raised = st.key !== 'closed';
    T.bar.style.transform = raised ? T.barRaised : 'none';
    T.connBot.setAttribute('class', 'conn' + (st.key === 'minting' || st.key === 'open' ? '' : ' idle'));
    T.gateIcon.setAttribute('d', ICON[st.icon]);
    T.gateIcon.setAttribute('transform', 'translate(' + (gx + 46) + ',' + (by + (st.icon === 'glass' || st.icon === 'plus' ? 0 : -1)) + ')');
    T.gate1.textContent = st.t1; T.gate2.textContent = st.t2;
    var gw = Math.max(estW(st.t1, 12), estW(st.t2, 11)) + 32;
    T.gatePillRect.setAttribute('width', gw.toFixed(0));
    // chevrons + flow caption: trailing 15 buckets
    var out = S.sumRange('netHimsOutOfHimsUsdg', i - 14, i) || 0, into = S.sumRange('netHimsIntoBonerHims', i - 14, i) || 0;
    setChev(E.usd, out >= 0 ? 1 : -1, Math.abs(out) > 1);
    setChev(E.boner, into >= 0 ? 1 : -1, Math.abs(into) > 1);
    setChev(E.direct, 1, false);
    var l2 = '', l3 = '';
    if (Math.abs(out) <= 1 && Math.abs(into) <= 1) l2 = tr('tri.flowNone');
    else {
      l2 = out >= 0 ? tr('tri.flowOut', { a: S.fmtHims(out) }) : tr('tri.flowBack', { a: S.fmtHims(-out) });
      l3 = into >= 0 ? tr('tri.flowIn', { b: S.fmtHims(into) }) : tr('tri.flowLeft', { b: S.fmtHims(-into) });
    }
    T.flow1.textContent = tr('tri.flow'); T.flow2.textContent = l2; T.flow3.textContent = l3;
    if (!T.flowHtml.hidden) T.flowHtml.textContent = tr('tri.flow') + ' ' + l2 + (l3 ? ' · ' + l3 : '');
    // pulses on mint/burn crossings
    pulse(i);
    // accessible summary, at most once a second
    var now = Date.now();
    if (now - T.lastLabel > 1000) {
      T.lastLabel = now;
      T.svg.setAttribute('aria-label', S.fmtDT(ts) + '. ' + tr('pool.usd') + ': ' + S.fmtHims(v('himsInHimsUsdg')) + ' HIMS, ' + S.fmtUsdg(v('usdgInHimsUsdg')) + ' USDG, ' + S.fmtUsdg2(c) + '. ' +
        tr('pool.boner') + ': ' + S.fmtHims(v('himsInBonerHims')) + ' HIMS. ' + st.t1 + ' ' + st.t2 + '.');
    }
    T.updateTable(i);
  };

  var lastPulseI = null, lastPulseAt = 0, pulseTimer = null;
  function pulse(i) {
    var prev = lastPulseI; lastPulseI = i;
    if (prev == null || i <= prev || i - prev > 30 || S.reducedMotion()) return;
    var mint = S.sumRange('himsMinted', prev + 1, i) || 0, burn = S.sumRange('himsBurned', prev + 1, i) || 0;
    if (!mint && !burn) return;
    var now = Date.now(); if (now - lastPulseAt < 250) return; lastPulseAt = now;
    var p = T.pulse, down = mint >= burn;
    p.classList.remove('run-down', 'run-up'); void p.getBBox();
    p.setAttribute('opacity', 1);
    p.classList.add(down ? 'run-down' : 'run-up');
    T.pulseLabel.textContent = down ? '+' + S.fmtHims(mint) : '−' + S.fmtHims(burn);
    clearTimeout(pulseTimer);
    pulseTimer = setTimeout(function () { T.pulseLabel.textContent = ''; p.setAttribute('opacity', 0); }, 1500);
  }

  // Gate state from data.reference (icon + words + barrier form, never hue).
  S.gateState = function (ts) {
    if (ts < S.fenceFrom) return { key: 'open', icon: 'open', t1: tr('gate.open'), t2: tr('gate.openSub'), chip: tr('chip.gateOpen') };
    if (ts < S.reopenTs) {
      var d = S.fmtDur(ts - S.fenceFrom);
      return { key: 'closed', icon: 'lock', t1: tr('gate.closed'), t2: tr('gate.fenced', { d: d }), chip: tr('chip.gateClosed', { d: d }) };
    }
    if (S.firstMintTs && ts < S.firstMintTs) return { key: 'waiting', icon: 'glass', t1: tr('gate.waiting'), t2: tr('gate.waitingSub', { m: Math.floor((ts - S.reopenTs) / 60) }), chip: tr('chip.gateWaiting') };
    var n = S.firstMintTs ? S.sumRange('himsMinted', S.idx(S.firstMintTs), S.idx(ts)) : 0;
    return { key: 'minting', icon: 'plus', t1: tr('gate.minting'), t2: tr('gate.mintingSub', { n: S.fmtHims(n), t: S.fmtHM(S.firstMintTs || ts) }), chip: tr('chip.gateMinting') };
  };

  // ---------- triangle Numbers table (3 pools x 4) ----------
  T.toggleTable = function () {
    var btn = S.$('tri-num'), box = S.$('tri-table');
    var open = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', open ? 'true' : 'false');
    box.hidden = !open;
    T.updateTable(S.idx(S.state.cursorTs));
  };
  T.updateTable = function (i) {
    var box = S.$('tri-table'); if (!box || box.hidden) return;
    var tb = S.$('tri-tbody'); S.clear(tb);
    var rows = [
      [tr('s.bandUsd'), S.fmtUsdg2(S.val('himsUsdg.close', i)) + ' USDG/HIMS', S.fmtUsdg(S.val('usdgInHimsUsdg', i)) + ' USDG', S.fmtHims(S.val('himsInHimsUsdg', i)) + ' HIMS'],
      [tr('s.bandBoner'), S.fmtSig(S.val('bonerHims.close', i), 3) + ' HIMS/BONER', S.fmtHims(S.val('himsInBonerHims', i)) + ' HIMS', S.fmtCompact(S.val('bonerInBonerHims', i)) + ' BONER'],
      ['BONER/USDG', S.fmtSig(S.val('bonerUsdgDirect.close', i), 3) + ' USDG/BONER', S.fmtUsdg(S.val('usdgInBonerUsdg', i)) + ' USDG', S.fmtCompact(S.val('bonerInBonerUsdg', i)) + ' BONER']
    ];
    rows.forEach(function (r) { var tr0 = S.el('tr'); tr0.appendChild(S.el('th', { scope: 'row', text: r[0] })); for (var k = 1; k < 4; k++) tr0.appendChild(S.el('td', { text: r[k] })); tb.appendChild(tr0); });
  };

  // ---------- pools legend + where the supply sits ----------
  T.buildPanel = function () {
    var lg = S.$('pools-legend'); S.clear(lg);
    [['pool-usd', 'HIMS/USDG', 'pool.usd'], ['pool-boner', 'BONER/HIMS', 'pool.boner'], ['pool-direct', 'BONER/USDG', 'pool.direct']].forEach(function (p) {
      lg.appendChild(S.el('li', null, [S.el('i', { cls: 'sw', style: 'background:var(--' + p[0] + ')' }), S.el('span', { cls: 'pl-name', text: p[1] }), S.el('span', { cls: 'pl-role', text: tr(p[2]) })]));
    });
    S.$('pools-title').textContent = tr('pools.title');
    S.$('float-title').textContent = tr('float.title');
    var bar = S.$('float-bar'); S.clear(bar);
    T.fseg = ['pool-usd-fill', 'pool-boner-fill', 'other-v4', 'outside'].map(function (c) { var s = S.el('i', { style: 'background:var(--' + c + ')' }); bar.appendChild(s); return s; });
    var rows = S.$('float-rows'); S.clear(rows);
    T.frow = [['pool-usd-fill', 'f.usd'], ['pool-boner-fill', 'f.boner'], ['other-v4', 'f.other'], ['outside', 'f.outside']].map(function (p) {
      var v0 = S.el('strong'), pc = S.el('span', { cls: 'pc' });
      rows.appendChild(S.el('li', null, [S.el('i', { cls: 'sw', style: 'background:var(--' + p[0] + ')' }), S.el('span', { cls: 'fl-l', text: tr(p[1]) }), v0, pc]));
      return { v: v0, p: pc };
    });
    S.$('hero-label').textContent = tr('hero.label');
    var ml = S.$('hero-mse-label'); if (ml) ml.textContent = tr('hero.mseLabel');
  };
  T.updatePanel = function (i) {
    if (!T.fseg) return;
    var s = S.val('himsSupply', i) || 0, pm = S.val('himsInPoolManager', i) || 0, a = S.val('himsInHimsUsdg', i) || 0, b = S.val('himsInBonerHims', i) || 0;
    var vals = [a, b, Math.max(0, pm - a - b), Math.max(0, s - pm)], tot = vals.reduce(function (p, q) { return p + q; }, 0) || 1;
    vals.forEach(function (v0, k) {
      T.fseg[k].style.flexGrow = v0 / tot;
      T.frow[k].v.textContent = S.fmtHims(v0);
      T.frow[k].p.textContent = S.fmtFixed(v0 / tot * 100, 0) + '%';
    });
    // cost hero
    var up = S.val('pushUp10CostUsdg', i), base = S.val('pushUp10CostUsdg', S.baseI);
    S.$('hero-value').textContent = up == null ? '—' : S.fmtUsdg(up);
    var d = S.$('hero-delta');
    if (up != null && base) {
      var r = up / base, when = S.fmtWdHM(S.baseTs);
      if (S.state.cursorTs < S.baseTs + 30) d.textContent = tr('hero.baseline', { t: when, v: S.fmtUsdg(base) });
      else d.textContent = tr('hero.was', { v: S.fmtUsdg(base), t: when }) + ' · ' +
        (r <= 0.5 ? tr('hero.cheaper', { x: S.fmtFixed(1 / r, 1 / r < 10 ? 1 : 0) }) : (r >= 2 ? tr('hero.dearer', { x: S.fmtFixed(r, 1) }) : S.fmtPct((r - 1) * 100)));
    } else d.textContent = up == null ? tr('ro.nullCost') : '';
    // HAKARI's max safe exposure next to it (a replay), compared with Sun 19:40 once that minute has passed
    var mb = S.$('hero-mse'), ms = S.ser('hakari.maxSafeUsdg');
    if (mb) {
      mb.hidden = !ms;
      if (ms) {
        var mv = ms[i], m0 = ms[S.baseI], md = S.$('hero-mse-delta');
        S.$('hero-mse-value').textContent = mv == null ? '—' : S.fmtUsdg(mv);
        if (mv == null || !m0 || S.state.cursorTs < S.baseTs) md.textContent = '';
        else if (S.state.cursorTs < S.baseTs + 30) md.textContent = tr('hero.baseline', { t: S.fmtWdHM(S.baseTs), v: S.fmtUsdg(m0) });
        else md.textContent = tr('hero.was', { v: S.fmtUsdg(m0), t: S.fmtWdHM(S.baseTs) });
      }
    }
    if (T.heroDot && T.heroX && up != null && T.heroY) {
      var ts = S.state.cursorTs, inV = ts >= S.view.d0 && ts <= S.view.d1;
      T.heroDot.setAttribute('cx', T.heroX(ts).toFixed(1)); T.heroDot.setAttribute('cy', T.heroY(up).toFixed(1));
      T.heroDot.style.display = inV ? '' : 'none';
    }
  };
  // Cost hero sparkline over the current view (log y); rebuilt on domain change only.
  T.renderHeroSpark = function () {
    var host = S.$('hero-spark'); S.clear(host);
    var a = S.ser('pushUp10CostUsdg'); if (!a) return;
    var W = host.clientWidth || 208, H = 40, i0 = S.idx(S.view.d0), i1 = S.idx(S.view.d1);
    var e = S.extent([a], i0, i1, true); if (!e) return;
    if (e[1] / e[0] < 1.5) { e = [e[0] / 1.2, e[1] * 1.2]; }
    var x = S.linear(S.view.d0, S.view.d1, 2, W - 4), y = S.log(e[0], e[1], H - 4, 4);
    var svg = S.svg('svg', { width: W, height: H, 'aria-hidden': 'true' }, host);
    S.svg('path', { d: S.linePath(a, i0, i1, x, y), fill: 'none', stroke: 'var(--hakari)', 'stroke-width': 1.5, 'stroke-linejoin': 'round' }, svg);
    T.heroDot = S.svg('circle', { r: 3.5, fill: 'var(--hakari)', stroke: 'var(--surface-1)', 'stroke-width': 2 }, svg);
    T.heroX = x; T.heroY = y;
  };
})(window.SQZ = window.SQZ || {});
