# Phase 3（hook／webhook、MCP server、agent 說明檔）驗收紀錄

日期：2026-10-22。分支：`claude/phase3-delivery-mcp`，由 `main`（`fbab4f8`，PR #1 合併後）開出。設計書：`docs/design/2026-10-22-thu-ilearn-sync-design.md`「推送給 agent 的格式」「Agent 查詢介面」及實作階段 3。

## 已確認決定

| 項目 | 決定 |
| --- | --- |
| 失敗重試 | 依序等 5、10、20、40 分鐘，之後每 60 分鐘；`deliver_after` 超過 24 小時放棄，outbox 保留事件 |
| MCP 入口 | `ilearn mcp` 子命令，stdio |
| hook／webhook 狀態 | 兩個通道各自記錄，互不影響，也與 agent 的 `ack` 進度無關 |
| 送出時機 | `ilearn run`、`daemon`、`sync`、`reload` 結束時；Reload 夜間也即時送出 |
| webhook 位址 | 只接受 `localhost`、`*.localhost`、`127.0.0.0/8`、`::1`；不跟隨轉址；設定精靈與每次送出前都檢查 |
| MCP 工具 | `tasks`、`events`、`events_ack`、`courses`、`course`、`announcements`、`grades`、`files_search`、`file_text`、`status`、`rules_list`；除 `events_ack` 外全部只讀 |
| status | 只回報 hook／webhook 是否啟用、重試中及已放棄數量、最近錯誤；不輸出指令或網址 |

## 自動驗證

| 項目 | 結果 |
| --- | --- |
| `npm test` | 16 個測試檔，246 個測試全部通過（2026-10-23 修正後重跑） |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npm run build` | exit 0，產生 `dist/mcp/server.js` |
| `ilearn mcp` 經 stdio（空資料根） | `initialize` 回傳 `thu-ilearn 0.1.0`；`tools/list` 為上述 11 個工具；`tasks` 回傳 `initial_sync_in_progress: true`；標準錯誤沒有輸出；資料根沒有建立任何檔案 |
| 禁用字掃描（廣東話、簡體、` · `、emoji、箭嘴） | 沒有命中（「關係」為正常用字） |

## 測試對照

| 驗收項目 | 測試 |
| --- | --- |
| hook 成功：事件 JSON 經 stdin、環境變數、exit 0 | `dispatch.test.ts` runHook |
| hook 失敗：exit code、stderr、逾時 | `dispatch.test.ts` runHook |
| backoff 5／10／20／40／60／60 分鐘 | `outbox.test.ts` hook retries back off |
| 24 小時放棄，outbox 保留 | `outbox.test.ts` gives up；`cli.test.ts` hook failures |
| record 不送、夜間 push 等到 07:00、同一事件只送一次 | `dispatch.test.ts` dispatchPending |
| hook 與 webhook 分開記錄 | `dispatch.test.ts` track delivery separately |
| webhook 只接受本機位址、拒絕時不發出請求、非 2xx 與轉址算失敗 | `dispatch.test.ts` webhookUrlError、postWebhook |
| webhook 連線被拒、逾時時顯示清楚原因（不再只顯示 `fetch failed`） | `dispatch.test.ts` explains a refused connection、explains a timeout |
| 失敗 log 格式「本機指令 hook：N 則送出失敗，稍後重試（原因）」 | `cli.test.ts` hook failures |
| `config.yaml` 手動寫入外部網址時不送出 | `dispatch.test.ts` non-localhost webhook in config.yaml |
| `ilearn run` 實際執行 hook、只送一次 | `cli.test.ts` runs the hook |
| 夜間 Reload 即時送出 | `cli.test.ts` delivers to the hook immediately |
| MCP 工具清單與只讀標示 | `mcp.test.ts` exposes exactly |
| MCP 不提供同步、登入、標記隊員已交、改規則、讀帳密 | `mcp.test.ts` offers nothing that |
| MCP 說明告訴 agent：隊員已交由使用者在終端執行 `ilearn mark-teammate`，不是在 iLearn 網頁操作 | `mcp.test.ts` tells agents the user marks |
| MCP 回傳與 CLI JSON 相同 | `mcp.test.ts` same data as the CLI |
| `events_ack` 只影響該 agent；名稱與 event_id 檢查 | `mcp.test.ts` events_ack |
| 未設定時讀取為空、ack 被拒、不寫入任何檔案 | `mcp.test.ts` before setup |

## 設計書驗收條件

| # | 條件 | 狀態 |
| --- | --- | --- |
| 9 | 同一事件不重複推送；cursor 獨立；hook／webhook 失敗後重試，outbox 不遺失 | 自動 PASS |
| 13 | 帳密不出現在 agent 輸出 | 自動 PASS（MCP 輸出掃描） |

## 真機項目（使用者親手測）

2026-10-22 晚至 10-23，使用者以真帳戶在 macOS 測試。

| 項目 | 狀態 | 依據 |
| --- | --- | --- |
| `ilearn setup` 第 5 步勾選 hook 及 webhook，輸入後 `config.yaml` 正確 | PASS | 精靈顯示「已儲存：outbox 檔案、本機指令 hook（cat >> /tmp/ilearn-hook.jsonl）、本機 webhook（http://127.0.0.1:8787/ilearn）」 |
| `ilearn setup` 第 5 步輸入外部網址被拒 | TBD | 這次直接輸入本機網址，未試外部網址（自動測試已涵蓋） |
| 真帳戶 `ilearn reload --yes` 後 hook 收到事件 | PASS | 兩批 Reload 各 48 則，`/tmp/ilearn-hook.jsonl` 共 96 行，hook 重試 0 |
| webhook 沒有程式接收時進入重試，outbox 保留 | PASS | `status` 顯示 webhook 重試中 96 則；原錯誤訊息只有 `fetch failed`，已改為「連線被拒：127.0.0.1:8787 沒有程式在接收」 |
| `claude mcp add` 後 `claude mcp list` 顯示已連線 | PASS | `thu-ilearn … ✔ Connected` |
| MCP `events`（agent test）讀到真資料 | PASS | agent 列出 97 則，與 outbox 一致；未 ack 時沒有建立 cursor |
| MCP `tasks` 讀到真資料 | PASS | 10-23 重測：agent 由 `tasks` 列出兩份 `teammate_hint` 小組作業，id、標題、截止時間與 `ilearn tasks --json` 一致；CLI 計數為未完成 21 份（尚未開放 4、逾期 6），與設定精靈摘要相符 |
| 要求 agent 標記隊員已交 | PASS | 10-23 重測（修正後）：agent 拒絕代為標記，列出 `mark-teammate assignment:<id>` 指令、`--undo` 及先到 iLearn 確認的提醒；兩份作業仍為 pending |
| Phase 2 遺留：首次提取中途 Ctrl-C 後續傳、`ilearn reload` | Reload PASS；Ctrl-C 續傳 TBD | Reload 數量與推送已驗證 |
