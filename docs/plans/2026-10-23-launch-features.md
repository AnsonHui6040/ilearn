# 發布前補齊功能計劃

日期：2026-10-23。狀態：待使用者批准。範圍：設計文件中仍未實作、使用者要求在發布前完成的四項功能。

## 現況

| 功能 | 已有 | 缺少 |
| --- | --- | --- |
| 學期封存（驗收 #12） | 同步只取目前學期課程；`tasks`、`ilearn ui` 只顯示目前學期；`ilearn ui` 課程頁有「保留學期」；檔案依學期分資料夾 | 截止提醒仍會掃描所有學期（`src/sync/sync.ts` `runReminderTick`）；新學期第一次同步不算首次提取，所有作業、公告會一次以 push 推送 |
| 摘要佇列 | 設定精靈第 7、8 步、`config.summaries`（每科剔選、`daily_limit: 20`）；事件格式有 `summary` 欄位 | 佇列、寫回、來源 hash、每日上限、顯示位置；`ilearn ui` 課程設定頁只顯示「Phase 6 開放」 |
| 資料夾模式 | `config.interfaces.folder`；`outbox/通知.md` | `總覽.md`、`課程/<科>.md`、`保留/<學期>/<科>.md` |
| 精靈確認畫面（Stage 7） | 每步回答後立即存檔、中斷續接 | 最後列出全部答案，可選擇回到某一步修改 |

## Task 1：學期封存

- `runReminderTick` 只處理目前學期（`MAX(semester)`）的作業與考試。
- 偵測新學期：`activeSemesterCode()` 與資料庫中最新學期不同，且資料庫已有舊學期資料時，該次同步視為「新學期首次提取」：事件一律 `record`、不推送；完成後發出 `sync.initial_completed`（summary「新學期 115-2 首次同步完成，共 N 門課程」）。不新增事件類型，維持 15 種。
- 中斷續傳沿用 `in_progress_courses`。
- 舊學期資料、檔案、分數保留，`ilearn course <id>` 仍可查詢。
- 測試：舊學期作業不提醒；新學期首次同步不產生 push 事件；續傳。

## Task 2：摘要佇列

- 新 migration：`summaries` 表（`target_id`、`kind`＝`announcement`／`material`、`course_id`、`source_hash`、`text`、`agent`、`written_at`）。
- 待摘要條件：
  - 公告：課程剔選「老師公告摘要」，且沒有摘要或內文 hash 已改變。
  - 教材：課程剔選「教材檔案摘要」，檔案已下載到本機，且沒有摘要或檔案 hash 已改變。
- 每日上限：`summaries pending` 最多回傳「`daily_limit` 減去今天已寫入數量」。
- 新指令：
  - `ilearn summaries pending [--json]`：回傳 `target_id`、`kind`、課程、標題、公告內文或檔案本地路徑、`source_hash`。
  - `ilearn summaries write <target_id> --hash <source_hash> [--agent <名稱>]`：摘要文字由標準輸入讀入，最長 2000 字，移除控制字元；hash 不符時拒絕（內容已更新）。
- MCP 工具 `summaries_pending`、`summaries_write`。這是 `events_ack` 之外第二個會寫入的工具，只能寫摘要。
- 顯示位置：`ilearn course <id> --json`、`ilearn announcements --json` 的 `summary` 欄位；`ilearn ui` 課程頁公告與教材下方。
- `ilearn ui` 課程設定頁：每科可剔選兩種摘要，取代「Phase 6 開放」。
- AGENTS.md、SKILL.md、README 移除「摘要尚未提供」，加入用法。

## Task 3：資料夾模式

- `config.interfaces.folder` 為 true 時，在 `sync`、`run`（有同步時）、`reload`、`summaries write`、`mark-teammate` 之後重新產生：
  - `總覽.md`：日期時間、逾期與 7 日內作業、3 日內考試、今天起的公告、系統提示。
  - `課程/<科名>.md`：上課時間、教室、待辦、已完成、考試、公告（含摘要）、教材（本地路徑、摘要）、分數。
  - `保留/<學期>/<科名>.md`：舊學期課程，格式同上。
- 每個檔案開頭註明「唯讀檢視，修改不會影響資料」。只覆寫這三個位置；改名或刪除的課程，舊 `.md` 一併移除。
- 檔名沿用教材資料夾的安全檔名規則。
- 測試：內容、檔名、唯讀、關閉介面時不產生。

## Task 4：精靈確認畫面

- 第 8 步之後顯示全部答案：執行環境、帳號（只顯示「已登入」，不顯示學號）、保存密碼、介面、推送方式、通知規則數量、兩種摘要的課程數。
- 選項：「確認完成」或「修改第 N 步」。修改後回到確認畫面，已答內容作為預設值。
- 第 2 步（登入）不在可修改清單，改為提示 `ilearn login`。
- 中途 Ctrl-C：已存檔的答案保留，下次執行從確認畫面開始。
- 測試：修改單一步驟後其他答案不變；確認後 `setup-progress.json` 標記完成。

## Task 5：文件與驗收

- README、AGENTS.md、SKILL.md、設計文件「實作階段」更新。
- `docs/verification/` 新增驗收紀錄：自動測試結果與真機 TBD 分開列。
- 發布檢查清單更新。

## 執行方式

- 每個 Task 一條 branch、一個 PR，依序 1 → 2 → 3 → 4 → 5。Task 3 依賴 Task 2（課程頁要顯示摘要）。
- Task 1 與 Task 4 改不同檔案，可以並行。
- 每個 Task：test、typecheck、lint、build 全部通過才 commit。

## 待使用者決定

| 項目 | 選項 | 建議 |
| --- | --- | --- |
| 嘗試下載老師關閉下載的檔案（`files.download_disallowed: download`） | 移除選項；保留但在 README 加警告 | 移除，與學校細則「嚴禁事項」第二款最接近 |
| 新學期第一次同步 | 只記錄不推送；全部推送 | 只記錄 |
| 摘要寫回管道 | CLI 加 MCP；只有 CLI | CLI 加 MCP |
| 每個 Task 做完是否停下回報 | 每個停；除非遇到問題，一路做到 Task 5 | 一路做到 Task 5 |
