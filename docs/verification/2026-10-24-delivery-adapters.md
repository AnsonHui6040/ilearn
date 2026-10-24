# 推送轉接器與 delivery test 驗收紀錄

日期：2026-10-24。分支：`claude/delivery-adapters`。計劃：`docs/plans/2026-10-24-delivery-adapters.md`。

## 自動測試

| 項目 | 結果 |
| --- | --- |
| `npm run typecheck`、`npm run lint`、`npm run build` | exit 0 |
| `npm test` | 33 個測試檔，554 個測試全部通過（新增 25 個，在 `tests/delivery-adapters.test.ts`） |

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

## 真正的 agent 端到端

| 項目 | 狀態 |
| --- | --- |
| Claude（本 session）依 AGENTS.md 完成四級測試與正式事件的讀取、失敗回報、ACK | PASS（使用模擬接收器，不是 Hermes） |
| Hermes：`hermes webhook subscribe` 建立路由、以相同 secret 驗簽、排程工作讀取並 ACK、`delivery test --status` 四級 PASS | TBD（需要使用者在 Linux 的 Hermes 上執行） |

## 尚未能在目前環境驗證

- Hermes 一般 agent 路由回應 200 時，agent 是否已處理完成（官方文件沒有說明；設計上不依賴這一點）。
- Hermes 排程工作的建立指令（官方 CLI 參考沒有完整列出；AGENTS.md 要求 agent 以 `hermes --help` 確認）。
- Hermes 的 `--cron-job` 參數（官方頁面範例有用到，但 CLI 參考沒有列出）。
- Windows 上 CLI Adapter 的指令執行與 webhook 簽名。
- `ilearn setup` 第 5 步與 `ilearn ui` 輸入 secret 的畫面（只有程式路徑，未在真實終端操作）。
