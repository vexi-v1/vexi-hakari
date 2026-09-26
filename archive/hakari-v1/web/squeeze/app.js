/* HIMS weekend float squeeze: state, transport (stepper, playback, keys), chapter cards, the clock,
   presenter mode, the On X lane, the sections below the stage and the reference footer.
   Classic script, loaded last. Reads window.SQUEEZE_DATA / SQUEEZE_STORY / SQUEEZE_SOCIAL (no fetch). */
(function (S) {
  'use strict';
  var tr = S.tr, $ = S.$;

  S.state = { cursorTs: 0, chapterId: 'overview', zoom: 'chapter', yMode: 'fixed', playing: false, speed: 1, presenting: false };
  S.view = { d0: 0, d1: 1 };
  S.chapterById = function (id) { for (var i = 0; i < S.chapters.length; i++) if (S.chapters[i].id === id) return S.chapters[i]; return null; };
  var CH_SHORT = function (c) { return tr('ch.' + c.id) !== 'ch.' + c.id ? tr('ch.' + c.id) : S.L(c.title); };

  // ---------------------------------------------------------------- language
  // A bare #en or #zh (exactly that, nothing else) picks the language, so a link can open either version.
  // Any other hash keeps its meaning (a chapter id, #present, or an anchor such as #hakari / #lane-hakari).
  function hashLang() {
    var h = location.hash || '';
    return h === '#en' ? 'en' : (h === '#zh' ? 'zh' : null);
  }
  function resolveLang() {
    var h = hashLang();
    if (h) { S.store.set('lang', h); return h; } // a #en / #zh link also sets the language the plain page and later visits use
    var s = S.store.get('lang');
    if (s === 'en' || s === 'zh') return s;
    var langs = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en']);
    for (var i = 0; i < langs.length; i++) if (/^zh/i.test(langs[i])) return 'zh';
    return 'en';
  }
  var notoLoaded = false;
  function loadNoto() {
    if (notoLoaded) return; notoLoaded = true;
    var l = document.createElement('link'); l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700&display=swap';
    document.head ? document.head.appendChild(l) : document.body.appendChild(l);
  }
  // initial: first paint, nothing to re-render. fromHash: chosen by a #en / #zh link, so the saved choice is left alone.
  S.setLang = function (lang, initial, fromHash) {
    S.lang = lang;
    document.documentElement.lang = lang === 'zh' ? 'zh-Hant-TW' : 'en';
    if (lang === 'zh') loadNoto();
    if (!initial && !fromHash) S.store.set('lang', lang);
    // switched by hand while the URL says #en / #zh: keep the URL true to what is on screen
    if (!initial && !fromHash && hashLang() && hashLang() !== lang) { try { history.replaceState(null, '', '#' + lang); } catch (e) { /* sandboxed host */ } }
    ['en', 'zh'].forEach(function (l) { var b = $('lang-' + l); if (b) b.setAttribute('aria-pressed', l === lang ? 'true' : 'false'); });
    if (!initial) { applyTexts(); S.renderAll(); renderSections(); S.updateCursor(true); }
  };

  // ---------------------------------------------------------------- static texts
  function applyTexts() {
    document.querySelectorAll('[data-t]').forEach(function (e) { e.textContent = tr(e.getAttribute('data-t')); });
    document.querySelectorAll('[data-t-label]').forEach(function (e) { e.setAttribute('aria-label', tr(e.getAttribute('data-t-label'))); e.title = tr(e.getAttribute('data-t-label')); });
    var back = $('back-link'); back.textContent = tr('back'); back.href = window.SQZ_BACK || '../index.html';
    $('h1').textContent = tr('h1');
    $('h1-short').textContent = tr('h1short');
    $('h1-long').textContent = S.ST ? S.L(S.ST.title) : tr('h1');
    $('btn-present').textContent = S.state.presenting ? tr('exit') : tr('present');
    setPlayBtn();
    var sp = $('speed'); sp.setAttribute('aria-label', tr('speed')); sp.title = tr('speed');
    buildStepper();
    S.laneTexts();
    if (S.tri.svg) S.tri.texts();
    S.tri.buildPanel && S.tri.buildPanel();
    renderKeys();
    renderCard();
    $('mm-label').textContent = tr('mm.label');
    $('minimap').setAttribute('aria-label', tr('mm.label'));
    setSegs();
  }
  function setSegs() {
    [['zoom-chapter', S.state.zoom === 'chapter'], ['zoom-whole', S.state.zoom === 'whole'], ['y-fixed', S.state.yMode === 'fixed'], ['y-fit', S.state.yMode === 'fit'], ['tz-utc', S.tz === 'utc'], ['tz-jst', S.tz === 'jst']]
      .forEach(function (p) { var b = $(p[0]); if (b) b.setAttribute('aria-pressed', p[1] ? 'true' : 'false'); });
    var zc = $('zoom-chapter'); if (zc) zc.disabled = S.state.chapterId === 'overview';
  }

  // ---------------------------------------------------------------- stepper
  function buildStepper() {
    var nav = $('stepper'); S.clear(nav);
    nav.setAttribute('aria-label', tr('chapters'));
    var items = [{ id: 'overview', n: tr('chip.all'), title: tr('chip.allTitle') }].concat(S.chapters.map(function (c, k) { return { id: c.id, n: String(k + 1), title: S.L(c.kicker) + ' · ' + S.L(c.title) }; }));
    items.forEach(function (it) {
      var b = S.el('button', { type: 'button', cls: 'chip' + (it.id === 'overview' ? ' chip-all' : ''), id: 'chip-' + it.id, title: it.title, 'aria-label': it.title, 'data-ch': it.id, text: it.n });
      b.appendChild(S.el('span', { cls: 'chip-progress', 'aria-hidden': 'true' }));
      b.addEventListener('click', function () { S.pause(); S.goChapter(it.id); });
      nav.appendChild(b);
    });
    nav.onkeydown = function (ev) {
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      var bs = Array.prototype.slice.call(nav.querySelectorAll('button')), k = bs.indexOf(document.activeElement);
      if (k < 0) return;
      ev.preventDefault(); ev.stopPropagation();
      bs[S.clamp(k + (ev.key === 'ArrowRight' ? 1 : -1), 0, bs.length - 1)].focus();
    };
    markStepper();
  }
  var visited = {};
  function markStepper() {
    document.querySelectorAll('#stepper .chip').forEach(function (b) {
      var id = b.getAttribute('data-ch');
      if (id === S.state.chapterId) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
      b.classList.toggle('visited', !!visited[id] && id !== S.state.chapterId);
    });
    var k = S.chapterIndex(S.state.chapterId);
    var pl = $('pt-label');
    if (pl) pl.textContent = S.state.chapterId === 'overview' ? tr('ch.overview') + ' ▴' : (k + 1) + '/' + S.chapters.length + ' ' + CH_SHORT(S.chapters[k]) + ' ▴';
  }

  // ---------------------------------------------------------------- chapters and zoom
  S.domainFor = function (id) {
    if (id === 'overview' || S.state.zoom === 'whole') return [S.W0, S.W1];
    var c = S.chapterById(id); return c ? S.chapterDomain(c) : [S.W0, S.W1];
  };
  S.goChapter = function (id, opts) {
    opts = opts || {};
    var prev = S.state.chapterId;
    S.state.chapterId = id;
    visited[id] = true;
    if (!opts.keepCursor) {
      var c = S.chapterById(id);
      S.setCursor(id === 'overview' ? S.peakTs : (c ? c.focusTs : S.state.cursorTs));
    }
    var d = S.domainFor(id);
    S.setView(d[0], d[1], opts.instant ? false : true);
    markStepper(); setSegs();
    if (prev !== id) { renderCard(true); S.live(id); try { S.store.set('chapter', id); } catch (e) { /* ignore */ } }
    if (S.state.presenting) S.presLayout();
  };
  S.live = function (id) {
    var k = S.chapterIndex(id), el = $('live');
    if (el) el.textContent = id === 'overview' ? tr('ch.overview') : tr('live', { n: k + 1, title: S.L(S.chapters[k].title) });
  };

  var tween = null;
  S.setView = function (d0, d1, animate) {
    if (tween) { cancelAnimationFrame(tween); tween = null; }
    var a0 = S.view.d0, a1 = S.view.d1;
    if (!animate || S.reducedMotion() || !(a1 > a0) || (Math.abs(a0 - d0) < 1 && Math.abs(a1 - d1) < 1)) {
      S.view = { d0: d0, d1: d1 }; S.renderAll(); return;
    }
    var start = performance.now(), dur = 450;
    // interpolate in log-span space so zooming feels even
    var la = Math.log(a1 - a0), lb = Math.log(d1 - d0), ca = (a0 + a1) / 2, cb = (d0 + d1) / 2;
    function step(now) {
      var p = Math.min(1, (now - start) / dur), e = 1 - Math.pow(1 - p, 3);
      var span = Math.exp(la + (lb - la) * e), c = ca + (cb - ca) * e;
      S.view = { d0: Math.max(S.W0, c - span / 2), d1: Math.min(S.W1, c + span / 2) };
      if (p >= 1) S.view = { d0: d0, d1: d1 };
      S.renderAll(true);
      if (p < 1) tween = requestAnimationFrame(step); else { tween = null; S.renderAll(); }
    }
    tween = requestAnimationFrame(step);
  };

  // ---------------------------------------------------------------- render
  S.layout = S.dims();
  S.renderAll = function (fast) {
    S.layout = S.dims();
    var lanesHost = $('lanes');
    S.laneWidth = lanesHost.clientWidth;
    var m = S.layout.m;
    S.xs = S.linear(S.view.d0, S.view.d1, m.l, S.laneWidth - m.r);
    S.lanes.forEach(function (L) { S.renderLane(L); });
    S.renderMinimap(); S.renderAxis();
    if (!fast) { S.tri.renderHeroSpark(); S.lanes.forEach(function (L) { if (L.subEl && L.def.id === 'route') L.subEl.textContent = tr(L.def.sub, { t: S.fmtWdHM(S.routeOrigin()) }); }); }
    S.updateCursor(true);
  };
  S.rebuild = function () {
    S.layout = S.dims();
    S.applyCollapsedAll();
    S.tri.build();
    S.renderAll();
  };

  // ---------------------------------------------------------------- cursor
  var frameReq = null, lastAria = 0, lastChapterCheck = null;
  S.setCursor = function (ts) {
    ts = S.clamp(ts, S.W0, S.W1);
    S.state.cursorTs = ts;
    if (!frameReq) frameReq = requestAnimationFrame(function () { frameReq = null; S.updateCursor(); });
  };
  S.userScrub = function (ts, commit, fromMinimap, snap) {
    S.pause();
    ts = S.t0 + (snap === 'floor' ? S.idxFloor(ts) : Math.round((ts - S.t0) / S.step)) * S.step;
    S.setCursor(ts);
    if (S.state.chapterId !== 'overview') {
      var c = S.chapterAt(ts);
      if (c && c.id !== S.state.chapterId) { S.state.chapterId = c.id; visited[c.id] = true; markStepper(); renderCard(true); S.live(c.id); }
    }
    void commit; void fromMinimap;
  };
  S.scrubEnd = function () {
    if (S.state.chapterId === 'overview') return;
    var d = S.domainFor(S.state.chapterId);
    if (Math.abs(d[0] - S.view.d0) > 1 || Math.abs(d[1] - S.view.d1) > 1) S.setView(d[0], d[1], true);
    if (S.state.presenting) S.presLayout();
  };
  var endTimer = null;
  S.scrubEndSoon = function () { clearTimeout(endTimer); endTimer = setTimeout(S.scrubEnd, 350); };

  S.updateCursor = function () {
    if (!S.D) return;
    var ts = S.state.cursorTs, i = S.idx(ts);
    updateClock(ts, i);
    updateMoment(ts);
    updateWatch(i);
    S.lanes.forEach(function (L) { S.updateLaneCursor(L, i); });
    S.minimapCursor(ts); S.axisCursor(ts);
    S.tri.update(i); S.tri.updatePanel(i);
    updateOverviewWhere(ts);
    var now = Date.now();
    if (now - lastAria > 250) {
      lastAria = now;
      var c = S.chapterAt(ts), k = c ? S.chapterIndex(c.id) : -1;
      var mm = $('minimap');
      mm.setAttribute('aria-valuenow', Math.round(ts));
      mm.setAttribute('aria-valuetext', tr('mm.valuetext', { t: S.fmtDT(ts), p: S.fmtUsdg2(S.val('himsUsdg.close', i)), prem: S.fmtPct((S.val('himsUsdg.close', i) / S.NAV - 1) * 100), ch: c ? tr('chapterOf', { n: k + 1, m: S.chapters.length }) + ', ' + CH_SHORT(c) : '' }));
    }
    void lastChapterCheck;
  };

  // ---------------------------------------------------------------- clock + chips
  function updateClock(ts, i) {
    $('clk-day').textContent = S.fmtDay(ts, true);
    $('clk-time').textContent = S.fmtHM(ts);
    $('clk-zone').textContent = S.zoneLabel();
    $('clk-ny').textContent = tr('ny', { t: S.fmtNY(ts) });
    var nyseOpen = ts < S.nyseCloseTs || ts >= S.nyseOpenTs;
    var sessOpen = ts < S.fenceFrom || ts >= S.reopenTs;
    var g = S.gateState(ts);
    setChip('chip-nyse', nyseOpen ? 'open' : 'closed', tr(nyseOpen ? 'chip.nyseOpen' : 'chip.nyseClosed'));
    setChip('chip-session', sessOpen ? 'open' : 'closed', tr(sessOpen ? 'chip.sessionOpen' : 'chip.sessionClosed'));
    setChip('chip-gate', g.key === 'closed' ? 'closed' : (g.key === 'waiting' ? 'waiting' : (g.key === 'minting' ? 'plus' : 'open')), g.chip);
    // phone/presenter compact pill
    var pill = $('clock-pill');
    if (pill) pill.textContent = S.fmtWdHM(ts) + ' ' + S.zoneLabel() + ' · ' + S.fmtUsdg2(S.val('himsUsdg.close', i)) + ' (' + S.fmtPct((S.val('himsUsdg.close', i) / S.NAV - 1) * 100) + ')';
    var pg = $('clock-pill-gate'); if (pg) { pg.className = 'st-icon st-' + (g.key === 'closed' ? 'closed' : g.key === 'waiting' ? 'waiting' : g.key === 'minting' ? 'plus' : 'open'); pg.setAttribute('aria-label', g.chip); }
  }
  function setChip(id, state, text) {
    var c = $(id); if (!c) return;
    c.className = 'status-chip';
    var ic = c.firstChild; if (!ic || ic.nodeType !== 1) { S.clear(c); ic = S.el('i', { 'aria-hidden': 'true' }); c.appendChild(ic); c.appendChild(S.el('span')); }
    ic.className = 'st-icon st-' + state;
    c.lastChild.textContent = text;
  }

  // ---------------------------------------------------------------- nearby moment caption (±10 min)
  function updateMoment(ts) {
    var best = null, bd = 601;
    S.glyphEvents().forEach(function (e) { var d = Math.abs(e.ts - ts); if (d < bd) { bd = d; best = { ts: e.ts, label: S.L(e.label), tx: e.tx }; } });
    (S.D.notableSwaps || []).forEach(function (s) {
      var d = Math.abs(s.ts - ts), lab = s.label ? S.L(s.label) : (S.lang === 'zh' && s.noteZh ? s.noteZh : s.note);
      if (d < bd && lab) { bd = d; best = { ts: s.ts, label: lab, tx: s.tx }; }
    });
    var el = $('moment'); S.clear(el);
    if (!best || (S.state.chapterId === 'overview' && S.layout.mode === 'phone')) { el.hidden = true; return; }
    el.hidden = false;
    S.append(el, [S.el('span', { cls: 'mo-k', text: tr('nearby') }), ' · ', S.el('span', { cls: 'mo-t', text: S.fmtHMS(best.ts) }), ' · ', best.label + ' ']);
    if (best.tx) el.appendChild(S.link(S.txUrl(best.tx), '↗ ' + S.shortHash(best.tx), 'mono'));
  }

  // ---------------------------------------------------------------- watch readout (chapter card)
  var WATCH = {
    himsUsdg: { c: 'pool-usd', f: function (i) { return S.fmtUsdg2(S.val('himsUsdg.close', i)) + ' USDG'; }, raw: 'himsUsdg.close' },
    himsPremiumPct: { dash: true, f: function (i) { var p = S.val('himsPremiumPct', i); if (p == null) { var c = S.val('himsUsdg.close', i); p = c == null ? null : (c / S.NAV - 1) * 100; } return S.fmtPct(p); } },
    himsSupply: { c: 'text-primary', f: function (i) { return S.fmtSupply(S.val('himsSupply', i)) + ' HIMS'; }, raw: 'himsSupply' },
    himsInPoolManager: { c: 'other-v4', rect: true, f: function (i) { return S.fmtHims(S.val('himsInPoolManager', i)) + ' HIMS'; }, raw: 'himsInPoolManager' },
    himsInBonerHims: { c: 'pool-boner', f: function (i) { return S.fmtHims(S.val('himsInBonerHims', i)) + ' HIMS'; }, raw: 'himsInBonerHims' },
    himsInHimsUsdg: { c: 'pool-usd', f: function (i) { return S.fmtHims(S.val('himsInHimsUsdg', i)) + ' HIMS'; }, raw: 'himsInHimsUsdg' },
    usdgInHimsUsdg: { c: 'ref', f: function (i) { return S.fmtUsdg(S.val('usdgInHimsUsdg', i)) + ' USDG'; }, raw: 'usdgInHimsUsdg' },
    bonerHims: { c: 'pool-boner', f: function (i) { return S.fmtSig(S.val('bonerHims.close', i), 3) + ' HIMS'; }, raw: 'bonerHims.close' },
    bonerUsdgViaHims: { c: 'pool-boner', f: function (i) { return S.fmtSig(S.val('bonerUsdgViaHims', i), 3) + ' USDG'; }, raw: 'bonerUsdgViaHims' },
    bonerUsdAtNav: { dash: true, f: function (i) { return S.fmtSig(S.val('bonerUsdAtNav', i), 3) + ' USDG'; }, raw: 'bonerUsdAtNav' },
    bonerUsdgDirect: { c: 'pool-direct', f: function (i) { return S.fmtSig(S.val('bonerUsdgDirect.close', i), 3) + ' USDG'; }, raw: 'bonerUsdgDirect.close' },
    routeGapPct: { f: function (i) { return S.fmtPct(S.val('routeGapPct', i)); } },
    pushUp10CostUsdg: { c: 'hakari', f: function (i) { var v = S.val('pushUp10CostUsdg', i); return v == null ? '—' : S.fmtUsdg(v) + ' USDG'; }, raw: 'pushUp10CostUsdg' },
    volUsdgHimsUsdg: { c: 'pool-usd', f: function (i) { return S.fmtUsdg(S.sumRange('volUsdgHimsUsdg', i - 9, i)) + ' USDG ' + tr('ro.10min'); } },
    volHimsBonerHims: { c: 'pool-boner', f: function (i) { return S.fmtHims(S.sumRange('volHimsBonerHims', i - 9, i)) + ' HIMS ' + tr('ro.10min'); } },
    himsMinted: { c: 'text-primary', since: true, f: function (i, c) { var n = S.sumRange('himsMinted', S.idxFloor(c.fromTs) + 1, i) || 0; return '+' + S.fmtHims(n) + ' HIMS'; } },
    himsBurned: { c: 'text-primary', since: true, f: function (i, c) { var n = S.sumRange('himsBurned', S.idxFloor(c.fromTs) + 1, i) || 0; return (n ? '−' : '') + S.fmtHims(n) + ' HIMS'; } },
    // HAKARI's read (a counterfactual replay: series.hakari). Max safe exposure is the bound v1 decides with (the
    // ladder, lower where the gap between the two TWAPs binds), so it never contradicts the decision row beside it.
    maxSafeExposure: { need: 'hakari.maxSafeUsdg', c: 'hakari', v: function (i) { return S.hkBound(i).eff; }, f: function (i) {
      var b = S.hkBound(i); return b.eff == null ? '—' : S.fmtBound(b.eff) + ' USDG' + (b.gap != null ? ' · ' + tr('w.gapIn') : '');
    } },
    hakariDecision: { need: 'hakari.decision.e1000', c: 'hakari', cf: function (i) { var d = S.hkDecision(i); return d === 0 ? 'hakari' : (d === 1 ? 'pool-usd' : null); }, rect: true, f: function (i) { var d = S.hkDecision(i); return (d === 0 ? tr('w.refuses') : d === 1 ? tr('w.trusts') : tr('hk.noTwap')) + (d == null ? '' : ' ' + S.fmtInt(S.hk.exp) + ' USDG'); } },
    // what each rule would have paid out on, measured against NAV first (the pool itself is the premium); the mint
    // chapter adds "vs the pool", where the question is how far the TWAPs lag a real drop
    v0Settle: { need: 'hakari.v0Pick.d10.w1800', c: 'text-primary', f: function (i, ch) {
      var p = S.hkV0(i); if (!p || p.price == null) return '—';
      return settleText(p.price, i, ch);
    } },
    v1Settle: { need: 'hakari.decision.e1000', c: 'hakari', f: function (i, ch) {
      var p = S.hkV1(i, S.hk.exp); if (!p || p.dec == null) return tr('hk.noTwap');
      return p.dec === 0 ? tr('w.refuses') + ' ' + S.fmtInt(S.hk.exp) + ' USDG' : settleText(p.price, i, ch);
    } },
    hookTwap: { need: 'hakari.rawTick.w1800', c: 'hakari', lab: function () { return tr('w.hookTwap', { w: S.hk.win / 60, d: S.hk.delta }); }, f: function (i) {
      var r = S.tickPrice(S.hkRawTick(i)), u = S.tickPrice(S.hkTruncTick(i)); if (r == null || u == null) return '—';
      return tr('w.hookTwapV', { r: S.fmtUsdg2(r), u: S.fmtUsdg2(u) });
    } }
  };
  function settleText(price, i, ch) {
    var c = S.val('himsUsdg.close', i), out = S.fmtUsdg2(price) + ' USDG · ' + tr('w.vsNav', { x: S.fmtFixed(price / S.NAV, 2) });
    if (ch && ch.id === 'mint' && c) out += ' · ' + tr('w.vsPool', { p: S.fmtPct((price / c - 1) * 100) });
    return out;
  }
  var warned = {};
  function updateWatch(i) {
    var host = $('watch'); if (!host) return;
    var c = S.chapterById(S.state.chapterId);
    if (!c) { host.hidden = true; return; }
    host.hidden = false;
    S.clear(host);
    var keys = (c.watch || []).slice(0, S.state.presenting ? 3 : 8);
    keys.forEach(function (k) {
      var w = WATCH[k];
      if (!w) { if (!warned[k]) { warned[k] = 1; try { console.warn('[squeeze] unknown watch key', k); } catch (e) { /* no console */ } } return; }
      if ((w.need && !S.ser(w.need)) || (w.raw && w.raw.indexOf('hakari.') === 0 && !S.ser(w.raw))) return; // HAKARI's read not in this data.json
      var row = S.el('li', { cls: 'watch-row' });
      var col = w.cf ? w.cf(i) : w.c;
      row.appendChild(S.el('i', { cls: (w.rect ? 'key-rect' : 'key-line') + (w.dash ? ' dash' : ''), style: col && !w.dash ? 'background:var(--' + col + ')' : null, 'aria-hidden': 'true' }));
      row.appendChild(S.el('strong', { cls: 'wv', text: w.f(i, c) }));
      var lab = w.since ? tr(k === 'himsMinted' ? 'ro.mintedSince' : 'ro.burnedSince', { t: S.fmtHM(c.fromTs) }) : (w.lab ? w.lab() : tr('w.' + k));
      row.appendChild(S.el('span', { cls: 'wl', text: lab }));
      if (w.raw || w.v) {
        var at = function (j) { return w.v ? w.v(j) : S.val(w.raw, j); };
        var a = at(S.idxFloor(c.fromTs)), b = at(i);
        if (a && b != null && Math.abs(b / a - 1) > 0.0005) row.appendChild(S.el('span', { cls: 'wd', text: S.fmtChange(b, a) + (S.lang === 'zh' ? '' : ' ') + tr('ro.since', { t: S.fmtHM(c.fromTs) }) }));
      }
      host.appendChild(row);
    });
  }
  // One place to look per chapter: a sentence above the triangle caption (i18n look.<id>) and a "look here" tag
  // on one lane. Only that lane is flagged; the watch readouts above still list every watched series.
  // peak and reopen look at HAKARI's read (so presenter mode shows it first); mint at the oracle lane (v0 goes stale)
  var LOOK_LANE = { overview: 'cost', friday: 'float', redeem: 'float', fence: 'price', climb: 'float', peak: 'hakari', reopen: 'hakari', mint: 'oracle', aftermath: 'boner' };
  S.lookLane = function (id) { var l = LOOK_LANE[id]; return l && S.lanesById && !S.lanesById[l] ? null : (l || null); };
  function markLook() {
    var id = S.state.chapterId, lane = S.lookLane(id);
    S.lanes.forEach(function (L) { if (!L.watchDot) return; var on = L.id === lane; L.watchDot.hidden = !on; L.watchTag.hidden = !on; });
    var el = $('tri-look'); if (!el) return;
    var key = 'look.' + id, txt = tr(key);
    el.hidden = txt === key; el.textContent = txt === key ? '' : txt;
  }

  // ---------------------------------------------------------------- chapter / overview card
  var TLDR_CH = ['fence', 'climb', 'peak', 'mint'];
  function renderCard(fade) {
    var card = $('card'); if (!card) return;
    if (fade && !S.reducedMotion()) { card.classList.remove('fade'); void card.offsetWidth; card.classList.add('fade'); }
    S.clear(card);
    var id = S.state.chapterId, c = S.chapterById(id), ST = S.ST;
    if (!ST) { card.appendChild(S.el('p', { cls: 'notice', text: tr('err.story') })); return; }
    markLook();
    if (!c) {
      card.appendChild(S.el('p', { cls: 'kicker', text: tr('ch.overview') }));
      var lead = S.el('p', { cls: 'lead clamp', id: 'dek', text: S.L(ST.dek) });
      card.appendChild(lead);
      var more = S.el('button', { type: 'button', cls: 'more-btn', id: 'dek-more', 'aria-controls': 'dek', 'aria-expanded': 'false', text: tr('more') });
      more.addEventListener('click', function () { var o = lead.classList.toggle('open'); more.setAttribute('aria-expanded', o ? 'true' : 'false'); more.textContent = tr(o ? 'less' : 'more'); });
      card.appendChild(more);
      // the fifth tldr item is the "why it matters" line: always visible on the first screen, phone included
      var why = (ST.tldr || [])[4];
      if (why) {
        var wb = S.el('div', { cls: 'why', id: 'why' }, [S.el('h3', { cls: 'card-h why-h', text: tr('whyMatters') }), S.el('p', { cls: 'why-p' }, [S.rich(S.L(why)) , ' '])]);
        var wa = S.el('a', { href: '#hakari', cls: 'to-ch', text: '→ ' + tr('sec.hakari') });
        wa.addEventListener('click', function (ev) { var t = $('hakari'); if (!t) return; ev.preventDefault(); t.scrollIntoView({ behavior: S.reducedMotion() ? 'auto' : 'smooth', block: 'start' }); });
        wb.lastChild.appendChild(wa);
        card.appendChild(wb);
      }
      var tbox = S.el('details', { cls: 'tldr-box', id: 'tldr-box' });
      if (S.layout.mode !== 'phone') tbox.open = true;
      tbox.appendChild(S.el('summary', { cls: 'card-h', text: tr('tldr') }));
      card.appendChild(tbox);
      var ol = S.el('ol', { cls: 'tldr' });
      (ST.tldr || []).slice(0, 4).forEach(function (t, k) {
        var li = S.el('li', null, [S.rich(S.L(t))]);
        var cid = TLDR_CH[k], ci = S.chapterIndex(cid);
        if (ci >= 0) {
          li.appendChild(document.createTextNode(' '));
          var a = S.el('a', { href: '#' + cid, cls: 'to-ch', text: '→ ' + tr('toChapter', { n: ci + 1 }) });
          a.addEventListener('click', function (ev) { ev.preventDefault(); S.pause(); S.goChapter(cid); });
          li.appendChild(a);
        }
        ol.appendChild(li);
      });
      tbox.appendChild(ol);
      card.appendChild(S.el('p', { cls: 'hint', text: tr(S.layout.mode === 'phone' ? 'hintTouch' : 'hint') }));
      card.appendChild(S.el('p', { cls: 'where', id: 'where' }));
      updateOverviewWhere(S.state.cursorTs, true);
      return;
    }
    var k = S.chapterIndex(id);
    card.appendChild(S.el('p', { cls: 'kicker', text: tr('chapterOf', { n: k + 1, m: S.chapters.length }) + ' · ' + S.L(c.kicker) }));
    card.appendChild(S.el('h2', { cls: 'ch-title', text: S.L(c.title) }));
    if (!S.state.presenting) card.appendChild(S.el('p', { cls: 'summary', text: S.L(c.summary) }));
    else card.appendChild(S.el('p', { cls: 'pres-note', text: S.L(c.presenterNote) }));
    card.appendChild(S.el('ul', { cls: 'watch', id: 'watch', 'aria-label': tr('inThisChapter') }));
    var det = S.el('details', { cls: 'ch-body', id: 'ch-details' });
    if (!S.state.presenting && S.layout.mode !== 'phone') det.open = true;
    det.appendChild(S.el('summary', { text: S.state.presenting ? tr('details') : tr('readChapter') }));
    if (S.state.presenting) det.appendChild(S.el('p', { cls: 'summary-in', text: S.L(c.summary) }));
    var body = c.body ? (c.body[S.lang] || c.body.en || []) : [];
    body.forEach(function (p) { det.appendChild(S.el('p', null, [S.rich(p)])); });
    if (c.evidence && c.evidence.length) {
      det.appendChild(S.el('h3', { cls: 'card-h3', text: tr('evidence') }));
      var ul = S.el('ul', { cls: 'evidence' });
      c.evidence.forEach(function (ev) { ul.appendChild(S.el('li', null, [S.link(ev.url, S.L(ev.label))])); });
      det.appendChild(ul);
    }
    card.appendChild(det);
    if (!S.state.presenting) {
      var one = S.el('div', { cls: 'one-line' });
      one.appendChild(S.el('h3', { cls: 'card-h3', text: tr('inOneLine') }));
      one.appendChild(S.el('p', { text: S.L(c.presenterNote) }));
      card.appendChild(one);
    }
    updateWatch(S.idx(S.state.cursorTs));
  }
  function updateOverviewWhere(ts) {
    var el = $('where'); if (!el || S.state.chapterId !== 'overview') return;
    var c = S.chapterAt(ts); S.clear(el);
    if (!c) return;
    var k = S.chapterIndex(c.id);
    el.appendChild(document.createTextNode(tr('cursorIn', { n: k + 1, title: S.L(c.title) }) + ' '));
    var a = S.el('a', { href: '#' + c.id, text: '→ ' + tr('open') });
    a.addEventListener('click', function (ev) { ev.preventDefault(); S.goChapter(c.id, { keepCursor: true }); });
    el.appendChild(a);
  }

  // ---------------------------------------------------------------- playback (chapter-normalised)
  var play = null, wakeLock = null;
  function setPlayBtn() {
    var b = $('btn-play'), p = S.state.playing;
    [b, $('pt-play')].forEach(function (x) {
      if (!x) return;
      x.setAttribute('aria-pressed', p ? 'true' : 'false');
      x.setAttribute('aria-label', tr(p ? 'pause' : 'play')); x.title = tr(p ? 'pause' : 'play');
      x.querySelector('.ic').textContent = p ? '❚❚' : '▶';
    });
  }
  function schedule(fromOverview) {
    var D = 6000 / S.state.speed, segs = [];
    if (fromOverview) segs.push({ kind: 'intro', dur: 3000 / S.state.speed });
    S.chapters.forEach(function (c) { segs.push({ kind: 'ch', c: c, dur: D }); });
    return segs;
  }
  S.play = function () {
    if (S.state.playing || !S.chapters.length) return;
    var fromOv = S.state.chapterId === 'overview';
    var segs = schedule(fromOv), startSeg = 0, startOff = 0;
    if (!fromOv) {
      var k = S.chapterIndex(S.state.chapterId), c = S.chapters[k];
      startSeg = k;
      var ts = S.state.cursorTs;
      if (ts >= c.toTs - 1) { startSeg = k + 1; startOff = 0; if (startSeg >= segs.length) { startSeg = 0; } }
      else if (ts <= c.focusTs) startOff = 0.53 * S.clamp((ts - c.fromTs) / Math.max(1, c.focusTs - c.fromTs), 0, 1) * segs[startSeg].dur;
      else startOff = (0.8 + 0.2 * S.clamp((ts - c.focusTs) / Math.max(1, c.toTs - c.focusTs), 0, 1)) * segs[startSeg].dur;
    }
    var t0 = performance.now() - startOff, segStart = t0, si = startSeg;
    S.state.playing = true; setPlayBtn(); document.body.classList.add('playing');
    if (S.state.presenting) requestWake();
    var rm = S.reducedMotion();
    if (segs[si].kind === 'ch') { if (S.state.chapterId !== segs[si].c.id) S.goChapter(segs[si].c.id, { keepCursor: true }); }
    else { S.state.chapterId = 'overview'; S.setView(S.W0, S.W1, true); markStepper(); }
    function frame(now) {
      if (!S.state.playing) return;
      var seg = segs[si], el = now - segStart;
      if (el >= seg.dur) {
        si++; segStart = now; el = 0;
        if (si >= segs.length) { S.pause(); S.goChapter('overview'); return; }
        seg = segs[si];
        S.goChapter(seg.c.id, { keepCursor: true });
      }
      var p = el / seg.dur, ts;
      if (seg.kind === 'intro') ts = S.W0 + (S.W1 - S.W0) * S.ease(p);
      else {
        var c = seg.c;
        if (rm) ts = c.focusTs;
        else if (p < 0.53) ts = c.fromTs + (c.focusTs - c.fromTs) * S.ease(p / 0.53);
        else if (p < 0.8 || c.focusTs >= c.toTs) ts = c.focusTs;
        else ts = c.focusTs + (c.toTs - c.focusTs) * S.ease((p - 0.8) / 0.2);
      }
      S.setCursor(ts);
      var chip = seg.kind === 'ch' ? $('chip-' + seg.c.id) : $('chip-overview');
      document.querySelectorAll('#stepper .chip').forEach(function (b) { b.style.removeProperty('--p'); });
      if (chip) chip.style.setProperty('--p', p.toFixed(3));
      play = requestAnimationFrame(frame);
    }
    play = requestAnimationFrame(frame);
  };
  S.pause = function () {
    if (!S.state.playing) return;
    S.state.playing = false;
    if (play) cancelAnimationFrame(play); play = null;
    setPlayBtn(); document.body.classList.remove('playing');
    document.querySelectorAll('#stepper .chip').forEach(function (b) { b.style.removeProperty('--p'); });
    releaseWake();
  };
  S.togglePlay = function () { if (S.state.playing) S.pause(); else S.play(); };
  function requestWake() { try { if (navigator.wakeLock) navigator.wakeLock.request('screen').then(function (w) { wakeLock = w; }, function () { /* refused */ }); } catch (e) { /* no wake lock */ } }
  function releaseWake() { try { if (wakeLock) wakeLock.release(); } catch (e) { /* ignore */ } wakeLock = null; }
  S.stepChapter = function (dir) {
    S.pause();
    var ids = ['overview'].concat(S.chapters.map(function (c) { return c.id; }));
    var k = ids.indexOf(S.state.chapterId);
    S.goChapter(ids[S.clamp(k + dir, 0, ids.length - 1)]);
  };

  // ---------------------------------------------------------------- presenter mode
  S.setPresenting = function (on, fromClick) {
    if (on === S.state.presenting) return;
    S.state.presenting = on;
    document.body.classList.toggle('presenting', on);
    $('btn-present').textContent = on ? tr('exit') : tr('present');
    $('btn-present').setAttribute('aria-pressed', on ? 'true' : 'false');
    if (on) {
      if (fromClick) try { var de = document.documentElement; if (de.requestFullscreen && de.clientWidth >= 1024) de.requestFullscreen().catch(function () { /* refused */ }); } catch (e) { /* ignore */ }
      if (S.state.playing) requestWake();
      S.presLayout();
    } else {
      try { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function () { /* ignore */ }); } catch (e) { /* ignore */ }
      S.presH = null; S.presTriH = null;
      S.lanes.forEach(function (L) { if (L.root) L.root.classList.remove('pres-off'); });
      S.$$('.group-label').forEach(function (g) { g.classList.remove('pres-off'); });
      renderCard(); S.rebuild();
    }
  };
  S.presLayout = function () {
    if (!S.state.presenting) return;
    var c = S.chapterById(S.state.chapterId), keys = c ? (c.watch || []) : null, lit = [], look = S.lookLane(S.state.chapterId);
    S.lanes.forEach(function (L) {
      if (L.def.kind === 'events' || L.def.kind === 'social') return;
      var on = keys ? S.laneWatch(L.def).some(function (k) { return keys.indexOf(k) >= 0; }) : ['price', 'float', 'cost'].indexOf(L.id) >= 0;
      if (on || L.id === look) lit.push(L);
    });
    lit.sort(function (p, q) { return (q.id === look) - (p.id === look); });
    if (!lit.length) lit = [S.lanesById.price];
    var wide = document.documentElement.clientWidth >= 1024;
    var vh = window.innerHeight, maxLanes = vh >= 900 ? 3 : 2, chosen = lit.slice(0, maxLanes);
    function apply() {
      S.lanes.forEach(function (L) { if (L.root && L.def.kind !== 'events') L.root.classList.toggle('pres-off', wide && chosen.indexOf(L) < 0); });
      S.$$('.group-label').forEach(function (g) { g.classList.toggle('pres-off', wide); });
    }
    apply();
    S.presH = {};
    if (wide) {
      var bar = $('topbar').offsetHeight, avail = vh - bar - 16;
      S.presTriH = S.clamp(Math.round(avail * 0.42), 300, 380);
      var tb = $('timeblock').offsetHeight || 90;
      var rest = avail - S.presTriH - tb - 32 /* axis */ - chosen.length * 52 /* compact heads */ - 8;
      var wsum = chosen.reduce(function (s0, L) { return s0 + (L.def.presenterWeight || 1); }, 0);
      chosen.forEach(function (L) { S.presH[L.id] = Math.max(64, Math.floor(rest * (L.def.presenterWeight || 1) / wsum)); });
    } else S.presTriH = null;
    renderCard();
    S.rebuild();
    // measure-and-correct: shrink the lanes to 64 px, then drop the last watched lane; the triangle keeps >= 300 px
    if (wide) {
      for (var pass = 0; pass < 3; pass++) {
        var over = $('axis').getBoundingClientRect().bottom + window.scrollY - window.innerHeight + 6;
        if (over <= 2) break;
        var room = chosen.reduce(function (s0, L) { return s0 + Math.max(0, S.presH[L.id] - 64); }, 0);
        if (room >= over) {
          chosen.forEach(function (L) { var r0 = Math.max(0, S.presH[L.id] - 64); S.presH[L.id] = Math.round(S.presH[L.id] - over * r0 / room); });
        } else if (chosen.length > 1) {
          var gone = chosen.pop(); delete S.presH[gone.id];
          var share = Math.floor((over > room ? 0 : 0) + (S.presH[chosen[0].id] || 64));
          chosen.forEach(function (L) { S.presH[L.id] = Math.max(64, share); });
          apply();
        } else break;
        S.rebuild();
      }
    }
  };

  // ---------------------------------------------------------------- keyboard
  function inForm(t) { return t && (t.closest('input,select,textarea,[contenteditable=""],[contenteditable="true"]')); }
  function onKey(ev) {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    var t = ev.target && ev.target.nodeType === 1 ? ev.target : document.body, k = ev.key;
    if (k === 'Escape') {
      if (!$('keys-pop').hidden) { $('keys-pop').hidden = true; $('btn-keys').setAttribute('aria-expanded', 'false'); $('btn-keys').focus(); return; }
      if (!$('sheet').hidden) { closeSheet(); return; }
      if (S.pinned) { S.pinned = null; S.tip.hide(); return; }
      if (S.state.presenting) { S.setPresenting(false); return; }
      return;
    }
    if (inForm(t)) return;
    if (t && t.id === 'minimap') return; // slider handles its own keys
    var inStepper = t && t.closest && t.closest('#stepper');
    if ((k === 'ArrowLeft' || k === 'ArrowRight') && !inStepper) { ev.preventDefault(); S.stepChapter(k === 'ArrowRight' ? 1 : -1); return; }
    if (k === ' ' || k === 'Spacebar') { if (t && t.closest && t.closest('button,a,summary,[role=button]')) return; ev.preventDefault(); S.togglePlay(); return; }
    if (k === 'Home') { ev.preventDefault(); S.pause(); S.goChapter(S.chapters[0].id); return; }
    if (k === 'End') { ev.preventDefault(); S.pause(); S.goChapter(S.chapters[S.chapters.length - 1].id); return; }
    if (k === 'p' || k === 'P') { S.setPresenting(!S.state.presenting); return; }
    if (k === 'l' || k === 'L') { S.setLang(S.lang === 'en' ? 'zh' : 'en'); return; }
    if (k === 'n' || k === 'N') {
      var any = S.lanes.some(function (L) { return L.numBtn && !L.numbersOpen && !L.isCollapsed && !(L.root && L.root.classList.contains('pres-off')); });
      S.lanes.forEach(function (L) { if (L.numBtn && !L.isCollapsed) S.toggleNumbers(L, any); });
      return;
    }
    if (/^[0-8]$/.test(k)) { var n = +k; S.pause(); if (n === 0) S.goChapter('overview'); else if (S.chapters[n - 1]) S.goChapter(S.chapters[n - 1].id); }
  }
  function renderKeys() {
    var pop = $('keys-pop'); S.clear(pop);
    pop.appendChild(S.el('h2', { cls: 'card-h', text: tr('k.title') }));
    var dl = S.el('dl', { cls: 'keys' });
    [['← →', 'k.chapters'], ['Space', 'k.play'], ['Home End', 'k.ends'], ['0–8', 'k.jump'], ['P', 'k.present'], ['L', 'k.lang'], ['N', 'k.numbers'], ['Esc', 'k.esc'], ['⇄', 'k.slider']].forEach(function (r) {
      dl.appendChild(S.el('dt', null, r[0].split(' ').map(function (x) { return S.el('kbd', { text: x }); })));
      dl.appendChild(S.el('dd', { text: tr(r[1]) }));
    });
    pop.appendChild(dl);
  }

  // ---------------------------------------------------------------- phone chapter sheet
  function openSheet() {
    var sh = $('sheet'), list = $('sheet-list'); S.clear(list);
    $('sheet-title').textContent = tr('chapters');
    [{ id: 'overview', k: tr('ch.overview'), t: S.ST ? S.L(S.ST.title) : '' }].concat(S.chapters.map(function (c, i) { return { id: c.id, k: (i + 1) + ' · ' + S.L(c.kicker), t: S.L(c.title) }; })).forEach(function (it) {
      var b = S.el('button', { type: 'button', cls: 'sheet-item', id: 'sheet-' + it.id, 'aria-current': it.id === S.state.chapterId ? 'step' : null }, [S.el('span', { cls: 'kicker', text: it.k }), S.el('span', { cls: 'st', text: it.t })]);
      b.addEventListener('click', function () { closeSheet(); S.pause(); S.goChapter(it.id); });
      list.appendChild(b);
    });
    sh.hidden = false; $('pt-label').setAttribute('aria-expanded', 'true');
    var first = list.querySelector('[aria-current]') || list.firstChild; if (first) first.focus();
  }
  function closeSheet() { $('sheet').hidden = true; $('pt-label').setAttribute('aria-expanded', 'false'); $('pt-label').focus(); }

  // ---------------------------------------------------------------- On X lane (optional social.json)
  var KIND_SHAPE = { realtime: 'circle', analysis: 'square', claim: 'diamond', official: 'star', pushback: 'tri-down', meme: 'ring', retrospective: 'tri-up' };
  function shapePath(kind, x, y) {
    switch (KIND_SHAPE[kind] || 'circle') {
      case 'square': return 'M' + (x - 3.5) + ',' + (y - 3.5) + 'h7v7h-7z';
      case 'diamond': return 'M' + x + ',' + (y - 5) + 'l5,5l-5,5l-5,-5z';
      case 'star': return 'M' + x + ',' + (y - 5) + 'l1.5,3.3l3.6,.4l-2.7,2.4l.8,3.6l-3.2,-1.8l-3.2,1.8l.8,-3.6l-2.7,-2.4l3.6,-.4z';
      case 'tri-down': return 'M' + (x - 4.5) + ',' + (y - 3.5) + 'h9l-4.5,8z';
      case 'tri-up': return 'M' + (x - 4.5) + ',' + (y + 3.5) + 'h9l-4.5,-8z';
      case 'ring': return 'M' + (x - 4) + ',' + y + 'a4,4 0 1,0 8,0a4,4 0 1,0 -8,0';
      default: return 'M' + (x - 3.5) + ',' + y + 'a3.5,3.5 0 1,0 7,0a3.5,3.5 0 1,0 -7,0';
    }
  }
  S.socialLegend = function (L) {
    var kinds = {};
    (S.SO.posts || []).forEach(function (p) { kinds[p.kind] = 1; });
    L.legendEl.appendChild(S.el('span', { cls: 'lg' }, [S.el('i', { cls: 'key-rect', style: 'background:var(--text-primary);opacity:.45' }), tr('unit.social').split('·')[0].trim()]));
    Object.keys(kinds).forEach(function (k) {
      var svg = S.svg('svg', { width: 12, height: 12, 'aria-hidden': 'true', cls: 'lg-glyph' });
      S.svg('path', { d: shapePath(k, 6, 6), cls: 'glyph' + (KIND_SHAPE[k] === 'ring' ? ' ring' : '') }, svg);
      L.legendEl.appendChild(S.el('span', { cls: 'lg' }, [svg, tr('x.kind.' + k)]));
    });
    var inW = (S.SO.posts || []).filter(function (p) { return p.ts >= S.W0 && p.ts <= S.W1; }).length;
    L.subEl.textContent = (S.SO.hourlyDef ? S.L(S.SO.hourlyDef) + ' ' : '') + tr('x.markers', { n: inW, m: (S.SO.posts || []).length });
  };
  S.renderSocial = function (L) {
    var svg = L.svgEl, m = S.layout.m, W = L.plotEl.clientWidth || S.laneWidth, h = S.laneH(L), H = h + 6;
    S.clear(svg); svg.setAttribute('width', W); svg.setAttribute('height', H); L.plotEl.style.height = H + 'px';
    var x = S.xs, g = S.svg('g', null, svg), hourly = S.SO.hourly || [], max = 1;
    hourly.forEach(function (b) { if (b.n > max) max = b.n; });
    var sy = 2, sh = 14;
    S.svg('rect', { cls: 'x-strip-bg', x: m.l, y: sy, width: Math.max(0, W - m.l - m.r), height: sh }, g);
    hourly.forEach(function (b) {
      var x0 = Math.max(m.l, x(b.ts)), x1 = Math.min(W - m.r, x(b.ts + 3600));
      if (x1 <= x0 || !b.n) return;
      var r = S.svg('rect', { cls: 'x-cell', x: x0, y: sy, width: Math.max(1, x1 - x0 - (x1 - x0 > 3 ? 1 : 0)), height: sh, 'fill-opacity': (0.1 + 0.8 * Math.sqrt(b.n / max)).toFixed(2) }, g);
      var tt = S.svg('title', null, r); tt.textContent = S.fmtDT(b.ts) + ': ' + tr('x.perHour', { n: b.n });
    });
    var yy = sy + sh + 14;
    L.hits = [];
    (S.SO.posts || []).forEach(function (p) {
      if (p.ts < S.view.d0 || p.ts > S.view.d1) return;
      var px = x(p.ts);
      var hit = S.svg('g', { cls: 'x-hit', tabindex: '0', role: 'button' }, g);
      S.svg('rect', { x: px - 12, y: yy - 12, width: 24, height: 24, fill: 'transparent' }, hit);
      S.svg('path', { cls: 'glyph' + (KIND_SHAPE[p.kind] === 'ring' ? ' ring' : ''), d: shapePath(p.kind, px, yy) }, hit);
      hit.setAttribute('aria-label', authorName(p) + ', ' + S.fmtDT(p.ts) + ': ' + S.L(p.paraphrase));
      function show(ev, pin) {
        var r = hit.getBoundingClientRect();
        S.pinned = pin ? p : null;
        S.tip.show(ev && ev.clientX != null ? ev.clientX : r.left, ev && ev.clientY != null ? ev.clientY : r.bottom, function (t) { postTip(t, p, pin); }, pin);
      }
      hit.addEventListener('pointerenter', function (ev) { if (!S.pinned && ev.pointerType === 'mouse') show(ev, false); });
      hit.addEventListener('pointerleave', function () { if (!S.pinned) S.tip.hide(); });
      hit.addEventListener('focus', function () { if (!S.pinned) show(null, false); });
      hit.addEventListener('blur', function () { if (!S.pinned) S.tip.hide(); });
      hit.addEventListener('pointerdown', function (ev) { ev.stopPropagation(); });
      function pin(ev) { ev.preventDefault(); ev.stopPropagation(); S.userScrub(p.ts, true, false, 'floor'); show(ev.clientX != null ? ev : null, true); }
      hit.addEventListener('click', pin);
      hit.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') pin(ev); });
    });
    svg.setAttribute('aria-label', tr('lane.social'));
  };
  function authorName(p) { return p.author ? (p.author.displayI18n ? S.L(p.author.displayI18n) : (p.author.display || '')) : ''; }
  function verdictChip(c) {
    var v = c.verdict || 'unverifiable';
    return S.el('span', { cls: 'verdict v-' + v }, [S.el('i', { 'aria-hidden': 'true', text: ({ supported: '✓', partly: '≈', contradicted: '✗', unverifiable: '?' })[v] || '?' }), tr('x.verdict.' + v)]);
  }
  function postTip(t, p, pinned) {
    var head = S.el('div', { cls: 'tip-time', text: S.fmtDT(p.ts) + (p.kind ? ' · ' + tr('x.kind.' + p.kind) : '') });
    t.appendChild(head);
    if (p.author) t.appendChild(S.el('div', { cls: 'tip-strong', text: authorName(p) + (p.author.followersBucket ? ' · ' + tr('x.followers', { b: p.author.followersBucket }) : '') }));
    t.appendChild(S.el('p', { cls: 'tip-para', text: S.L(p.paraphrase) }));
    (p.claims || []).forEach(function (c) {
      var row = S.el('div', { cls: 'claim' });
      row.appendChild(verdictChip(c));
      row.appendChild(document.createTextNode(' ' + S.L(c.what) + (c.value != null ? ': ' + c.value + (c.unit ? ' ' + c.unit : '') : '')));
      if (c.onchain && c.onchain.value != null) row.appendChild(S.el('span', { cls: 'tip-note', text: ' · ' + tr('x.onchain', { v: c.onchain.value }) }));
      if (c.note) row.appendChild(S.el('div', { cls: 'tip-note', text: S.L(c.note) }));
      t.appendChild(row);
    });
    if (p.url) {
      var bar = S.el('div', { cls: 'tip-actions' });
      bar.appendChild(S.link(p.url, tr('x.open') + ' ↗'));
      if (pinned) { var cb = S.el('button', { type: 'button', cls: 'tool', id: 'tip-close', text: tr('x.close') }); cb.addEventListener('click', function () { S.pinned = null; S.tip.hide(); }); bar.appendChild(cb); }
      t.appendChild(bar);
    }
  }
  S.socialCursor = function (L, ts) {
    if (!S.xs || !L.cursorEl) return;
    L.cursorEl.style.transform = 'translateX(' + S.xs(ts).toFixed(1) + 'px)';
    L.cursorEl.hidden = ts < S.view.d0 || ts > S.view.d1;
    var n = 0; (S.SO.hourly || []).forEach(function (b) { if (ts >= b.ts && ts < b.ts + 3600) n = b.n; });
    S.renderParts(L.readoutEl, [{ v: S.fmtInt(n), l: tr('x.perHour', { n: '' }).replace(/\s+/g, ' ').trim() }]);
  };

  // ---------------------------------------------------------------- sections below the stage
  var MECH_CH = ['fence', 'climb', 'climb', 'peak', 'reopen', 'mint'];
  function sec(id, titleKey) {
    var s = S.el('section', { cls: 'sec', id: id, 'aria-labelledby': id + '-h' });
    s.appendChild(S.el('h2', { id: id + '-h', text: tr(titleKey) }));
    return s;
  }
  function renderSections() {
    var host = $('sections'); S.clear(host);
    var ST = S.ST;
    if (ST) {
      var s1 = sec('how', 'sec.mechanism'), ol = S.el('ol', { cls: 'mechanism' });
      (ST.mechanism || []).forEach(function (m, k) {
        var li = S.el('li', null, [S.rich(S.L(m))]);
        var cid = MECH_CH[k], ci = S.chapterIndex(cid);
        if (ci >= 0) { var a = S.el('a', { href: '#' + cid, cls: 'to-ch', text: '→ ' + CH_SHORT(S.chapters[ci]) }); a.addEventListener('click', function (ev) { ev.preventDefault(); S.goChapter(cid); window.scrollTo({ top: 0, behavior: S.reducedMotion() ? 'auto' : 'smooth' }); }); li.appendChild(document.createTextNode(' ')); li.appendChild(a); }
        ol.appendChild(li);
      });
      s1.appendChild(ol); host.appendChild(s1);
      var s2 = sec('roles', 'sec.roles'), dl = S.el('dl', { cls: 'roles' });
      (ST.roles || []).forEach(function (r) { dl.appendChild(S.el('div', { cls: 'role' }, [S.el('dt', { text: S.L(r.who) }), S.el('dd', { text: S.L(r.outcome) })])); });
      s2.appendChild(dl); host.appendChild(s2);
    }
    if (ST && S.D) {
      var s3 = sec('hakari', 'sec.hakari');
      // story.hakari paragraphs (blank-line separated): the cost pair follows the first, the max-safe-exposure pair the second
      var paras = S.L(ST.hakari).split(/\n\s*\n/), para = function (k) { if (paras[k]) s3.appendChild(S.el('p', { cls: 'prose' }, [S.rich(paras[k])])); };
      para(0);
      var up = S.ser('pushUp10CostUsdg');
      if (up) {
        var a0 = up[S.baseI], ti = S.idx(S.hakariTs), b0 = up[ti];
        var hero = S.el('div', { cls: 'hakari-hero' });
        hero.appendChild(S.el('p', { cls: 'hh-pair' }, [S.el('span', { cls: 'hh-v', text: S.fmtUsdg(a0) }), S.el('span', { cls: 'hh-arrow', text: '→' }), S.el('i', { cls: 'key-line', style: 'background:var(--hakari)', 'aria-hidden': 'true' }), S.el('span', { cls: 'hh-v', text: S.fmtUsdg(b0) }), S.el('span', { cls: 'hh-u', text: tr('hakari.unit') })]));
        hero.appendChild(S.el('p', { cls: 'hh-sub', text: tr('hakari.sub', { a: S.fmtWdHM(S.baseTs), b: S.fmtWdHM(S.t[ti]), z: S.zoneLabel(), x: S.fmtFixed(a0 / b0, 0) }) }));
        var mn = Infinity, mj = 0; for (var q = S.idx(S.fenceFrom); q < S.idx(S.firstMintTs || S.W1); q++) if (up[q] != null && up[q] < mn) { mn = up[q]; mj = q; }
        if (mn < Infinity) hero.appendChild(S.el('p', { cls: 'hh-sub', text: tr('hakari.min', { v: S.fmtUsdg(mn), t: S.fmtWdHM(S.t[mj]) + ' ' + S.zoneLabel() }) }));
        s3.appendChild(hero);
      }
      para(1);
      // the bound v1 decides with (S.hkEffArr), the one every "max safe exposure" on the page shows
      var ms = S.hkEffArr ? S.hkEffArr() : null, dec = S.ser('hakari.decision.e1000');
      if (ms && dec) {
        var m0 = ms[S.baseI], lo = Infinity, lj = 0, nref = 0, nclosed = 0, mintTs = S.firstMintTs || S.W1;
        for (var r = S.idx(S.fenceFrom); r < S.idx(mintTs); r++) if (ms[r] != null && ms[r] < lo) { lo = ms[r]; lj = r; }
        for (var r2 = 0; r2 < S.N; r2++) if (dec[r2] === 0) { nref++; if (S.t[r2] >= S.fenceFrom && S.t[r2] <= mintTs) nclosed++; }
        var hero2 = S.el('div', { cls: 'hakari-hero' });
        hero2.appendChild(S.el('p', { cls: 'hh-pair' }, [S.el('span', { cls: 'hh-v', text: S.fmtBound(m0) }), S.el('span', { cls: 'hh-arrow', text: '→' }), S.el('i', { cls: 'key-line', style: 'background:var(--hakari)', 'aria-hidden': 'true' }), S.el('span', { cls: 'hh-v', text: S.fmtBound(lo) }), S.el('span', { cls: 'hh-u', text: tr('hakari.mseUnit') })]));
        hero2.appendChild(S.el('p', { cls: 'hh-sub', text: tr('hakari.mseSub', { a: S.fmtWdHM(S.baseTs), b: S.fmtWdHM(S.t[lj]), z: S.zoneLabel(), m: S.fmtInt(nref), c: S.fmtInt(nclosed) }) }));
        var jump = S.el('a', { href: '#lane-hakari', cls: 'to-ch', text: '→ ' + tr('hakari.toLanes') });
        jump.addEventListener('click', function (ev) { var t = $('lane-hakari'); if (!t) return; ev.preventDefault(); t.scrollIntoView({ behavior: S.reducedMotion() ? 'auto' : 'smooth', block: 'center' }); });
        hero2.appendChild(S.el('p', { cls: 'hh-sub' }, [jump]));
        s3.appendChild(hero2);
      }
      for (var pk = 2; pk < paras.length; pk++) para(pk);
      var gl = S.el('p'); gl.appendChild(S.link((window.SQZ_BACK ? window.SQZ_BACK : '../index.html#hims-price'), tr('hakari.link'))); s3.appendChild(gl);
      host.appendChild(s3);
    }
    if (S.SO) host.appendChild(socialSection());
    if (ST && ST.next) {
      var s4 = sec('next', 'sec.next');
      var np = S.el('p', { cls: 'prose', text: S.L(ST.next) + ' ' });
      if (S.lanesById && S.lanesById.hakari) {
        var na = S.el('a', { href: '#lane-hakari', text: tr('next.lane') });
        na.addEventListener('click', function (ev) { var t = $('lane-hakari'); if (!t) return; ev.preventDefault(); t.scrollIntoView({ behavior: S.reducedMotion() ? 'auto' : 'smooth', block: 'center' }); });
        np.appendChild(na);
      }
      s4.appendChild(np);
      var vp = S.el('p'); vp.appendChild(S.link('https://vexi-v1.github.io/vexi-hakari/web/vexi/', tr('next.vexi'))); s4.appendChild(vp);
      host.appendChild(s4);
    }
    if (ST && ST.glossary) {
      var s5 = sec('glossary', 'sec.glossary'), gdl = S.el('dl', { cls: 'glossary' });
      ST.glossary.forEach(function (g) { gdl.appendChild(S.el('div', { cls: 'gl' }, [S.el('dt', { text: S.L(g.term) }), S.el('dd', { text: S.L(g.def) })])); });
      s5.appendChild(gdl); host.appendChild(s5);
    }
    host.appendChild(referenceSection());
    var f = $('footer-line'); S.clear(f);
    f.appendChild(document.createTextNode(tr('footer')));
    f.appendChild(S.link('https://github.com/vexi-v1/vexi-hakari', tr('source')));
  }
  function socialSection() {
    var s = sec('on-x', 'sec.social'), SO = S.SO, c = SO.counts || {};
    if (c.collected != null || c.curated != null) s.appendChild(S.el('p', { cls: 'meta', text: tr('x.counts', { c: S.fmtInt(c.curated != null ? c.curated : (SO.posts || []).length), r: S.fmtInt(c.relevant), t: S.fmtInt(c.collected) }) }));
    if (SO.findings && SO.findings.length) {
      s.appendChild(S.el('h3', { text: tr('x.findings') }));
      var ul = S.el('ul', { cls: 'plain' }); SO.findings.forEach(function (f) { ul.appendChild(S.el('li', { text: S.L(f) })); }); s.appendChild(ul);
    }
    if (SO.limits && SO.limits.length) {
      s.appendChild(S.el('h3', { text: tr('x.limits') }));
      var ul2 = S.el('ul', { cls: 'plain' }); SO.limits.forEach(function (f) { ul2.appendChild(S.el('li', { text: S.L(f) })); }); s.appendChild(ul2);
    }
    // the table twin of the On X lane: every curated post, including those outside the replay window
    var posts = (SO.posts || []).slice().sort(function (a, b) { return a.ts - b.ts; });
    if (posts.length) {
      var det = S.el('details', { cls: 'numbers-used', id: 'x-posts' });
      det.appendChild(S.el('summary', { text: tr('x.all', { n: posts.length }) }));
      var w = S.el('div', { cls: 'tablewrap' }), tb = S.el('table', { cls: 'nu' }), body = S.el('tbody');
      tb.appendChild(S.el('thead', null, [S.el('tr', null, [S.el('th', { text: tr('tbl.time') + ' (UTC)' }), S.el('th', { text: tr('x.who') }), S.el('th', { text: tr('x.said') }), S.el('th', { text: tr('x.checked') })])]));
      posts.forEach(function (p) {
        var inWin = p.ts >= S.W0 && p.ts <= S.W1;
        var when = S.el('th', { scope: 'row' }, [S.isoUTC(p.ts).slice(5, 16).replace('T', ' ')]);
        if (!inWin) when.appendChild(S.el('span', { cls: 'src', text: ' · ' + tr('x.outside') }));
        var said = S.el('td', null, [S.el('span', { cls: 'x-kind', text: tr('x.kind.' + p.kind) + ' · ' }), S.L(p.paraphrase) + ' ']);
        if (p.url) said.appendChild(S.link(p.url, '↗'));
        var chk = S.el('td', { cls: 'src' });
        (p.claims || []).forEach(function (c0) { chk.appendChild(S.el('div', null, [verdictChip(c0), ' ' + S.L(c0.what)])); });
        body.appendChild(S.el('tr', null, [when, S.el('td', { text: authorName(p) }), said, chk]));
      });
      tb.appendChild(body); w.appendChild(tb); det.appendChild(w); s.appendChild(det);
    }
    return s;
  }
  var MEASURE = {
    usdgPerHims: { en: 'HIMS/USDG price', zh: 'HIMS/USDG 價格' }, himsPrincipal: { en: 'HIMS in dollar pool (principal)', zh: '美元池 HIMS（本金）' },
    usdgPrincipal: { en: 'USDG in dollar pool (principal)', zh: '美元池 USDG（本金）' }, supply: { en: 'HIMS supply', zh: 'HIMS 供給' },
    himsSupply: { en: 'HIMS supply', zh: 'HIMS 供給' }, himsInPoolManager: { en: 'HIMS in v4 PoolManager', zh: 'v4 PoolManager 內 HIMS' },
    pushUp10CostUsdg: { en: 'Cost to push +10%', zh: '推高 10% 成本' }, pushUp10: { en: 'Cost to push +10%', zh: '推高 10% 成本' },
    himsInBonerHims: { en: 'HIMS in BONER pool (principal)', zh: 'BONER 池 HIMS（本金）' }, himsInHimsUsdg: { en: 'HIMS in dollar pool (principal)', zh: '美元池 HIMS（本金）' },
    himsPerBoner: { en: 'HIMS per BONER', zh: '每顆 BONER 的 HIMS' }, bonerHims: { en: 'HIMS per BONER', zh: '每顆 BONER 的 HIMS' },
    premiumPct: { en: 'Premium vs NAV (%)', zh: '相對淨值溢價（%）' }, mints: { en: 'Mints', zh: '鑄造次數' }, minted: { en: 'HIMS minted', zh: '鑄造的 HIMS' },
    himsInUniswapV4: { en: 'HIMS in Uniswap v4 (PoolManager)', zh: 'Uniswap v4（PoolManager）內 HIMS' },
    pushDown10CostHims: { en: 'Cost to push −10% (HIMS)', zh: '下壓 10% 成本（HIMS）' },
    amountsHims: { en: 'Burned HIMS', zh: '銷毀的 HIMS' }, times: { en: 'Times (UTC)', zh: '時間（UTC）' }, from: { en: 'From', zh: '來源地址' },
    time: { en: 'Time (UTC)', zh: '時間（UTC）' }, amountHims: { en: 'HIMS', zh: 'HIMS' }, tx: { en: 'Transaction', zh: '交易' }, signer: { en: 'Signer', zh: '簽署者' },
    count: { en: 'Mints', zh: '鑄造次數' }, totalHims: { en: 'HIMS minted', zh: '鑄造的 HIMS' }, burns: { en: 'Burns', zh: '銷毀次數' },
    usdgPerBonerViaHims: { en: 'BONER in USDG (via HIMS)', zh: 'BONER 的 USDG 價（經 HIMS）' }, usdPerBoner: { en: 'BONER in USD', zh: 'BONER 美元價' },
    impliedCapUsd: { en: 'BONER implied value', zh: 'BONER 隱含市值' }, usdgInHimsUsdg: { en: 'USDG in dollar pool (principal)', zh: '美元池 USDG（本金）' },
    shareOfSupplyPct: { en: 'Share of supply (%)', zh: '佔供給比例（%）' }, valueUsdg: { en: 'Pool value (USDG)', zh: '池子價值（USDG）' }, valueUsd: { en: 'Pool value', zh: '池子價值' },
    grossUsdg: { en: 'Gross gain (USDG)', zh: '毛利（USDG）' }
  };
  var ALIAS = { himsInUniswapV4: ['himsInPoolManager'], usdPerBoner: ['usdgPerBonerViaHims'], valueUsd: ['valueUsdg'] };
  function fmtAny(v) {
    if (Array.isArray(v)) return v.map(fmtAny).join(', ');
    if (typeof v === 'number' && isFinite(v)) {
      var dec = (String(v).split('.')[1] || '').length; // show the value at the precision data.json carries (6 significant digits)
      return Math.abs(v) < 1e-3 && v !== 0 ? S.fmtSig(v, 4) : S.fmtFixed(v, Math.min(dec, 6));
    }
    if (typeof v === 'string' && /^0x[0-9a-f]{40,64}$/i.test(v)) return S.shortHash(v);
    if (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v)) return v.replace('T', ' ').replace(/\.\d+Z$|Z$/, '');
    if (typeof v === 'boolean') return v ? '✓' : '✗';
    if (typeof v === 'number') { var a = Math.abs(v); return a >= 1000 ? S.fmtFixed(v, a >= 10000 ? 0 : 1) : a >= 1 ? S.fmtFixed(v, a >= 100 ? 2 : 4).replace(/0+$/, '').replace(/\.$/, '') : S.fmtSig(v, 4); }
    if (v == null) return '—';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }
  function matchPill(m) {
    var k = m === 'exact' ? 'exact' : (m === 'close' ? 'close' : 'differs');
    return S.el('span', { cls: 'match m-' + k }, [S.el('i', { 'aria-hidden': 'true', text: k === 'exact' ? '✓' : (k === 'close' ? '≈' : '!') }), tr('xc.' + k)]);
  }
  function referenceSection() {
    var s = S.el('section', { cls: 'sec reference', id: 'reference', 'aria-labelledby': 'reference-h' });
    s.appendChild(S.el('h2', { id: 'reference-h', text: tr('sec.reference') }));
    var nav = S.el('nav', { cls: 'ref-nav', 'aria-label': tr('sec.reference') });
    [['ref-numbers', 'ref.numbers'], ['ref-sources', 'ref.sources'], ['ref-method', 'ref.method'], ['ref-caveats', 'ref.caveats']].forEach(function (p, k) {
      if (k) nav.appendChild(document.createTextNode(' · '));
      nav.appendChild(S.el('a', { href: '#' + p[0], text: tr(p[1]) }));
    });
    s.appendChild(nav);
    var D = S.D, ST = S.ST;
    // Numbers
    var n = S.el('div', { cls: 'ref-block', id: 'ref-numbers' });
    n.appendChild(S.el('h3', { text: tr('ref.numbers') + tr('colon') + tr('xc.title') }));
    var anchors = (D && D.anchors) || [];
    if (anchors.length) {
      // Grouped by anchor: a header row (moment, label, block, Show), one row per measure, then the note.
      var wrap = S.el('div', { cls: 'tablewrap xc-wrap' }), tb = S.el('table', { cls: 'xc' }), head = S.el('tr');
      ['xc.measure', 'xc.ours', 'xc.ref', 'xc.match'].forEach(function (h) { head.appendChild(S.el('th', { scope: 'col', text: tr(h) })); });
      tb.appendChild(S.el('thead', null, [head]));
      var body = S.el('tbody');
      anchors.forEach(function (a, ai) {
        var ours = a.ours && typeof a.ours === 'object' ? a.ours : { value: a.ours };
        var ref = a.reference && typeof a.reference === 'object' ? a.reference : { value: a.reference };
        var pairs = [];
        Object.keys(ref).forEach(function (rk) {
          if (rk === 'source' || rk === 'url' || rk === 'note') return;
          var ok = ours[rk] !== undefined ? rk : (ALIAS[rk] || []).filter(function (x) { return ours[x] !== undefined; })[0];
          if (ok) pairs.push([ok, rk]);
        });
        if (!pairs.length) pairs = Object.keys(ours).slice(0, 1).map(function (k) { return [k, k]; });
        var txKey = ['priceSwapTx', 'swapTx', 'tx'].filter(function (x) { return typeof ours[x] === 'string' && /^0x[0-9a-f]{64}$/i.test(ours[x]); })[0];
        var hr = S.el('tr', { cls: 'xc-group' }), hc = S.el('th', { colspan: '4', scope: 'rowgroup' });
        hc.appendChild(S.el('span', { cls: 'xc-when', text: a.ts ? S.isoUTC(a.ts).slice(5, 19).replace('T', ' ') + ' UTC' : '' }));
        hc.appendChild(S.el('span', { cls: 'xc-label', text: S.L(a.label) }));
        if (a.block) hc.appendChild(S.el('span', { cls: 'xc-block' }, [tr('block') + ' ', S.link(S.blockUrl(a.block), S.fmtInt(a.block), 'mono')]));
        if (a.ts) {
          var b = S.el('button', { type: 'button', cls: 'tool', id: 'xc-show-' + ai, text: tr('xc.show') });
          b.addEventListener('click', function () { var c = S.chapterAt(a.ts); S.pause(); if (c) S.goChapter(c.id, { keepCursor: true }); S.userScrub(a.ts, true, false, 'floor'); S.scrubEnd(); window.scrollTo({ top: 0, behavior: S.reducedMotion() ? 'auto' : 'smooth' }); });
          hc.appendChild(b);
        }
        hr.appendChild(hc); body.appendChild(hr);
        pairs.forEach(function (pr) {
          var k = pr[0], rk = pr[1], r = S.el('tr');
          r.appendChild(S.el('th', { scope: 'row', cls: 'l', text: MEASURE[k] ? S.L(MEASURE[k]) : (MEASURE[rk] ? S.L(MEASURE[rk]) : k) }));
          r.appendChild(S.el('td', { text: fmtAny(ours[k]) }));
          r.appendChild(S.el('td', { text: fmtAny(ref[rk]) }));
          var mt = a.match && typeof a.match === 'object' ? a.match[k] : a.match;
          r.appendChild(S.el('td', { cls: 'l' }, [matchPill(mt)]));
          body.appendChild(r);
        });
        var src = ref.source || a.source || '';
        var nr = S.el('tr', { cls: 'xc-note' }), nc = S.el('td', { colspan: '4' });
        if (src) nc.appendChild(S.el('span', { cls: 'xc-src', text: (typeof src === 'string' ? src : S.L(src)) + (a.note ? ' · ' : '') }));
        if (a.note) nc.appendChild(document.createTextNode(S.L(a.note)));
        if (txKey) { nc.appendChild(document.createTextNode(' ')); nc.appendChild(S.link(S.txUrl(ours[txKey]), '↗ ' + S.shortHash(ours[txKey]), 'mono')); }
        nr.appendChild(nc); body.appendChild(nr);
      });
      tb.appendChild(body); wrap.appendChild(tb); n.appendChild(wrap);
      n.appendChild(S.el('p', { cls: 'meta', text: tr('xc.legend') }));
    } else n.appendChild(S.el('p', { cls: 'meta', text: tr('xc.none') }));
    if (ST && ST.numbersUsed) {
      var det = S.el('details', { cls: 'numbers-used' });
      det.appendChild(S.el('summary', { text: tr('num.every', { n: ST.numbersUsed.length }) }));
      var w2 = S.el('div', { cls: 'tablewrap' }), t2 = S.el('table', { cls: 'nu' });
      t2.appendChild(S.el('thead', null, [S.el('tr', null, [S.el('th', { text: tr('num.value') }), S.el('th', { text: tr('num.meaning') }), S.el('th', { text: tr('num.source') })])]));
      var b2 = S.el('tbody');
      ST.numbersUsed.forEach(function (u) { b2.appendChild(S.el('tr', null, [S.el('th', { scope: 'row', text: u.value }), S.el('td', { text: S.L(u.meaning) }), S.el('td', { cls: 'src', text: S.L(u.source) })])); });
      t2.appendChild(b2); w2.appendChild(t2); det.appendChild(w2); n.appendChild(det);
    }
    s.appendChild(n);
    // Sources
    var so = S.el('div', { cls: 'ref-block', id: 'ref-sources' });
    so.appendChild(S.el('h3', { text: tr('ref.sources') }));
    if (ST && ST.sources) {
      var ul = S.el('ul', { cls: 'sources' });
      ST.sources.forEach(function (x) { ul.appendChild(S.el('li', null, [x.url ? S.link(x.url, S.L(x.label)) : S.el('span', { text: S.L(x.label) }), x.note ? S.el('span', { cls: 'src-note', text: S.L(x.note) }) : null])); });
      so.appendChild(ul);
    }
    if (S.SO && S.SO.method) {
      so.appendChild(S.el('h4', { text: tr('src.x') }));
      so.appendChild(S.el('p', { cls: 'prose small', text: S.L(S.SO.method) }));
    }
    if (D) {
      so.appendChild(S.el('h4', { text: tr('src.identity') }));
      var dl = S.el('dl', { cls: 'identity' });
      function row(k, v) { dl.appendChild(S.el('dt', { text: k })); dl.appendChild(S.el('dd', null, v)); }
      row(tr('src.chain'), [(D.chain.name || 'Robinhood Chain') + ' · ' + D.chain.id]);
      row(tr('src.explorer'), [S.link(D.chain.explorer, D.chain.explorer.replace(/^https?:\/\//, ''))]);
      var toks = S.el('span', { cls: 'id-list' });
      Object.keys(D.tokens || {}).forEach(function (k) { var t = D.tokens[k]; toks.appendChild(S.el('span', { cls: 'id-item' }, [S.el('strong', { text: k }), ' ', S.link(S.addrUrl(t.address, 'token'), t.address, 'mono'), t.decimals != null ? ' · ' + t.decimals + ' dec' : ''])); });
      row(tr('src.tokens'), [toks]);
      var pl = S.el('span', { cls: 'id-list' });
      ['himsUsdg', 'bonerHims', 'bonerUsdg'].forEach(function (k) {
        var p = D.pools && D.pools[k]; if (!p) return;
        pl.appendChild(S.el('span', { cls: 'id-item' }, [S.el('strong', { text: p.label || k }), ' ', S.el('code', { cls: 'mono break', text: p.id }),
          ' · ' + tr('src.fee') + ' ' + p.fee + ' · ' + tr('src.tickSpacing') + ' ' + p.tickSpacing + ' · ' + tr('src.hooks') + ' ', S.el('code', { cls: 'mono', text: S.shortHash(p.hooks) }), p.initBlock ? ' · ' + tr('src.init') + ' ' + S.fmtInt(p.initBlock) : '']));
      });
      row(tr('src.pools'), [pl]);
      so.appendChild(dl);
      var others = (D.pools && D.pools.others) || [];
      if (others.length) {
        var det2 = S.el('details');
        det2.appendChild(S.el('summary', { text: tr('src.others') + ' (' + others.length + ')' }));
        var w3 = S.el('div', { cls: 'tablewrap' }), t3 = S.el('table', { cls: 'nu' }), b3 = S.el('tbody');
        others.forEach(function (o) { b3.appendChild(S.el('tr', null, [S.el('th', { scope: 'row', text: o.label || o.pair || S.shortHash(o.id) }), S.el('td', { text: [o.swapsInWindow, o.swaps, o.windowSwaps].filter(function (x) { return x != null; }).map(function (x) { return S.fmtInt(x) + ' swaps'; })[0] || '' }), S.el('td', { cls: 'src', text: o.volumeNote || (o.volume != null ? S.fmtCompact(o.volume) + ' ' + (o.volumeUnit || '') : '') })])); });
        t3.appendChild(b3); w3.appendChild(t3); det2.appendChild(w3); so.appendChild(det2);
      }
    }
    s.appendChild(so);
    // Method
    var me = S.el('div', { cls: 'ref-block', id: 'ref-method' });
    me.appendChild(S.el('h3', { text: tr('ref.method') }));
    if (D) {
      var w = D.window || {};
      [['m.window', tr('m.windowText', { a: S.isoUTC(S.W0).replace('T', ' ').replace('Z', ''), b: S.isoUTC(S.W1).replace('T', ' ').replace('Z', ''), fb: S.fmtInt(w.fromBlock), tb: S.fmtInt(w.toBlock), step: S.step, n: S.fmtInt(S.N) })],
        ['m.prices', tr('m.pricesText')], ['m.inventory', tr('m.inventoryText')], ['m.supply', tr('m.supplyText')], ['m.cost', tr('m.costText')]]
        .forEach(function (p) { me.appendChild(S.el('p', { cls: 'prose small' }, [S.el('strong', { text: tr(p[0]) + '. ' }), p[1]])); });
      var HK = D.hakari;
      if (HK) {
        var hp = S.el('p', { cls: 'prose small', id: 'ref-hakari' }, [S.el('strong', { text: tr('m.hakari') + '. ' }), S.L(HK.what) + ' ' + tr('m.hakariText') + ' ']);
        hp.appendChild(S.link('../../' + (HK.summaryFile || 'gauge/data/hims-hook-replay.json'), (HK.summaryFile || 'gauge/data/hims-hook-replay.json').split('/').pop()));
        hp.appendChild(document.createTextNode(' · ' + tr('m.hakariCmd') + ' '));
        hp.appendChild(S.el('code', { text: 'cd gauge && ' + (HK.command || 'npm run hims:hook') + ' && npm run squeeze:build' }));
        hp.appendChild(document.createTextNode(' · '));
        hp.appendChild(S.link('../../' + (HK.code || 'gauge/src/squeeze/hakari-read.ts'), (HK.code || 'gauge/src/squeeze/hakari-read.ts').split('/').pop()));
        me.appendChild(hp);
        me.appendChild(S.el('h4', { text: tr('m.hakariAssume') }));
        var hl = S.el('ul', { cls: 'plain small' });
        (HK.caveats || []).forEach(function (c) { hl.appendChild(S.el('li', { text: S.L(c) })); });
        me.appendChild(hl);
        if (HK.assumptions && HK.assumptions.length) {
          var ad = S.el('details', { cls: 'numbers-used' });
          ad.appendChild(S.el('summary', { text: tr('m.hakariFull', { n: HK.assumptions.length }) }));
          var al = S.el('ol', { cls: 'plain small', lang: 'en' });
          HK.assumptions.forEach(function (a) { al.appendChild(S.el('li', { text: a })); });
          ad.appendChild(al); me.appendChild(ad);
        }
      }
      var checks = D.checks || [];
      if (checks.length) {
        me.appendChild(S.el('h4', { text: tr('m.checks') }));
        var cl = S.el('ul', { cls: 'checks' });
        checks.forEach(function (c) { cl.appendChild(S.el('li', { cls: c.pass ? 'ok' : 'bad' }, [S.el('span', { cls: 'chk', 'aria-hidden': 'true', text: c.pass ? '✓' : '✗' }), S.el('span', { cls: 'sr-only', text: tr(c.pass ? 'm.pass' : 'm.fail') + ': ' }), S.el('code', { text: c.name }), c.detail ? ' ' + (typeof c.detail === 'string' ? c.detail : JSON.stringify(c.detail)) : ''])); });
        me.appendChild(cl);
      }
      me.appendChild(S.el('p', { cls: 'prose small' }, [S.el('strong', { text: tr('m.caching') + '. ' }), tr('m.cachingText', { g: D.generatedAt ? D.generatedAt.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—' })]));
    }
    if (S.SO && S.SO.method) me.appendChild(S.el('p', { cls: 'prose small' }, [S.el('strong', { text: tr('m.social') + '. ' }), S.L(S.SO.method)]));
    s.appendChild(me);
    // Caveats: data first, then story, de-duplicated by EN text
    var cv = S.el('div', { cls: 'ref-block', id: 'ref-caveats' });
    cv.appendChild(S.el('h3', { text: tr('ref.caveats') }));
    var seen = {}, cu = S.el('ul', { cls: 'caveats' });
    var hkCav = D && D.hakari && D.hakari.caveats ? [D.hakari.caveats[0], D.hakari.caveats[2]].filter(Boolean) : [];
    ((D && D.caveats) || []).concat(hkCav).concat((ST && ST.caveats) || []).concat((S.SO && S.SO.limits) ? [] : []).forEach(function (c) {
      var key = (c.en || String(c)).trim(); if (seen[key]) return; seen[key] = 1;
      cu.appendChild(S.el('li', { text: S.L(c) }));
    });
    cv.appendChild(cu);
    s.appendChild(cv);
    return s;
  }

  // ---------------------------------------------------------------- errors
  function errorPanel() {
    var st = $('stage');
    var p = S.el('div', { cls: 'error-panel', role: 'alert' }, [S.el('p', { text: tr('err.data') })]);
    st.parentNode.insertBefore(p, st);
    st.hidden = true;
  }

  // ---------------------------------------------------------------- init
  function wire() {
    $('lang-en').addEventListener('click', function () { S.setLang('en'); });
    $('lang-zh').addEventListener('click', function () { S.setLang('zh'); });
    $('btn-play').addEventListener('click', S.togglePlay);
    $('btn-prev').addEventListener('click', function () { S.stepChapter(-1); });
    $('btn-next').addEventListener('click', function () { S.stepChapter(1); });
    $('pt-play').addEventListener('click', S.togglePlay);
    $('pt-prev').addEventListener('click', function () { S.stepChapter(-1); });
    $('pt-next').addEventListener('click', function () { S.stepChapter(1); });
    $('pt-label').addEventListener('click', openSheet);
    $('sheet-close').addEventListener('click', closeSheet);
    $('sheet').addEventListener('click', function (ev) { if (ev.target === $('sheet')) closeSheet(); });
    $('btn-present').addEventListener('click', function () { S.setPresenting(!S.state.presenting, true); });
    $('btn-keys').addEventListener('click', function () { var p = $('keys-pop'); p.hidden = !p.hidden; $('btn-keys').setAttribute('aria-expanded', p.hidden ? 'false' : 'true'); });
    var sp = $('speed');
    var saved = parseFloat(S.store.get('speed')); if ([0.5, 1, 2].indexOf(saved) >= 0) S.state.speed = saved;
    sp.value = String(S.state.speed);
    sp.addEventListener('change', function () { var was = S.state.playing; S.pause(); S.state.speed = parseFloat(sp.value) || 1; S.store.set('speed', String(S.state.speed)); if (was) S.play(); });
    $('zoom-chapter').addEventListener('click', function () { S.state.zoom = 'chapter'; setSegs(); var d = S.domainFor(S.state.chapterId); S.setView(d[0], d[1], true); });
    $('zoom-whole').addEventListener('click', function () { S.state.zoom = 'whole'; setSegs(); S.setView(S.W0, S.W1, true); });
    $('y-fixed').addEventListener('click', function () { S.state.yMode = 'fixed'; setSegs(); S.renderAll(); });
    $('y-fit').addEventListener('click', function () { S.state.yMode = 'fit'; setSegs(); S.renderAll(); });
    $('tz-utc').addEventListener('click', function () { S.tz = 'utc'; S.store.set('tz', 'utc'); setSegs(); applyTexts(); S.renderAll(); renderSections(); });
    $('tz-jst').addEventListener('click', function () { S.tz = 'jst'; S.store.set('tz', 'jst'); setSegs(); applyTexts(); S.renderAll(); renderSections(); });
    $('tri-num').addEventListener('click', S.tri.toggleTable);
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', function (ev) {
      var tg = ev.target && ev.target.nodeType === 1 ? ev.target : document.body;
      if (S.pinned && !tg.closest('#tip')) { S.pinned = null; S.tip.hide(); }
      var kp = $('keys-pop'); if (!kp.hidden && !tg.closest('#keys-pop,#btn-keys')) { kp.hidden = true; $('btn-keys').setAttribute('aria-expanded', 'false'); }
    });
    window.addEventListener('hashchange', fromHash);
    var raf = null, lastW = document.documentElement.clientWidth, lastMode = S.layout.mode;
    function onResize() {
      if (raf) return;
      raf = requestAnimationFrame(function () {
        raf = null;
        var w = document.documentElement.clientWidth; if (w === lastW && !S.state.presenting) return; lastW = w;
        var mode = S.dims().mode;
        if (mode !== lastMode) { lastMode = mode; S.layout = S.dims(); renderCard(); }
        if (S.state.presenting) S.presLayout(); else S.rebuild();
        measureBar();
      });
    }
    if (window.ResizeObserver) new ResizeObserver(onResize).observe(document.documentElement); else window.addEventListener('resize', onResize);
    // hide the mouse cursor after 2 s idle while presenting and playing
    var idle = null;
    document.addEventListener('pointermove', function () { document.body.classList.remove('idle'); clearTimeout(idle); if (S.state.presenting && S.state.playing) idle = setTimeout(function () { document.body.classList.add('idle'); }, 2000); });
  }
  function measureBar() {
    var b = $('topbar'); if (!b) return;
    document.documentElement.style.setProperty('--bar-h', b.offsetHeight + 'px');
  }
  function fromHash() {
    var h = (location.hash || '').replace('#', '');
    if (!h) return false;
    var hl = hashLang();
    if (hl) { if (hl !== S.lang) S.setLang(hl, false, true); return false; }
    if (h === 'present') { S.setPresenting(true); return true; }
    if (h === 'overview' || S.chapterById(h)) { S.goChapter(h); return true; }
    return false;
  }

  S.init = function () {
    S.tip.el = $('tip');
    S.setLang(resolveLang(), true);
    var tz = S.store.get('tz'); if (tz === 'jst' || tz === 'utc') S.tz = tz;
    if (!S.D || !S.D.t || !S.D.series) {
      applyStaticOnly();
      errorPanel();
      renderSections();
      return;
    }
    S.initData();
    S.hakariTs = 1788133980; // Sun 23:53 UTC, the replay point HAKARI quotes (story: "about 12 USDG at 23:53")
    if (!S.ST) { var n = $('notice'); n.hidden = false; n.textContent = tr('err.story'); document.body.classList.add('no-story'); }
    S.tri.prepare();
    S.layout = S.dims();
    S.buildLanes();
    S.buildMinimap();
    wire();
    S.state.cursorTs = S.peakTs;
    S.view = { d0: S.W0, d1: S.W1 };
    applyTexts();
    measureBar();
    S.applyCollapsedAll();
    S.tri.build();
    S.renderAll();
    renderSections();
    if (!fromHash()) { markStepper(); renderCard(); }
    S.updateCursor();
    document.body.classList.add('ready');
  };
  function applyStaticOnly() {
    document.querySelectorAll('[data-t]').forEach(function (e) { e.textContent = tr(e.getAttribute('data-t')); });
    $('h1').textContent = tr('h1'); $('h1-short').textContent = tr('h1short'); $('h1-long').textContent = S.ST ? S.L(S.ST.title) : tr('h1');
    var back = $('back-link'); back.textContent = tr('back'); back.href = window.SQZ_BACK || '../index.html';
    if (!S.chapters) S.chapters = S.ST && S.ST.chapters ? S.ST.chapters : [];
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', S.init); else S.init();
})(window.SQZ = window.SQZ || {});
