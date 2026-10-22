---
name: thu-ilearn
description: 讀取使用者已同步到本機的東海大學 iLearn 資料（作業、考試、公告、分數、教材檔案及待推送事件）。使用者問到東海 iLearn 的作業、截止日、考試、公告、成績或課程檔案，或要處理 iLearn 通知時使用。
---

# thu-ilearn

`ilearn` 已把使用者的東海大學 iLearn 同步到這台電腦。你只讀本機資料，不直接連線 iLearn。完整說明見 `AGENTS.md`。

## 取得資料

有 MCP 工具（`thu-ilearn` server）就用工具；沒有就用指令，一律加 `--json`，標準輸出只有一個 JSON 值。

| 需要 | MCP 工具 | 指令 |
| --- | --- | --- |
| 未完成的作業及影片 | `tasks` | `ilearn tasks --json` |
| 要通知使用者的新事件 | `events`（`deliverable: true`、`agent: <你的名稱>`） | `ilearn events --deliverable --agent <你的名稱> --json` |
| 標記事件已處理 | `events_ack` | `ilearn events ack <你的名稱> <event_id>` |
| 課程列表、單一課程 | `courses`、`course` | `ilearn courses --json`、`ilearn course <id> --json` |
| 公告（`posted_at` 為 iLearn 發布時間） | `announcements` | `ilearn announcements [--category <代碼>] --json` |
| 分數與評語 | `grades` | `ilearn grades [--course <id>] --json` |
| 找檔案、讀文字檔 | `files_search`、`file_text` | `ilearn files search <關鍵字> --json`、`ilearn file text <id>` |
| 同步狀態 | `status` | `ilearn status --json` |

## 處理通知

1. 取得 deliverable 事件，依 `delivery` 處理：`force_push` 立刻告訴使用者，`push` 正常通知，`record` 不主動通知。
2. 同一個 `reload_id` 的事件可以合併成一則總覽。
3. `grade.posted`、`feedback.posted` 只說哪一科有新分數或評語，不要主動讀出分數；使用者問了才用 `grades` 讀取。
4. 處理完就 `ack` 最後一個 `event_id`。用 hook 或 webhook 收到的事件也一樣要 `ack`。

## 回答前先檢查

- `initial_sync_in_progress` 為 `true`：資料還在提取中，不可以說「沒有作業」。
- `incomplete_courses` 不為空：那幾科資料可能不完整，要告訴使用者。
- `not_started` 為 `true`：作業尚未開放，不要催促。
- `teammate_hint` 為 `true`：系統顯示隊員可能已交，但仍算未完成；請使用者自己確認並在終端執行 `ilearn mark-teammate`。
- 時間都是台北時間（`+08:00`）。

## 不可以做

- 標記「隊員已交」或修改完成狀態。
- 修改規則、`config.yaml`、`rules.yaml`、hook 指令或 webhook 網址。
- 讀取帳號、密碼、cookie 或 session 檔案。
- 執行 `ilearn login`、`ilearn setup`。exit code 2 或 `auth.expired` 事件表示需要使用者自己重新登入，請提醒對方。
- 直接連線 iLearn 或修改 iLearn 上的任何資料。
