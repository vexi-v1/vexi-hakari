/* HIMS weekend float squeeze: lane registry, lanes, Moments rug, minimap and time axis.
   Classic script. Attaches to window.SQZ. */
(function (S) {
  'use strict';
  var tr = S.tr;

  /* =====================================================================================
     LANE REGISTRY
     Every time lane on the page (and each lane's legend, readout, tooltip, Numbers table and
     watch hooks) comes from this one ordered array. A future overlay is ONE more entry here;
     nothing else in the page changes.

     Entry fields
       id        stable id: DOM data-lane, #lane-<id>, localStorage key suffix
       group     'price' | 'float' | 'depth' | 'social' | null (a group label is drawn before
                 the first lane of each group)
       after     optional: insert after the lane with this id (used by overlays)
       kind      'chart' (default) | 'events' (the Moments rug, pinned in the sticky block) | 'social'
       when()    render only if true (default: every series key exists in data.json)
       source()  where keys resolve (default window.SQUEEZE_DATA.series)
       title / unit / sub   i18n keys
       height    {desk, tab, phone} plot height in px; phone: 'open' | 'collapsed'
       y         {scale: 'linear'|'log', fixed(): [lo, hi] | 'lane:<id>', fit: 'view'|'always', ticks(scale, h)}
       series[]  {id, kind: 'line'|'band'|'area'|'stack'|'cum'|'step'|'flagStrip', key (dotted path into
                 data.series) or get(i) -> number|null, color (token name without --), width, dash:'nav',
                 opacity, label (i18n key), watch: [story watch keys that light this lane]}
       readout(i) -> [{v, l, color, dash}]   docked readout at the committed cursor (values lead)
       tip(i)     -> same shape, for the hover tooltip (defaults to readout)
       table      {cols: [{h, get(i) -> string}]}  the Numbers view
       marks(ctx), refs(ctx)  extra drawing (NAV line, notable swaps, event glyphs)

     The HAKARI/Vexi settlement read (story.next) will ship as overlay.js
     (window.SQUEEZE_OVERLAY = {version, stepSec: 60, fromTs, n: 4081,
       series: {settlePrice: [], settleGapPct: [], fenced: [0|1]}, method, source})
     loaded with one more classic <script src="overlay.js"> in index.html (and inlined by
     build-web.mjs when present). Its lane is this single entry, pushed onto S.LANES:

       S.LANES.push({ id: 'settle', group: 'price', after: 'price',
         when: function () { return !!(S.OV && S.OV.series && S.OV.series.settlePrice); },
         title: 'lane.settle', unit: 'unit.price', height: {desk: 120, tab: 110, phone: 110}, phone: 'collapsed',
         y: {scale: 'linear', fixed: 'lane:price'},
         series: [
           {id: 'spotGhost', kind: 'line', key: 'himsUsdg.close', color: 'pool-usd', width: 1.25, opacity: .45, label: 's.close'},
           {id: 'settle', kind: 'step', get: function (i) { return S.OV.series.settlePrice[i]; }, color: 'hakari', width: 2, label: 's.settle', watch: ['settlePrice']},
           {id: 'fenced', kind: 'flagStrip', get: function (i) { return S.OV.series.fenced[i]; }, color: 'hakari', label: 's.fenced', watch: ['fenced']}
         ] });

     (plus the three i18n keys). Chapters can then list 'settlePrice' or 'fenced' in watch[].
     ===================================================================================== */
  var NAVK = [0.9, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.5, 4, 5];
  function v(key) { return function (i) { return S.val(key, i); }; }
  function mul(key, k) { return function (i) { var a = S.val(key, i); return a == null ? null : a * k(); }; }
  function nav() { return S.NAV; }
  function band3(i) {
    var pm = S.val('himsInPoolManager', i), a = S.val('himsInHimsUsdg', i), b = S.val('himsInBonerHims', i);
    return pm == null ? null : Math.max(0, pm - (a || 0) - (b || 0));
  }
  function band4(i) { var s = S.val('himsSupply', i), pm = S.val('himsInPoolManager', i); return s == null || pm == null ? null : Math.max(0, s - pm); }
  function prem(i) {
    var p = S.val('himsPremiumPct', i);
    if (p == null) { var c = S.val('himsUsdg.close', i); p = c == null ? null : (c / S.NAV - 1) * 100; }
    return p;
  }
  function fixedExtent(keys, pad) {
    var e = S.extent(keys.map(S.ser), 0, S.N - 1, true);
    return e || [0.001, 1];
  }

  S.LANES = [
    { id: 'moments', kind: 'events', group: null, height: { desk: 36, tab: 34, phone: 32 } },
    {
      id: 'price', group: 'price', title: 'lane.price', unit: 'unit.price', sub: 'sub.price',
      height: { desk: 180, tab: 170, phone: 150 }, phone: 'open', presenterWeight: 1.3,
      y: {
        scale: 'linear',
        fixed: function () {
          var e = S.extent([S.ser('himsUsdg.close')], 0, S.N - 1) || [S.NAV, S.NAV * 2];
          var hi = Math.ceil((e[1] * 1.04) / (S.NAV * 0.25)) * S.NAV * 0.25;
          return [Math.min(S.NAV * 0.9, e[0] * 0.98), hi];
        },
        fitKeys: ['himsUsdg.close'],
        ticks: 'nav'
      },
      series: [
        { id: 'hlBand', kind: 'band', lo: function (i) { var l = S.val('himsUsdg.low', i); return l == null ? S.val('himsUsdg.close', i) : l; },
          hi: function (i) { var h = S.val('himsUsdg.high', i); return h == null ? S.val('himsUsdg.close', i) : h; },
          color: 'pool-usd', opacity: 0.16, label: 's.band', legend: 'rect' },
        { id: 'close', kind: 'line', key: 'himsUsdg.close', color: 'pool-usd', width: 2, label: 's.close', watch: ['himsUsdg', 'himsPremiumPct'] },
        { id: 'nav', kind: 'ref', value: nav, color: 'ref', dash: 'nav', width: 1.5, label: 's.nav' }
      ],
      readout: function (i) {
        var c = S.val('himsUsdg.close', i), lo = S.val('himsUsdg.low', i), hi = S.val('himsUsdg.high', i), n = S.val('swapsHimsUsdg', i);
        var out = [{ v: S.fmtUsdg2(c), l: 'USDG', color: 'pool-usd' }, { v: S.fmtPct(prem(i)), l: tr('s.premium') }];
        if (n) { if (lo != null && hi != null) out.push({ v: S.fmtUsdg2(lo) + '–' + S.fmtUsdg2(hi), l: tr('s.band') }); out.push({ l: tr('ro.swaps', { n: S.fmtInt(n) }) }); }
        else out.push({ l: tr('ro.noswap') });
        return out;
      },
      table: { cols: [
        { h: 's.close', get: function (i) { return S.fmtUsdg2(S.val('himsUsdg.close', i)); } },
        { h: 's.premium', get: function (i) { return S.fmtPct(prem(i)); } },
        { h: 'High', hz: '高', get: function (i) { return S.fmtUsdg2(S.val('himsUsdg.high', i)); } },
        { h: 'Low', hz: '低', get: function (i) { return S.fmtUsdg2(S.val('himsUsdg.low', i)); } },
        { h: 's.swaps', get: function (i) { return S.fmtInt(S.val('swapsHimsUsdg', i)); } }
      ] },
      spark: 'himsUsdg.close'
    },
    {
      id: 'boner', group: 'price', title: 'lane.boner', unit: 'unit.boner', sub: 'sub.boner',
      height: { desk: 140, tab: 130, phone: 130 }, phone: 'collapsed',
      y: { scale: 'log', fixed: function () { var e = fixedExtent(['bonerUsdgViaHims', 'bonerUsdAtNav', 'bonerUsdgDirect.close']); return [S.floor125(e[0]), S.ceil125(e[1])]; },
        fitKeys: ['bonerUsdgViaHims', 'bonerUsdAtNav', 'bonerUsdgDirect.close'] },
      series: [
        { id: 'via', kind: 'line', key: 'bonerUsdgViaHims', color: 'pool-boner', width: 2, label: 's.via', end: 'e.via', z: 3, watch: ['bonerUsdgViaHims', 'bonerHims'] },
        { id: 'atNav', kind: 'line', key: 'bonerUsdAtNav', color: 'ref', dash: 'nav', width: 1.5, label: 's.atNav', end: 'e.atNav', z: 1, watch: ['bonerUsdAtNav'] },
        { id: 'direct', kind: 'line', key: 'bonerUsdgDirect.close', color: 'pool-direct', width: 1.75, label: 's.direct', end: 'e.direct', z: 2, watch: ['bonerUsdgDirect', 'routeGapPct'] }
      ],
      readout: function (i) {
        var via = S.val('bonerUsdgViaHims', i), at = S.val('bonerUsdAtNav', i), gap = S.val('routeGapPct', i);
        var out = [
          { v: S.fmtSig(via, 3), l: tr('s.via'), color: 'pool-boner' },
          { v: S.fmtSig(at, 3), l: tr('s.atNav'), dash: true },
          { v: S.fmtSig(S.val('bonerUsdgDirect.close', i), 3), l: tr('s.direct'), color: 'pool-direct' },
          { v: S.fmtPct(gap), l: tr('s.routeGap') }
        ];
        if (via && at) out.push({ l: tr('ro.premiumInside', { p: S.fmtPct((1 - at / via) * 100).replace('+', '') }) });
        return out;
      },
      table: { cols: [
        { h: 's.via', get: function (i) { return S.fmtSig(S.val('bonerUsdgViaHims', i), 3); } },
        { h: 's.atNav', get: function (i) { return S.fmtSig(S.val('bonerUsdAtNav', i), 3); } },
        { h: 's.direct', get: function (i) { return S.fmtSig(S.val('bonerUsdgDirect.close', i), 3); } },
        { h: 's.bonerHims', get: function (i) { return S.fmtSig(S.val('bonerHims.close', i), 3); } },
        { h: 's.routeGap', get: function (i) { return S.fmtPct(S.val('routeGapPct', i)); } }
      ] },
      spark: 'bonerUsdgViaHims'
    },
    {
      id: 'float', group: 'float', title: 'lane.float', unit: 'unit.float', sub: 'sub.float',
      height: { desk: 170, tab: 160, phone: 140 }, phone: 'open',
      y: { scale: 'linear', fixed: function () { var e = S.extent([S.ser('himsSupply')], 0, S.N - 1) || [0, 1]; return [0, S.niceCeil(e[1] * 1.04)]; }, fitKeys: ['himsSupply'], zero: true },
      series: [
        { id: 'stack', kind: 'stack', layers: [
          { id: 'b1', get: v('himsInHimsUsdg'), fill: 'pool-usd-fill', edge: 'pool-usd', label: 's.bandUsd', watch: ['himsInHimsUsdg'] },
          { id: 'b2', get: v('himsInBonerHims'), fill: 'pool-boner-fill', edge: 'pool-boner', label: 's.bandBoner', watch: ['himsInBonerHims'] },
          { id: 'b3', get: band3, fill: 'other-v4', label: 's.otherV4', watch: ['himsInPoolManager'] },
          { id: 'b4', get: band4, fill: 'outside', label: 's.outside' }
        ] },
        { id: 'supply', kind: 'line', key: 'himsSupply', color: 'text-primary', width: 1.5, label: 's.supply', watch: ['himsSupply', 'himsMinted', 'himsBurned'] }
      ],
      readout: function (i) {
        var s = S.val('himsSupply', i), a = S.val('himsInHimsUsdg', i), b = S.val('himsInBonerHims', i);
        function pc(x) { return s ? ' · ' + S.fmtFixed(x / s * 100, 0) + '%' : ''; }
        return [
          { v: S.fmtSupply(s), l: tr('s.supply'), color: 'text-primary' },
          { v: S.fmtHims(b) + pc(b), l: tr('s.bandBoner'), color: 'pool-boner' },
          { v: S.fmtHims(a) + pc(a), l: tr('s.bandUsd'), color: 'pool-usd' }
        ];
      },
      tip: function (i) {
        var s = S.val('himsSupply', i);
        return [
          { v: S.fmtSupply(s), l: tr('s.supply'), color: 'text-primary' },
          { v: S.fmtHims(band4(i)), l: tr('s.outside'), color: 'outside', rect: true },
          { v: S.fmtHims(band3(i)), l: tr('s.otherV4'), color: 'other-v4', rect: true },
          { v: S.fmtHims(S.val('himsInBonerHims', i)), l: tr('s.bandBoner'), color: 'pool-boner' },
          { v: S.fmtHims(S.val('himsInHimsUsdg', i)), l: tr('s.bandUsd'), color: 'pool-usd' }
        ];
      },
      table: { cols: [
        { h: 's.supply', get: function (i) { return S.fmtSupply(S.val('himsSupply', i)); } },
        { h: 's.bandUsd', get: function (i) { return S.fmtHims(S.val('himsInHimsUsdg', i)); } },
        { h: 's.bandBoner', get: function (i) { return S.fmtHims(S.val('himsInBonerHims', i)); } },
        { h: 's.otherV4', get: function (i) { return S.fmtHims(band3(i)); } },
        { h: 's.outside', get: function (i) { return S.fmtHims(band4(i)); } }
      ] },
      spark: 'himsInBonerHims'
    },
    {
      id: 'route', group: 'float', title: 'lane.route', unit: 'unit.route', sub: 'sub.route',
      height: { desk: 100, tab: 100, phone: 100 }, phone: 'collapsed',
      y: { scale: 'linear', fit: 'always', zero: true },
      series: [
        { id: 'out', kind: 'cum', key: 'netHimsOutOfHimsUsdg', color: 'pool-usd', width: 2, label: 's.out', end: 'e.out', watch: ['volUsdgHimsUsdg'] },
        { id: 'into', kind: 'cum', key: 'netHimsIntoBonerHims', color: 'pool-boner', width: 2, label: 's.into', end: 'e.into', watch: ['volHimsBonerHims'] }
      ],
      readout: function (i) {
        var i0 = S.idx(S.view.d0) + 1;
        var o = S.sumRange('netHimsOutOfHimsUsdg', i0, i), n = S.sumRange('netHimsIntoBonerHims', i0, i);
        var out = [{ v: S.fmtHims(o), l: tr('s.out'), color: 'pool-usd' }, { v: S.fmtHims(n), l: tr('s.into'), color: 'pool-boner' }];
        if (o > 10 && n != null) out.push({ l: tr('ro.matched', { p: S.fmtFixed(n / o * 100, 0) + '%' }) });
        out.push({ l: tr('ro.since', { t: S.fmtHM(S.view.d0) }) });
        return out;
      },
      table: { cols: [
        { h: 's.out', get: function (i) { return S.fmtHims(S.sumRange('netHimsOutOfHimsUsdg', S.idx(S.view.d0) + 1, i)); } },
        { h: 's.into', get: function (i) { return S.fmtHims(S.sumRange('netHimsIntoBonerHims', S.idx(S.view.d0) + 1, i)); } },
        { h: 'USDG traded (min)', hz: '成交 USDG（每分）', get: function (i) { return S.fmtUsdg(S.val('volUsdgHimsUsdg', i)); } },
        { h: 'HIMS traded in BONER pool (min)', hz: 'BONER 池成交 HIMS（每分）', get: function (i) { return S.fmtHims(S.val('volHimsBonerHims', i)); } }
      ] },
      spark: null
    },
    {
      id: 'inventory', group: 'depth', title: 'lane.inventory', unit: 'unit.inventory', sub: 'sub.inventory',
      height: { desk: 120, tab: 110, phone: 110 }, phone: 'collapsed',
      y: { scale: 'linear', fixed: function () {
        var a = S.extent([S.ser('usdgInHimsUsdg')], 0, S.N - 1) || [0, 1], b = S.extent([S.ser('himsInHimsUsdg')], 0, S.N - 1) || [0, 1];
        return [0, S.niceCeil(Math.max(a[1], b[1] * S.NAV) * 1.05)]; }, fitKeys: ['usdgInHimsUsdg'], zero: true },
      series: [
        { id: 'himsSide', kind: 'area', get: mul('himsInHimsUsdg', nav), color: 'pool-usd', width: 2, opacity: 0.1, label: 's.himsSide', end: 'hims', watch: ['himsInHimsUsdg'] },
        { id: 'usdgSide', kind: 'line', key: 'usdgInHimsUsdg', color: 'ref', width: 1.5, label: 's.usdgSide', end: 'usdg', watch: ['usdgInHimsUsdg'] }
      ],
      readout: function (i) {
        var h = S.val('himsInHimsUsdg', i), u = S.val('usdgInHimsUsdg', i);
        var out = [{ v: S.fmtHims(h) + ' HIMS', l: tr('s.himsSide'), color: 'pool-usd' }, { v: S.fmtUsdg(u) + ' USDG', l: tr('s.usdgSide'), color: 'ref' }];
        if (h != null && u) out.push({ l: tr('ro.share', { p: S.fmtFixed(h * S.NAV / (h * S.NAV + u) * 100, 1) + '%' }) });
        return out;
      },
      table: { cols: [
        { h: 'HIMS', get: function (i) { return S.fmtHims(S.val('himsInHimsUsdg', i)); } },
        { h: 'HIMS × 28.84', get: function (i) { var h = S.val('himsInHimsUsdg', i); return S.fmtUsdg(h == null ? null : h * S.NAV); } },
        { h: 'USDG', get: function (i) { return S.fmtUsdg(S.val('usdgInHimsUsdg', i)); } }
      ] },
      spark: 'himsInHimsUsdg'
    },
    {
      id: 'cost', group: 'depth', title: 'lane.cost', unit: 'unit.cost', sub: 'sub.cost',
      height: { desk: 130, tab: 120, phone: 110 }, phone: 'open',
      y: { scale: 'log', fixed: function () { var e = fixedExtent(['pushUp10CostUsdg', 'pushDown10CostUsdg']); return [S.floor125(e[0]), S.ceil125(e[1])]; },
        fitKeys: ['pushUp10CostUsdg', 'pushDown10CostUsdg'] },
      series: [
        { id: 'up', kind: 'line', key: 'pushUp10CostUsdg', color: 'hakari', width: 2, label: 's.up', end: 'e.up', z: 2, watch: ['pushUp10CostUsdg'] },
        { id: 'down', kind: 'line', key: 'pushDown10CostUsdg', color: 'ref', width: 1.5, label: 's.down', end: 'e.down', z: 1 }
      ],
      readout: function (i) {
        var up = S.val('pushUp10CostUsdg', i), cap = S.val('pushUp10CapitalUsdg', i);
        var out = [{ v: up == null ? '—' : S.fmtUsdg(up) + ' USDG', l: up == null ? tr('ro.nullCost') : tr('s.up'), color: 'hakari' }];
        if (cap != null) out.push({ l: tr('ro.capital', { v: S.fmtUsdg(cap) }) });
        out.push({ v: S.fmtUsdg(S.val('pushDown10CostUsdg', i)) + ' USDG', l: tr('s.down'), color: 'ref' });
        return out;
      },
      table: { cols: [
        { h: 's.up', get: function (i) { return S.fmtUsdg(S.val('pushUp10CostUsdg', i)); } },
        { h: 's.capital', get: function (i) { return S.fmtUsdg(S.val('pushUp10CapitalUsdg', i)); } },
        { h: 's.down', get: function (i) { return S.fmtUsdg(S.val('pushDown10CostUsdg', i)); } }
      ] },
      spark: 'pushUp10CostUsdg'
    },
    { id: 'social', kind: 'social', group: 'social', title: 'lane.social', unit: 'unit.social',
      height: { desk: 48, tab: 48, phone: 48 }, phone: 'open',
      when: function () { return !!(S.SO && (Array.isArray(S.SO.hourly) || Array.isArray(S.SO.posts))); } }
  ];

  // Watch key -> lane id (the chapter card lights these lanes with "in this chapter").
  S.laneWatch = function (L) {
    var keys = [];
    (L.series || []).forEach(function (s) { (s.watch || []).forEach(function (k) { keys.push(k); }); (s.layers || []).forEach(function (l) { (l.watch || []).forEach(function (k) { keys.push(k); }); }); });
    return keys;
  };

  // ---------- layout ----------
  S.dims = function () {
    var w = document.documentElement.clientWidth;
    var mode = w >= 1180 ? 'desk' : (w >= 720 ? 'tab' : 'phone');
    var m = mode === 'desk' ? { l: 72, r: 88, t: 10, b: 6 } : (mode === 'tab' ? { l: 64, r: 72, t: 10, b: 6 } : { l: 44, r: 12, t: 8, b: 6 });
    return { mode: mode, m: m, w: w };
  };
  S.laneH = function (L) {
    if (S.presH && S.presH[L.def.id]) return S.presH[L.def.id];
    return L.def.height[S.layout.mode];
  };

  // ---------- build DOM for all lanes ----------
  S.lanes = [];
  S.buildLanes = function () {
    var host = S.$('lanes'), sticky = S.$('moments-host');
    S.clear(host); S.clear(sticky);
    var defs = [];
    S.LANES.forEach(function (d) {
      var ok = d.when ? d.when() : (d.series || []).every(function (s) { return !s.key || !!S.ser(s.key); });
      if (d.when && !ok) return;
      d._missing = !ok ? (d.series || []).filter(function (s) { return s.key && !S.ser(s.key); }).map(function (s) { return s.key; }) : null;
      if (d.after) { var at = defs.map(function (x) { return x.id; }).indexOf(d.after); if (at >= 0) { defs.splice(at + 1, 0, d); return; } }
      defs.push(d);
    });
    var saved = S.store.getJSON('lanes') || {};
    var lastGroup = null;
    S.lanes = defs.map(function (d) {
      var L = { def: d, id: d.id };
      if (d.kind === 'events') { buildMoments(L, sticky); return L; }
      if (d.group && d.group !== lastGroup) {
        host.appendChild(S.el('div', { cls: 'group-label', 'data-group': d.group, 'data-i18n': 'group.' + d.group }));
        lastGroup = d.group;
      }
      var sec = S.el('section', { cls: 'lane', id: 'lane-' + d.id, 'data-lane': d.id, 'aria-labelledby': 'lt-' + d.id });
      var head = S.el('div', { cls: 'lane-head' });
      var main = S.el('div', { cls: 'lh-main' });
      L.watchDot = S.el('span', { cls: 'watch-dot', 'aria-hidden': 'true', hidden: true });
      L.titleEl = S.el('h3', { cls: 'lane-title', id: 'lt-' + d.id });
      L.unitEl = S.el('span', { cls: 'lane-unit' });
      L.watchTag = S.el('span', { cls: 'watch-tag', hidden: true });
      S.append(main, [L.watchDot, L.titleEl, L.unitEl, L.watchTag]);
      L.readoutEl = S.el('div', { cls: 'lane-readout' });
      var tools = S.el('div', { cls: 'lh-tools' });
      if (d.kind !== 'social') {
        L.numBtn = S.el('button', { cls: 'tool', id: 'num-' + d.id, type: 'button', 'aria-pressed': 'false' });
        L.numBtn.addEventListener('click', function () { S.toggleNumbers(L); });
        tools.appendChild(L.numBtn);
      }
      L.colBtn = S.el('button', { cls: 'tool col-btn', id: 'col-' + d.id, type: 'button', 'aria-controls': 'plot-' + d.id });
      L.colBtn.addEventListener('click', function () { L.collapsed = !L.isCollapsed; saveLaneState(); applyCollapsed(L); S.renderLane(L); S.updateLaneCursor(L); });
      tools.appendChild(L.colBtn);
      S.append(head, [main, tools, L.readoutEl]);
      var meta = S.el('div', { cls: 'lane-meta' });
      L.legendEl = S.el('div', { cls: 'lane-legend' });
      L.subEl = S.el('p', { cls: 'lane-sub' });
      S.append(meta, [L.legendEl, L.subEl]);
      L.metaEl = meta;
      L.sparkEl = S.el('div', { cls: 'lane-spark', 'aria-hidden': 'true', hidden: true });
      L.plotEl = S.el('div', { cls: 'lane-plot', id: 'plot-' + d.id });
      L.svgEl = S.svg('svg', { cls: 'plot-svg', role: 'img' });
      L.plotEl.appendChild(L.svgEl);
      L.cursorEl = S.el('div', { cls: 'cursor-rule', 'aria-hidden': 'true' });
      L.hoverEl = S.el('div', { cls: 'hover-rule', 'aria-hidden': 'true', hidden: true });
      S.append(L.plotEl, [L.hoverEl, L.cursorEl]);
      L.tableEl = S.el('div', { cls: 'lane-table', hidden: true });
      S.append(sec, [head, meta, L.sparkEl, L.plotEl, L.tableEl]);
      host.appendChild(sec);
      L.root = sec;
      var st = saved[d.id] || {};
      L.numbersOpen = !!st.n;
      L.collapsed = st.c != null ? !!st.c : null;
      attachPlotPointer(L, L.plotEl);
      return L;
    });
    S.lanesById = {};
    S.lanes.forEach(function (L) { S.lanesById[L.id] = L; });
  };
  function saveLaneState() {
    var o = {};
    S.lanes.forEach(function (L) { if (L.def.kind === 'events') return; o[L.id] = { n: L.numbersOpen ? 1 : 0, c: L.collapsed != null ? (L.collapsed ? 1 : 0) : null }; });
    S.store.setJSON('lanes', o);
  }
  function isCollapsed(L) {
    if (S.state.presenting) return false;
    if (S.layout.mode !== 'phone') return false;
    if (L.collapsed != null) return L.collapsed;
    return L.def.phone === 'collapsed';
  }
  function applyCollapsed(L) {
    if (!L.root) return;
    var c = isCollapsed(L);
    L.isCollapsed = c;
    L.root.classList.toggle('collapsed', c);
    L.colBtn.hidden = S.layout.mode !== 'phone';
    L.colBtn.setAttribute('aria-expanded', c ? 'false' : 'true');
    L.colBtn.setAttribute('aria-label', tr(c ? 'expand' : 'collapse'));
    L.colBtn.textContent = c ? '▸' : '▾';
    L.sparkEl.hidden = !c || !L.def.spark;
    L.plotEl.hidden = c || !!L.numbersOpen;
    L.tableEl.hidden = c || !L.numbersOpen;
    if (L.metaEl) L.metaEl.hidden = c;
  }
  S.applyCollapsedAll = function () { S.lanes.forEach(function (L) { if (L.def.kind !== 'events') applyCollapsed(L); }); };

  // ---------- text (language) ----------
  S.laneTexts = function () {
    S.lanes.forEach(function (L) {
      var d = L.def;
      if (d.kind === 'events') { if (L.labelEl) L.labelEl.textContent = tr('mo.label'); return; }
      L.titleEl.textContent = tr(d.title);
      L.unitEl.textContent = tr(d.unit);
      L.watchTag.textContent = tr('inThisChapter');
      if (L.numBtn) { L.numBtn.textContent = L.numbersOpen ? tr('chart') : tr('numbers'); }
      var sub = d.sub ? tr(d.sub, { t: S.fmtHM(S.view ? S.view.d0 : S.W0) }) : '';
      if (d._missing && d._missing.length) sub = tr('err.series', { k: d._missing.join(', ') });
      L.subEl.textContent = sub;
      S.clear(L.legendEl);
      (d.series || []).forEach(function (s) {
        if (s.kind === 'stack') {
          s.layers.forEach(function (l) { L.legendEl.appendChild(S.el('span', { cls: 'lg' }, [S.el('i', { cls: 'key-rect', style: 'background:var(--' + l.fill + ')' }), tr(l.label)])); });
          return;
        }
        var k = s.legend === 'rect' ? S.el('i', { cls: 'key-rect', style: 'background:var(--' + s.color + ');opacity:.35' })
          : S.el('i', { cls: 'key-line' + (s.dash ? ' dash' : ''), style: s.dash ? null : 'background:var(--' + s.color + ')' });
        L.legendEl.appendChild(S.el('span', { cls: 'lg' }, [k, tr(s.label)]));
      });
      if (d.kind === 'social') S.socialLegend(L);
    });
    S.$$('.group-label').forEach(function (g) { g.textContent = tr(g.getAttribute('data-i18n')); });
  };
  S.$$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  // ---------- y scale per lane ----------
  function yScale(L, i0, i1, h, top) {
    var d = L.def, y = d.y, lo, hi;
    var fit = y.fit === 'always' || S.state.yMode === 'fit';
    if (y.fixed === 'lane:price' || (typeof y.fixed === 'string' && y.fixed.indexOf('lane:') === 0)) {
      var other = S.lanesById[y.fixed.slice(5)]; if (other && other.y) return S.linear(other.y.d[0], other.y.d[1], top + h, top);
    }
    if (d.id === 'route') {
      var e0 = cumExtent(L, i0, i1); lo = Math.min(0, e0[0]); hi = Math.max(0, e0[1]);
      var pad = (hi - lo) * 0.1 || 1; lo -= lo < 0 ? pad : 0; hi += pad;
    } else if (fit && y.fitKeys) {
      var e = S.extent(y.fitKeys.map(S.ser), i0, i1, y.scale === 'log');
      if (!e) e = y.fixed();
      if (y.scale === 'log') { lo = S.floor125(e[0]); hi = S.ceil125(e[1]); if (hi / lo < 2.5) { lo = e[0] / 1.15; hi = e[1] * 1.15; } }
      else { var p = (e[1] - e[0]) * 0.08 || e[1] * 0.05 || 1; lo = y.zero ? 0 : e[0] - p; hi = e[1] + p; }
    } else { var f = y.fixed(); lo = f[0]; hi = f[1]; }
    return y.scale === 'log' ? S.log(lo, hi, top + h, top) : S.linear(lo, hi, top + h, top);
  }
  function cumExtent(L, i0, i1) {
    var lo = 0, hi = 0;
    L.def.series.forEach(function (s) {
      var a = S.ser(s.key), acc = 0; if (!a) return;
      for (var i = i0 + 1; i <= i1; i++) { acc += a[i] || 0; if (acc < lo) lo = acc; if (acc > hi) hi = acc; }
    });
    return [lo, hi];
  }
  function yTicks(L, y, h) {
    var d = L.def, out = [], dm = y.d, phone = S.layout.mode === 'phone';
    if (d.y.ticks === 'nav') {
      var ks = NAVK.filter(function (k) { var v0 = k * S.NAV; return v0 >= dm[0] - 1e-9 && v0 <= dm[1] + 1e-9; });
      var minGap = 20;
      if (ks.length >= 3) {
        var kept = [], lastY = null;
        ks.forEach(function (k) { var yy = y(k * S.NAV); if (lastY == null || Math.abs(lastY - yy) >= minGap || k === 1) { if (lastY != null && Math.abs(lastY - yy) < minGap && kept.length) kept.pop(); kept.push(k); lastY = yy; } });
        return kept.map(function (k) {
          var val = k * S.NAV;
          return { v: val, a: S.fmtUsdg2(val), b: phone ? null : (k === 1 ? 'NAV' : S.fmtPct((k - 1) * 100)), nav: k === 1 };
        });
      }
      return S.linTicks(dm[0], dm[1], Math.max(2, Math.floor(h / 36))).map(function (val) { return { v: val, a: S.fmtUsdg2(val), b: phone ? null : S.fmtPct((val / S.NAV - 1) * 100) }; });
    }
    if (d.y.scale === 'log') {
      var t = S.ticks125(dm[0], dm[1]);
      if (t.length > Math.max(3, Math.floor(h / 22))) t = S.ticks125(dm[0], dm[1], 1);
      return t.map(function (val) { return { v: val, a: fmtTick(d, val) }; });
    }
    var n = Math.max(2, Math.floor(h / (phone ? 40 : 30)));
    return S.linTicks(dm[0], dm[1], n).map(function (val) { return { v: val, a: fmtTick(d, val) }; });
  }
  function fmtTick(d, val) {
    if (d.id === 'boner') return S.fmtSig(val, 1);
    if (d.id === 'cost' || d.id === 'inventory' || d.id === 'float') return S.fmtCompact(val);
    return S.fmtCompact(val);
  }

  // ---------- render one chart lane (domain / resize / yMode / language) ----------
  S.renderLane = function (L) {
    if (L.def.kind === 'events') return renderMoments(L);
    if (L.def.kind === 'social') { if (!L.isCollapsed) S.renderSocial(L); return; }
    if (L.isCollapsed) { renderSpark(L); return; }
    if (L.numbersOpen) { S.renderTable(L); }
    if (L.plotEl.hidden) return;
    var d = L.def, svg = L.svgEl, m = S.layout.m;
    var W = L.plotEl.clientWidth || S.laneWidth || 600, h = S.laneH(L), H = h + m.t + m.b;
    S.clear(svg);
    svg.setAttribute('width', W); svg.setAttribute('height', H); svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    L.plotEl.style.height = H + 'px';
    if (d._missing && d._missing.length) { svg.setAttribute('height', 40); L.plotEl.style.height = '40px'; return; }
    var x = S.xs, i0 = Math.max(0, S.idx(S.view.d0) - 1), i1 = Math.min(S.N - 1, S.idx(S.view.d1) + 1);
    var y = yScale(L, i0, i1, h, m.t);
    L.y = y; L.W = W; L.H = H;
    var clipId = 'clip-' + d.id;
    var defs = S.svg('defs', null, svg);
    var cp = S.svg('clipPath', { id: clipId }, defs);
    S.svg('rect', { x: m.l, y: m.t - 1, width: Math.max(0, W - m.l - m.r), height: h + 2 }, cp);
    drawBackground(svg, x, m.t, h, W, m);
    // grid
    var g = S.svg('g', { cls: 'grid' }, svg);
    S.timeTicks(S.view.d0, S.view.d1, W - m.l - m.r).ticks.forEach(function (t) { var xx = Math.round(x(t)) + 0.5; S.svg('line', { x1: xx, x2: xx, y1: m.t, y2: m.t + h }, g); });
    var ticks = yTicks(L, y, h), ax = S.svg('g', { cls: 'yaxis' }, svg);
    ticks.forEach(function (tk) {
      var yy = Math.round(y(tk.v)) + 0.5;
      if (!tk.nav) S.svg('line', { x1: m.l, x2: W - m.r, y1: yy, y2: yy }, g);
      var tx = S.svg('text', { x: m.l - 8, y: tk.b ? yy - 1 : yy + 4, 'text-anchor': 'end' }, ax);
      tx.textContent = tk.a;
      if (tk.b) { var t2 = S.svg('text', { x: m.l - 8, y: yy + 10, 'text-anchor': 'end', cls: 'sub' }, ax); t2.textContent = tk.b; }
    });
    if (d.y.zero && y.d[0] < 0) { var zy = Math.round(y(0)) + 0.5; S.svg('line', { cls: 'zero', x1: m.l, x2: W - m.r, y1: zy, y2: zy }, svg); }
    if (d.id === 'route') { var zr = Math.round(y(0)) + 0.5; S.svg('line', { cls: 'zero', x1: m.l, x2: W - m.r, y1: zr, y2: zr }, svg); }
    drawEventVerticals(svg, x, m.t, h, m, W);
    var sg = S.svg('g', { 'clip-path': 'url(#' + clipId + ')' }, svg);
    var ends = [];
    d.series.slice().sort(function (a, b) { return (a.z || 0) - (b.z || 0); }).forEach(function (s) { drawSeries(L, s, sg, x, y, i0, i1, h, m, ends); });
    drawMarks(L, svg, sg, x, y, i0, i1, h, m, W);
    if (S.layout.mode !== 'phone') drawEndLabels(svg, ends, W, m, h);
    svg.setAttribute('aria-label', tr(d.title) + '. ' + tr(d.unit) + '.');
  };

  function drawBackground(svg, x, top, h, W, m) {
    var g = S.svg('g', { cls: 'bg' }, svg);
    function band(a, b, cls) {
      if (a == null || b == null) return;
      var x0 = S.clamp(x(a), m.l, W - m.r), x1 = S.clamp(x(b), m.l, W - m.r);
      if (x1 - x0 < 0.5) return;
      S.svg('rect', { cls: cls, x: x0, y: top, width: x1 - x0, height: h }, g);
      return [x0, x1];
    }
    var f = band(S.fenceFrom, S.fenceTo, 'fence');
    band(S.reopenTs, S.firstMintTs, 'fence-soft');
    if (f) S.svg('line', { cls: 'rail', x1: f[0], x2: f[1], y1: top - 1, y2: top - 1 }, g);
  }
  function drawEventVerticals(svg, x, top, h, m, W) {
    var g = S.svg('g', { cls: 'evv' }, svg);
    [S.nyseCloseTs, S.reopenTs, S.firstMintTs, S.nyseOpenTs].forEach(function (t) {
      if (t == null || t < S.view.d0 || t > S.view.d1) return;
      var xx = Math.round(x(t)) + 0.5;
      S.svg('line', { x1: xx, x2: xx, y1: top, y2: top + h }, g);
    });
  }
  S.seriesArr = function (s) {
    if (s._arr) return s._arr;
    if (s.key) return (s._arr = S.ser(s.key));
    if (s.get) { var a = new Array(S.N); for (var i = 0; i < S.N; i++) a[i] = s.get(i); return (s._arr = a); }
    return null;
  };
  function drawSeries(L, s, g, x, y, i0, i1, h, m, ends) {
    var stroke = 'var(--' + s.color + ')';
    if (s.kind === 'ref') {
      var val = s.value(); if (val < y.d[0] || val > y.d[1]) return;
      var yy = y(val);
      S.svg('line', { cls: 'ref-line', x1: m.l, x2: L.W - m.r, y1: yy, y2: yy }, g);
      var lab = S.svg('text', { cls: 'halo ref-label', x: m.l + 6, y: yy - 5 }, g);
      lab.textContent = tr(s.label);
      return;
    }
    if (s.kind === 'band') {
      var dp = S.bandPath(s.lo, s.hi, i0, i1, x, y);
      S.svg('path', { d: dp, fill: stroke, 'fill-opacity': s.opacity, stroke: 'none' }, g);
      return;
    }
    if (s.kind === 'stack') { drawStack(L, s, g, x, y, i0, i1, m); return; }
    var arr;
    if (s.kind === 'cum') {
      var src = S.ser(s.key); if (!src) return;
      arr = new Array(S.N); var acc = 0;
      for (var i = 0; i < S.N; i++) { if (i <= i0) { arr[i] = i === i0 ? 0 : null; continue; } acc += src[i] || 0; arr[i] = acc; }
    } else arr = S.seriesArr(s);
    if (!arr) return;
    var path = S.linePath(arr, i0, i1, x, y);
    if (s.kind === 'area' && path) {
      var y0 = y(Math.max(y.d[0], 0));
      var area = S.bandPath(function () { return y.d[0] > 0 ? y.d[0] : 0; }, function (i) { return arr[i]; }, i0, i1, x, y);
      S.svg('path', { d: area, fill: stroke, 'fill-opacity': s.opacity || 0.1, stroke: 'none' }, g);
      void y0;
    }
    var attrs = { d: path, fill: 'none', stroke: stroke, 'stroke-width': s.width || 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' };
    if (s.dash) attrs['stroke-dasharray'] = '4 3';
    if (s.opacity && s.kind !== 'area') attrs['stroke-opacity'] = s.opacity;
    S.svg('path', attrs, g);
    if (s.end) {
      var j = Math.min(i1, S.idx(S.view.d1)); while (j > i0 && arr[j] == null) j--;
      if (arr[j] != null && isFinite(y(arr[j]))) {
        var txt = typeof s.end === 'string' && s.end.indexOf('e.') === 0 ? tr(s.end) : tr(s.label);
        if (s.end === 'hims') txt = S.fmtHims(S.val('himsInHimsUsdg', j)) + ' HIMS';
        else if (s.end === 'usdg') txt = S.fmtUsdg(arr[j]) + ' USDG';
        ends.push({ y: y(arr[j]), text: txt, color: s.color, dash: s.dash });
      }
    }
  }
  function drawStack(L, s, g, x, y, i0, i1, m) {
    var layers = s.layers, base = new Array(S.N);
    for (var i = i0; i <= i1; i++) base[i] = 0;
    var tops = [];
    layers.forEach(function (l) {
      var b0 = base.slice(), t = new Array(S.N);
      for (var k = i0; k <= i1; k++) { var v0 = l.get(k); t[k] = v0 == null ? null : b0[k] + v0; base[k] = t[k] == null ? b0[k] : t[k]; }
      var p = S.bandPath(function (k) { return t[k] == null ? null : b0[k]; }, function (k) { return t[k]; }, i0, i1, x, y);
      S.svg('path', { d: p, fill: 'var(--' + l.fill + ')', stroke: 'var(--surface-1)', 'stroke-width': 1, 'paint-order': 'stroke' }, g);
      tops.push({ l: l, t: t, b: b0 });
    });
    tops.forEach(function (o) {
      if (!o.l.edge) return;
      S.svg('path', { d: S.linePath(o.t, i0, i1, x, y), fill: 'none', stroke: 'var(--' + o.l.edge + ')', 'stroke-width': 1.5 }, g);
    });
    // direct labels inside bands at the view's right edge, when the band is >= 16 px tall there
    var j = Math.min(i1, S.idx(S.view.d1)), lx = L.W - m.r - 6;
    tops.forEach(function (o) {
      var t = o.t[j], b = o.b[j]; if (t == null || b == null) return;
      var hpx = y(b) - y(t); if (hpx < 16) return;
      var sup = S.val('himsSupply', j);
      var txt = tr(o.l.label) + ' ' + S.fmtHims(t - b) + (sup ? ' · ' + S.fmtFixed((t - b) / sup * 100, 0) + '%' : '');
      var te = S.svg('text', { cls: 'halo band-label', x: lx, y: (y(t) + y(b)) / 2 + 4, 'text-anchor': 'end' }, g);
      te.textContent = txt;
    });
  }
  function drawEndLabels(svg, ends, W, m, h) {
    if (!ends.length) return;
    ends.sort(function (a, b) { return a.y - b.y; });
    var minY = m.t + 4, maxY = m.t + h;
    for (var k = 0; k < ends.length; k++) { ends[k].ly = S.clamp(ends[k].y, minY, maxY); if (k && ends[k].ly - ends[k - 1].ly < 12) ends[k].ly = ends[k - 1].ly + 12; }
    var over = ends[ends.length - 1].ly - maxY;
    if (over > 0) for (var q = ends.length - 1; q >= 0; q--) { ends[q].ly -= over; if (q && ends[q].ly - ends[q - 1].ly >= 12) break; }
    var g = S.svg('g', { cls: 'end-labels' }, svg), x0 = W - m.r;
    ends.forEach(function (e) {
      if (Math.abs(e.ly - e.y) > 2) S.svg('path', { cls: 'leader', d: 'M' + (x0 + 1) + ',' + e.y.toFixed(1) + 'L' + (x0 + 5) + ',' + e.ly.toFixed(1) }, g);
      var t = S.svg('text', { x: x0 + 7, y: e.ly + 4 }, g);
      t.textContent = e.text;
    });
    // end labels are truncated to the margin width by the SVG's own bounds; a <title> keeps the full text
  }

  // Marks: notable swaps, peak, off-scale highs, burns and mints, the fence bracket, cost labels.
  function drawMarks(L, svg, sg, x, y, i0, i1, h, m, W) {
    var id = L.def.id, g = S.svg('g', { cls: 'marks' }, svg), inView = function (t) { return t >= S.view.d0 && t <= S.view.d1; };
    if (id === 'price') {
      (S.D.notableSwaps || []).forEach(function (s) {
        var pool = s.pool || s.poolRole; if (pool && pool !== 'himsUsdg') return;
        var p = s.priceAfter != null ? s.priceAfter : (s.usdgPerHims != null ? s.usdgPerHims : s.price);
        if (!S.isNum(p) || !inView(s.ts) || p > y.d[1] || p < y.d[0]) return;
        var xx = x(s.ts), yy = y(p);
        S.svg('path', { cls: 'glyph ring', d: 'M' + xx + ',' + (yy - 5) + 'l5,5l-5,5l-5,-5z' }, g);
      });
      // off-scale single-swap highs: one ▲ at the top edge for the highest in view
      var hiA = S.ser('himsUsdg.high'), best = -Infinity, bi = -1, offBox = null;
      if (hiA) for (var i = i0; i <= i1; i++) if (hiA[i] != null && hiA[i] > best) { best = hiA[i]; bi = i; }
      if (bi >= 0 && best > y.d[1]) {
        var bx = x(S.t[bi]), top = m.t + 1;
        S.svg('path', { cls: 'glyph', d: 'M' + bx + ',' + top + 'l4,6l-8,0z' }, g);
        var lt = S.svg('text', { cls: 'halo mark-label', x: bx + 7, y: top + 8, 'text-anchor': bx > W - m.r - 150 ? 'end' : 'start' }, g);
        if (bx > W - m.r - 150) lt.setAttribute('x', bx - 7);
        lt.textContent = tr('mo.outOfRange', { v: S.fmtUsdg2(best) });
        offBox = { x: bx, y: top + 8 };
      }
      var labelled = false;
      (S.pricePeaks || []).forEach(function (pk) {
        if (!inView(pk.ts)) return;
        var pv = S.isNum(pk.amount) && pk.amount > 5 ? pk.amount : S.val('himsUsdg.close', S.idx(pk.ts));
        if (pv == null || pv > y.d[1]) return;
        var px = x(pk.ts), py = y(pv);
        S.svg('circle', { cls: 'glyph dot', cx: px, cy: py, r: 4 }, g);
        if (labelled) return; labelled = true;
        var right = px < W - m.r - 200, ly = py + 4;
        if (offBox && Math.abs(offBox.y - ly) < 14 && Math.abs(offBox.x - px) < 260) ly = Math.max(ly, offBox.y + 15);
        var pt = S.svg('text', { cls: 'halo mark-label strong', x: right ? px + 8 : px - 8, y: ly, 'text-anchor': right ? 'start' : 'end' }, g);
        pt.textContent = S.fmtUsdg2(pv) + ' · ' + S.fmtHM(pk.ts) + ' · ' + S.shortLabel(S.L(pk.label));
      });
    }
    if (id === 'float') {
      var sup = S.ser('himsSupply');
      S.glyphEvents().forEach(function (e) {
        if (!inView(e.ts) || (e.kind !== 'burn' && e.kind !== 'mint')) return;
        var s0 = sup ? sup[S.idx(e.ts)] : null; if (s0 == null) return;
        var ex = x(e.ts), ey = y(s0);
        S.svg('path', { cls: 'glyph', d: e.kind === 'burn' ? 'M' + (ex - 4) + ',' + (ey - 8) + 'l8,0l-4,6z' : 'M' + (ex - 4) + ',' + (ey - 2) + 'l8,0l-4,-6z' }, g);
      });
      var mi = S.ser('himsMinted'); if (mi) {
        var rug = [];
        for (var k = i0; k <= i1; k++) if (mi[k] > 0) { var rx = Math.round(x(S.t[k])) + 0.5; rug.push('M' + rx + ',' + m.t + 'v6'); }
        if (rug.length) S.svg('path', { cls: 'rug', d: rug.join('') }, g);
      }
      var ff = S.frozenFrom, ft = S.firstMintTs;
      if (ff && ft && ft > ff && sup) {
        var sv = sup[S.idx((ff + ft) / 2)];
        var fx0 = Math.max(m.l, x(ff)), fx1 = Math.min(W - m.r, x(ft)), fy = y(sv) - 8;
        if (fx1 - fx0 > 150) {
          S.svg('path', { cls: 'bracket', d: 'M' + fx0 + ',' + (fy + 4) + 'v-4H' + fx1 + 'v4' }, g);
          var bt = S.svg('text', { cls: 'halo mark-label', x: (fx0 + fx1) / 2, y: fy - 4, 'text-anchor': 'middle' }, g);
          bt.textContent = tr('mo.fenceBracket', { v: S.fmtSupply(sv), d: S.fmtDur(ft - ff) });
        }
      }
    }
    if (id === 'cost') {
      var up = S.ser('pushUp10CostUsdg'); if (!up) return;
      if (inView(S.baseTs) && up[S.baseI] != null) {
        var bx2 = x(S.baseTs), by = y(up[S.baseI]);
        S.svg('circle', { cls: 'glyph dot', cx: bx2, cy: by, r: 3.5 }, g);
        var b2 = S.svg('text', { cls: 'halo mark-label', x: bx2 - 6, y: by - 7, 'text-anchor': 'end' }, g);
        if (bx2 - m.l < 110) { b2.setAttribute('x', bx2 + 6); b2.setAttribute('text-anchor', 'start'); }
        b2.textContent = S.fmtUsdg(up[S.baseI]) + ' · ' + S.fmtWdHM(S.baseTs);
      }
      var mn = Infinity, mj = -1;
      for (var q = Math.max(i0, S.idx(S.view.d0)); q <= Math.min(i1, S.idx(S.view.d1)); q++) if (up[q] != null && up[q] < mn) { mn = up[q]; mj = q; }
      if (mj >= 0 && Math.abs(mj - S.baseI) > 5) {
        var mx2 = x(S.t[mj]), my = y(mn);
        S.svg('circle', { cls: 'glyph dot', cx: mx2, cy: my, r: 3.5 }, g);
        var mt = S.svg('text', { cls: 'halo mark-label strong', x: mx2 + 6, y: my + 14 }, g);
        if (mx2 > W - m.r - 120) { mt.setAttribute('x', mx2 - 6); mt.setAttribute('text-anchor', 'end'); }
        mt.textContent = S.fmtUsdg(mn) + ' · ' + S.fmtWdHM(S.t[mj]);
      }
    }
  }

  // ---------- phone: collapsed lane sparkline ----------
  function renderSpark(L) {
    var el = L.sparkEl; S.clear(el);
    if (!L.def.spark) return;
    var a = S.ser(L.def.spark); if (!a) return;
    var W = el.clientWidth || 200, H = 24, i0 = S.idx(S.view.d0), i1 = S.idx(S.view.d1);
    var e = S.extent([a], i0, i1) || [0, 1];
    var log = L.def.y && L.def.y.scale === 'log';
    var x = S.linear(S.view.d0, S.view.d1, 0, W), y = log ? S.log(Math.max(e[0], 1e-12), Math.max(e[1], e[0] * 1.01), H - 2, 2) : S.linear(e[0], e[1] === e[0] ? e[0] + 1 : e[1], H - 2, 2);
    var svg = S.svg('svg', { width: W, height: H }, el);
    var col = (L.def.series[0] && L.def.series[0].color) || 'text-secondary';
    if (L.def.id === 'float') col = 'pool-boner';
    if (L.def.id === 'inventory') col = 'pool-usd';
    S.svg('path', { d: S.linePath(a, i0, i1, x, y), fill: 'none', stroke: 'var(--' + col + ')', 'stroke-width': 1.5 }, svg);
    L.sparkX = x;
    L.sparkCursor = S.svg('line', { cls: 'spark-cursor', x1: 0, x2: 0, y1: 0, y2: H }, svg);
  }

  // ---------- per-frame: cursor, readout ----------
  S.updateLaneCursor = function (L, i) {
    if (i == null) i = S.idx(S.state.cursorTs);
    var ts = S.state.cursorTs;
    if (L.def.kind === 'events') { if (L.cursorEl && S.xs) { L.cursorEl.style.transform = 'translateX(' + S.xs(ts).toFixed(1) + 'px)'; L.cursorEl.hidden = ts < S.view.d0 || ts > S.view.d1; } return; }
    if (L.def.kind === 'social') { S.socialCursor(L, ts); return; }
    if (L.isCollapsed) { if (L.sparkCursor && L.sparkX) { var sx = L.sparkX(ts).toFixed(1); L.sparkCursor.setAttribute('x1', sx); L.sparkCursor.setAttribute('x2', sx); } }
    else if (S.xs) {
      var xx = S.xs(ts);
      L.cursorEl.style.transform = 'translateX(' + xx.toFixed(1) + 'px)';
      L.cursorEl.hidden = ts < S.view.d0 || ts > S.view.d1;
    }
    if (L.def.readout) renderParts(L.readoutEl, L.def.readout(i));
    if (L.numbersOpen && L.rows) highlightRow(L, ts);
  };
  function renderParts(el, parts) {
    S.clear(el);
    parts.forEach(function (p) {
      var sp = S.el('span', { cls: 'ro' });
      if (p.color || p.dash) sp.appendChild(S.el('i', { cls: (p.rect ? 'key-rect' : 'key-line') + (p.dash ? ' dash' : ''), style: p.dash ? null : 'background:var(--' + p.color + ')' }));
      if (p.v != null) sp.appendChild(S.el('strong', { text: p.v }));
      if (p.l) sp.appendChild(S.el('span', { cls: 'ro-l', text: p.l }));
      el.appendChild(sp);
    });
  }
  S.renderParts = renderParts;

  // ---------- pointer: hover peek, click / drag commits ----------
  function attachPlotPointer(L, el) {
    var drag = null;
    function tsAt(ev) { var r = el.getBoundingClientRect(); return S.clamp(S.xs.inv(ev.clientX - r.left), S.W0, S.W1); }
    el.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0 || ev.target.closest('a,button')) return;
      drag = { x: ev.clientX, y: ev.clientY, id: ev.pointerId, moved: false, touch: ev.pointerType !== 'mouse' };
      if (!drag.touch) { try { el.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ } S.userScrub(tsAt(ev), true); }
    });
    el.addEventListener('pointermove', function (ev) {
      if (drag && drag.id === ev.pointerId) {
        var dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
        if (drag.touch && !drag.moved) { if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return; if (Math.abs(dy) > Math.abs(dx)) { drag = null; return; } drag.moved = true; try { el.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ } }
        drag.moved = true;
        S.userScrub(tsAt(ev), true);
        S.tip.hide();
        return;
      }
      if (ev.pointerType !== 'mouse' || L.def.kind === 'social') return;
      var ts = tsAt(ev), i = S.idx(ts), xx = S.xs(S.t[i]);
      L.hoverEl.hidden = false; L.hoverEl.style.transform = 'translateX(' + xx.toFixed(1) + 'px)';
      var parts = (L.def.tip || L.def.readout)(i);
      S.tip.show(ev.clientX, ev.clientY, function (t) {
        t.appendChild(S.el('div', { cls: 'tip-time', text: S.fmtDT(S.t[i]) }));
        parts.forEach(function (p) { if (p.v != null) t.appendChild(S.tipRow(p.dash ? 'ref' : p.color, p.v, p.l, p.dash)); else t.appendChild(S.el('div', { cls: 'tip-note', text: p.l })); });
      });
    });
    function end(ev) {
      if (drag && drag.id === ev.pointerId) {
        if (drag.touch && !drag.moved && ev.type === 'pointerup') S.userScrub(tsAt(ev), true);
        drag = null; S.scrubEnd();
      }
    }
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', function (ev) { drag = null; void ev; });
    el.addEventListener('pointerleave', function () { L.hoverEl.hidden = true; S.tip.hide(); });
  }
  S.attachPlotPointer = attachPlotPointer;

  // ---------- Numbers view ----------
  S.toggleNumbers = function (L, force) {
    L.numbersOpen = force != null ? force : !L.numbersOpen;
    L.numBtn.setAttribute('aria-pressed', L.numbersOpen ? 'true' : 'false');
    L.numBtn.textContent = L.numbersOpen ? tr('chart') : tr('numbers');
    saveLaneState();
    applyCollapsed(L);
    S.renderLane(L);
    S.updateLaneCursor(L);
  };
  S.renderTable = function (L) {
    var el = L.tableEl; S.clear(el);
    var d = L.def, span = (S.view.d1 - S.view.d0) / 60, steps = [1, 2, 5, 10, 15, 30, 60, 120, 240, 360], st = steps[steps.length - 1];
    for (var k = 0; k < steps.length; k++) if (span / steps[k] <= 48) { st = steps[k]; break; }
    var set = {}, i0 = S.idx(S.view.d0), i1 = S.idx(S.view.d1);
    for (var i = i0; i <= i1; i++) if (Math.round((S.t[i] - S.t0) / 60) % st === 0) set[i] = '';
    var ch = S.chapterById(S.state.chapterId); if (ch && ch.focusTs >= S.view.d0 && ch.focusTs <= S.view.d1) set[S.idx(ch.focusTs)] = '◎';
    S.events.forEach(function (e) { if (e.ts >= S.view.d0 && e.ts <= S.view.d1) set[S.idx(e.ts)] = GLYPH[e.kind] || '•'; });
    var idxs = Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
    var bar = S.el('div', { cls: 'table-bar' });
    bar.appendChild(S.el('span', { cls: 'meta', text: tr('tbl.step', { m: st }) }));
    var copyBtn = S.el('button', { cls: 'tool', type: 'button', id: 'copy-' + d.id, text: tr('copy') });
    bar.appendChild(copyBtn);
    el.appendChild(bar);
    var wrap = S.el('div', { cls: 'tablewrap numbers-wrap' });
    var tb = S.el('table', { cls: 'num-table' });
    var thead = S.el('thead'), hr = S.el('tr');
    hr.appendChild(S.el('th', { text: tr('tbl.time') + ' (' + S.zoneLabel() + ')' }));
    d.table.cols.forEach(function (c) { hr.appendChild(S.el('th', { text: c.hz ? (S.lang === 'zh' ? c.hz : c.h) : tr(c.h) })); });
    thead.appendChild(hr); tb.appendChild(thead);
    var tbody = S.el('tbody'); L.rows = [];
    idxs.forEach(function (i) {
      var r = S.el('tr');
      r.appendChild(S.el('th', { scope: 'row', text: (set[i] ? set[i] + ' ' : '') + S.fmtWdHM(S.t[i]) }));
      d.table.cols.forEach(function (c) { r.appendChild(S.el('td', { text: c.get(i) })); });
      tbody.appendChild(r); L.rows.push({ ts: S.t[i], el: r });
    });
    tb.appendChild(tbody); wrap.appendChild(tb); el.appendChild(wrap);
    wrap.style.maxHeight = (S.laneH(L) + 240) + 'px';
    copyBtn.addEventListener('click', function () {
      var lines = [];
      tb.querySelectorAll('tr').forEach(function (r) { lines.push(Array.prototype.map.call(r.children, function (c) { return c.textContent; }).join('\t')); });
      var txt = lines.join('\n');
      function sel() { var rg = document.createRange(); rg.selectNodeContents(tb); var s = window.getSelection(); s.removeAllRanges(); s.addRange(rg); copyBtn.textContent = tr('selected'); }
      try { navigator.clipboard.writeText(txt).then(function () { copyBtn.textContent = tr('copied'); }, sel); } catch (e) { sel(); }
    });
    L.lastRow = null;
  };
  function highlightRow(L, ts) {
    var best = null;
    for (var k = 0; k < L.rows.length; k++) { if (L.rows[k].ts <= ts) best = L.rows[k]; else break; }
    if (best === L.lastRow) return;
    if (L.lastRow) L.lastRow.el.classList.remove('at-cursor');
    if (best) best.el.classList.add('at-cursor');
    L.lastRow = best;
  }

  // ---------- Moments lane ----------
  var GLYPH = { burn: '▼', mint: '▲', mintCluster: '┆', nyse: '■', reopen: '◆', peak: '●', arb: '◇', note: '•' };
  S.GLYPH = GLYPH;
  function buildMoments(L, host) {
    var wrap = S.el('div', { cls: 'moments', id: 'lane-moments' });
    L.labelEl = S.el('span', { cls: 'sr-only' });
    L.plotEl = S.el('div', { cls: 'moments-plot' });
    L.svgEl = S.svg('svg', { cls: 'plot-svg', role: 'group' });
    L.plotEl.appendChild(L.svgEl);
    L.cursorEl = S.el('div', { cls: 'cursor-rule', 'aria-hidden': 'true' });
    L.hoverEl = S.el('div', { cls: 'hover-rule', hidden: true });
    S.append(L.plotEl, [L.hoverEl, L.cursorEl]);
    S.append(wrap, [L.labelEl, L.plotEl]);
    host.appendChild(wrap);
    L.root = wrap;
    attachPlotPointer({ def: { kind: 'social' }, hoverEl: L.hoverEl }, L.plotEl);
  }
  var PRIORITY = { fence: 0, nyseClose: 1, mint: 2, reopen: 3, peak: 4, nyse: 5, burn: 6, arb: 7, note: 8, mintCluster: 9 };
  function glyphPath(kind, x, y) {
    switch (kind) {
      case 'burn': return 'M' + (x - 4.5) + ',' + (y - 3.5) + 'h9l-4.5,8z';
      case 'mint': return 'M' + (x - 4.5) + ',' + (y + 3.5) + 'h9l-4.5,-8z';
      case 'nyse': return 'M' + (x - 3.5) + ',' + (y - 3.5) + 'h7v7h-7z';
      case 'reopen': return 'M' + x + ',' + (y - 5) + 'l5,5l-5,5l-5,-5z';
      case 'arb': return 'M' + x + ',' + (y - 5) + 'l5,5l-5,5l-5,-5z';
      case 'peak': return 'M' + (x - 4) + ',' + y + 'a4,4 0 1,0 8,0a4,4 0 1,0 -8,0';
      default: return 'M' + (x - 2.5) + ',' + y + 'a2.5,2.5 0 1,0 5,0a2.5,2.5 0 1,0 -5,0';
    }
  }
  function renderMoments(L) {
    var svg = L.svgEl, m = S.layout.m, W = L.plotEl.clientWidth || S.laneWidth || 600, H = S.laneH(L);
    S.clear(svg); svg.setAttribute('width', W); svg.setAttribute('height', H);
    L.plotEl.style.height = H + 'px';
    svg.setAttribute('aria-label', tr('mo.label'));
    var x = S.xs, g = S.svg('g', null, svg), labels = [];
    var cl = function (v) { return S.clamp(v, m.l, W - m.r); };
    // bars row
    var fx0 = cl(x(S.fenceFrom)), fx1 = cl(x(S.fenceTo));
    if (fx1 - fx0 > 1) {
      S.svg('rect', { cls: 'mo-fence', x: fx0, y: 16, width: fx1 - fx0, height: 6, rx: 1 }, g);
      labels.push({ p: 0, x: fx0, x1: fx1, text: tr('mo.fence'), inside: true });
    }
    if (S.firstMintTs && S.reopenTs && S.firstMintTs > S.reopenTs) {
      var gx0 = cl(x(S.reopenTs)), gx1 = cl(x(S.firstMintTs));
      if (gx1 - gx0 > 0.5) {
        S.svg('rect', { cls: 'mo-gap', x: gx0 + 0.5, y: 16.5, width: Math.max(1, gx1 - gx0 - 1), height: 5 }, g);
        labels.push({ p: 3.5, x: gx0, x1: gx1, text: tr('mo.gap', { m: Math.floor((S.firstMintTs - S.reopenTs) / 60) }), inside: true });
      }
    }
    if (S.silenceFrom && S.silenceTo) {
      var sx0 = cl(x(S.silenceFrom)), sx1 = cl(x(S.silenceTo));
      if (sx1 - sx0 > 2) S.svg('path', { cls: 'mo-silence', d: 'M' + sx0 + ',12v4M' + sx0 + ',14H' + sx1 + 'M' + sx1 + ',12v4' }, g);
    }
    // mint rug (one tick per minute with mints)
    var mi = S.ser('himsMinted');
    if (mi) {
      var d = [], i0 = S.idx(S.view.d0), i1 = S.idx(S.view.d1);
      for (var i = i0; i <= i1; i++) if (mi[i] > 0) d.push('M' + (Math.round(x(S.t[i])) + 0.5) + ',25v6');
      if (d.length) S.svg('path', { cls: 'rug', d: d.join('') }, g);
    }
    // glyph row
    var gg = S.svg('g', { cls: 'mo-glyphs' }, svg);
    L.hits = [];
    S.glyphEvents().forEach(function (e) {
      var end = e.kind === 'mintCluster' && e.toTs ? e.toTs : e.ts;
      if (end < S.view.d0 || e.ts > S.view.d1) return;
      var xx = x(e.ts), yy = 28;
      var hit = S.svg('g', { cls: 'mo-hit', tabindex: '0', role: 'button', 'data-ts': e.ts }, gg);
      if (e.kind === 'mintCluster') {
        var cx0 = cl(xx), cx1 = Math.max(cx0 + 2, cl(x(end)));
        S.svg('rect', { x: cx0 - 4, y: 16, width: cx1 - cx0 + 8, height: 20, fill: 'transparent' }, hit);
        S.svg('rect', { cls: 'mo-cluster', x: cx0, y: 24, width: cx1 - cx0, height: 8, rx: 1 }, hit);
      } else {
        S.svg('rect', { x: xx - 12, y: 16, width: 24, height: 20, fill: 'transparent' }, hit);
        S.svg('path', { cls: 'glyph ' + (e.kind === 'arb' ? 'ring' : ''), d: glyphPath(e.kind, xx, yy) }, hit);
      }
      var lab = S.L(e.label) || e.kind;
      hit.setAttribute('aria-label', lab + ', ' + S.fmtDT(e.ts, true));
      function show(ev) {
        var r = hit.getBoundingClientRect();
        S.tip.show(ev && ev.clientX != null ? ev.clientX : r.left + r.width / 2, ev && ev.clientY != null ? ev.clientY : r.bottom, function (t) { eventTip(t, e); });
      }
      hit.addEventListener('pointerenter', show);
      hit.addEventListener('focus', function () { show(null); });
      hit.addEventListener('pointerleave', function () { S.tip.hide(); });
      hit.addEventListener('blur', function () { S.tip.hide(); });
      function go(ev) { if (ev) { ev.stopPropagation(); ev.preventDefault(); } S.userScrub(e.ts, true); S.scrubEnd(); }
      hit.addEventListener('click', go);
      hit.addEventListener('pointerdown', function (ev) { ev.stopPropagation(); });
      hit.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') go(ev); });
      var key = e.kind === 'nyse' && Math.abs(e.ts - S.nyseCloseTs) < 120 ? 'nyseClose' : e.kind;
      labels.push({ p: PRIORITY[key] != null ? PRIORITY[key] : 9, x: xx, text: S.shortLabel(lab) });
    });
    // label row (y = 11): placed by priority; right of the mark, else left, else hidden (the table carries it)
    labels.sort(function (a, b) { return a.p - b.p; });
    var placed = [], lg = S.svg('g', { cls: 'mo-labels' }, svg);
    var cw = S.lang === 'zh' ? 11.5 : 6.2;
    labels.forEach(function (lb) {
      var w = lb.text.length * cw + 4, cands;
      if (lb.inside) { var mid = (lb.x + lb.x1) / 2; cands = [Math.max(m.l, Math.min(mid - w / 2, W - m.r - w)), lb.x + 2]; }
      else cands = [lb.x + 6, lb.x - 6 - w];
      for (var c = 0; c < cands.length; c++) {
        var a = cands[c], b = a + w;
        if (a < m.l - 30 || b > W - 2) continue;
        var clash = placed.some(function (p) { return !(b + 8 <= p[0] || a >= p[1] + 8); });
        if (clash) continue;
        placed.push([a, b]);
        var t = S.svg('text', { x: a, y: 10 }, lg); t.textContent = lb.text;
        break;
      }
    });
  }
  function eventTip(t, e) {
    t.appendChild(S.el('div', { cls: 'tip-time', text: S.fmtDT(e.ts, true) }));
    t.appendChild(S.el('div', { cls: 'tip-strong', text: S.L(e.label) || e.kind }));
    var meta = [];
    if (e.block) meta.push(tr('block') + ' ' + S.fmtInt(e.block));
    if (e.tx) meta.push(tr('tx') + ' ' + S.shortHash(e.tx));
    if (meta.length) t.appendChild(S.el('div', { cls: 'tip-note mono', text: meta.join(' · ') }));
  }
  S.eventTip = eventTip;

  // ---------- minimap (focus + context) ----------
  S.buildMinimap = function () {
    var el = S.$('minimap');
    el.setAttribute('role', 'slider'); el.setAttribute('tabindex', '0');
    el.setAttribute('aria-valuemin', S.W0); el.setAttribute('aria-valuemax', S.W1);
    var drag = null;
    function tsAt(ev) { var r = el.getBoundingClientRect(); return S.clamp(S.xm.inv(ev.clientX - r.left), S.W0, S.W1); }
    el.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0) return;
      drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, touch: ev.pointerType !== 'mouse', moved: false };
      if (!drag.touch) { try { el.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ } S.userScrub(tsAt(ev), true, true); }
    });
    el.addEventListener('pointermove', function (ev) {
      if (!drag || drag.id !== ev.pointerId) return;
      if (drag.touch && !drag.moved) {
        var dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        if (Math.abs(dy) > Math.abs(dx)) { drag = null; return; }
        try { el.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      }
      drag.moved = true;
      S.userScrub(tsAt(ev), true, true);
    });
    el.addEventListener('pointerup', function (ev) { if (drag && drag.id === ev.pointerId) { if (drag.touch && !drag.moved) S.userScrub(tsAt(ev), true, true); drag = null; S.scrubEnd(); } });
    el.addEventListener('pointercancel', function () { drag = null; });
    el.addEventListener('keydown', function (ev) {
      var step = 0, k = ev.key;
      if (k === 'ArrowLeft' || k === 'ArrowDown') step = ev.shiftKey ? -600 : -60;
      else if (k === 'ArrowRight' || k === 'ArrowUp') step = ev.shiftKey ? 600 : 60;
      else if (k === 'PageUp') step = 3600; else if (k === 'PageDown') step = -3600;
      else if (k === 'Home') { ev.preventDefault(); S.userScrub(S.W0, true); S.scrubEndSoon(); return; }
      else if (k === 'End') { ev.preventDefault(); S.userScrub(S.W1, true); S.scrubEndSoon(); return; }
      else return;
      ev.preventDefault(); ev.stopPropagation();
      S.userScrub(S.clamp(S.state.cursorTs + step, S.W0, S.W1), true, true);
      S.scrubEndSoon();
    });
  };
  S.renderMinimap = function () {
    var el = S.$('minimap'), m = S.layout.m, W = el.clientWidth || 600, H = S.layout.mode === 'desk' ? 48 : (S.layout.mode === 'tab' ? 44 : 36);
    if (S.state.presenting) H = 32;
    var svg = S.$('minimap-svg'); S.clear(svg);
    svg.setAttribute('width', W); svg.setAttribute('height', H);
    var x = S.linear(S.W0, S.W1, m.l, W - m.r); S.xm = x;
    S.svg('rect', { cls: 'fence', x: x(S.fenceFrom), y: 0, width: Math.max(0, x(S.fenceTo) - x(S.fenceFrom)), height: H - 8 }, svg);
    if (S.firstMintTs > S.reopenTs) S.svg('rect', { cls: 'fence-soft', x: x(S.reopenTs), y: 0, width: Math.max(1, x(S.firstMintTs) - x(S.reopenTs)), height: H - 8 }, svg);
    var a = S.ser('himsUsdg.close');
    if (a) {
      var e = S.extent([a], 0, S.N - 1), y = S.linear(e[0], e[1], H - 12, 3);
      S.svg('path', { d: S.linePath(a, 0, S.N - 1, x, y), fill: 'none', stroke: 'var(--pool-usd)', 'stroke-width': 1.25 }, svg);
    }
    // chapter ticks + numbers (collapse crowded ones)
    S.svg('line', { cls: 'mm-base', x1: m.l, x2: W - m.r, y1: H - 7.5, y2: H - 7.5 }, svg);
    var lastX = -99, pend = [];
    S.chapters.forEach(function (c, k) {
      var cx = x(c.fromTs);
      S.svg('line', { cls: 'mm-tick', x1: Math.round(cx) + 0.5, x2: Math.round(cx) + 0.5, y1: H - 13, y2: H - 7 }, svg);
      var mid = (x(c.fromTs) + x(c.toTs)) / 2;
      pend.push({ n: k + 1, x: mid });
    });
    var groups = [];
    pend.forEach(function (p) { var g0 = groups[groups.length - 1]; if (g0 && p.x - g0.x1 < 14) { g0.b = p.n; g0.x1 = p.x; } else groups.push({ a: p.n, b: p.n, x0: p.x, x1: p.x }); });
    groups.forEach(function (g0) {
      var t = S.svg('text', { cls: 'mm-num', x: (g0.x0 + g0.x1) / 2, y: H - 0.5, 'text-anchor': 'middle' }, svg);
      t.textContent = g0.a === g0.b ? String(g0.a) : g0.a + '–' + g0.b;
      void lastX;
    });
    var bx0 = x(S.view.d0), bx1 = x(S.view.d1);
    if (bx1 - bx0 < 8) { var c0 = (bx0 + bx1) / 2; bx0 = c0 - 4; bx1 = c0 + 4; }
    S.mmBracket = S.svg('rect', { cls: 'mm-bracket', x: bx0, y: 1, width: bx1 - bx0, height: H - 10, rx: 3 }, svg);
    S.mmCursor = S.svg('line', { cls: 'mm-cursor', x1: 0, x2: 0, y1: 0, y2: H - 8 }, svg);
    // funnel: bracket edges -> lane plot edges
    var f = S.$('funnel-svg'); S.clear(f);
    var fh = S.layout.mode === 'phone' ? 8 : 12;
    f.setAttribute('width', W); f.setAttribute('height', fh);
    S.svg('path', { cls: 'funnel', d: 'M' + bx0 + ',0L' + m.l + ',' + fh + 'M' + bx1 + ',0L' + (W - m.r) + ',' + fh }, f);
  };
  S.minimapCursor = function (ts) {
    if (!S.mmCursor || !S.xm) return;
    var xx = S.xm(ts).toFixed(1);
    S.mmCursor.setAttribute('x1', xx); S.mmCursor.setAttribute('x2', xx);
  };

  // ---------- time axis ----------
  S.renderAxis = function () {
    var svg = S.$('axis-svg'), m = S.layout.m, host = S.$('axis'), W = host.clientWidth || 600, H = 30;
    S.clear(svg); svg.setAttribute('width', W); svg.setAttribute('height', H);
    var x = S.xs, tt = S.timeTicks(S.view.d0, S.view.d1, W - m.l - m.r), g = S.svg('g', null, svg);
    S.svg('line', { cls: 'axis-line', x1: m.l, x2: W - m.r, y1: 0.5, y2: 0.5 }, g);
    tt.ticks.forEach(function (t) {
      var xx = Math.round(x(t)) + 0.5;
      S.svg('line', { cls: 'axis-tick', x1: xx, x2: xx, y1: 0, y2: 5 }, g);
      var tx = S.svg('text', { x: xx, y: 16, 'text-anchor': 'middle' }, g); tx.textContent = S.fmtHM(t);
      var minor = x(t + tt.step / 2);
      if (minor < W - m.r) S.svg('line', { cls: 'axis-tick', x1: Math.round(minor) + 0.5, x2: Math.round(minor) + 0.5, y1: 0, y2: 3 }, g);
    });
    // day labels at the left edge and at each midnight crossing
    var off = S.tz === 'jst' ? 9 * 3600 : 0, days = [S.view.d0];
    for (var d = Math.ceil((S.view.d0 + off) / 86400) * 86400 - off; d <= S.view.d1; d += 86400) days.push(d);
    // a midnight crossing close to the left edge replaces the edge label (the day that is actually shown)
    if (days.length > 1 && x(days[1]) - m.l < 60) days.shift();
    var lastX = -1e9;
    days.forEach(function (d0) {
      var xx = Math.max(m.l, x(d0));
      if (xx - lastX < 60) return; lastX = xx;
      var t = S.svg('text', { cls: 'axis-day', x: xx, y: 28 }, g); t.textContent = S.fmtDayShort(d0);
    });
    var z = S.svg('text', { cls: 'axis-zone', x: W - m.r + (S.layout.mode === 'phone' ? 0 : 6), y: 16, 'text-anchor': S.layout.mode === 'phone' ? 'end' : 'start' }, g);
    z.textContent = S.zoneLabel();
    if (S.layout.mode === 'phone') z.setAttribute('y', 28);
    S.edgeFlag = S.svg('text', { cls: 'edge-flag', y: 28 }, g);
    S.axisFlag = S.$('time-flag');
  };
  S.axisCursor = function (ts) {
    var f = S.axisFlag; if (!f || !S.xs) return;
    var inV = ts >= S.view.d0 && ts <= S.view.d1;
    f.hidden = !inV;
    if (inV) { f.textContent = S.fmtHM(ts); f.style.transform = 'translateX(' + S.xs(ts).toFixed(1) + 'px) translateX(-50%)'; }
    if (S.edgeFlag) {
      if (inV) S.edgeFlag.textContent = '';
      else {
        var m = S.layout.m, right = ts > S.view.d1, W = S.$('axis').clientWidth;
        S.edgeFlag.textContent = (right ? '→ ' : '← ') + S.fmtWdHM(ts);
        S.edgeFlag.setAttribute('x', right ? W - m.r : m.l);
        S.edgeFlag.setAttribute('text-anchor', right ? 'end' : 'start');
      }
    }
  };
})(window.SQZ = window.SQZ || {});
