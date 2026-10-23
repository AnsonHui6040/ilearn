---
name: thu-ilearn
description: 讀取使用者已同步到本機的東海大學 iLearn 資料（作業、考試、公告、分數、教材檔案及待推送事件）。使用者問到東海 iLearn 的作業、截止日、考試、公告、成績或課程檔案，或要處理 iLearn 通知時使用。
---

# thu-ilearn

`ilearn` 已把使用者的東海大學 iLearn 同步到這台電腦。你只讀本機資料，不直接連線 iLearn。逐步做法與使用者說法對應的設定鍵，見 `AGENTS.md` 的「使用方法」。

## 基本規則

1. 只用下表的 MCP 工具或 `ilearn` 指令，不要修改資料根底下的檔案。
2. 會寫入的只有 `events_ack`、`summaries_write`、`config_set`、`rules_add`；使用者沒有要求就不要寫摘要、改設定或加規則。
3. 失敗就停下來，把錯誤訊息轉告使用者；不要換其他鍵名、改檔案或用別的方法繞過。
4. 不確定使用者的意思，先問。
5. 找不到 `ilearn` 指令時，照 `AGENTS.md`「出錯時」透過使用者的登入 shell 查出 Node 與 npm root，之後一律用 `"<node>" "<npm root>/thu-ilearn/dist/cli/index.js"` 執行。

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
| 待摘要的公告與教材 | `summaries_pending` | `ilearn summaries pending --json` |
| 寫回摘要 | `summaries_write`（`target_id`、`source_hash`、`text`） | `ilearn summaries write <target_id> --hash <source_hash> --agent <你的名稱>`（摘要文字從標準輸入） |
| 目前的 agent 權限與可修改的設定 | `config_get` | `ilearn config get --json` |
| 修改一項設定 | `config_set`（`key`、`value`、`agent`） | `ilearn config set <key> <value> --agent <你的名稱>` |
| 新增通知規則 | `rules_add`（`name`、`keywords`、`action`、`agent`、`courses`） | `ilearn rules add --name <名稱> --keywords <a,b> --action <等級> [--course <id,...>] --agent <你的名稱>` |
| 同步狀態 | `status` | `ilearn status --json` |

## 處理通知

1. 取得 deliverable 事件，依 `delivery` 處理：`force_push` 立刻告訴使用者，`push` 正常通知，`record` 不主動通知。
2. 同一個 `reload_id` 的事件可以合併成一則總覽。
3. `grade.posted`、`feedback.posted` 只說哪一科有新分數或評語，不要主動讀出分數；使用者問了才用 `grades` 讀取。
4. 處理完就 `ack` 最後一個 `event_id`。用 hook 或 webhook 收到的事件也一樣要 `ack`。

## 寫摘要

只在使用者要摘要時做。本工具不呼叫 AI，摘要由你寫。

1. 取得 `summaries_pending`。`agent_write` 為 `false` 表示使用者沒有允許寫入摘要，不要寫入。
2. 公告讀 `body`；教材讀 `path` 的本機檔案。
3. 寫摘要（最多 2000 字），連同該筆的 `target_id` 與 `source_hash` 寫回。
4. `hash` 不符表示原文已變動，重新取得 `pending` 再寫。
5. 寫到 `remaining_today` 為 0 就停止。
6. 寫入後，`course` 與 `announcements` 的 `summary` 欄位會有內容（沒有時為 `null`）。

## 修改設定

只在使用者要你調整通知、提醒或規則時做。

1. 先 `config_get`。`agent_permissions.settings` 為 `false` 表示使用者沒有允許，不要修改，也不要請使用者為你開啟（除非對方本來就是要你改設定）。
2. 先說明要改什麼、改成什麼，使用者同意再改（對方已明確要你改的除外）。
3. 只能改這些鍵：`quiet_hours.start|end`、`reminders.offsets`、`force_push_offsets`、`rules.<代碼>.enabled|action|keywords`、`course_overrides.<課程 id>.rules.<代碼>.enabled|action`、`course_overrides.<課程 id>.reminders`、`summaries.courses.<課程 id>.materials|announcements`、`summaries.daily_limit`、`interfaces.folder`、`updates.check`，以及新增規則。值的格式見 `AGENTS.md`。
4. 每次修改都會記錄並顯示給使用者；`agent` 請固定用同一個名稱。

## 回答前先檢查

- `initial_sync_in_progress` 為 `true`：資料還在提取中，不可以說「沒有作業」。
- `incomplete_courses` 不為空：那幾科資料可能不完整，要告訴使用者。
- `not_started` 為 `true`：作業尚未開放，不要催促。
- `teammate_hint` 為 `true`：系統顯示隊員可能已交，但仍算未完成；請使用者自己確認並在終端執行 `ilearn mark-teammate`。
- 時間都是台北時間（`+08:00`）。
- 新學期的第一次同步不推送事件，完成時有一則 `record` 的 `sync.initial_completed`，`summary` 會寫明學期；舊學期不再提醒。
- 老師關閉下載的教材沒有本機檔案，只有檔名與 iLearn 連結。

## 出錯時

| 情況 | 做法 |
| --- | --- |
| exit code 2 | 請使用者自己執行 `ilearn login`（尚未設定時 `ilearn setup`），不要重試 |
| 「尚未允許」 | 停止，不要再試 |
| hash 不符、原文已變動 | 重新取得 `summaries_pending` |
| 每日上限 | 今天停止寫摘要 |
| 不能修改、不在清單、值無效 | 停止，把訊息轉告使用者 |
| 其他錯誤 | 把訊息轉告使用者，不要自己修改檔案修復 |

## 不可以做

- 標記「隊員已交」或修改完成狀態。
- 在使用者沒有允許時寫入摘要或修改設定，或要求對方為你開啟這些權限（除非對方想要摘要或要你改設定）。
- 直接編輯 `config.yaml`、`rules.yaml`，或修改 hook 指令、webhook 網址、帳號、推送方式、節次時間、背景服務與 agent 權限。設定只能經 `config set`、`rules add`，且只在使用者允許時。
- 讀取帳號、密碼、cookie 或 session 檔案。
- 執行 `ilearn login`、`ilearn setup`。exit code 2 或 `auth.expired` 事件表示需要使用者自己重新登入，請提醒對方。
- 直接連線 iLearn 或修改 iLearn 上的任何資料。
