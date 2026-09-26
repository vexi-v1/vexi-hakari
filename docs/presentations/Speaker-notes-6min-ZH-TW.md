# Vexi Hakari — six-minute demo / AAPL

AAPL 是本簡報的代幣示意範例。數量與價格路徑改編自 TSLA/USDG 本機分叉測試，並非 AAPL 執行紀錄或股票即時價格。連結的網站回放保留原始 TSLA 標籤；HIMS 歷史資料也維持原本資產名稱。

## 1. Vexi Hakari (0:00–0:15)

Vexi Hakari 讓選擇權和現貨共用同一個造市者錢包。Aqua 負責策略帳務與資金移動，Uniswap v4 的價格參考則控制報價。接下來從資金流一路看到拒單，再切到實際 demo。

**操作提示:** 開始前先開好公開回放。整份規劃為六分鐘。

**來源:** docs/website.md; website/vexi-logo.svg

## 2. Covered call 與 cash-secured put (0:15–0:40)

先用 AAPL 代幣和 USDG 的假設價格理解選擇權。Covered call 是買方先付五塊權利金，取得用四百買一個 AAPL 的權利。到期三百五十就不履約，四百五十就付四百取得代幣。Put 方向相反，買方有權用四百賣出 AAPL，所以賣方要備妥四百 USDG。

**操作提示:** Illustrative contract with a five-USDG premium. This is a teaching example, not the recorded eight-USDG base-premium lifecycle. AAPL 是本簡報的代幣示意範例。數量與價格路徑改編自 TSLA/USDG 本機分叉測試，並非 AAPL 執行紀錄或股票即時價格。連結的網站回放保留原始 TSLA 標籤；HIMS 歷史資料也維持原本資產名稱。

**來源:** User-supplied HAKARI Pitch Deck.html, slides 2–3; aqua/src/book/OptionBook.sol

## 3. 閒置抵押品與過時報價 (0:40–1:05)

這個整合處理兩個問題。先存抵押品的模式，就算十口只賣出兩口，十個代幣仍然先鎖進合約。另一方面，股票市場休市時，代幣池仍能交易，固定選擇權報價可能跟不上池價。Aqua 處理何時移動抵押品，band 處理新報價何時縮小或停止。

**操作提示:** The deposit-first comparison is an illustrative design, not a claim about every options protocol. Price path is schematic and is not market data.

**來源:** User-supplied HAKARI Pitch Deck.html, slides 4–6; docs/history.md; docs/band.md

## 4. 公開整合的完整架構 (1:05–1:30)

資產留在左邊的同一個錢包。Aqua 連接兩種策略：上面是選擇權 writer 與 book，下面是有庫存 guard 的 SwapVM 現貨策略。Hook 記錄 Uniswap 價格，band 再包住公開的固定權利金報價。資金存取、訂單帳務和報價檢查，各有清楚分工。

**操作提示:** 分開追蹤資金存取的實線，以及粉紅色的價格參考路徑。

**來源:** docs/website.md; aqua/src/swapvm/ExposureGuard.sol; aqua/src/band/StabilityBandPricer.sol

## 5. 未成交承諾仍留在造市者錢包 (1:30–1:50)

錢包最初有三十個 AAPL 和兩萬 USDG。掛十口 call，承諾十個 AAPL；掛十口履約價四百的 put，承諾四千 USDG。此時 book 還沒有收到代幣，其餘是未承諾庫存。Aqua 的虛擬額度指向同一批資產，不能相加當成更多存款。

**操作提示:** 先指出承諾與可用區段，再指出 book 為零。Ship 和 post 都沒有移動代幣。 AAPL 是本簡報的代幣示意範例。數量與價格路徑改編自 TSLA/USDG 本機分叉測試，並非 AAPL 執行紀錄或股票即時價格。連結的網站回放保留原始 TSLA 標籤；HIMS 歷史資料也維持原本資產名稱。

**來源:** website/evidence/demo.json: lifecycle initial, ship, post

## 6. 現貨 guard 保護未成交承諾 (1:50–2:15)

Guard 會用實際錢包餘額扣掉 writer 的未成交承諾，再等比例縮小 SwapVM 的兩邊虛擬儲備。有保護的範例中，四百 USDG 的現貨交易後還剩約二十九個 AAPL。另一個沒有 guard 的獨立情境賣掉二十一個，只剩九個，低於十個的承諾，後續 call 成交就會失敗。這個保護只約束有使用 guard 的策略。

