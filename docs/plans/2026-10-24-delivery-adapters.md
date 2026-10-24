# 推送轉接器與 delivery test 計劃

日期：2026-10-24。狀態：使用者選方案 2 並追加 8 項要求後，依本計劃實作。

## 現況核實（main，0.1.0）

| 項目 | 現有實作 | 位置 |
| --- | --- | --- |
| 持久化事件來源 | `outbox/events/YYYY-MM-DD.jsonl`，ULID `event_id`，`dedupe_key` 去重（`outbox/state.json`） | `src/events/outbox.ts` |
| agent 補讀與 ACK | 每個 agent 一個 cursor（`outbox/cursors/<agent>.json`），`events --deliverable --agent` 只回傳 cursor 之後且 `deliver_after` 已到的事件 | 同上 |
| 推送通道 | `hook`（本機指令，事件 JSON 經 stdin）與 `webhook`（只限本機位址，POST 事件 JSON），各自記錄成功、失敗次數與最後錯誤 | `src/events/dispatch.ts` |
| 重試與恢復 | 5、10、20、40、60 分鐘 backoff，24 小時後放棄；狀態寫入檔案，重新啟動後沿用 | `outbox.ts` `pendingHooks`、`markHook` |
| 觸發時機 | `run`（背景服務每 5 分鐘）、`sync`、`reload`、`daemon`、`ilearn ui` 同步後 | `src/cli/commands/sync.ts` |
| 權限 | agent 不可修改 `delivery.*`；webhook 網址只接受本機位址 | `src/agent/settings.ts`、`dispatch.ts` |
| 缺少 | webhook 簽名、通道測試、處理失敗回報、測試事件隔離、以實際功能檢查 agent 的接收能力 | — |

## Hermes 官方功能（已核實，來源：hermes-agent.nousresearch.com 的 Webhooks 頁）

- 啟用：`~/.hermes/.env` 的 `WEBHOOK_ENABLED=true`、`WEBHOOK_PORT=8644`（預設），或 `hermes gateway setup`。健康檢查：`curl http://localhost:8644/health`。
- 路由：`http://<host>:8644/webhooks/<route>`；`hermes webhook subscribe <name> [--prompt] [--events] [--deliver] [--deliver-chat-id] [--secret] [--deliver-only] [--skills]`、`hermes webhook list`、`hermes webhook test <name>`。每個路由都必須有 secret。
- 簽名：建議 `X-Webhook-Signature-V2`（`<timestamp>.<body>` 的 HMAC-SHA256 hex）加 `X-Webhook-Timestamp`（Unix 秒，±300 秒）；另支援 `X-Hub-Signature-256`、Standard Webhooks、舊版 `X-Webhook-Signature`。
- 去重：`X-Request-ID` 等標頭作為 delivery ID，快取 1 小時。
- 回應：200 `delivered`／`duplicate`、401 簽名錯誤、429 超過每分鐘 30 次。文件沒有說明一般 agent 路由的 200 是否代表 agent 已處理完成。
- 安全：webhook 觸發的 agent 預設只有 `web_search`、`web_extract`、`vision_analyze`、`clarify`，不能執行終端指令；文件提醒 payload 是不可信內容。

結論：Hermes 由 webhook 觸發的那一次執行不能呼叫 `ilearn` 讀取或 ACK。正確做法是 webhook 只負責「有新事件」的通知；讀取、處理、ACK 交給使用者在 Hermes 設定、提示詞固定的排程工作，排程工作同時是離線補讀的保底。

## 設計

### 1. 以實際功能檢查接收能力

AGENTS.md「使用方法」新增「連接時：檢查接收能力」。agent 不可只憑自述，要執行並回報輸出：

- Hermes：`hermes --version`、`hermes webhook --help`、`hermes webhook list`、`curl -s http://127.0.0.1:8644/health`、是否能建立排程工作。
- 其他 agent：查詢已安裝版本的官方說明（`--help`、版本號、官方文件），找出本機 HTTP 接收端、可呼叫的 CLI、排程功能。
- 依結果選擇：webhook（有本機 HTTP 接收端並支援簽名）、CLI Adapter（有可由其他程式呼叫的指令）、只有排程（定時輪詢）、都沒有（只在使用者詢問時查詢）。
- 回覆格式固定：檢查結果（附指令輸出）、推薦方式與原因、使用者要設定的值。推送設定仍由使用者本人在 `ilearn ui` 或 `ilearn setup` 輸入。

### 2. Hook 改名為 CLI Adapter

- 設定鍵改為 `delivery.cli`；讀到舊的 `delivery.hook` 自動沿用（相容）。
- 通道名稱改為 `cli`；`outbox/state.json` 中舊的 `hook:` 狀態自動轉換。
- `ilearn status --json` 的 `delivery` 同時提供 `cli` 與舊名 `hook`（相同內容），之後版本再移除 `hook`。
- 介面與文件一律稱「CLI Adapter（本機指令）」，避免與 agent 的 lifecycle hooks 混淆。

