# AGENTS.md

給 Codex、Claude、Hermes 等 AI agent 的使用說明。`ilearn` 把東海大學 iLearn 同步到使用者的電腦，agent 透過指令讀取。

## 使用原則

- 所有資料指令都加 `--json`。標準輸出只會有一個 JSON 值，可直接解析。
- 錯誤時 exit code 為 1，訊息在標準錯誤；exit code 2 表示尚未設定或 iLearn 登入已過期，請依標準錯誤的訊息提醒使用者自己執行 `ilearn setup` 或 `ilearn login`。
- 你的 agent 名稱自己決定（英數、`.`、`_`、`-`，最長 64 字元），用於 `--agent` 與 `ack`，各 agent 各自有進度。
- 時間一律是台北時間（`+08:00`）。

## 指令

| 指令 | 回傳 |
| --- | --- |
| `ilearn tasks --json` | `{ initial_sync_in_progress, incomplete_courses, tasks[] }`。`tasks[]` 欄位：`id`、`kind`（`assignment` 或 `video`）、`course`、`title`、`due_at`、`overdue`、`not_started`、`group`、`teammate_hint`、`completion`、`url` |
| `ilearn events --deliverable --agent <名稱> --json` | 該 agent 尚未 ack 且 `deliver_after` 已到的事件陣列 |
| `ilearn events ack <名稱> <event_id>` | 標記該 agent 已處理到此事件（含之前的） |
| `ilearn events [--type <類型>] [--since <ISO 時間>] --json` | 查詢全部事件 |
| `ilearn courses --json` | 課程列表 |
| `ilearn course <id> --json` | 單一課程：上課時間、待辦、已完成、考試、公告與分類、教材與檔案的本地路徑、問卷、影片、分數與評語 |
| `ilearn announcements [--category <代碼>] [--course <id>] --json` | 公告與分類，依發布時間由新到舊；`posted_at` 為 iLearn 發布時間 |
| `ilearn grades [--course <id>] --json` | 分數與評語 |
| `ilearn files search <關鍵字> --json` | 以檔名搜尋，回傳本地路徑 |
| `ilearn file text <id>` | 輸出 `.txt`、`.md` 檔案的文字；其他格式回傳「尚未支援」 |
| `ilearn status --json` | 同步狀態、最近錯誤、首次同步進度 |
| `ilearn rules list --json` | 目前生效的規則（只讀） |

## MCP server

支援 MCP 的客戶端可以改用 `ilearn mcp`（stdio）。設定範例：

```json
{
  "mcpServers": {
    "thu-ilearn": { "command": "ilearn", "args": ["mcp"] }
  }
}
```

工具與上表指令一一對應，回傳內容相同（一段 JSON 文字）：

| 工具 | 對應指令 | 參數 |
| --- | --- | --- |
| `tasks` | `ilearn tasks --json` | 無 |
| `events` | `ilearn events --json` | `deliverable`、`agent`、`type`、`since`，皆可省略 |
| `events_ack` | `ilearn events ack` | `agent`、`event_id` |
| `courses` | `ilearn courses --json` | 無 |
| `course` | `ilearn course <id> --json` | `id` |
| `announcements` | `ilearn announcements --json` | `category`、`course`，皆可省略 |
| `grades` | `ilearn grades --json` | `course`，可省略 |
| `files_search` | `ilearn files search --json` | `keyword` |
| `file_text` | `ilearn file text --json` | `id` |
| `status` | `ilearn status --json` | 無 |
| `rules_list` | `ilearn rules list --json` | 無 |

除了 `events_ack` 之外全部只讀。錯誤以工具錯誤（`isError`）回傳中文訊息。MCP server 不提供同步、Reload、登入、標記「隊員已交」、修改規則或設定、讀取帳密的工具。

`initial_sync_in_progress` 為 `true` 時，首次同步還沒完成，清單可能不完整。這時不要告訴使用者「沒有作業」，要說明資料還在提取中。`incomplete_courses` 不為空時，表示那幾科的資料可能不完整。

`teammate_hint` 為 `true` 表示小組作業可能已由隊員繳交，但系統無法確認，仍視為未完成。

`not_started` 為 `true` 表示作業尚未開放繳交（開放時間在未來），不要催促使用者現在處理。

## 事件格式

事件存放在 `<資料根>/outbox/events/YYYY-MM-DD.jsonl`，每行一個，格式為 `thu-ilearn.event.v1`，JSON Schema 在 `<資料根>/outbox/schema/event.v1.json`。