**操作提示:** 比較錢包餘額與十個 AAPL 的承諾。兩個現貨交易的輸入不同，且屬獨立情境，不是交易績效比較。 AAPL 是本簡報的代幣示意範例。數量與價格路徑改編自 TSLA/USDG 本機分叉測試，並非 AAPL 執行紀錄或股票即時價格。連結的網站回放保留原始 TSLA 標籤；HIMS 歷史資料也維持原本資產名稱。

**來源:** website/evidence/demo.json: lifecycle spot; unguarded unguarded; aqua/src/swapvm/ExposureGuard.sol

## 7. 成交時拉取剛好的抵押品 (2:15–2:40)

買方成交五口 call 和三口 put。Writer 透過 Aqua.pull，從造市者直接拉取五個 AAPL 和一千兩百 USDG 到 book。買方另付六十四點零零六四 USDG 權利金，取得多頭部位。所以 book 共有五個 AAPL 和一千兩百六十四點零零六四 USDG。剩餘未成交承諾則是五個 AAPL 和兩千八百 USDG。

**操作提示:** 綠色是抵押品，粉紅是權利金。Aqua.pull 是拉取機制，不是中間保管帳戶。 AAPL 是本簡報的代幣示意範例。數量與價格路徑改編自 TSLA/USDG 本機分叉測試，並非 AAPL 執行紀錄或股票即時價格。連結的網站回放保留原始 TSLA 標籤；HIMS 歷史資料也維持原本資產名稱。

**來源:** website/evidence/demo.json: lifecycle spot, buy; aqua/test/WebsiteEvidence.t.sol

## 8. Hook 如何記錄價格 (2:40–3:05)

價格帶中心是一小時 tick TWAP。OpenZeppelin 的 oracle 在每秒第一筆 swap 之前記錄，所以同一交易裡推高再拉回，不會被記成那次尖峰。另一組截斷序列每次最多移動兩百五十個 tick，band 會比較兩組平均。但價格如果持續停留，仍然會逐漸成為新中心。

**操作提示:** Schematic observation timing. The chart is not an oracle simulation. The time-weighted mean tick converts to a geometric price average. Credit the upstream oracle.

**來源:** src/HakariOracleHook.sol; test/HakariOracleHook.t.sol; docs/band.md; OpenZeppelin BaseOracleHook / Panoptic oracle

## 9. 價格參考決定固定百分比價格帶 (3:05–3:30)

這張 AAPL 示意圖沿用已記錄的 TSLA 參考價格路徑。滾動 TWAP 中心約三百七十八點二三，固定往上下各延伸百分之五。偏離百分之二點五時還能報價；到百分之五點一就越過上界，合約拒絕買入。另外也會檢查觀測資料是否可讀、流動性是否足夠，以及原始與截斷價格是否一致。

**操作提示:** 指出 +5.1% 快照超過上界。這是本機 EVM 裡的合成市場觀測。 AAPL 是本簡報的代幣示意範例。數量與價格路徑改編自 TSLA/USDG 本機分叉測試，並非 AAPL 執行紀錄或股票即時價格。連結的網站回放保留原始 TSLA 標籤；HIMS 歷史資料也維持原本資產名稱。

**來源:** website/evidence/demo.json: lifecycle buy, taper, pause, recover; aqua/src/band/StabilityBandPricer.sol

## 10. 可成交量與權利金的反應不同 (3:30–3:55)

這兩條是網站的示意計算曲線，和剛才的分叉記錄分開。中心設四百，基本權利金八塊。左邊的口數上限線性縮小，右邊的額外權利金則呈平方增加。在百分之二點五的位置，每次上限二十五口，報價八點四。到邊緣，上限變成零，就沒有可成交報價。這是每次呼叫的上限，不是累積成交額度。

**操作提示:** 對照兩張圖的 2.5% 位置。整數捨入會減少口數、提高報價。到 ±5% 已沒有一整口可報。 AAPL 是本簡報的代幣示意範例。數量與價格路徑改編自 TSLA/USDG 本機分叉測試，並非 AAPL 執行紀錄或股票即時價格。連結的網站回放保留原始 TSLA 標籤；HIMS 歷史資料也維持原本資產名稱。

