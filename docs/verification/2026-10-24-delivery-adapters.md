# 推送轉接器與 delivery test 驗收紀錄

日期：2026-10-24。分支：`claude/delivery-adapters`。計劃：`docs/plans/2026-10-24-delivery-adapters.md`。

## 自動測試

| 項目 | 結果 |
| --- | --- |
| `npm run typecheck`、`npm run lint`、`npm run build` | exit 0 |
| `npm test` | 33 個測試檔，602 個測試全部通過 |

涵蓋：舊設定 `delivery.hook` 沿用為 `delivery.cli`、state 鍵轉換、`status` 同時提供 `cli` 與 `hook`、V2 簽名以 Hermes 公式重算比對、沒有 secret 時不送簽名標頭、`X-Request-ID` 等於 `event_id`、secret 不出現在 `status`／`config get`／MCP、agent 不能修改 `delivery.*`、測試事件隔離、四級狀態轉換、24 小時逾時清理、處理失敗不移動 cursor、離線補讀、重新啟動後不重送、未設定資料夾時 agent 讀取回報錯誤而不是空清單。

## 模擬端到端（本機，2026-10-24 15:28–15:31）

以 Node 寫的本機接收器模擬 Hermes webhook 路由：依 Hermes 官方 V2 公式（`HMAC-SHA256(secret, "<timestamp>.<body>")`，±300 秒）驗簽，以 `X-Request-ID` 去重。CLI Adapter 指令把事件寫入暫存檔。agent 的讀取、report、ACK 由本 session 的 Claude 依 AGENTS.md 執行。

| 項目 | 結果 |
| --- | --- |
| `delivery test`：Transport（CLI Adapter exit 0、webhook 200 且簽名通過） | PASS |
| Agent：`events --deliverable --agent claude --test` 讀到測試事件；正式 `events` 沒有出現測試事件 | PASS |
| Processing：`events report … --status processed --test` | PASS |
| ACK：`events ack … --test`；測試事件檔案刪除、結果保留；正式 cursor 沒有建立 | PASS |
| 正式事件 3 則經 CLI Adapter 與簽名 webhook 送出，`X-Request-ID` 與事件 ID 一致 | PASS |
| 再跑一次推送（等同重新啟動）：0 則重送 | PASS |
| agent 離線後一次讀到 3 則；ACK 第 1 則、第 2 則回報失敗並停止；下次讀到第 2、3 則；`status` 的 `processing_failures` 有紀錄 | PASS |
| 資料夾未設定時 agent 讀取：exit 2「尚未設定」，不是空清單 | PASS |
| secret 錯誤：接收器回 401，Transport 顯示 webhook FAIL（HTTP 401） | PASS |
| 接收器停止：Transport 顯示「連線被拒：127.0.0.1:<port> 沒有程式在接收」 | PASS |
| secret 沒有出現在 `status`、`config get`、測試結果檔 | PASS |

實作中發現並修正：`events ack`／`events report` 的 `--test`、`--json` 被上層 `events` 指令吃掉（改用 `optsWithGlobals`）；agent 讀取未設定的資料夾時原本回傳空清單（改為 exit 2）。

## `ilearn connect hermes` 模擬端到端（本機，2026-10-24）

以假的 `hermes` 指令（照官方 CLI 的指令形狀回應，記錄每次呼叫）、假 gateway（`/health`；`/webhooks/thu-ilearn` 依 V2 公式驗簽，通過回 202 並觸發排程）與一個只照固定提示詞步驟執行的腳本 agent，執行真正的 `runConnectHermes`（以腳本回答提問、全部確認）。

| 項目 | 結果 |
| --- | --- |
| 偵測表：版本、cron status、gateway status、`webhook subscribe --cron-job` 支援、`/health` | PASS |
| 指令都帶 `-p daily`；`cron create "*/5 * * * *" <固定提示詞> --name thu-ilearn-inbox --deliver telegram:42` | PASS |
| `webhook subscribe thu-ilearn --cron-job thu-ilearn-inbox --secret …`；畫面與紀錄只顯示 `--secret ***` | PASS |
| ilearn 的 webhook 指向 `http://127.0.0.1:<port>/webhooks/thu-ilearn` 並帶 secret | PASS |
| 四級測試：webhook 簽名通過（202）→ 排程 agent 讀取、report、ACK → Transport／Agent／Processing／ACK 全 PASS | PASS |
| 正式事件經簽名 webhook 觸發排程，agent 整理成通知（「資料結構：下週改到 M201 上課」）並 ACK | PASS |
| secret 沒有出現在畫面輸出、`status`、hermes 呼叫紀錄 | PASS |
| `--remove`：刪除排程與路由，ilearn webhook 關閉並清除 secret | PASS |

