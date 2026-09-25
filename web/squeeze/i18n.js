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
    'unit.route': { en: 'HIMS, summed from the left edge', zh: 'HIMS，自畫面左緣累加' },
    'sub.route': { en: 'Trades only (no LP adds or removals), summed from {t}.', zh: '只計交易（不含 LP 加減），自 {t} 起累加。' },
    'lane.inventory': { en: 'Dollar pool: HIMS side vs USDG side', zh: '美元池：HIMS 端與 USDG 端' },
    'unit.inventory': { en: 'USDG, HIMS counted at 28.84', zh: 'USDG，HIMS 以 28.84 計' },
    'sub.inventory': { en: 'LP principal rebuilt from positions, not reserves. HIMS is counted at the Friday close so this line tracks tokens, not the premium.', zh: '由部位重建的 LP 本金，不是儲備。HIMS 以週五收盤價計，所以這條線反映顆數而不是溢價。' },
    'lane.cost': { en: 'Cost to push HIMS 10% and sell back', zh: '把 HIMS 推動 10% 再賣回的成本' },
    'unit.cost': { en: 'USDG, log scale', zh: 'USDG，對數刻度' },
    'sub.cost': { en: 'Fees on both legs, same method as HAKARI’s PushCostLens. Lower = cheaper to fake.', zh: '兩段都計手續費，方法與 HAKARI 的 PushCostLens 相同。越低＝越便宜就能造假。' },
    'lane.social': { en: 'Posts about it on X', zh: 'X 上的相關貼文' },
    'unit.social': { en: 'posts per hour · markers = sampled posts', zh: '每小時貼文數・標記＝抽樣貼文' },
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
    // end labels (right margin, <= 12 characters)
    'e.via': { en: 'via HIMS', zh: '經 HIMS' }, 'e.atNav': { en: 'at 28.84', zh: '以 28.84 計' }, 'e.direct': { en: 'direct pool', zh: '直接池' },
    'e.out': { en: 'out of $ pool', zh: '流出美元池' }, 'e.into': { en: 'into BONER', zh: '流入 BONER' },
    'e.up': { en: 'up 10%', zh: '上推 10%' }, 'e.down': { en: 'down 10%', zh: '下壓 10%' },
    'f.usd': { en: 'dollar pool', zh: '美元池' }, 'f.boner': { en: 'BONER\u2019s pool', zh: 'BONER 池' },
    'f.other': { en: 'other v4 + fees', zh: '其他 v4＋手續費' }, 'f.outside': { en: 'outside v4', zh: 'v4 之外' },
    // readouts
    'ro.range': { en: 'range {a}–{b}', zh: '區間 {a}–{b}' },
    'ro.noswap': { en: 'no swap this minute, price carried', zh: '本分鐘無兌換，沿用前價' },
    'ro.swaps': { en: '{n} swaps this minute', zh: '本分鐘 {n} 筆兌換' },
    'ro.premiumInside': { en: 'HIMS premium inside BONER’s price: {p}', zh: 'BONER 價格中的 HIMS 溢價：{p}' },
    'ro.matched': { en: 'matched {p}', zh: '對得上 {p}' },
    'ro.share': { en: 'HIMS share of the pool at NAV {p}', zh: '以淨值計 HIMS 佔池 {p}' },
    'ro.capital': { en: 'capital {v} USDG, returned', zh: '所需資金 {v} USDG，會收回' },
    'ro.nullCost': { en: 'the push runs past the last initialized tick', zh: '推價超出最後一個已初始化的 tick' },
    'ro.since': { en: 'since {t}', zh: '自 {t}' },
    'ro.10min': { en: '/ 10 min', zh: '／10 分鐘' },
    'ro.burnedSince': { en: 'burned since {t}', zh: '自 {t} 銷毀' }, 'ro.mintedSince': { en: 'minted since {t}', zh: '自 {t} 鑄造' },
    inThisChapter: { en: 'in this chapter', zh: '本章重點' },
    // watch labels
    'w.himsUsdg': { en: 'HIMS in the dollar pool', zh: '美元池的 HIMS 價格' },
    'w.himsPremiumPct': { en: 'vs the 28.84 close', zh: '相對收盤價 28.84' },
    'w.himsSupply': { en: 'HIMS supply', zh: 'HIMS 總供給' },
    'w.himsInPoolManager': { en: 'HIMS in the v4 PoolManager', zh: 'v4 PoolManager 內的 HIMS' },
    'w.himsInBonerHims': { en: 'HIMS in BONER’s pool', zh: 'BONER 池內的 HIMS' },
    'w.himsInHimsUsdg': { en: 'HIMS in the dollar pool', zh: '美元池內的 HIMS' },
    'w.usdgInHimsUsdg': { en: 'USDG in the dollar pool', zh: '美元池內的 USDG' },
    'w.bonerHims': { en: 'HIMS per BONER', zh: '每顆 BONER 的 HIMS' },
    'w.bonerUsdgViaHims': { en: 'BONER via HIMS', zh: '經 HIMS 換算的 BONER' },
    'w.bonerUsdAtNav': { en: 'BONER if HIMS were 28.84', zh: '若 HIMS 為 28.84 的 BONER' },
    'w.bonerUsdgDirect': { en: 'BONER in the direct pool', zh: '直接池的 BONER' },
    'w.routeGapPct': { en: 'route gap, via HIMS vs direct', zh: '路由價差：經 HIMS 對直接池' },
    'w.pushUp10CostUsdg': { en: 'to push HIMS +10% and sell back', zh: '推高 10% 再賣回的成本' },
    'w.volUsdgHimsUsdg': { en: 'USDG traded in the dollar pool', zh: '美元池成交的 USDG' },
    'w.volHimsBonerHims': { en: 'HIMS traded in BONER’s pool', zh: 'BONER 池成交的 HIMS' },
    // gate & clock
    'gate.issuer': { en: 'Issuer', zh: '發行方' }, 'gate.mintRedeem': { en: 'mint ⇅ redeem', zh: '鑄造 ⇅ 贖回' },
    'gate.hours': { en: 'brokerage hours only', zh: '只在券商交易時段' },
    'gate.open': { en: 'Open', zh: '開放' }, 'gate.openSub': { en: 'mint & redeem', zh: '可鑄造與贖回' },
    'gate.closed': { en: 'Closed', zh: '關閉' }, 'gate.fenced': { en: 'fenced {d}', zh: '圍欄 {d}' },
    'gate.waiting': { en: 'Open · no mint yet', zh: '已開放・尚未鑄造' }, 'gate.waitingSub': { en: '{m} min so far', zh: '已 {m} 分鐘' },
    'gate.minting': { en: 'Minting', zh: '鑄造中' }, 'gate.mintingSub': { en: '+{n} HIMS since {t}', zh: '{t} 起 +{n} 顆' },
    'chip.nyseOpen': { en: 'NYSE open', zh: '紐約證交所開盤' }, 'chip.nyseClosed': { en: 'NYSE closed', zh: '紐約證交所休市' },
    'chip.sessionOpen': { en: '24/5 session open', zh: '24/5 時段開啟' }, 'chip.sessionClosed': { en: '24/5 session closed', zh: '24/5 時段關閉' },
    'chip.gateOpen': { en: 'Mint/redeem open', zh: '可鑄造／贖回' },
    'chip.gateClosed': { en: 'Gate closed · fenced {d}', zh: '閘門關閉・圍欄 {d}' },
    'chip.gateWaiting': { en: 'Gate open · no mint yet', zh: '閘門開啟・尚未鑄造' },
    'chip.gateMinting': { en: 'Minting', zh: '鑄造中' },
    ny: { en: '{t} in New York', zh: '紐約 {t}' },
    nearby: { en: 'Nearby', zh: '附近事件' },
    hint: { en: 'Press → or pick chapter 1 to start. The cursor is on the peak.', zh: '按 → 或點第 1 章開始。游標停在高峰。' },
    hintTouch: { en: 'Tap ▶ to play the story, or › to step through it. The cursor is on the peak.', zh: '點 ▶ 播放，或點 › 逐章前進。游標停在高峰。' },
    cursorIn: { en: 'Cursor is in chapter {n} · {title}', zh: '游標在第 {n} 章・{title}' },
    open: { en: 'open', zh: '開啟' },
    toChapter: { en: 'chapter {n}', zh: '第 {n} 章' },
    tldr: { en: 'In four steps', zh: '四個步驟' },
    more: { en: 'More', zh: '更多' }, less: { en: 'Less', zh: '收起' },
    inOneLine: { en: 'In one line', zh: '一句話' },
    evidence: { en: 'Evidence', zh: '證據' },
    readChapter: { en: 'Read the chapter', zh: '閱讀本章' },
    details: { en: 'Details', zh: '詳細內容' },
    chapterOf: { en: 'Chapter {n} of {m}', zh: '第 {n}／{m} 章' },
    // triangle
    'tri.title': { en: 'Three pools, one frozen token', zh: '三個池子，一個被凍結的代幣' },
    'tri.caption': { en: 'Ribbon width = tokens held by LP positions (rebuilt principal, not reserves; uncollected fees excluded), converted at fixed prices (HIMS 28.84 USDG, BONER {b} USDG) so width tracks tokens, not the premium. Outline: baseline, {t}.', zh: '帶寬＝LP 部位持有的代幣（重建的本金，不是儲備，不含未領手續費），以固定價格換算（HIMS 28.84 USDG、BONER {b} USDG），所以寬度反映顆數而非溢價。外框：基準時點，{t}。' },
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
    'tri.sinceBase': { en: '×{x} since {t}', zh: '自 {t} ×{x}' },
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
    'hero.cheaper': { en: '{x}× cheaper', zh: '便宜 {x} 倍' },
    'hero.dearer': { en: '{x}× the baseline', zh: '基準的 {x} 倍' },
    // moments
    'mo.fence': { en: 'Mint/redeem closed · fenced', zh: '鑄造／贖回關閉・圍欄中' },
    'mo.gap': { en: 'Open · no mint yet ({m} min)', zh: '已開放・尚未鑄造（{m} 分）' },
    'mo.silence': { en: 'No mint or burn for {d}', zh: '{d} 沒有鑄造或銷毀' },
    'mo.label': { en: 'Moments', zh: '關鍵時刻' },
    'mo.clusterTick': { en: '{n} mints this minute, +{v} HIMS', zh: '本分鐘 {n} 次鑄造，+{v} 顆' },
    'mo.fenceBracket': { en: 'Supply frozen at {v} for {d}', zh: '流通量凍結在 {v}，長達 {d}' },
    'mo.outOfRange': { en: '{v} (one swap, off the scale)', zh: '{v}（單筆成交，超出刻度）' },
    block: { en: 'block', zh: '區塊' }, tx: { en: 'tx', zh: '交易' },
    // minimap
    'mm.label': { en: 'Replay time', zh: '重播時間' },
    'mm.valuetext': { en: '{t}. HIMS {p} USDG, {prem} vs NAV. {ch}.', zh: '{t}。HIMS {p} USDG，相對淨值 {prem}。{ch}。' },
    // sections
    'sec.mechanism': { en: 'How it happened', zh: '事情怎麼發生的' },
    'sec.roles': { en: 'Who came out where', zh: '誰得到什麼結果' },
    'sec.hakari': { en: 'Why HAKARI cares', zh: 'HAKARI 為什麼在意' },
    'sec.next': { en: 'Next', zh: '下一步' },
    'sec.glossary': { en: 'Glossary', zh: '名詞解釋' },
    'sec.social': { en: 'What X adds', zh: 'X 上的討論補充了什麼' },
    'sec.reference': { en: 'Reference', zh: '參考資料' },
    'ref.numbers': { en: 'Numbers', zh: '數字' }, 'ref.sources': { en: 'Sources', zh: '來源' },
    'ref.method': { en: 'Method', zh: '方法' }, 'ref.caveats': { en: 'Caveats', zh: '注意事項' },
    'next.lane': { en: 'It will appear as one more lane under the price lane.', zh: '它會以價格線下方的一條新軌道出現。' },
    'hakari.sub': { en: '{a} → {b}, {x}× cheaper, while the fence kept arbitrage out', zh: '{a} → {b}，便宜 {x} 倍，而圍欄把套利擋在外面' },
    'hakari.unit': { en: 'USDG to push +10%', zh: 'USDG 即可推高 10%' },
    'hakari.link': { en: 'See the live cost ladder on the HAKARI gauge →', zh: '在 HAKARI 量測頁看即時成本階梯 →' },
    'hakari.min': { en: 'Lowest minute close in the replay: {v} USDG at {t}, when the dollar pool had run out of HIMS.', zh: '重播中最低的分鐘收盤：{t} 的 {v} USDG，當時美元池的 HIMS 已被買光。' },
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
    'm.costText': { en: 'The same math as HAKARI’s PushCostLens with fees on both legs; the push-down cost is converted to USDG at the minute close.', zh: '與 HAKARI 的 PushCostLens 相同的算法，兩段都計手續費；下壓成本以分鐘收盤價換成 USDG。' },
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
  S.fmtUsdg = function (v) {
    if (v == null || !isFinite(v)) return '—';
    var a = Math.abs(v);
    if (a >= 1e6) return minus(nf(2, 2).format(v / 1e6)) + 'M';
    if (a >= 1e4) return minus(nf(1, 1).format(v / 1e3)) + 'K';
    if (a >= 100) return S.fmtFixed(v, 0);
    if (a >= 10) return S.fmtFixed(v, 1);
    return S.fmtFixed(v, 2);
  };
  S.fmtCompact = function (v) {
    if (v == null || !isFinite(v)) return '—';
    var a = Math.abs(v);
    if (a >= 1e9) return minus(nf(0, 1).format(v / 1e9)) + 'B';
    if (a >= 1e6) return minus(nf(0, 1).format(v / 1e6)) + 'M';
    if (a >= 1e3) return minus(nf(0, 1).format(v / 1e3)) + 'K';
    return minus(nf(0, 2).format(v));
  };
  S.fmtInt = function (v) { return v == null || !isFinite(v) ? '—' : minus(nf(0, 0).format(v)); };
  S.fmtSigned = function (s, v) { return (v > 0 ? '+' : '') + s; };
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