**來源:** website/band.mjs calculateBand; fixed example assumes readable reference, enough liquidity and raw/truncated agreement

## 11. 價格帶開啟，不代表一定能成交 (3:55–4:15)

Band 開啟只是其中一道門。原報價可能已到期；持續百分之六的偏移即使變成新中心，原始錨點仍然拒絕。沒有 guard 的現貨策略也可能把抵押品用掉，此時小額報價甚至還讀得到。真正成交仍要同時通過期限、錨點、剩餘庫存和實際抵押品檢查。

**操作提示:** 逐列橫向閱讀。讀得到報價不代表能買，book 依序檢查，可能在第一個失敗處停止。 AAPL 是本簡報的代幣示意範例。數量與價格路徑改編自 TSLA/USDG 本機分叉測試，並非 AAPL 執行紀錄或股票即時價格。連結的網站回放保留原始 TSLA 標籤；HIMS 歷史資料也維持原本資產名稱。

**來源:** website/evidence/demo.json: lifecycle pause, expired; anchor anchor-refused; unguarded unguarded; website/app.js cases

## 12. 履約、關單與權利金回流 (4:15–4:40)

範例接受的到期價格約三百七十八點二六九，低於四百履約價，所以 put 在價內。買方交付三個 AAPL，收到一千兩百 USDG，call 則在價外。履約期結束後，關單透過 Aqua 退回八個 AAPL，包含五個未用的 call 抵押品，以及三個履約收入。再分開領取六十四點零零六四的權利金，book 代幣餘額歸零。

**操作提示:** 兩種代幣都來自同一條生命週期。Close 和 claim 是不同操作，剩餘承諾在第 15 步解除。 AAPL 是本簡報的代幣示意範例。數量與價格路徑改編自 TSLA/USDG 本機分叉測試，並非 AAPL 執行紀錄或股票即時價格。連結的網站回放保留原始 TSLA 標籤；HIMS 歷史資料也維持原本資產名稱。

**來源:** website/evidence/demo.json: lifecycle settle, exercise, close, premium, release; docs/settlement.md

## 13. 合約回放的四個檢查點 (4:40–5:20)

AAPL 範例對應這份 TSLA/USDG 合約回放。第五步，抵押品和權利金進入 book，可以看到兩者的差別。第七步，超出價格帶再買一筆會 revert，買方資金和部位不變。第九步，band 已開啟，但報價到期，必須由造市者更新。第十四步，領完權利金後，book 的代幣餘額變成零。每一步都有前後餘額和 EVM logs 可以展開查核。

**操作提示:** 先開好回放，依序選 05、07、09、14，每步約十秒；網站無法使用時，以本頁完成講解。 Public demo: https://vexi-v1.github.io/vexi-hakari/ . Local fallback: http://127.0.0.1:8787/ . AAPL 是本簡報的代幣示意範例。數量與價格路徑改編自 TSLA/USDG 本機分叉測試，並非 AAPL 執行紀錄或股票即時價格。連結的網站回放保留原始 TSLA 標籤；HIMS 歷史資料也維持原本資產名稱。

**來源:** website/evidence/demo.json: lifecycle buy, pause, expired, premium; website/app.js

## 14. Vexi Hakari 的公開貢獻 (5:20–6:00)

對 Aqua，這是成交才拉抵押品的選擇權 writer，加上共用庫存的 SwapVM guard。對 Uniswap，這是會實際改變口數、拒絕買入的價格消費端。公開測試把兩者串起來。Hook 和 pool 有測試網紀錄，公開 band 整合則以本機分叉展示。 Repo 也記錄固定百分之五政策、獨立報價期限與錨點，以及實驗性結算。後面六頁保留技術細節、歷史動機和開發來源，方便問答。

**操作提示:** End the timed presentation here, at 6:00. Slides 15–20 are optional discussion pages. Source history and reproduction commands follow.

**來源:** README.md; docs/extraction.md; docs/demo.md; FEEDBACK.md

## 15. 兩條實驗性的結算分支 (Backup / 備用)

結算是獨立的實驗機制。一個測試拒絕到期當下的窗口，呼叫者稍後重試，下一個五分鐘窗口才被接受。另一個測試六個窗口都拒絕，一小時寬限期過後，可退回抵押品，持有人按口數分配權利金池退款。晚一點的價格或退款，都會改變經濟結果，這不代表公平到期價。

