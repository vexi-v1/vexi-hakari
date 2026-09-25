/* HIMS weekend float squeeze: UI strings (EN / 繁中) and number/time formats.
   Classic script: attaches to window.SQZ. Every UI string on the page goes through S.tr(). */
(function (S) {
  'use strict';

  // One table for every UI string. {name} placeholders are filled by S.tr(key, vars).
  var T = {
    back: { en: '← HAKARI gauge', zh: '← HAKARI 量測頁' },
    skip: { en: 'Skip to the replay', zh: '跳到重播' },
    h1: { en: 'The HIMS weekend float squeeze', zh: 'HIMS 週末流通量擠壓' },
    h1short: { en: 'HIMS float squeeze', zh: 'HIMS 流通量擠壓' },
    'chip.all': { en: 'All', zh: '全覽' },
    'chip.allTitle': { en: 'Overview: the whole weekend', zh: '全覽：整個週末' },
    'ch.friday': { en: 'Friday', zh: '週五' }, 'ch.redeem': { en: 'Redemptions', zh: '贖回' },
    'ch.fence': { en: 'The fence', zh: '圍欄' }, 'ch.climb': { en: 'The climb', zh: '爬升' },
    'ch.peak': { en: 'The peak', zh: '高峰' }, 'ch.reopen': { en: 'Reopen', zh: '重開' },
    'ch.mint': { en: 'First mint', zh: '首次鑄造' }, 'ch.aftermath': { en: 'Aftermath', zh: '餘波' },
    'ch.overview': { en: 'Overview', zh: '全覽' },
    chapters: { en: 'Chapters', zh: '章節' },
    play: { en: 'Play the story', zh: '播放' }, pause: { en: 'Pause', zh: '暫停' },
    prev: { en: 'Previous chapter', zh: '上一章' }, next: { en: 'Next chapter', zh: '下一章' },
    speed: { en: 'Speed', zh: '速度' },
    present: { en: 'Present', zh: '簡報模式' }, exit: { en: 'Exit (Esc)', zh: '離開（Esc）' },
    keys: { en: 'Keyboard shortcuts', zh: '鍵盤快捷鍵' },
    'zoom.label': { en: 'Time range', zh: '時間範圍' },
    'zoom.chapter': { en: 'Chapter', zh: '本章' }, 'zoom.whole': { en: 'Whole weekend', zh: '整個週末' },
    'y.label': { en: 'Vertical scale', zh: '縱軸' },
    'y.fixed': { en: 'y fixed', zh: '縱軸固定' }, 'y.fit': { en: 'y fit to view', zh: '縱軸貼合畫面' },
    'tz.label': { en: 'Time zone', zh: '時區' },
    numbers: { en: 'Numbers', zh: '數字' }, chart: { en: 'Chart', zh: '圖表' },
    expand: { en: 'Show chart', zh: '展開圖表' }, collapse: { en: 'Hide chart', zh: '收起圖表' },
    'group.price': { en: 'Price', zh: '價格' }, 'group.float': { en: 'Float', zh: '流通量' },
    'group.depth': { en: 'Depth', zh: '深度' }, 'group.social': { en: 'On X', zh: 'X 上的討論' },
    // lanes
    'lane.price': { en: 'HIMS price in the dollar pool', zh: '美元池裡的 HIMS 價格' },
    'unit.price': { en: 'USDG per HIMS', zh: '每顆 HIMS 的 USDG' },
    'sub.price': { en: 'Gridlines sit at multiples of the Friday close, so each one is a premium step.', zh: '格線放在週五收盤價的倍數上，每一條就是一級溢價。' },
    'lane.boner': { en: 'BONER in USDG, three ways', zh: 'BONER 的 USDG 價格：三種算法' },
    'unit.boner': { en: 'USDG per BONER, log scale', zh: '每顆 BONER 的 USDG，對數刻度' },
    'sub.boner': { en: 'On a log axis the gap between two lines is their ratio: via vs at-NAV is the HIMS premium, via vs direct is the route gap.', zh: '對數軸上兩條線的距離就是比值：「經 HIMS」與「以淨值計」的差是 HIMS 溢價，「經 HIMS」與「直接池」的差是路由價差。' },
    'lane.float': { en: 'Where the HIMS supply sits', zh: 'HIMS 流通量在哪裡' },
    'unit.float': { en: 'HIMS tokens', zh: 'HIMS 顆數' },
    'sub.float': { en: 'Pools: HIMS held by rebuilt LP positions. Other v4 = PoolManager balance minus those two (other pools, uncollected fees). Outside v4 = everything else.', zh: '池子：重建的 LP 部位持有的 HIMS。其他 v4＝PoolManager 餘額減去這兩個池（其他池、未領手續費）。v4 之外＝其餘全部。' },
    'lane.route': { en: 'HIMS moved by trades', zh: '交易搬動的 HIMS' },
    'unit.route': { en: 'HIMS, net, trades only', zh: 'HIMS，淨額，只計交易' },
    'sub.route': { en: 'Trades only (no LP adds or removals), summed from {t}. BONER’s pool also takes HIMS from other pools and wallets, so the two lines need not match.', zh: '只計交易（不含 LP 加減），自 {t} 起累加。BONER 池也會從其他池子與錢包收進 HIMS，所以兩條線不必相等。' },
    'lane.inventory': { en: 'Dollar pool: HIMS side vs USDG side', zh: '美元池：HIMS 端與 USDG 端' },
    'unit.inventory': { en: 'USDG, HIMS counted at 28.84', zh: 'USDG，HIMS 以 28.84 計' },
    'sub.inventory': { en: 'LP principal rebuilt from positions, not reserves. HIMS is counted at the Friday close so this line tracks tokens, not the premium.', zh: '由部位重建的 LP 本金，不是儲備。HIMS 以週五收盤價計，所以這條線反映顆數而不是溢價。' },
    'lane.cost': { en: 'Cost to push HIMS 10% and sell back', zh: '把 HIMS 推動 10% 再賣回的成本' },
    'unit.cost': { en: 'USDG, log scale', zh: 'USDG，對數刻度' },
    'sub.cost': { en: 'Fees on both legs, same method as HAKARI’s on-chain cost-to-push lens. Lower = cheaper to fake.', zh: '兩段都計手續費，方法與 HAKARI 的鏈上推價成本工具相同。越低＝越便宜就能造假。' },
    'lane.social': { en: 'Posts about it on X', zh: 'X 上的相關貼文' },
    'unit.social': { en: 'posts per hour · markers = sampled posts', zh: '每小時貼文數・標記＝抽樣貼文' },
    'group.hakari': { en: 'HAKARI’s read · a replay: this pool never had the hook', zh: 'HAKARI 的判讀・重播：這個池子從未掛上 hook' },
    'lane.hakari': { en: 'HAKARI’s max safe exposure and decision (replay)', zh: 'HAKARI 的最大安全曝險與結算決定（重播）' },
    'unit.hakari': { en: 'USDG, log scale', zh: 'USDG，對數刻度' },
    'sub.hakari': { en: 'Max safe exposure: the most USDG that can settle on this price before faking it pays, i.e. the cost of the cheapest fake divided by what each USDG settling on it would gain, assuming nobody pushes the price back. Replayed over the pool’s real swaps and positions (it never had the hook). The bold line is SafeSettle v1’s bound (Δ 10, 30-minute TWAP); where a faint line runs above it, that is the cost ladder alone, before the gap between the two TWAPs is priced in. The strip is v1’s decision for the size you pick. 10K is refused most of the weekend: that is this pool’s normal depth, not the squeeze.', zh: '最大安全曝險：在造假開始划算之前，能用這個價格結算的最大 USDG 金額，也就是最便宜的造假成本，除以每 1 USDG 結算能從造假賺到的錢（假設沒有人把價格拉回）。以池子真實的兌換與部位重播（它從未掛上 hook）。粗線是 SafeSettle v1 的上限（Δ 10，30 分鐘 TWAP）；粗線上方若出現細線，那是只看成本階梯、還沒把兩條 TWAP 的價差算進去的上限。下方色帶是 v1 對你所選規模的決定。1 萬 USDG 整個週末大多被拒絕：那是這個池子平常的深度，不是擠壓造成的。' },
    'lane.oracle': { en: 'What the hook’s TWAPs would have read (replay: no hook on this pool)', zh: 'hook 的 TWAP 會讀到的價格（重播：此池沒有 hook）' },
    'sub.oracle': { en: 'Replayed over the same swaps (the pool never had the hook): HakariOracleHook’s raw and truncated TWAP; the wide grey band is the price the first rule (v0) would have settled on, the wide orange band the raw TWAP SafeSettle v1 settles on when it trusts (a gap is a refusal). v0 never refuses. Neither checks NAV: v1 asks what faking the price would cost.', zh: '用同一批兌換重播（這個池子從未掛上 hook）：HakariOracleHook 的原始與截斷 TWAP；灰色寬帶是第一版規則（v0）會用的結算價，橘色寬帶是 SafeSettle v1 信任時用來結算的原始 TWAP（中斷處就是拒絕）。v0 從不拒絕。兩者都不檢查淨值：v1 問的是造假要花多少成本。' },
    // series
    's.band': { en: 'Minute high–low', zh: '每分鐘高低' }, 's.close': { en: 'Pool price (minute close)', zh: '池價（每分鐘收盤）' },
    's.nav': { en: 'NYSE close 28.84 (NAV)', zh: '紐約收盤 28.84（淨值）' },
    's.via': { en: 'Via HIMS', zh: '經 HIMS 換算' }, 's.atNav': { en: 'If HIMS were at 28.84', zh: '若 HIMS 以 28.84 計' },
    's.direct': { en: 'Direct BONER/USDG pool', zh: 'BONER/USDG 直接池' },
    's.bandUsd': { en: 'HIMS/USDG pool', zh: 'HIMS/USDG 池' }, 's.bandBoner': { en: 'BONER/HIMS pool', zh: 'BONER/HIMS 池' },
    's.otherV4': { en: 'Other v4 pools + fees', zh: '其他 v4 池與手續費' }, 's.outside': { en: 'Outside v4 (wallets)', zh: 'v4 之外（錢包）' },
    's.supply': { en: 'Total supply', zh: '總供給' },
    's.out': { en: 'Out of the dollar pool', zh: '流出美元池' }, 's.into': { en: 'Into BONER’s pool', zh: '流入 BONER 池' },
    's.himsSide': { en: 'HIMS side', zh: 'HIMS 端' }, 's.usdgSide': { en: 'USDG side', zh: 'USDG 端' },
    's.up': { en: 'Push up 10%', zh: '上推 10%' }, 's.down': { en: 'Push down 10%', zh: '下壓 10%' },
    's.capital': { en: 'Capital for the push (returned)', zh: '上推所需資金（會收回）' },
    's.premium': { en: 'Premium vs NAV', zh: '相對淨值溢價' }, 's.swaps': { en: 'Swaps this minute', zh: '本分鐘兌換數' },
    's.routeGap': { en: 'Route gap', zh: '路由價差' },
    's.bonerHims': { en: 'HIMS per BONER', zh: '每顆 BONER 的 HIMS' },
    's.maxSafe': { en: 'Max safe exposure (nobody pushing back; Δ 10, 30 min)', zh: '最大安全曝險（無人拉回價格；Δ 10，30 分）' },
    's.ladder': { en: 'the ladder alone, before the TWAP gap', zh: '只看階梯（未計入 TWAP 價差）' },
    's.raw': { en: 'Raw TWAP ({w} min)', zh: '原始 TWAP（{w} 分）' },
    's.trunc': { en: 'Truncated TWAP (Δ {d}, {w} min)', zh: '截斷 TWAP（Δ {d}，{w} 分）' },
    's.v0': { en: 'What v0 settles on ({v} USDG)', zh: 'v0 的結算價（{v} USDG）' },
    's.v1': { en: 'What v1 settles on ({v} USDG; a gap = refused)', zh: 'v1 的結算價（{v} USDG；中斷＝拒絕）' },
    's.v1Only': { en: 'What v1 settles on (30 min, Δ 10 only)', zh: 'v1 的結算價（僅 30 分、Δ 10）' },
    'hk.settling': { en: 'settling {v} USDG', zh: '結算 {v} USDG' },
    'hk.stripAxis': { en: '@{v}', zh: '結算 {v}' }, 'hk.stripAxisShort': { en: '@{v}', zh: '@{v}' },
    'hk.heroSub': { en: 'the largest settlement v1 would trust now · {d} {v} USDG', zh: 'v1 此刻願意信任的最大結算・{d} {v} USDG' },
    'hk.refuse': { en: 'refuse', zh: '拒絕' }, 'hk.trust': { en: 'trust', zh: '信任' }, 'hk.noTwap': { en: 'no TWAP yet', zh: '尚無 TWAP' },
    'ctl.exposure': { en: 'Settlement size', zh: '結算規模' }, 'ctl.settling': { en: 'Settling', zh: '結算' },
    'ctl.window': { en: 'TWAP window', zh: 'TWAP 時窗' }, 'ctl.min': { en: '{m} min', zh: '{m} 分' }, 'ctl.delta': { en: 'Truncation Δ', zh: '截斷 Δ' },
    // end labels (right margin, <= 12 characters)
    'e.via': { en: 'via HIMS', zh: '經 HIMS' }, 'e.atNav': { en: 'at 28.84', zh: '以 28.84 計' }, 'e.direct': { en: 'direct pool', zh: '直接池' },
    'e.out': { en: 'out of $ pool', zh: '流出美元池' }, 'e.into': { en: 'into BONER', zh: '流入 BONER' },
    'e.up': { en: 'up 10%', zh: '上推 10%' }, 'e.down': { en: 'down 10%', zh: '下壓 10%' },
    'e.maxSafe': { en: 'max safe', zh: '安全上限' }, 'e.raw': { en: 'raw TWAP', zh: '原始 TWAP' }, 'e.trunc': { en: 'truncated', zh: '截斷' },
    'f.usd': { en: 'dollar pool', zh: '美元池' }, 'f.boner': { en: 'BONER\u2019s pool', zh: 'BONER 池' },
    'f.other': { en: 'other v4 + fees', zh: '其他 v4＋手續費' }, 'f.outside': { en: 'outside v4', zh: 'v4 之外' },
    // readouts
    'ro.range': { en: 'range {a}–{b}', zh: '區間 {a}–{b}' },
    'ro.noswap': { en: 'no swap this minute, price carried', zh: '本分鐘無兌換，沿用前價' },
    'ro.swaps': { en: '{n} swaps this minute', zh: '本分鐘 {n} 筆兌換' },
    'ro.premiumInside': { en: 'via HIMS vs at 28.84: {p}, the HIMS premium', zh: '經 HIMS 對以 28.84 計：{p}，即 HIMS 溢價' },
    'ro.intoMore': { en: 'BONER’s pool took in {x}× what left the dollar pool; the rest came from other HIMS pools and wallets', zh: 'BONER 池收進的 HIMS 是流出美元池的 {x} 倍；其餘來自其他 HIMS 池與錢包' },
    'ro.intoLess': { en: 'BONER’s pool took in {p} of what left the dollar pool', zh: 'BONER 池收進了流出美元池的 {p}' },
    'ro.fromBase': { en: 'summed from {t}', zh: '自 {t} 起累加' },
    'ro.share': { en: 'HIMS share of the pool at NAV {p}', zh: '以淨值計 HIMS 佔池 {p}' },
    'ro.capital': { en: 'capital {v} USDG, returned', zh: '所需資金 {v} USDG，會收回' },
    'ro.nullCost': { en: 'the push runs past the last initialized tick', zh: '推價超出最後一個已初始化的 tick' },
    'ro.since': { en: 'since {t}', zh: '（自 {t}）' },
    'ro.10min': { en: '/ 10 min', zh: '／10 分鐘' },
    'ro.maxSafe': { en: 'max safe exposure (replay)', zh: '最大安全曝險（重播）' },
    'ro.bind': { en: 'cheapest fake: HIMS {p} ({n} ticks)', zh: '最便宜的造假：HIMS {p}（{n} ticks）' },
    'ro.bindGap': { en: 'set by the gap between the two TWAPs, {n} ticks ({p}); the ladder alone: {v}', zh: '由兩條 TWAP 的價差 {n} ticks（{p}）決定；只看階梯為 {v}' },
    'ro.up': { en: 'up', zh: '上漲' }, 'ro.down': { en: 'down', zh: '下跌' }, 'ro.upShort': { en: 'up', zh: '上' }, 'ro.downShort': { en: 'down', zh: '下' },
    'ro.settlingV': { en: 'settling {v} USDG', zh: '結算 {v} USDG' },
    'ro.raw': { en: 'raw TWAP, {w} min', zh: '原始 TWAP，{w} 分' }, 'ro.trunc': { en: 'truncated, Δ {d}', zh: '截斷，Δ {d}' },
    'ro.gap': { en: '{n} ticks ({p}) apart', zh: '相差 {n} ticks（{p}）' },
    'ro.v0unchecked': { en: 'v0 settles {v} USDG on raw, unchecked (within 10 ticks)', zh: 'v0 以原始 TWAP 結算 {v} USDG，未檢查（相差 10 ticks 以內）' },
    'ro.v0raw': { en: 'v0 settles {v} USDG on raw (faking costs more than it earns)', zh: 'v0 以原始 TWAP 結算 {v} USDG（造假成本高於獲利）' },
    'ro.v0trunc': { en: 'v0 settles {v} USDG on the truncated TWAP', zh: 'v0 以截斷 TWAP 結算 {v} USDG' },
    'ro.v1trust': { en: 'v1 trusts: settles {v} USDG on the raw TWAP', zh: 'v1 信任：以原始 TWAP 結算 {v} USDG' },
    'ro.v1refuse': { en: 'v1 refuses to settle {v} USDG', zh: 'v1 拒絕結算 {v} USDG' },
    'tbl.ladder': { en: 'Ladder alone (before the TWAP gap)', zh: '只看階梯（未計入 TWAP 價差）' },
    'tbl.binding': { en: 'Cheapest fake (ticks, HIMS move)', zh: '最便宜的造假（ticks，HIMS 變動）' }, 'tbl.bindGap': { en: 'TWAP gap {n} ({p})', zh: 'TWAP 價差 {n}（{p}）' },
    'tbl.decide': { en: 'v1, {v} USDG', zh: 'v1，{v} USDG' }, 'tbl.gapTicks': { en: 'Gap (ticks)', zh: '價差（ticks）' },
    'tbl.v0': { en: 'v0 settles, {v} USDG', zh: 'v0 結算價，{v} USDG' }, 'tbl.truncMark': { en: '(truncated)', zh: '（截斷）' },
    'tbl.v1': { en: 'v1 settles, {v} USDG (30 min, Δ 10)', zh: 'v1 結算價，{v} USDG（30 分，Δ 10）' },
    'mk.unseen': { en: '{t} · a swap to the tick limit the hook never recorded', zh: '{t}・hook 從未記錄的一筆（價格衝到 tick 極限）' },
    'mk.v0at': { en: '{t}, between two minute closes · raw {r}, truncated {u}, {n} ticks apart: v0 settles on {v}', zh: '{t}（兩個分鐘收盤之間）・原始 {r}、截斷 {u}，相差 {n} ticks：v0 以 {v} 結算' },
    'mk.v0atShort': { en: '{t} · v0 settles on {v}', zh: '{t}・v0 以 {v} 結算' },
    'ro.burnedSince': { en: 'burned since {t}', zh: '自 {t} 銷毀' }, 'ro.mintedSince': { en: 'minted since {t}', zh: '自 {t} 鑄造' },
    inThisChapter: { en: 'in this chapter', zh: '本章重點' },
    // watch labels
    'w.himsUsdg': { en: 'HIMS price, dollar pool', zh: '美元池的 HIMS 價格' },
    'w.himsPremiumPct': { en: 'vs the 28.84 close', zh: '相對收盤價 28.84' },
    'w.himsSupply': { en: 'HIMS supply', zh: 'HIMS 總供給' },
    'w.himsInPoolManager': { en: 'HIMS in the v4 PoolManager', zh: 'v4 PoolManager 內的 HIMS' },
    'w.himsInBonerHims': { en: 'HIMS in BONER’s pool', zh: 'BONER 池內的 HIMS' },
    'w.himsInHimsUsdg': { en: 'HIMS left in the dollar pool', zh: '美元池內剩下的 HIMS' },
    'w.usdgInHimsUsdg': { en: 'USDG in the dollar pool', zh: '美元池內的 USDG' },
    'w.bonerHims': { en: 'HIMS per BONER', zh: '每顆 BONER 的 HIMS' },
    'w.bonerUsdgViaHims': { en: 'BONER via HIMS', zh: '經 HIMS 換算的 BONER' },
    'w.bonerUsdAtNav': { en: 'BONER if HIMS were 28.84', zh: '若 HIMS 為 28.84 的 BONER' },
    'w.bonerUsdgDirect': { en: 'BONER in the direct pool', zh: '直接池的 BONER' },
    'w.routeGapPct': { en: 'route gap, via HIMS vs direct', zh: '路由價差：經 HIMS 對直接池' },
    'w.pushUp10CostUsdg': { en: 'to push HIMS +10% and sell back', zh: '推高 10% 再賣回的成本' },
    'w.volUsdgHimsUsdg': { en: 'USDG traded in the dollar pool', zh: '美元池成交的 USDG' },
    'w.volHimsBonerHims': { en: 'HIMS traded in BONER’s pool', zh: 'BONER 池成交的 HIMS' },
    'w.maxSafeExposure': { en: 'HAKARI’s max safe exposure (replay)', zh: 'HAKARI 最大安全曝險（重播）' },
    'w.hakariDecision': { en: 'SafeSettle v1 (replay)', zh: 'SafeSettle v1（重播）' },
    'w.v0Settle': { en: 'what v0 would settle on (replay)', zh: 'v0 會用的結算價（重播）' },
    'w.v1Settle': { en: 'what v1 would settle on (replay)', zh: 'v1 會用的結算價（重播）' },
    'w.hookTwap': { en: 'the hook’s {w}-min TWAP, raw · truncated Δ {d} (replay)', zh: 'hook 的 {w} 分鐘 TWAP，原始・截斷 Δ {d}（重播）' },
    'w.hookTwapV': { en: '{r} raw · {u} truncated', zh: '原始 {r}・截斷 {u}' },
    'w.refuses': { en: 'refuses', zh: '拒絕結算' }, 'w.trusts': { en: 'trusts', zh: '信任並結算' },
    'w.vsPool': { en: '{p} vs the pool', zh: '相對池價 {p}' },
    'w.vsNav': { en: '{x}× the 28.84 close', zh: '收盤價 28.84 的 {x} 倍' },
    'w.gapIn': { en: 'TWAP gap priced in', zh: '計入 TWAP 價差' },
    // gate & clock
    'gate.issuer': { en: 'Issuer', zh: '發行方' }, 'gate.mintRedeem': { en: 'mint ⇅ redeem', zh: '鑄造 ⇅ 贖回' },
    'gate.hours': { en: 'brokerage hours only', zh: '只在券商交易時段' },
    'gate.open': { en: 'Open', zh: '開放' }, 'gate.openSub': { en: 'mint & redeem', zh: '可鑄造與贖回' },
    'gate.closed': { en: 'Closed', zh: '關閉' }, 'gate.fenced': { en: 'fenced {d}', zh: '已圍欄 {d}' },
    'gate.waiting': { en: 'Open · no mint yet', zh: '已開放・尚未鑄造' }, 'gate.waitingSub': { en: '{m} min so far', zh: '已 {m} 分鐘' },
    'gate.minting': { en: 'Minting', zh: '鑄造中' }, 'gate.mintingSub': { en: '+{n} HIMS since {t}', zh: '{t} 起 +{n} 顆' },
    'chip.nyseOpen': { en: 'NYSE open', zh: '紐約證交所開盤' }, 'chip.nyseClosed': { en: 'NYSE closed', zh: '紐約證交所休市' },
    'chip.sessionOpen': { en: '24/5 session open', zh: '24/5 時段開啟' }, 'chip.sessionClosed': { en: '24/5 session closed', zh: '24/5 時段關閉' },
    'chip.gateOpen': { en: 'Mint/redeem open', zh: '可鑄造／贖回' },
    'chip.gateClosed': { en: 'Mint/redeem closed · fenced {d}', zh: '鑄造／贖回關閉・已圍欄 {d}' },
    'chip.gateWaiting': { en: 'Mint/redeem open · no mint yet', zh: '可鑄造／贖回・尚未鑄造' },
    'chip.gateMinting': { en: 'Minting', zh: '鑄造中' },
    ny: { en: '{t} in New York', zh: '紐約 {t}' },
    nearby: { en: 'Nearby', zh: '附近事件' },
    hint: { en: 'Press → or pick chapter 1 to start. The cursor is on the peak.', zh: '按 → 或點第 1 章開始。游標停在高峰。' },
    hintTouch: { en: 'Tap ▶ to play the story, or › to step through it. The cursor is on the peak.', zh: '點 ▶ 播放，或點 › 逐章前進。游標停在高峰。' },
    cursorIn: { en: 'Cursor is in chapter {n} · {title}', zh: '游標在第 {n} 章・{title}' },
    open: { en: 'open', zh: '開啟' },
    toChapter: { en: 'chapter {n}', zh: '第 {n} 章' },
    tldr: { en: 'In four steps', zh: '四個步驟' },
    whyMatters: { en: 'Why it matters', zh: '為什麼重要' },
    lookHere: { en: 'look here', zh: '看這裡' },
    // one "where to look" line per chapter (above the triangle caption); the lane it names is the only one flagged
    'look.overview': { en: 'Look at the orange number: what it costs to push HIMS 10% and sell back. About 1,351 USDG on Sunday evening, a few USDG at the peak.', zh: '看橘色數字：把 HIMS 推高 10% 再賣回的成本。週日傍晚約 1,351 USDG，高峰時只要幾 USDG。' },
    'look.friday': { en: 'Look at the magenta band under the triangle: BONER’s pool already holds more than half of all HIMS.', zh: '看三角形下方的洋紅色帶：BONER 的池子已經握有超過一半的 HIMS。' },
    'look.redeem': { en: 'Look at the supply line in the float lane: it steps down twice, 500 and then 400 HIMS redeemed.', zh: '看流通量軌道上的總供給線：它往下跳兩次，先贖回 500 顆，再 400 顆。' },
    'look.fence': { en: 'Look at the shaded fence in the price lane: the price barely moves, apart from one spike on Saturday morning.', zh: '看價格軌道上的灰色圍欄區：除了週六早上一次急漲，價格幾乎不動。' },
    'look.climb': { en: 'Look at the triangle: the blue ribbon’s HIMS end thins while the magenta ribbon’s HIMS end fattens.', zh: '看三角形：藍色帶的 HIMS 端變細，洋紅色帶的 HIMS 端變粗。' },
    'look.peak': { en: 'Look at HAKARI’s read (a replay): with nobody pushing back, the largest settlement the pool could safely carry falls from 7,259 USDG at 19:40 to 20.38 at 23:25, so 1,000 USDG would be refused.', zh: '看 HAKARI 的判讀（重播）：在無人拉回價格時，池子能安全承載的最大結算從 19:40 的 7,259 USDG 掉到 23:25 的 20.38，所以 1,000 USDG 會被拒絕。' },
    'look.reopen': { en: 'Look at HAKARI’s read (a replay): trading has reopened but no new HIMS has arrived, and 1,000 USDG would still be refused; the bound is 123.86 USDG at 00:43:30, on the pool as the block before the first mint left it.', zh: '看 HAKARI 的判讀（重播）：交易已重開，但還沒有新的 HIMS 進來，1,000 USDG 仍會被拒絕；00:43:30、以首次鑄造前一個區塊的池子狀態計算，上限是 123.86 USDG。' },
    'look.mint': { en: 'Look at the oracle lane: the pool is down to about 32 by 00:55, but the truncated TWAP stays near 50 until about 01:10, and v0 keeps settling on it (in the replay, 30 minutes more than 10% above the pool at 1,000 USDG, 144 at 10,000). The raw TWAP v1 settles on is 47 here too: v1 prices the cost to fake, not NAV.', zh: '看預言機軌道：池價在 00:55 已跌到約 32，截斷 TWAP 卻到約 01:10 都還停在 50 附近，而 v0 繼續用它結算（重播中，1,000 USDG 有 30 分鐘比池價高出 10% 以上，10,000 USDG 有 144 分鐘）。v1 用來結算的原始 TWAP 在這裡也是 47：v1 衡量的是造假成本，不是淨值。' },
    'look.aftermath': { en: 'Look at the BONER lane: with HIMS back at NAV, BONER through HIMS stays near 4x its Friday price.', zh: '看 BONER 軌道：HIMS 回到淨值後，經 HIMS 換算的 BONER 仍約是週五價格的 4 倍。' },
    more: { en: 'More', zh: '更多' }, less: { en: 'Less', zh: '收起' },
    inOneLine: { en: 'In one line', zh: '一句話' },
    evidence: { en: 'Evidence', zh: '證據' },
    readChapter: { en: 'Read the chapter', zh: '閱讀本章' },
    details: { en: 'Details', zh: '詳細內容' },
    chapterOf: { en: 'Chapter {n} of {m}', zh: '第 {n}／{m} 章' },
    // triangle
    'tri.title': { en: 'Three pools, one frozen token', zh: '三個池子，一個被凍結的代幣' },
    'tri.caption': { en: 'Each ribbon is a pool; the width at each end is how much of that token its LPs hold. Outline: {t}.', zh: '每條帶子是一個池子；兩端的寬度是池中 LP 持有該代幣的多寡。外框：{t} 的狀態。' },
    'tri.note': { en: 'Widths are rebuilt LP principal (not reserves; uncollected fees excluded), converted at fixed prices (HIMS 28.84 USDG, BONER {b} USDG) so width tracks tokens, not the premium.', zh: '寬度是重建的 LP 本金（不是儲備，不含未領手續費），以固定價格換算（HIMS 28.84 USDG、BONER {b} USDG），所以寬度反映顆數而非溢價。' },
    'tri.flow': { en: 'Last 15 min:', zh: '最近 15 分鐘：' },
    'tri.flowOut': { en: '{a} HIMS left the dollar pool', zh: '{a} 顆 HIMS 流出美元池' },
    'tri.flowIn': { en: '{b} entered BONER’s pool', zh: '{b} 顆流入 BONER 池' },
    'tri.flowBack': { en: '{a} HIMS came back to the dollar pool', zh: '{a} 顆 HIMS 回到美元池' },
    'tri.flowLeft': { en: '{b} left BONER’s pool', zh: '{b} 顆流出 BONER 池' },
    'tri.flowNone': { en: 'no net HIMS moved by trades.', zh: '交易沒有淨搬動 HIMS。' },
    'tri.perHims': { en: 'USDG per HIMS', zh: '每顆 HIMS 的 USDG' },
    'tri.perBonerH': { en: 'HIMS per BONER', zh: '每顆 BONER 的 HIMS' },
    'tri.perBonerU': { en: 'USDG per BONER', zh: '每顆 BONER 的 USDG' },
    'tri.vsNav': { en: '{p} vs NAV', zh: '相對淨值 {p}' },
    'tri.sinceBase': { en: '{x} since {t}', zh: '{t} 起 {x}' }, 'tri.vsBase': { en: '{x} vs {t}', zh: '對比 {t}：{x}' },
    'tri.routeGap': { en: 'route gap {p}', zh: '路由價差 {p}' },
    'tri.noTrade': { en: 'no trade yet', zh: '尚無成交' },
    'tri.supply': { en: 'supply {v}', zh: '供給 {v}' },
    'tri.pm': { en: 'v4 PoolManager {v}', zh: 'v4 PoolManager {v}' },
    'tri.usdg': { en: 'dollar stablecoin', zh: '美元穩定幣' },
    'tri.bonerVia': { en: '{v} USDG via HIMS', zh: '經 HIMS {v} USDG' },
    'tri.wider': { en: 'wider than drawn', zh: '實際更寬' },
    'tri.numbers': { en: 'Pools at the cursor', zh: '游標時點的池子' },
    'tri.col.pool': { en: 'Pool', zh: '池子' }, 'tri.col.price': { en: 'Price', zh: '價格' },
    'tri.col.a': { en: 'Token A held', zh: '代幣 A 持有量' }, 'tri.col.b': { en: 'Token B held', zh: '代幣 B 持有量' },
    'pool.usd': { en: 'dollar pool', zh: '美元池' }, 'pool.boner': { en: 'BONER’s pool', zh: 'BONER 池' },
    'pool.direct': { en: 'direct pool', zh: '直接池' },
    'pools.title': { en: 'Pools', zh: '池子' },
    'float.title': { en: 'Where the supply sits', zh: '流通量在哪裡' },
    'hero.label': { en: 'Cost to push HIMS +10% and sell back', zh: '把 HIMS 推高 10% 再賣回的成本' },
    'hero.was': { en: 'was {v} at {t}', zh: '{t} 時為 {v}' },
    'hero.baseline': { en: 'baseline ({t}): {v}', zh: '基準（{t}）：{v}' },
    'hero.cheaper': { en: '{x}× cheaper', zh: '成本降到 1/{x}' },
    'hero.dearer': { en: '{x}× the baseline', zh: '基準的 {x} 倍' },
    'hero.mseLabel': { en: 'Max safe exposure (HAKARI replay)', zh: '最大安全曝險（HAKARI 重播）' },
    'hero.lower': { en: '{x}× lower', zh: '降到 1/{x}' },
    'hero.higher': { en: '{x}× the baseline', zh: '基準的 {x} 倍' },
    // moments
    'mo.fence': { en: 'Mint/redeem closed · fenced', zh: '鑄造／贖回關閉・圍欄中' },
    'mo.gap': { en: 'Open · no mint yet ({m} min)', zh: '已開放・尚未鑄造（{m} 分）' },
    'mo.silence': { en: 'No mint or burn for {d}', zh: '{d} 沒有鑄造或銷毀' },
    'mo.label': { en: 'Moments', zh: '關鍵時刻' },
    'mo.clusterTick': { en: '{n} mints this minute, +{v} HIMS', zh: '本分鐘 {n} 次鑄造，+{v} 顆' },
    'mo.fenceBracket': { en: 'Supply frozen at {v} for {d}', zh: '流通量凍結在 {v}，長達 {d}' },
    'mo.outOfRange': { en: '{v} after one swap (off the scale)', zh: '{v}（單筆兌換後報價，超出刻度）' },
    block: { en: 'block', zh: '區塊' }, tx: { en: 'tx', zh: '交易' },
    // minimap
    'mm.label': { en: 'Replay time', zh: '重播時間' },
    'mm.valuetext': { en: '{t}. HIMS {p} USDG, {prem} vs NAV. {ch}.', zh: '{t}。HIMS {p} USDG，相對淨值 {prem}。{ch}。' },
    // sections
    'sec.mechanism': { en: 'How it happened', zh: '事情怎麼發生的' },
    'sec.roles': { en: 'Who came out where', zh: '各方得失' },
    'sec.hakari': { en: 'Why HAKARI cares', zh: 'HAKARI 為什麼在意' },
    'sec.next': { en: 'Next', zh: '下一步' },
    'sec.glossary': { en: 'Glossary', zh: '名詞解釋' },
    'sec.social': { en: 'What X adds', zh: 'X 上的討論補充了什麼' },
    'sec.reference': { en: 'Reference', zh: '參考資料' },
    'ref.numbers': { en: 'Numbers', zh: '數字' }, 'ref.sources': { en: 'Sources', zh: '來源' },
    'ref.method': { en: 'Method', zh: '方法' }, 'ref.caveats': { en: 'Caveats', zh: '注意事項' },
    'next.lane': { en: 'Both lanes are under “HAKARI’s read” in the replay above.', zh: '這兩條軌道就在上方重播的「HAKARI 的判讀」之下。' },
    'hakari.sub': { en: '{a} → {b} {z}, {x}× cheaper, while the fence kept arbitrage out', zh: '{a} → {b} {z}，成本降到 1/{x}，而圍欄把套利擋在外面' },
    'hakari.unit': { en: 'USDG to push +10%', zh: 'USDG 即可推高 10%' },
    'hakari.link': { en: 'See the live cost ladder on the HAKARI gauge →', zh: '在 HAKARI 量測頁看即時成本階梯 →' },
    'hakari.min': { en: 'Lowest minute close in the replay: {v} USDG at {t}, when the dollar pool was down to under 4 HIMS.', zh: '重播中最低的分鐘收盤：{t} 的 {v} USDG，當時美元池只剩不到 4 顆 HIMS。' },
    'hakari.toLanes': { en: 'See it minute by minute under “HAKARI’s read”', zh: '在「HAKARI 的判讀」逐分鐘查看' },
    'hakari.mseUnit': { en: 'USDG max safe exposure', zh: 'USDG 最大安全曝險' },
    'hakari.mseSub': { en: '{a} → {b} {z}, HAKARI’s own rules replayed (the pool never had the hook): the largest settlement it would trust with nobody pushing back. Over the weekend it refuses a 1,000 USDG settlement for {m} minutes (Δ 10, 30-minute TWAP), {c} of them while minting was closed.', zh: '{a} → {b} {z}，以 HAKARI 自己的規則重播（這個池子從未掛上 hook）：無人拉回價格時它願意信任的最大結算。整個週末，1,000 USDG 的結算共被拒絕 {m} 分鐘（Δ 10，30 分鐘 TWAP），其中 {c} 分鐘在鑄造關閉期間。' },
    // reference
    'xc.title': { en: 'Cross-check: our reconstruction vs published figures', zh: '交叉核對：我們的重建與公開數字' },
    'xc.moment': { en: 'Moment (UTC)', zh: '時點（UTC）' }, 'xc.block': { en: 'Block', zh: '區塊' },
    'xc.measure': { en: 'Measure', zh: '量' }, 'xc.ours': { en: 'Ours', zh: '本頁' },
    'xc.ref': { en: 'Reference', zh: '參考值' }, 'xc.source': { en: 'Source', zh: '來源' },
    'xc.match': { en: 'Match', zh: '比對' }, 'xc.note': { en: 'Note', zh: '備註' }, 'xc.show': { en: 'Show', zh: '顯示' },
    'xc.exact': { en: 'exact', zh: '完全一致' }, 'xc.close': { en: 'close', zh: '接近' }, 'xc.differs': { en: 'differs', zh: '不同' },
    'xc.legend': { en: 'Exact = identical at the displayed precision. Close = within 1% or one unit in the last shown digit. Differs = anything else; the note says why.', zh: '完全一致＝在顯示精度下相同。接近＝差距在 1% 內或末位差一。不同＝其他情況，備註說明原因。' },
    'xc.none': { en: 'No anchors in data.json yet.', zh: 'data.json 尚無比對點。' },
    'num.every': { en: 'Every number in the text ({n})', zh: '文中出現的每個數字（{n}）' },
    'num.value': { en: 'Value', zh: '數值' }, 'num.meaning': { en: 'Meaning', zh: '意義' }, 'num.source': { en: 'Source', zh: '來源' },
    'src.identity': { en: 'On-chain identity', zh: '鏈上身分' },
    'src.chain': { en: 'Chain', zh: '鏈' }, 'src.explorer': { en: 'Explorer', zh: '區塊瀏覽器' },
    'src.tokens': { en: 'Tokens', zh: '代幣' }, 'src.pools': { en: 'Pools', zh: '池子' },
    'src.others': { en: 'Other pools touching HIMS or BONER', zh: '其他涉及 HIMS 或 BONER 的池子' },
    'src.fee': { en: 'fee', zh: '手續費' }, 'src.tickSpacing': { en: 'tick spacing', zh: 'tick 間距' },
    'src.hooks': { en: 'hooks', zh: 'hooks' }, 'src.init': { en: 'initialized at block', zh: '初始化區塊' },
    'src.x': { en: 'X / Twitter', zh: 'X / Twitter' },
    'm.window': { en: 'Window and grid', zh: '時間窗與格點' },
    'm.windowText': { en: '{a} to {b} UTC, blocks {fb}–{tb}, {step}-second buckets, {n} steps. The value at a minute is the state after the last event at or before it; highs, lows, volumes and counts cover the minute that ends there.', zh: '{a} 至 {b} UTC，區塊 {fb}–{tb}，每 {step} 秒一格，共 {n} 格。某分鐘的值是該時點以前最後一個事件之後的狀態；高低價、成交量與筆數涵蓋截至該時點的那一分鐘。' },
    'm.prices': { en: 'Prices', zh: '價格' },
    'm.pricesText': { en: 'Minute close = the last swap’s post-swap price in the minute, carried forward when the minute has no swap; high and low come from swaps in the minute. Swaps that emptied the in-range liquidity are counted in volume but left out of high and low.', zh: '分鐘收盤＝該分鐘最後一筆兌換後的價格，無兌換時沿用前值；高低價取自該分鐘內的兌換。把區間內流動性買空的兌換計入成交量，但不計入高低價。' },
    'm.inventory': { en: 'Inventory', zh: '池內存量' },
    'm.inventoryText': { en: 'Principal of LP positions rebuilt from every ModifyLiquidity log at the minute’s price, not reserves; uncollected fees excluded.', zh: '由每一筆 ModifyLiquidity 紀錄重建的 LP 部位本金（以該分鐘價格計），不是儲備，不含未領手續費。' },
    'm.supply': { en: 'Supply', zh: '供給' },
    'm.supplyText': { en: 'From HIMS Transfer logs: mints from and burns to the zero address; the PoolManager balance from transfers in and out.', zh: '取自 HIMS 的 Transfer 紀錄：從零地址鑄造、轉入零地址銷毀；PoolManager 餘額由轉入轉出計算。' },
    'm.cost': { en: 'Cost to push', zh: '推價成本' },
    'm.costText': { en: 'The same math as HAKARI’s on-chain cost lens (PushCostLens) with fees on both legs; the push-down cost is converted to USDG at the minute close.', zh: '與 HAKARI 鏈上推價成本工具（PushCostLens）相同的算法，兩段都計手續費；下壓成本以分鐘收盤價換成 USDG。' },
    'm.hakari': { en: 'HAKARI’s read (a replay)', zh: 'HAKARI 的判讀（重播）' },
    'm.hakariText': { en: 'HakariOracleHook’s observations (one per second, before the second’s first swap), its raw and truncated TWAPs, SafeSettle v1’s max safe exposure and trust-or-refuse decision, and the first rule (v0), replayed on the pool rebuilt at every minute. Summary, key moments and checks:', zh: 'HakariOracleHook 的觀測（每秒一次，在該秒第一筆兌換之前）、它的原始與截斷 TWAP、SafeSettle v1 的最大安全曝險與信任或拒絕的決定，以及第一版規則（v0），逐分鐘套用在重建的池子上重播。摘要、關鍵時刻與檢查：' },
    'm.hakariCmd': { en: 'rebuild:', zh: '重建：' },
    'm.hakariAssume': { en: 'HAKARI’s read: assumptions and limits', zh: 'HAKARI 的判讀：假設與限制' },
    'm.hakariFull': { en: 'The replay’s full assumptions ({n}, as written in the data)', zh: '重播的完整假設（{n} 條，資料原文，英文）' },
    'm.checks': { en: 'Checks', zh: '檢查' },
    'm.caching': { en: 'Caching', zh: '快取' },
    'm.cachingText': { en: 'Every figure comes from cached collector output (gauge/cache/squeeze/). The page never queries the chain; rebuilding the data re-reads the cache and fetches only blocks it has not seen. Data generated {g}.', zh: '所有數字都來自收集程式的快取（gauge/cache/squeeze/）。本頁從不查詢鏈上；重建資料時只讀快取，只抓尚未看過的區塊。資料產生於 {g}。' },
    'm.pass': { en: 'pass', zh: '通過' }, 'm.fail': { en: 'fail', zh: '未通過' },
    'm.social': { en: 'X / Twitter sample', zh: 'X / Twitter 抽樣' },
    footer: { en: 'ETHGlobal Tokyo 2026 · MIT · ', zh: 'ETHGlobal Tokyo 2026 · MIT · ' },
    source: { en: 'source', zh: '原始碼' },
    // tables
    'tbl.time': { en: 'Time', zh: '時間' }, copy: { en: 'Copy as TSV', zh: '複製為 TSV' },
    copied: { en: 'Copied', zh: '已複製' }, selected: { en: 'Selected, press ⌘C or Ctrl C', zh: '已選取，請按 ⌘C 或 Ctrl C' },
    'tbl.step': { en: 'every {m} min, plus event minutes', zh: '每 {m} 分鐘一列，另加事件時點' },
    // social
    'x.verdict.supported': { en: 'supported', zh: '有鏈上支持' }, 'x.verdict.partly': { en: 'partly', zh: '部分符合' },
    'x.verdict.contradicted': { en: 'contradicted', zh: '與鏈上不符' }, 'x.verdict.unverifiable': { en: 'unverifiable', zh: '無法驗證' },
    'x.kind.realtime': { en: 'real-time', zh: '即時' }, 'x.kind.analysis': { en: 'analysis', zh: '分析' },
    'x.kind.claim': { en: 'claim', zh: '主張' }, 'x.kind.official': { en: 'official', zh: '官方' },
    'x.kind.pushback': { en: 'pushback', zh: '反駁' }, 'x.kind.meme': { en: 'meme', zh: '迷因' },
    'x.kind.retrospective': { en: 'retrospective', zh: '事後回顧' },
    'x.open': { en: 'Open on X', zh: '在 X 上開啟' }, 'x.onchain': { en: 'on-chain {v}', zh: '鏈上 {v}' },
    'x.perHour': { en: '{n} posts in this hour', zh: '這一小時 {n} 則貼文' },
    'x.followers': { en: '{b} followers', zh: '{b} 追蹤者' },
    'x.posts': { en: '{n} posts', zh: '{n} 則貼文' },
    'x.findings': { en: 'What the posts add', zh: '貼文補充的內容' }, 'x.limits': { en: 'Limits of this sample', zh: '這份抽樣的限制' },
    'x.method': { en: 'How the posts were collected', zh: '貼文怎麼收集的' },
    'x.close': { en: 'Close', zh: '關閉' },
    'x.markers': { en: 'Markers: {n} of the {m} curated posts fall in this window.', zh: '標記：{m} 則精選貼文中有 {n} 則落在這段時間內。' },
    'x.counts': { en: '{c} curated posts, from {r} related to the event ({t} collected).', zh: '精選 {c} 則貼文，取自 {r} 則與事件相關的貼文（共收集 {t} 則）。' },
    'x.all': { en: 'All {n} curated posts, with what the replay says about their numbers', zh: '全部 {n} 則精選貼文，以及重播資料對其數字的核對' },
    'x.who': { en: 'Account', zh: '帳號' }, 'x.said': { en: 'What it said (paraphrased)', zh: '內容（改寫）' }, 'x.checked': { en: 'Checked against the chain', zh: '與鏈上核對' },
    'x.outside': { en: 'outside the replay window', zh: '在重播時段之外' },
    // errors
    'err.data': { en: 'data.js didn’t load. Build it from the cached collector output (no chain calls): run the squeeze data step in gauge/, then reload.', zh: 'data.js 沒有載入。請用收集程式的快取重建（不會查詢鏈上）：在 gauge/ 執行 squeeze 資料步驟後重新整理。' },
    'err.story': { en: 'story.js didn’t load, so the chapters are hidden. Run node web/squeeze/build-web.mjs, then reload.', zh: 'story.js 沒有載入，所以章節隱藏。請執行 node web/squeeze/build-web.mjs 後重新整理。' },
    'err.series': { en: 'This series is missing from data.json ({k}).', zh: 'data.json 缺少這個序列（{k}）。' },
    // keys help
    'k.title': { en: 'Keyboard', zh: '鍵盤' },
    'k.chapters': { en: 'previous / next chapter', zh: '上一章／下一章' }, 'k.play': { en: 'play / pause', zh: '播放／暫停' },
    'k.ends': { en: 'first / last chapter', zh: '第一章／最後一章' }, 'k.present': { en: 'presenter mode', zh: '簡報模式' },
    'k.lang': { en: 'switch language', zh: '切換語言' }, 'k.numbers': { en: 'numbers view on every lane', zh: '所有軌道切換數字表' },
    'k.jump': { en: 'overview / chapter n', zh: '全覽／第 n 章' },
    'k.slider': { en: 'on the timeline: ±1 min, Shift ±10 min, PgUp/PgDn ±1 h, Home/End', zh: '在時間軸上：±1 分，Shift ±10 分，PgUp/PgDn ±1 小時，Home/End' },
    'k.esc': { en: 'leave presenter mode', zh: '離開簡報模式' },
    colon: { en: ': ', zh: '：' },
    live: { en: 'Chapter {n}: {title}', zh: '第 {n} 章：{title}' }
  };
  S.I18N = T;

  S.lang = 'en';
  S.tr = function (key, vars) {
    var e = T[key];
    var s = e ? (e[S.lang] != null ? e[S.lang] : e.en) : key;
    if (vars) s = s.replace(/\{(\w+)\}/g, function (m, k) { return vars[k] != null ? vars[k] : m; });
    return s;
  };
  // Pick the current language out of a bilingual story/data object.
  S.L = function (o) {
    if (o == null) return '';
    if (typeof o === 'string') return o;
    return o[S.lang] != null ? o[S.lang] : (o.en != null ? o.en : '');
  };

  // ---------- numbers (true minus U+2212) ----------
  var nfCache = {};
  function nf(min, max) {
    var k = S.lang + min + ':' + max;
    if (!nfCache[k]) nfCache[k] = new Intl.NumberFormat(S.lang === 'zh' ? 'zh-TW' : 'en-US', { minimumFractionDigits: min, maximumFractionDigits: max });
    return nfCache[k];
  }
  function minus(s) { return s.replace(/^-/, '−'); }
  S.fmtFixed = function (v, dp) { return v == null || !isFinite(v) ? '—' : minus(nf(dp, dp).format(v)); };
  S.fmtUsdg2 = function (v) { return S.fmtFixed(v, 2); };
  S.fmtSig = function (v, sig) {
    if (v == null || !isFinite(v)) return '—';
    if (v === 0) return '0';
    var a = Math.abs(v), mag = Math.floor(Math.log10(a));
    var dp = Math.max(0, (sig || 3) - 1 - mag);
    return minus(nf(dp, dp).format(Number(v.toFixed(Math.min(dp, 20)))));
  };
  S.fmtPct = function (v, forceDp) {
    if (v == null || !isFinite(v)) return '—';
    var dp = forceDp != null ? forceDp : (Math.abs(v) < 10 ? 1 : 0);
    var s = nf(dp, dp).format(Math.abs(v));
    var sign = v > 0.00001 ? '+' : (v < -0.00001 ? '−' : '');
    return sign + s + '%';
  };
  S.fmtHims = function (v) {
    if (v == null || !isFinite(v)) return '—';
    if (v === 0) return '0';
    return Math.abs(v) >= 100 ? S.fmtFixed(v, 0) : S.fmtFixed(v, 1);
  };
  S.fmtSupply = function (v) { return S.fmtFixed(v, 1); };
  var NB = '\u00a0';
  // zh: 萬 / 億 instead of K / M (Taiwan usage); a no-break space keeps the number and its unit together.
  function wan(v, a) {
    if (a >= 1e8) return minus(nf(0, 2).format(v / 1e8)) + NB + '億';
    return minus(nf(0, a >= 1e6 ? 0 : 2).format(v / 1e4)) + NB + '萬';
  }
  S.fmtUsdg = function (v) {
    if (v == null || !isFinite(v)) return '—';
    var a = Math.abs(v);
    if (S.lang === 'zh' && a >= 1e4) return wan(v, a);
    if (a >= 1e6) return minus(nf(2, 2).format(v / 1e6)) + 'M';
    if (a >= 1e4) return minus(nf(1, 1).format(v / 1e3)) + 'K';
    if (a >= 100) return S.fmtFixed(v, 0);
    if (a >= 10) return S.fmtFixed(v, 1);
    return S.fmtFixed(v, 2);
  };
  S.fmtCompact = function (v) {
    if (v == null || !isFinite(v)) return '—';
    var a = Math.abs(v);
    if (S.lang === 'zh') return a >= 1e4 ? wan(v, a) : minus(nf(0, a >= 100 ? 0 : 2).format(v));
    if (a >= 1e9) return minus(nf(0, 1).format(v / 1e9)) + 'B';
    if (a >= 1e6) return minus(nf(0, 1).format(v / 1e6)) + 'M';
    if (a >= 1e3) return minus(nf(0, 1).format(v / 1e3)) + 'K';
    return minus(nf(0, 2).format(v));
  };
  S.fmtInt = function (v) { return v == null || !isFinite(v) ? '—' : minus(nf(0, 0).format(v)); };
  S.fmtSigned = function (s, v) { return (v > 0 ? '+' : '') + s; };
  // Change from a to b for deltas: ×N for 2x and up, 1/N below 2% of the start, a percentage in between.
  S.fmtChange = function (b, a) {
    if (a == null || b == null || !a || !isFinite(b / a)) return '';
    var r = b / a;
    if (r >= 2) return '×' + S.fmtFixed(r, r < 10 ? 1 : 0);
    if (r < 0.02 && r > 0) return '1/' + S.fmtInt(1 / r);
    return S.fmtPct((r - 1) * 100);
  };
  S.fmtDur = function (sec) {
    sec = Math.max(0, Math.round(sec / 60));
    var h = Math.floor(sec / 60), m = sec % 60;
    if (S.lang === 'zh') return (h ? h + ' 小時 ' : '') + m + ' 分';
    return (h ? h + 'h ' : '') + m + 'm';
  };

  // ---------- time (UTC by default, optional JST) ----------
  S.tz = 'utc';
  var WD_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var WD_ZH = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
  var MO_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function zd(ts) { return new Date((ts + (S.tz === 'jst' ? 9 * 3600 : 0)) * 1000); }
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  S.zoneLabel = function () { return S.tz === 'jst' ? 'JST' : 'UTC'; };
  S.fmtHM = function (ts) { var d = zd(ts); return p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()); };
  S.fmtHMS = function (ts) { var d = zd(ts); return S.fmtHM(ts) + ':' + p2(d.getUTCSeconds()); };
  S.fmtDay = function (ts, upper) {
    var d = zd(ts);
    if (S.lang === 'zh') return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + '（' + WD_ZH[d.getUTCDay()] + '）';
    var s = WD_EN[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MO_EN[d.getUTCMonth()];
    return upper ? s.toUpperCase() : s;
  };
  S.fmtDayShort = function (ts) {
    var d = zd(ts);
    if (S.lang === 'zh') return WD_ZH[d.getUTCDay()] + ' ' + d.getUTCDate() + ' 日';
    return (WD_EN[d.getUTCDay()] + ' ' + d.getUTCDate()).toUpperCase();
  };
  S.fmtWdHM = function (ts) {
    var d = zd(ts);
    return (S.lang === 'zh' ? WD_ZH[d.getUTCDay()] + ' ' : WD_EN[d.getUTCDay()] + ' ') + S.fmtHM(ts);
  };
  S.fmtDT = function (ts, secs) {
    var t = secs ? S.fmtHMS(ts) : S.fmtHM(ts);
    if (S.lang === 'zh') return S.fmtDay(ts) + t + ' ' + S.zoneLabel();
    return S.fmtDay(ts) + ' · ' + t + ' ' + S.zoneLabel();
  };
  var nyFmt = null;
  S.fmtNY = function (ts) {
    try {
      if (!nyFmt) nyFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
      return nyFmt.format(new Date(ts * 1000));
    } catch (e) { return S.fmtHM(ts - 4 * 3600); }
  };
  S.isoUTC = function (ts) { return new Date(ts * 1000).toISOString().replace('.000Z', 'Z'); };
})(window.SQZ = window.SQZ || {});
