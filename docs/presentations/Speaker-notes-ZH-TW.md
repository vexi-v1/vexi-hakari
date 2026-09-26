# Vexi Hakari — 3-minute demo

## 1. Vexi Hakari (0:00–0:15)

Vexi Hakari 讓選擇權和現貨共用同一個錢包，透過 Aqua 移動資金，再用 Uniswap v4 價格帶控制報價。接著看一次成交和兩次拒單。

**操作:** 開始前，先開好本機網站的繁中回放頁。

**來源:** docs/website.md; website/app.js; website/vexi-logo.svg

## 2. 一個錢包，兩種策略 (0:15–0:45)

造市者一開始有三十個 TSLA 和兩萬 USDG。Aqua 把選擇權策略，以及有庫存保護的 SwapVM 現貨策略，連到同一個錢包。註冊策略和掛單時，代幣都還留在錢包。現貨的 guard 會扣除已承諾給選擇權的庫存。這裡的虛擬餘額是策略帳務，不能加起來當作更多資產。

**操作:** 指向左側同一個錢包，再沿 Aqua 的兩條分支講解。上方的預言機連線影響選擇權報價。

**來源:** docs/website.md steps 1–4; website/evidence/demo.json lifecycle initial, ship, post, spot

## 3. 成交時，抵押品才進入合約 (0:45–1:15)

這筆成交買了五口 call 和三口 put，履約價是四百 USDG。Aqua 從造市者錢包拉取剛好的五個 TSLA 和一千兩百 USDG，放進選擇權 book。買方另外支付合計六十四點零零六四 USDG 的權利金，並收到多頭部位。未成交的承諾還在原錢包，只有成交部分才轉成實際抵押品。

**操作:** 沿造市者、Aqua、Book 的箭頭說明。抵押品和買方支付的權利金要分開講。Aqua.pull 是拉取機制，並非另一個資金保管帳戶。

**來源:** website/evidence/demo.json lifecycle spot and buy; aqua/test/WebsiteEvidence.t.sol test_WebsiteLifecycle

## 4. 越接近價格帶邊緣，可成交量越小 (1:15–1:55)

公開版本使用固定正負百分之五的價格帶，中心來自滾動 TWAP。這張是網站的示意計算器，中心四百，基本權利金八塊。在中心，每次最多五十口。偏離百分之二點五，上限降到二十五口，報價變成八點四。超過到百分之五點一，就拒絕成交。但價格帶只是其中一道檢查，報價期限、原始錨點和可用抵押品，都還要成立。

**操作:** 從圖的頂點移到 +2.5%，再指向 +5.1% 拒單。上限是每次呼叫，不是累積風險額度。

**來源:** website/band.mjs calculateBand; website/app.js renderLab。固定示例假設觀測可讀、流動性足夠、原始與截斷價格一致。

## 5. 網站 demo 的三個檢查點 (1:55–2:45)

直接看合約執行的回放。第五步，抵押品確實進到 book。第七步，價格超出價格帶，再買一筆會 revert，買方的 USDG 和部位都沒有變。第九步，價格帶雖然恢復，原報價卻已到期，所以還是不能成交。造市者必須明確更新條件，價格回來不會自動延長舊報價。

**操作:** 點「開啟本機回放」，依序選 05 承諾轉為抵押品、07 合約確實拒絕成交、09 價格帶開啟還不夠。切換和點選共預留約二十秒。網站無法使用時，直接以本頁三個檢查點完成講解。最後切回簡報。

**來源:** website/evidence/demo.json lifecycle buy, pause, expired。拒單前後餘額與部位由測試斷言。http://127.0.0.1:8787/?lang=zh-Hant#replay

## 6. 可重現的合約證據 (2:45–3:00)

這是連續十五步的流程，加上四個獨立異常情境，共五個測試。全部在本機分叉執行，沒有主網廣播。證據可從 repo 重現。

**操作:** 停在 repository 連結結尾。三分鐘版本不展開結算與額外異常情境。

**來源:** docs/website.md; website/evidence/demo.json; scripts/website-evidence.py; scripts/build-website.py。範圍：本機 EVM 整合、合成價格歷史、實驗性結算，不宣稱公平到期價或可正式上線。Aqua © Degensoft Ltd 2025. Powered by SwapVM © Degensoft Ltd 2025.