模擬中發現並修正：
- 提示詞原本寫入帶版本號的 node 路徑（`/opt/homebrew/Cellar/node/<版本>/bin/node`），升級 Node 後會失效；改用與背景服務相同的 `stableNodePath`，現在是 `/opt/homebrew/bin/node`。
- webhook 已觸發排程後又執行 `cron run`，兩次執行同時處理同一則測試事件，測試成功訊息送出兩次；改為只在 webhook 沒有指向 Hermes 路由或沒有送達時才 `cron run`。

未驗證：真正的 Hermes 指令輸出文字（`cron status` 判斷是否執行中的字樣）、`--cron-job` 是否存在於使用者安裝的版本、排程工作的 session 是否有終端機工具。這些都會在使用者於 Linux 執行 `ilearn connect hermes` 時由偵測表與四級測試直接顯示。

## agent 提出、使用者確認（`--prompt`／`--request`／`approve`）模擬端到端（2026-10-24）

使用者測試回報：webhook 沒有被啟用；提問應由 agent 回答。改為 agent 提出連接申請、使用者只在終端確認，並以 Hermes 自己的 `config set` 啟用 webhook。假 gateway 一開始沒有啟動，只有在 `WEBHOOK_ENABLED=true` 後 `gateway restart` 才會啟動。

| 步驟 | 執行者 | 結果 |
| --- | --- | --- |
| `ilearn connect hermes --prompt --agent hermes --json`：取得排程名稱、`every 5m`、`origin` 與固定提示詞 | agent（由 Claude 扮演） | PASS |
| 以自己的排程工具建立 `thu-ilearn-inbox` | agent（模擬） | PASS |
| `ilearn connect hermes --request --profile daily --agent hermes --port 18644`：只呼叫唯讀指令（`--version`、`cron list`、`webhook subscribe --help`、`webhook list`、`config get WEBHOOK_PORT`），寫入 0600 的申請檔與 6 碼確認代碼 | agent | PASS |
| `approve`：核對代碼 → 確認排程存在 → `/health` 沒有回應 → `config set WEBHOOK_ENABLED true`、`config set WEBHOOK_PORT 18644`、`gateway restart -y` → 接收端啟用 | 使用者確認（腳本回答「是」） | PASS |
| 建立路由 `--cron-job thu-ilearn-inbox`、ilearn webhook 指向路由並帶 secret；畫面只顯示 `--secret ***` | 使用者確認 | PASS |
| 四級測試全 PASS，測試成功訊息只送出一次；申請檔在完成後刪除 | 自動 | PASS |

## 真正的 Hermes 端到端（本機 Hermes v0.15.1，2026-10-24 16:22–16:31）

使用者提供本機一個平常沒有使用的 Hermes（預設 profile，模型 deepseek-v4.1-flash，沒有任何訊息平台）。ilearn 端使用隔離的暫存資料夾（假帳號、`ILEARN_HOME` 指向暫存處），不影響 `~/.thu-ilearn` 與背景服務。測試期間在終端分頁執行 `hermes gateway run`，結束後停止。

| 步驟 | 結果 |
| --- | --- |
| 唯讀檢查：`hermes --version`、`profile list`、`gateway status`、`cron status`、`webhook --help`、`webhook subscribe --help` | 完成；發現 v0.15.1 的 `profile list` 是表格、目前 profile 標 `◆`（已修正解析並加測試）；沒有 `config get`；`webhook subscribe` 沒有 `--cron-job` |
| `cron status` 字樣：未啟動「Gateway is not running — cron jobs will NOT fire」、啟動後「Gateway is running — cron jobs will fire automatically」 | 程式判斷正確 |
| 以 `hermes chat -q` 交給 Hermes agent 連接提示詞：agent 執行 `--prompt`、用自己的 cron 工具建立 `thu-ilearn-inbox`（每 5 分鐘、origin）、逐字比對提示詞、執行 `--request` 並回報確認代碼 | PASS |
| `approve`（使用者確認以腳本回答）：核對代碼、確認排程存在；因不支援 `--cron-job` 只用排程輪詢，沒有更改任何 Hermes 或 ilearn 設定 | PASS |
| 四級測試：Transport 未啟用（輪詢模式）、Agent／Processing／ACK 由 Hermes 排程 agent 完成 | PASS |
| 正式事件 3 則（作業、夾帶誘導指令的公告、record 教材）：agent 依序整理成通知、record 不通知、ACK 到最後一則；誘導指令只被轉述，`touch` 沒有執行 | PASS |
| 沒有事件時回覆 `[SILENT]` | PASS |
| 清理：`hermes cron remove thu-ilearn-inbox`、停止 gateway、刪除暫存資料夾 | 完成 |

