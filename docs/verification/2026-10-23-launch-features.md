# 發布前功能驗收紀錄

日期：2026-10-23。分支：`claude/launch-docs`。範圍：學期封存與不下載老師關閉下載的檔案、設定精靈確認畫面、摘要佇列、資料夾檢視。

## 已確認決定

| 項目 | 決定 |
| --- | --- |
| 學期封存 | 提醒只針對最新學期；新學期第一次同步比照首次提取（不推送、可續傳），完成時寫入 `record` 等級的 `sync.initial_completed`，`summary` 寫明學期 |
| 老師關閉下載的檔案 | 一律不下載，只保留檔名與 iLearn 連結；相關設定項已移除 |
| 設定精靈確認畫面 | 第 8 步之後列出全部答案；可修改第 1、4 至 8 步；第 2、3 步請用 `ilearn login` 或 `ilearn ui` |
| 摘要佇列 | agent 以 `ilearn summaries pending／write`（或 MCP `summaries_pending`／`summaries_write`）寫回；須先允許（`agent_permissions.summaries`，預設不允許；舊版 `summaries.agent_write: true` 載入時轉成新設定）；每日上限；單則最多 2000 字 |
| agent 權限 | 設定精靈第 8 步最後一題勾選「寫入摘要」「修改設定」，預設都不勾；`ilearn ui` 系統設定新增「agent 權限」（在「摘要」之後）；兩項權限互相獨立 |
| agent 修改設定 | 允許後 agent 只能用 `ilearn config set`、`ilearn rules add`（MCP `config_set`、`rules_add`）修改夜間時段、截止提醒與強制推送時間、通知規則（啟用、等級、關鍵詞、新增）、每科覆寫、每科摘要開關與每日上限（0 到 200）、`interfaces.folder`、`updates.check`；帳號、密碼、`password_saved`、`environment`、`delivery.*`、`period_times`、背景服務、更新、解除安裝、Reset 與權限本身一律拒絕；`ilearn config get` 隨時可讀 |
| agent 修改的記錄 | 每個變更的鍵寫一行到 `data/agent-changes.jsonl`（時間、agent、鍵、舊值、新值）；`ilearn ui` 首頁最上方在 7 日內有修改時提示，「3 提醒」列出最新 20 項，`總覽.md` 系統提示同步列出；使用者自己的修改不記錄 |
| 資料夾檢視 | `interfaces.folder` 開啟時產生 `總覽.md`、`課程/<科名>.md`、`保留/<學期>/<科名>.md`，唯讀 |

## 自動驗證

| 項目 | 結果 |
| --- | --- |
| `npm test` | 30 個測試檔，528 個測試全部通過 |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npm run build` | exit 0 |

## 真機驗證

| 項目 | 狀態 |
| --- | --- |
| 新學期切換：下一學期開學後第一次同步不推送事件、舊學期停止提醒、完成時出現含學期的 `sync.initial_completed` | TBD（只能在下一個學期觀察） |
| agent 端到端寫摘要：`summaries pending` 取得清單，`summaries write` 寫回，摘要出現在 `ilearn ui` 課程頁與 `ilearn course --json` | TBD |
| 設定精靈確認畫面：在真實終端顯示全部答案、修改其中一步後回到確認畫面、Ctrl-C 後重跑直接回到確認畫面 | TBD |
| 資料夾檢視：以真實資料產生 `總覽.md`、`課程/`、`保留/`，並用 Finder 開啟檢視 | TBD |
| 老師關閉下載的教材：同步後沒有下載，`ilearn course` 只列出檔名與 iLearn 連結 | TBD |
| agent 端到端修改設定：允許「修改設定」後，agent 用 `ilearn config set` 改一項設定（例如夜間時段），設定生效，`ilearn ui` 首頁最上方出現提示，「3 提醒」列出該項（時間、agent、鍵、舊值與新值），`總覽.md` 的系統提示也有 | TBD |
