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

## 真機測試步驟

在測試用的資料夾副本進行，不影響正在執行的背景服務與 `~/.thu-ilearn`。每一步的「預期」符合就把上表對應項目改為 PASS。

### 0. 準備

```sh
cd ~/Documents/GitHub/ilearn/.claude/worktrees/phase4-web-ui-f1b5e4
git switch claude/agent-permissions && npm run build
cp -R ~/.thu-ilearn ~/.thu-ilearn-test
export ILEARN_HOME=~/.thu-ilearn-test
il() { node ~/Documents/GitHub/ilearn/.claude/worktrees/phase4-web-ui-f1b5e4/dist/cli/index.js "$@"; }
```

注意：

- 以下指令都在**同一個終端分頁**執行，`ILEARN_HOME` 與 `il` 只在這個分頁有效。
- 先開 `il ui` →「5 系統設定 > 推送方式」，把 hook 與 webhook 關閉，避免測試副本再推送一次事件給 agent。
- 測試期間**不要**安裝背景服務：設定精靈最後問是否安裝背景服務時選「否」，也不要在 `il ui` 按「背景服務」安裝。測試副本與正式的背景服務使用同一個排程名稱，安裝會取代正式的那一個。
- 不要在測試副本按「完全移除」。

### 1. 設定精靈確認畫面

1. `il setup`，沿用目前登入，其餘照舊回答；第 4 步剔選「資料夾」；第 8 步最後的「允許 agent：」兩項都剔選。
2. 預期：第 8 步之後出現「確認設定」，8 行答案，第 2 行只有「已登入」，沒有學號。
3. 選「修改第 5 步」，不改內容直接完成。預期：回到確認畫面，其他行不變。
4. 在確認畫面按 Ctrl-C，再執行 `il setup`。預期：第 1 至 8 步都顯示略過，直接回到確認畫面。
5. 選「確認完成」。背景服務問題選「否」。

### 2. 資料夾檢視

1. `il sync`，完成後 `open ~/.thu-ilearn-test`。
2. 預期：有 `總覽.md`、`課程/`（每科一個 `.md`），有舊學期資料時另有 `保留/`。每個檔案開頭有「唯讀檢視」說明。
3. 對照 `il ui` 首頁與課程頁，作業、截止時間、教室一致。

### 3. 老師關閉下載的教材

1. 在 `il ui` 的課程頁找標示「老師關閉下載」的教材（沒有的話此項記為「無資料」）。
2. 預期：`~/.thu-ilearn-test/files/` 裡沒有該檔案；`il course <課程 id> --json` 中該檔案 `status` 為 `skipped`、`local_path` 為 `null`。

### 4. 摘要

1. `il ui` →「4 課程設定」，選一門課，剔選「老師公告摘要」，Enter 確認。
2. `il summaries pending --json`。預期：`agent_write` 為 `true`，`pending` 有該科的公告，各有 `target_id` 與 `source_hash`。
3. 用第一筆的值寫一則測試摘要：

   ```sh
   printf '測試摘要' | il summaries write <target_id> --hash <source_hash> --agent test --json
   ```

4. 預期：回傳 `written_at`；`il ui` 該科課程頁的公告下方顯示「測試摘要」；`課程/<科名>.md` 也有。
5. 用同一個 `target_id` 但錯的 `--hash abc` 再寫一次。預期：被拒絕，訊息說原文已變動。

### 5. agent 修改設定

1. `il config set quiet_hours.start 23:30 --agent test --json`。預期：回傳 `old`、`new`。
2. 開 `il ui`。預期：首頁最上方提示「agent 最近 7 日修改了…」；「3 提醒」列出時間、test、`quiet_hours.start`、舊值 → 新值；`總覽.md` 的系統提示也有。
3. `il config set delivery.hook.command 'echo hi' --agent test --json`。預期：被拒絕，exit 1。
4. `il ui` →「5 系統設定 > agent 權限」，取消「修改設定」並確認，再執行第 1 步的指令。預期：被拒絕，訊息說尚未允許。
5. （可選）在 Claude Code 開新對話，先執行 `export ILEARN_HOME=~/.thu-ilearn-test`，請它閱讀 `AGENTS.md` 後「晚上 11 點後不要推送給我」。預期：它先執行 `config get`，說明舊值與新值，等你同意才改；權限關閉時它告訴你沒有權限，而不是改檔案。

### 6. 收尾

```sh
unset ILEARN_HOME
rm -rf ~/.thu-ilearn-test
```

確認正式的背景服務仍在執行：`ilearn service status`。
