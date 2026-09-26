# 香港產品目錄核對

`catalog_verified.json` 保存隨目前目錄發佈的兩個 Apple 香港公開產品頁擷取時間、解壓後 HTML SHA-256，以及 40 款產品逐項來源。核對結果為 iPhone 18 Pro 16 款、iPhone 18 Pro Max 16 款、iPhone Duo 8 款。2026-09-22 的獨立複核再次確認全部 40 項相符，詳見專案根目錄 `目录复核-2026-09-22.md`。

官方來源：

- [iPhone Duo](https://www.apple.com/hk-zh/shop/buy-iphone/iphone-duo)
- [iPhone 18 Pro / Pro Max](https://www.apple.com/hk-zh/shop/buy-iphone/iphone-18-pro)
- [Apple 香港 iPhone Duo 官方新聞稿](https://www.apple.com/hk/newsroom/2026/09/apple-unveils-iphone-duo/)

SKU 直接取自 HTML 的 `productSelectionData.products[].partNumber`，與 `familyType`、容量、顏色欄位對應。顏色名稱取自 `displayValues.dimensionColor`；Pro 保留既有簡體介面名稱。`PurchasePath` 複製自同頁上對應螢幕尺寸、容量、顏色的官方 `href`，保留 `/hk-zh` 及原有百分號編碼。地址不能包含查詢參數、購物袋或結帳動作。

`Price` 為每個產品 `fullPrice` 所指價格物件的 `currentPrice.raw_amount`（HKD 整數），並交叉核對 `amountBeforeTradeIn`、`priceCurrency`、`validProducts` 及價格對應型號／容量。某些顏色共用適用 SKU 清單；不能只用價格物件的單一 `product` 欄位判斷。

| 型號 | 256GB | 512GB | 1TB | 2TB |
|---|---:|---:|---:|---:|
| iPhone 18 Pro | 10,499 | 12,299 | 15,799 | 20,999 |
| iPhone 18 Pro Max | 11,499 | 13,299 | 16,799 | 21,999 |
| iPhone Duo | 17,499 | 19,299 | 22,799 | 27,999 |

全部價格為港元。Duo 每種容量均有夜空色及星光白色。商店頁公告為「10 月 16 日晚上 8 時起接受預訂」；官方新聞稿的發佈日期為 2026 年 9 月 9 日，正文明列香港時間。腳本同時核對新聞稿的 `NewsArticle` 身分、`datePublished`、可見發佈日期及香港預訂文字，支持 `2026-10-16T20:00:00+08:00`。每個 Duo 產品均有此 `PreorderAt`。`CatalogVerifiedAt` 只表示目錄核對時間，並非庫存更新時間。目前已發佈的證據保留原始格式；下次明確更新時才加入新聞稿證據，預設核對只在輸出中提供最新新聞稿證據。

腳本只讀取兩個公開產品頁與官方新聞稿，未查詢庫存、加入購物袋或結帳。已公布的 SKU 不代表已開放訂購；價格、預訂日期及頁面格式仍可能改動。`pending_products` 為空，所有 40 款均有已核對 SKU；將來沒有公開 SKU 的組合應留在獨立待核對清單，不能產生假 SKU 放進監控。

重新核對（只讀，不修改目錄或正式證據）：

```powershell
python .\catalog-provenance\verify_catalog.py
```

預設會核對全部 40 項的 SKU 集合、型號、容量、顏色、類型、價格、購買路徑和預訂時間，忽略每次抓取都會改變的核對時間。JSON 輸出中的 `catalog_matches` 表示現有目錄是否相符，`differences` 列出差異。退出碼 `0` 表示相符、`2` 表示目錄與已核對的官方資料有差異；網路、來源格式或安全檢查失敗會非零退出。正常重新核對不會破壞既有目錄測試。

確認差異後，全部來源與 40 種組合檢查通過才同時更新目錄和配套證據：

```powershell
python .\catalog-provenance\verify_catalog.py --write-catalog
node --test .\extension\shared.test.js .\extension\catalog.test.js
```

舊參數 `--update-catalog` 保留為相同功能的相容別名。寫入先暫存兩份完整文件，替換過程發生例外會還原已替換的文件；突然斷電或程序被強制終止不具備跨文件交易保證，更新後仍應執行目錄測試。不要使用 Python `-O` 或 `PYTHONOPTIMIZE`，腳本會拒絕省略檢查的執行環境。

回歸測試（使用暫存目錄與測試資料，不改目前目錄）：

```powershell
python -B .\catalog-provenance\test_verify_catalog.py
```

`extension/catalog.test.js` 以來源證據核對每個產品，並保護原有 32 個 Pro SKU、8 種 Duo 組合、價格及預訂時區。`extension/shared.test.js` 驗證地址必須匹配產品家族、螢幕尺寸、容量和顏色，拒絕跨地區／網域、加購／結帳參數及路徑繞行。