```json
{
  "schema": "thu-ilearn.event.v1",
  "event_id": "01JB8X5Q4N3Z...",
  "type": "announcement.new",
  "detected_at": "2026-10-22T01:12:40+08:00",
  "deliver_after": "2026-10-22T07:00:00+08:00",
  "delivery": "push",
  "categories": ["room_change"],
  "matched_rules": ["room_change"],
  "course": { "id": "12345", "name": "資料結構", "semester": "115-1" },
  "item": {
    "id": "announcement:88001",
    "kind": "announcement",
    "title": "下週起改至 M201 上課",
    "due_at": null,
    "url": "https://ilearn.thu.edu.tw/course/12345/bulletin"
  },
  "summary": null,
  "dedupe_key": "announcement.new:announcement:88001"
}
```

`type` 只有以下 15 種：`assignment.new`、`assignment.due_reminder`、`assignment.returned`、`exam.new`、`exam.reminder`、`video.new`、`announcement.new`、`material.new`、`survey.new`、`course.info_changed`、`grade.posted`、`feedback.posted`、`auth.expired`、`sync.incomplete`、`sync.initial_completed`。提醒類事件另有 `offset`（例如 `P1D`、`PT3H`）。

規則：

- 只處理 `deliver_after` 已到的事件，用 `events --deliverable` 即可。夜間（00:00 到 07:00）產生的推送事件會延到 07:00。
- `delivery` 為 `record` 的事件只供查詢，不需要主動通知使用者。`push` 要通知；`force_push` 要立刻通知。
- 帶有 `"reason": "reload"` 與 `reload_id` 的事件是使用者按 Reload 產生的一批，同一個 `reload_id` 可以合併成一則總覽。
- `grade.posted` 與 `feedback.posted` 只說明哪一科、哪一項有新分數或評語，不含內容。使用者詢問時，再用 `ilearn grades --json` 讀取並回答。
- 處理完一個事件就 `ack`。同一個 `dedupe_key` 只會出現一次。
- 也可以直接讀 `<資料根>/outbox/通知.md`，這是給人看的版本。

## 主動推送（hook／webhook）

使用者可以在 `ilearn setup` 第 5 步啟用，讓事件主動送到你這邊，不必定時查詢。只有 `delivery` 為 `push` 或 `force_push`、且 `deliver_after` 已到的事件會送出；`record` 只寫入 outbox。

- **本機指令 hook**：每則事件執行一次使用者設定的指令，事件 JSON（一行）經標準輸入傳入，另有環境變數 `ILEARN_EVENT_ID`、`ILEARN_EVENT_TYPE`。exit code 0 才算送達，限時 30 秒。
- **本機 webhook**：以 `POST` 送出同一份 JSON，`Content-Type: application/json`。只接受本機位址（`localhost`、`127.0.0.1`、`::1`），不跟隨轉址，回應 2xx 才算送達，限時 10 秒。
- **送出時機**：`ilearn run`（cron 每 5 分鐘）、`ilearn daemon`、`ilearn sync` 及 `ilearn reload` 結束時。Reload 即使在夜間也會立即送出。
- **失敗重試**：依序等 5、10、20、40 分鐘，之後每 60 分鐘再試；`deliver_after` 超過 24 小時仍未送達就放棄。outbox 一定保留事件，`ilearn status --json` 的 `delivery` 欄位會顯示重試中及已放棄的數量。
- hook 與 webhook 各自記錄是否送達，與你的 `ack` 進度無關。收到並處理後仍請 `ack`，避免之後用 `events --deliverable` 查詢時重複處理。

## Agent 權限

可以：

- 讀取所有同步資料，包括分數與評語，用來回答使用者的提問。
- `ilearn events ack`（MCP 工具 `events_ack`）。
- 查看目前規則與狀態。

不可以：

- 修改完成狀態或標記「隊員已交」（`mark-teammate` 在非互動終端會被拒絕，請提醒使用者自己操作）。
- 修改規則（`rules edit`）、設定檔（包括 hook 指令及 webhook 網址）或 `rules.yaml`。
- 讀取帳號、密碼、cookie 或 session 檔案。
- 觸發登入（`ilearn login`、`ilearn setup`）。登入過期時請使用者自己處理。
- 直接連線 iLearn 或修改 iLearn 上的任何資料。

## 限制

- 資料最多與上一次同步一樣新。需要最新資料時可請使用者執行 `ilearn sync`。
- 老師關閉下載權限的檔案預設不下載，`ilearn course` 會列出檔名與 iLearn 連結。
- `ilearn file text` 目前只支援 `.txt` 與 `.md`。
- 每科摘要功能（`summaries`）尚未提供。