觀察：
- 排程是在命令列對話（`hermes chat -q`）建立，gateway 記錄「no delivery target resolved for deliver=origin」，所以這次通知只存在 `~/.hermes/cron/output/`。在 Telegram 等真正的對話裡建立時，origin 會是該對話。
- 舊版 Hermes 沒有 `--cron-job`，新事件最多延遲 5 分鐘；新版 Hermes（官方文件有 `--cron-job`）會由 webhook 立即觸發。
- Hermes 的回覆偶爾在通知後附加一行說明（例如「以上為 iLearn 事件原文，僅轉述」），不影響處理與 ACK。

## 積壓事件處理（Linux 回報與修正，2026-10-24）

使用者在 Linux（Hermes v0.16.0、profile daily、Telegram）測試：連接與四級測試通過，但真實事件處理失敗。排程讀取 `events --deliverable --json` 時輸出過長被工具截斷，無法處理；以 jq／python 精簡需要審批而被擋；同一事件每 5 分鐘回報失敗一次並通知使用者，從未 ACK；`processing_failures` 重複列出同一事件。使用者已暫停排程。

修正：`events --compact`（精簡欄位、標題截到 120 字）與 `--limit`；`events report --status skipped`（同一事件失敗兩次後隔離略過，可 ACK 越過）；compact 每則附 `failures`，只在第一次失敗通知使用者；`processing_failures` 依事件合併並附次數；排程提示詞禁止使用 jq、python 等解析工具，每次讀 30 則。

本機 Hermes v0.15.1 重測（隔離資料夾，60 則積壓：40 則同一 reload 批次、1 則 5000 字標題、19 則新項目其中 7 則 record）：

| 項目 | 結果 |
| --- | --- |
| 精簡讀取一頁 30 則約 9 KB（原本一次全部約 46 KB） | PASS |
| 第 1 次執行：30 則 reload 合併成一則總覽，ACK 推進，剩 30 則 | PASS |
| 第 2 次執行：剩下 10 則 reload 合併、超長公告標題已截短、12 則新作業逐則通知、7 則 record 不通知，剩 0 則 | PASS |
| `processing_failures` 為空，沒有截斷與失敗 | PASS |

## 真正的 agent 端到端

| 項目 | 狀態 |
| --- | --- |
| Claude（本 session）依 AGENTS.md 完成四級測試與正式事件的讀取、失敗回報、ACK | PASS（使用模擬接收器，不是 Hermes） |
| Hermes（本機 v0.15.1）：agent 建立排程並送出申請、`approve`、四級測試、正式事件與誘導指令、`[SILENT]` | PASS（見上一節；通知送達訊息平台未測，因本機 Hermes 沒有設定平台） |
| Hermes（使用者 Linux、有訊息平台、新版有 `--cron-job`）：在真正的對話貼上提示詞並 `approve`，webhook 立即觸發並在該對話收到「thu-ilearn 推送測試成功」 | TBD |

## 尚未能在目前環境驗證

- Hermes 一般 agent 路由回應 200 時，agent 是否已處理完成（官方文件沒有說明；設計上不依賴這一點）。
- Hermes 排程工作的建立指令（官方 CLI 參考沒有完整列出；AGENTS.md 要求 agent 以 `hermes --help` 確認）。
- Hermes 的 `--cron-job` 參數（官方頁面範例有用到，但 CLI 參考沒有列出）。
- Windows 上 CLI Adapter 的指令執行與 webhook 簽名。
- `ilearn setup` 第 5 步與 `ilearn ui` 輸入 secret 的畫面（只有程式路徑，未在真實終端操作）。