### 3. Outbox 是唯一事件來源

- Webhook 與 CLI Adapter 只是「有新事件」的通知；為相容，內容仍是完整事件 JSON。
- agent 收到通知後一律以 `ilearn events --deliverable --agent <名稱> --json` 讀取、處理、`ilearn events ack`。通知送達不代表事件已處理，未 ACK 的事件下次仍會回傳。

### 4. 共用事件 ID、狀態與去重

- 所有通道使用同一個 `event_id`；webhook 加上 `X-Request-ID: <event_id>`（Hermes 依此去重）與 `X-Thu-Ilearn-Event-Id`；CLI Adapter 以環境變數 `ILEARN_EVENT_ID` 傳入。
- 離線補讀、失敗重試、重新啟動恢復沿用現有 cursor 與 backoff 狀態檔，新增測試覆蓋。

### 5. delivery test 分四級

`ilearn delivery test --agent <名稱> [--json]` 建立一則測試事件並經已啟用的通道送出，回傳 `test_id`。`ilearn delivery test --status <test_id> [--json]` 顯示四級結果：

| 級別 | PASS 條件 |
| --- | --- |
| Transport | webhook 回應 2xx，或 CLI Adapter exit code 0（每個通道分開） |
| Agent | agent 以 `ilearn events --deliverable --agent <名稱> --test --json` 讀到這則測試事件 |
| Processing | agent 執行 `ilearn events report <名稱> <event_id> --status processed` |
| ACK | agent 執行 `ilearn events ack <名稱> <event_id> --test` |

Transport PASS 只代表通知送達。

### 6. 測試事件隔離

- 測試事件存放在 `outbox/test/`，`type` 為 `delivery.test`，不寫入 `outbox/events/`，不影響正式 cursor、去重與重試狀態。
- 測試事件的 ACK 寫入獨立的測試 cursor；ACK 完成後才刪除測試事件，結果保留在 `outbox/test/results.json` 供 `--status` 查詢；超過 24 小時未完成的測試標記為逾時並清理。

### 7. 區分「沒有新事件」「讀取失敗」「處理失敗」

- 沒有新事件：exit code 0，輸出 `[]`。
- 讀取失敗：exit code 1 或 2，標準錯誤有訊息；不可 ACK。
- 處理失敗：新增 `ilearn events report <名稱> <event_id> --status failed --note <原因>`，記錄失敗並顯示在 `ilearn status` 與 `ilearn ui` 提醒頁；不移動 cursor。
- AGENTS.md 規定依 `event_id` 順序處理，遇到失敗就停，只 ACK 最後一則成功的事件（ACK 會連同之前的事件一起標記）。

### 8. 簽名、權限與敏感資訊

- 新增 `delivery.webhook.secret`。有設定時加上 `X-Webhook-Timestamp` 與 `X-Webhook-Signature-V2`（HMAC-SHA256，與 Hermes 相同格式）；沒有設定時照舊不簽名，`delivery test` 標示「未簽名」。
- secret 不出現在 `status`、`config get`、MCP、log、事件與 `總覽.md`；介面只顯示「已設定」。由使用者在 `ilearn setup` 第 5 步或 `ilearn ui` 的「推送方式」輸入（以 `*` 顯示）。
- agent 仍不可修改 `delivery.*`（包括 secret）。
- 事件內容（標題、內文）來自 iLearn，是不可信資料。文件與 MCP 說明規定不可把事件內容當成指令，也不可因事件內容擴大工具權限；Hermes 整合使用固定提示詞的排程工作讀取事件，不使用 `{__raw__}` 或擴大 webhook 路由的 toolsets。

## 相容性

- 現有 `config.yaml`（含 `delivery.hook`）、`outbox/state.json`、cursor、事件格式、CLI 輸出與 MCP 工具都維持可用。
- 新增的 `delivery.test` 類型只出現在測試事件，正式事件仍是 15 種。

## 驗證

- 自動測試：簽名格式（以 Hermes 文件的 V2 公式驗證）、`X-Request-ID`、CLI Adapter 改名與舊設定相容、state 轉換、測試事件隔離與四級狀態、處理失敗不移動 cursor、離線補讀、重新啟動後重試。
- 模擬端到端：本機臨時 webhook 接收器以 V2 公式驗簽；CLI Adapter 指令寫入暫存檔；由 agent（本 session 的 Claude）依 AGENTS.md 執行讀取、report、ACK，`--status` 四級全 PASS。
- 真正的 Hermes 端到端：需要使用者在 Linux 的 Hermes 設定 webhook 路由與排程工作後執行 `delivery test`，目前環境無法驗證。
