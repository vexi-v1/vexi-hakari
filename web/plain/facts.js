/* HAKARI · web/plain/facts.js
   Every number on the plain-language page, computed from window.SQUEEZE_DATA (web/squeeze/data.json).
   Pure: no DOM. plain.js uses it to refill each <span data-fact="id"> at load; build-plain.mjs runs the same
   file in Node to render the page and to fail the build when a number in the HTML disagrees with the data.
   Each fact: { v: raw value, text: what the page shows, src: the data key it comes from }. */
(function (root) {
  'use strict';

  // Minute-grid timestamps (UTC) the story refers to. D.t[0] = 1787940000 = Fri 2026-08-28 18:00 UTC.
  var TS = {
    fri1800: 1787940000, sat0000: 1787961600, sun1800: 1788112800, sun1940: 1788118800,
    sun2130: 1788125400, sun2200: 1788127200, sun2325: 1788132300, sun2353: 1788133980,
    mon0000: 1788134400, mon0037: 1788136620, mon0043: 1788136980, mon0100: 1788138000,
    mon0300: 1788145200, mon0600: 1788156000, mon0159: 1788141540, mon0954: 1788170040,
    mon1000: 1788170400, mon1400: 1788184800
  };
  var REQUIRED = [
    't', 'reference.nyseCloseFri.price', 'reference.mintRuleClosed.fromTs', 'reference.session24x5Reopen',
    'reference.nyseOpenMon', 'events', 'series.himsUsdg.close', 'series.himsInHimsUsdg', 'series.usdgInHimsUsdg',
    'series.himsInBonerHims', 'series.himsSupply', 'series.pushUp10CostUsdg', 'series.hakari.maxSafeUsdg',
    'series.hakari.gapBoundUsdg', 'series.hakari.decision.e1000', 'series.hakari.rawTick.w1800',
    'hakari.moments', 'hakari.weekend.v1RefusalsPrimary', 'hakari.weekend.maxSafeExposureAt',
    'hakari.weekend.minMaxSafeExposure', 'hakari.derived.afterFirstMint', 'hakari.parameters.primary'
  ];

  function get(o, path) {
    var parts = path.split('.');
    for (var i = 0; i < parts.length; i++) { if (o == null) return undefined; o = o[parts[i]]; }
    return o;
  }
  function missing(D) {
    if (!D) return REQUIRED.slice();
    return REQUIRED.filter(function (p) { return get(D, p) == null; });
  }

  // ---- formatting (same digits in both languages; Taiwan also groups with ",")
  function group(s) { return s.replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function int(v) { var n = Math.round(v); return (n < 0 ? '−' : '') + group(String(Math.abs(n))); }
  function fix(v, d) {
    var s = Math.abs(v).toFixed(d == null ? 2 : d), p = s.split('.');
    return (v < 0 ? '−' : '') + group(p[0]) + (p[1] ? '.' + p[1] : '');
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function hm(ts) { var d = new Date(ts * 1000); return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()); }
  function hms(ts) { var d = new Date(ts * 1000); return hm(ts) + ':' + pad(d.getUTCSeconds()); }
  function isoTs(s) { return Math.round(Date.parse(s) / 1000); }
  // A value on the chart's table: whole numbers from 100 up, two decimals below.
  function amount(v) { return v == null ? '—' : (Math.abs(v) >= 100 ? int(v) : fix(v, 2)); }

  function compute(D) {
    var gone = missing(D);
    if (gone.length) throw new Error('SQUEEZE_DATA is missing ' + gone.join(', '));
    var S = D.series, t0 = D.t[0];
    var at = function (ts) {
      var i = Math.round((ts - t0) / 60);
      if (D.t[i] !== ts) throw new Error('no grid minute at ' + ts);
      return i;
    };
    var ev = function (id) {
      for (var i = 0; i < D.events.length; i++) if (D.events[i].id === id) return D.events[i];
      throw new Error('event ' + id + ' not in data');
    };
    var moment = function (id) {
      for (var i = 0; i < D.hakari.moments.length; i++) if (D.hakari.moments[i].id === id) return D.hakari.moments[i];
      throw new Error('hakari moment ' + id + ' not in data');
    };
    var F = {};
    var put = function (id, v, text, src) { F[id] = { v: v, text: text, src: src }; };

    // --- the two prices
    var nav = D.reference.nyseCloseFri.price;
    put('nav', nav, fix(nav, 2), 'reference.nyseCloseFri.price');
    var close = S.himsUsdg.close, pk = 0;
    for (var i = 1; i < close.length; i++) if (close[i] > close[pk]) pk = i;
    var peak = close[pk];
    if (Math.abs(ev('peak-close').amount - peak) > 1e-6) throw new Error('peak-close event disagrees with the series max');
    put('peakClose', peak, fix(peak, 2), 'max(series.himsUsdg.close) = events[peak-close].amount');
    put('peakTime', D.t[pk], hm(D.t[pk]), 't[argmax series.himsUsdg.close]');
    put('peakRound', Math.round(peak), int(peak), 'max(series.himsUsdg.close), rounded');
    put('ratio', peak / nav, fix(peak / nav, 2), 'max(series.himsUsdg.close) / reference.nyseCloseFri.price');
    put('ratioHalf', Math.round(peak / nav * 2) / 2, fix(Math.round(peak / nav * 2) / 2, 1), 'the same ratio, to the nearest half');

    // --- supply
    var supply = S.himsSupply;
    put('supplyFri', supply[0], int(supply[0]), 'series.himsSupply[Fri 18:00]');
    var burns = D.events.filter(function (e) { return e.kind === 'burn'; });
    var burned = burns.reduce(function (a, e) { return a + e.amount; }, 0);
    put('burned', burned, int(burned), 'sum of events[kind = burn].amount');
    var fm = ev('mint-first');
    var fl = supply[at(TS.sun1940)];
    for (var j = at(TS.sat0000); j <= at(TS.mon0043); j++) if (supply[j] !== fl) throw new Error('supply moved while minting was closed');
    put('float', fl, int(fl), 'series.himsSupply, every minute Sat 00:00 → Mon 00:43 UTC');
    put('firstMint', fm.ts, hms(fm.ts), 'events[mint-first].ts');
    put('firstMintShort', fm.ts, hm(fm.ts), 'events[mint-first].ts');
    put('firstMintAmt', fm.amount, int(fm.amount), 'events[mint-first].amount');
    var reopen = D.reference.session24x5Reopen;
    put('reopenGap', (fm.ts - reopen) / 60, String(Math.floor((fm.ts - reopen) / 60)), 'events[mint-first].ts − reference.session24x5Reopen, whole minutes');

    // --- the dollar pool's shelf
    put('pool1940', S.himsInHimsUsdg[at(TS.sun1940)], int(S.himsInHimsUsdg[at(TS.sun1940)]), 'series.himsInHimsUsdg[Sun 19:40]');
    put('pool2130', S.himsInHimsUsdg[at(TS.sun2130)], int(S.himsInHimsUsdg[at(TS.sun2130)]), 'series.himsInHimsUsdg[Sun 21:30]');
    put('pool2200', S.himsInHimsUsdg[at(TS.sun2200)], int(S.himsInHimsUsdg[at(TS.sun2200)]), 'series.himsInHimsUsdg[Sun 22:00]');
    var pmin = ev('min-hims-dollar-pool');
    if (Math.abs(S.himsInHimsUsdg[at(pmin.ts)] - pmin.amount) > 1e-6) throw new Error('min-hims-dollar-pool disagrees with the series');
    put('poolMin', pmin.amount, fix(pmin.amount, 2), 'events[min-hims-dollar-pool].amount = series.himsInHimsUsdg[Sun 23:25]');
    put('poolMinUnder', Math.ceil(pmin.amount), String(Math.ceil(pmin.amount)), 'events[min-hims-dollar-pool].amount, rounded up');
    put('poolUsdgMin', S.usdgInHimsUsdg[at(pmin.ts)], int(S.usdgInHimsUsdg[at(pmin.ts)]), 'series.usdgInHimsUsdg[Sun 23:25]');
    put('boner1940', S.himsInBonerHims[at(TS.sun1940)], int(S.himsInBonerHims[at(TS.sun1940)]), 'series.himsInBonerHims[Sun 19:40]');
    var bmax = ev('max-hims-boner-pool');
    put('bonerMax', bmax.amount, int(bmax.amount), 'events[max-hims-boner-pool].amount');
    put('bonerMaxTime', bmax.ts, hm(bmax.ts), 'events[max-hims-boner-pool].ts');
    put('bonerShare', bmax.amount / fl * 100, int(bmax.amount / fl * 100), 'events[max-hims-boner-pool].amount / the frozen supply, %');

    // --- cost to push +10 % and sell straight back (measured from the pool's rebuilt positions, no hook)
    var cost = S.pushUp10CostUsdg;
    put('cost1940', cost[at(TS.sun1940)], int(cost[at(TS.sun1940)]), 'series.pushUp10CostUsdg[Sun 19:40]');
    var cmin = ev('min-push-up');
    put('costMin', cmin.amount, fix(cmin.amount, 2), 'events[min-push-up].amount = series.pushUp10CostUsdg[Sun 23:25]');
    put('cost2353', cost[at(TS.sun2353)], int(cost[at(TS.sun2353)]), 'series.pushUp10CostUsdg[Sun 23:53]');
    put('cost0159', cost[at(TS.mon0159)], int(cost[at(TS.mon0159)]), 'series.pushUp10CostUsdg[Mon 01:59]');

    // --- the "$132" aside
    var ps = ev('peak-swap');
    put('peakSwap', ps.amount, fix(ps.amount, 2), 'events[peak-swap].amount');
    var paid = /paid ([\d.]+) USDG per HIMS/.exec(ps.label.en);
    if (!paid) throw new Error('peak-swap label no longer states the average paid');
    put('peakSwapPaid', +paid[1], paid[1], 'events[peak-swap].label ("paid … USDG per HIMS on average")');
    put('peakSwapPaidRound', Math.round(+paid[1]), int(+paid[1]), 'events[peak-swap].label (average paid), rounded');

    // --- Monday
    var pg = ev('premium-gone');
    var back = (pg.ts - fm.ts) / 60;
    if (!new RegExp(Math.round(back) + ' minutes').test(pg.label.en)) throw new Error('premium-gone label disagrees with its timestamp');
    if (!(pg.amount < 2)) throw new Error('premium-gone is not within 2 %');
    put('backTime', pg.ts, hm(pg.ts), 'events[premium-gone].ts');
    put('backMin', back, String(Math.round(back)), 'events[premium-gone].ts − events[mint-first].ts, minutes');
    put('backPrice', close[at(pg.ts)], fix(close[at(pg.ts)], 2), 'series.himsUsdg.close[Mon 01:58]');
    var tEnd = D.t[D.t.length - 1], hiAfter = -Infinity, loAfter = Infinity;
    for (var q = at(pg.ts); q < close.length; q++) if (close[q] != null) { hiAfter = Math.max(hiAfter, close[q]); loAfter = Math.min(loAfter, close[q]); }
    put('dataEnd', tEnd, hm(tEnd), 't[last] (the minute grid ends Mon 14:00 UTC)');
    put('close0037', close[at(TS.mon0037)], String(Math.floor(close[at(TS.mon0037)])), 'series.himsUsdg.close[Mon 00:37], rounded down');
    var mb = ev('mints-by-0954');
    var mints = D.events.filter(function (e) { return e.kind === 'mint' && e.ts >= fm.ts && e.ts <= mb.ts; }).length;
    if (!new RegExp(String(mints) + ' mints').test(mb.label.en)) throw new Error('mint count disagrees with events[mints-by-0954]');
    put('mints0954', mints, String(mints), 'count of events[kind = mint] from events[mint-first] to events[mints-by-0954]');
    // .amount is rounded to 0.1 (18,750.5); the label keeps the exact figure (18,750.48)
    var exact = /([\d,]+\.\d+) HIMS/.exec(mb.label.en);
    var minted = exact ? +exact[1].replace(/,/g, '') : mb.amount;
    if (Math.abs(minted - mb.amount) > 0.1) throw new Error('events[mints-by-0954] label and amount disagree');
    put('minted0954', minted, int(minted), 'events[mints-by-0954].label (exact) ≈ .amount');
    var s954 = supply[at(TS.mon0954)];
    if (Math.abs(s954 - (fl + minted)) > 0.5) throw new Error('supply at 09:54 disagrees with float + minted');
    put('supply0954', s954, int(s954), 'series.himsSupply[Mon 09:54] = float + events[mints-by-0954].amount');
    put('nyseOpen', D.reference.nyseOpenMon, hm(D.reference.nyseOpenMon), 'reference.nyseOpenMon');
    put('arb1', ev('arb-1').amount, fix(ev('arb-1').amount, 2), 'events[arb-1].amount');
    put('arb2', ev('arb-2').amount, fix(ev('arb-2').amount, 2), 'events[arb-2].amount');

    // --- HAKARI, replayed (the HIMS/USDG pool never had the hook: hooks = 0x0)
    var W = D.hakari.weekend, R = W.v1RefusalsPrimary.byExposureUsdg['1000'];
    var tk = S.hakari.rawTick.w1800[pk];
    put('twap2331', 1e12 / Math.pow(1.0001, tk), fix(1e12 / Math.pow(1.0001, tk), 2), 'series.hakari.rawTick.w1800[Sun 23:31] (USDG per HIMS = 1e12 / 1.0001^tick), replay');
    put('safe1940', W.maxSafeExposureAt['sun-1940'], int(W.maxSafeExposureAt['sun-1940']), 'hakari.weekend.maxSafeExposureAt.sun-1940, replay');
    put('safeMin', W.minMaxSafeExposure.usdg, fix(W.minMaxSafeExposure.usdg, 2), 'hakari.weekend.minMaxSafeExposure.usdg, replay');
    put('safeMinRound', W.minMaxSafeExposure.usdg, int(W.minMaxSafeExposure.usdg), 'hakari.weekend.minMaxSafeExposure.usdg, rounded, replay');
    if (Math.abs(S.hakari.maxSafeUsdg[at(TS.sun2325)] - W.minMaxSafeExposure.usdg) > 1e-6) throw new Error('safe amount at 23:25 disagrees');
    var bind = moment('sun-2325').binding;
    var gain = Math.pow(1.0001, bind.ticks) - 1;
    if (Math.abs(bind.costUsdg / gain - W.minMaxSafeExposure.usdg) > 0.01) throw new Error('worked example does not reproduce the safe amount');
    put('fakeCost', bind.costUsdg, fix(bind.costUsdg, 2), 'hakari.moments[sun-2325].binding.costUsdg, replay');
    put('fakeMove', gain * 100, int(gain * 100), '1.0001^hakari.moments[sun-2325].binding.ticks − 1, %');
    put('fakeGain', gain, fix(gain, 2), '1.0001^hakari.moments[sun-2325].binding.ticks − 1');
    put('refused', R.minutesRefused, String(R.minutesRefused), 'hakari.weekend.v1RefusalsPrimary.byExposureUsdg.1000.minutesRefused, replay');
    var counted = 0;
    for (var k = 0; k < D.t.length; k++) if (S.hakari.decision.e1000[k] === 0) counted++;
    if (counted !== R.minutesRefused) throw new Error('refused minutes disagree with series.hakari.decision.e1000');
    put('refusedClosed', R.minutesRefusedWhileMintClosed, String(R.minutesRefusedWhileMintClosed), '… .1000.minutesRefusedWhileMintClosed, replay');
    put('refusedAfter', R.minutesRefusedAfterFirstMint, String(R.minutesRefusedAfterFirstMint), '… .1000.minutesRefusedAfterFirstMint, replay');
    put('runFrom', isoTs(R.longestRun.from), hm(isoTs(R.longestRun.from)), '… .1000.longestRun.from, replay');
    put('runTo', isoTs(R.longestRun.to), hm(isoTs(R.longestRun.to)), '… .1000.longestRun.to, replay');
    put('runMin', R.longestRun.minutes, String(R.longestRun.minutes), '… .1000.longestRun.minutes, replay');
    put('v0Max', R.v0SettledMeanwhileUsdgPerHims.max, fix(R.v0SettledMeanwhileUsdgPerHims.max, 2), '… .1000.v0SettledMeanwhileUsdgPerHims.max, replay');
    var worst = D.hakari.derived.afterFirstMint.byExposureUsdg['1000'].v1.onRawOverPool.worst;
    put('trustTime', isoTs(worst.at), hm(isoTs(worst.at)), 'hakari.derived.afterFirstMint.byExposureUsdg.1000.v1.onRawOverPool.worst.at, replay');
    put('trust0051', worst.settlesUsdgPerHims, fix(worst.settlesUsdgPerHims, 2), '… .worst.settlesUsdgPerHims, replay');
    put('pool0051', worst.poolUsdgPerHims, fix(worst.poolUsdgPerHims, 2), '… .worst.poolUsdgPerHims, replay');
    put('deltaTicks', D.hakari.parameters.primary.delta, String(D.hakari.parameters.primary.delta), 'hakari.parameters.primary.delta');
    put('twapMin', D.hakari.parameters.primary.windowSec / 60, String(D.hakari.parameters.primary.windowSec / 60), 'hakari.parameters.primary.windowSec / 60');

    // Literal round numbers in the copy that make a claim about the data: checked here, so the build fails if one stops holding.
    var claims = [
      ['"more than 100 times cheaper" (cost at 19:40 ÷ cost at 23:53)', cost[at(TS.sun1940)] / cost[at(TS.sun2353)] > 100],
      ['"nearly 80 % above Friday\'s close" (v0Max ÷ nav)', R.v0SettledMeanwhileUsdgPerHims.max / nav > 1.75 && R.v0SettledMeanwhileUsdgPerHims.max / nav < 1.8],
      ['"two unbroken hours" (longest refused run)', R.longestRun.minutes === 120],
      ['"about three hours in all" (refused minutes)', R.minutesRefused >= 170 && R.minutesRefused <= 190],
      ['"within 2 %" at backTime', pg.amount < 2],
      ['"stayed within 10 % of it through Monday dataEnd" (every minute close from backTime to t[last] within ±10 % of nav)', hiAfter / nav < 1.1 && loAfter / nav > 0.9],
      ['"more than double" (supply at 09:54 ÷ float)', s954 / fl > 2],
      ['"fewer than four hours" (19:40 → 23:25)', pmin.ts - TS.sun1940 < 4 * 3600],
      ['"about four hours" (19:40 → 23:53)', Math.abs(TS.sun2353 - TS.sun1940 - 4 * 3600) <= 15 * 60],
      ['"more than half above the close" (30-minute average at the peak ÷ nav)', 1e12 / Math.pow(1.0001, tk) / nav > 1.5],
      ['"a 10,000 USDG payout would have been refused anyway" (safe amount at 19:40 < 10,000)', W.maxSafeExposureAt['sun-1940'] < 10000],
      ['"1,000 USDG" is one of the replayed payout sizes', D.hakari.parameters.exposuresUsdg.indexOf(1000) >= 0]
    ];
    return { facts: F, claims: claims };
  }

  // Chart and table helpers shared with plain.js
  var api = {
    TS: TS, REQUIRED: REQUIRED, missing: missing, compute: compute,
    fmt: { int: int, fix: fix, hm: hm, hms: hms, amount: amount }
  };
  root.PLAIN_FACTS = api;
})(typeof window !== 'undefined' ? window : globalThis);