**操作提示:** 上下兩列是獨立測試。Revert 不會安排自動重試。退款是同系列的權利金池按口數分配，不保證退回每人原價。

**來源:** docs/settlement.md; website/evidence/demo.json: delayed and refund scenarios

## 16. v4 整合的具體做法 (Backup / 備用)

Hook 是 v4 pool key 的一部分，既有池不能直接補裝，所以需要自己的 hooked pool 與流動性。權限由地址位元決定，因此部署前搜尋 CREATE2 salt。分叉測試把測試網 hook bytecode 放在同一地址，連接真實 PoolManager。Aqua 與 canonical SwapVM router 都未修改，整合的重點是消費端與公開介面。

**操作提示:** Explain the three integration seams. The fork creates a new reference pool, not a hook attached to the existing unhooked pool. FEEDBACK.md documents current integration findings; historical feedback is separate.

**來源:** README.md; FEEDBACK.md; src/HakariOracleHook.sol; aqua/test/StabilityBandFork.t.sol

## 17. 常見問題與適用限制 (Backup / 備用)

造市者可以提款或撤銷授權，成交時仍需檢查可用量；guard 也只約束有採用的策略。持續價格偏移會變成新中心，即時 slot0 也能被暫時移動，所以還有報價期限和原始錨點。分次買入可超過單次上限，觀測環容量不足也會停止報價。這些條件均不保證外部公平價格。

**操作提示:** Use the table for Q&A. Docking can also block returns until a compatible strategy is shipped and rebound; consult the tests. Observation capacity must cover actual swap-seconds with margin, not a blanket guarantee from one number.

**來源:** docs/band.md; docs/demo.md; docs/settlement.md; aqua/src/aqua/AquaWriter.sol

## 18. Vexi 與本次 hackathon 的範圍 (Backup / 備用)

Vexi 在活動前已是選擇權交易平台，產品程式仍維持私有。活動期間新增 Aqua 介面、庫存 guard、hook、band 與結算 adapter。公開版用小型 book 和 FixedPremium，讓評審能獨立驗證整合，不包含活動前的私有產品程式。下一步是將公開 band 部署到已有紀錄的測試網 hooked pool。

**操作提示:** Times are JST. These are milestones, not all commits. Do not describe the public fixed premium as Vexi’s production pricing model.

**來源:** docs/history.md; docs/extraction.md; docs/ai-usage.md; README.md

## 19. 歷史動機：HIMS 案例 (Backup / 備用)

原始研究回看八月三十日 HIMS 週末案例。封存資料比較週五股票收盤二十八點八四，與之後池價五十四點五；另一次週日晚間測量，推價百分之十再拉回的估算是十二 USDG。這是不同時點，不能混成同步比較。案例說明參考池可能失真，不代表現在的 band 曾經阻止這件事。

**操作提示:** Historical appendix only. Stock close is a secondary-source value in the archived research. Do not read the chart as a return, a synchronized spread, or proof of protection. Omit the reference’s unverified aggregate volume and peak.

**來源:** docs/history.md; archive/hakari-v1/; user-supplied HAKARI Pitch Deck.html, slide 5

## 20. 可以重現的合約證據 (Backup / 備用)

整份證據包含連續十五步的完整生命週期，加上四個獨立異常情境，共五個測試。測試輸出 JSON 和呼叫 trace，網站與簡報都能追溯到這些檔案及原始碼指紋。全部在固定區塊的本機分叉、使用合成帳戶執行，沒有主網廣播。公開 repo 裡有重現指令和完整適用範圍。

**操作提示:** 用 repo 連結收尾。這是整合證據，不代表真實市場歷史或可直接正式上線。

Reproduce the website evidence:
python3 scripts/website-evidence.py

Focused sponsor traces:
bash scripts/judge-demo.sh 1inch
bash scripts/judge-demo.sh uniswap
bash scripts/judge-demo.sh limits

Current integration feedback: FEEDBACK.md. Fixed fork block: 72248228. No wallet key required.

**來源:** docs/website.md; website/evidence/demo.json; scripts/website-evidence.py; scripts/build-website.py. Aqua © Degensoft Ltd 2025. Powered by SwapVM © Degensoft Ltd 2025.
