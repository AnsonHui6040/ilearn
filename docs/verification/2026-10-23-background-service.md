# 背景服務驗收紀錄

日期：2026-10-23。分支：`claude/background-service`，由 `main`（`9078bc0`）開出。方向由使用者選定：`ilearn service install` 由系統排程每 5 分鐘執行 `ilearn run`，設定精靈與 `ilearn ui` 都可以開關。

## 已確認決定

| 項目 | 決定 |
| --- | --- |
| 排程方式 | macOS LaunchAgent（`StartInterval` 300 秒、`RunAtLoad`）；Linux systemd user timer（`OnUnitActiveSec=5min`、`Persistent=true`），沒有 systemd 時寫入 crontab 並以 `# thu-ilearn` 標記；Windows 工作排程器 |
| 路徑 | Node 與程式一律用絕對路徑；Homebrew 的 Node 改用 PATH 中指向同一檔案的連結，升級 Node 後仍有效 |
| 權限 | 安裝與移除只能在互動終端執行；`ilearn service status --json` 可供 agent 讀取 |
| 入口 | `ilearn service install／uninstall／status`、設定精靈最後一步、`ilearn ui` 系統設定「背景服務」 |
| 紀錄 | `<資料根>/logs/run.log` |

## 自動驗證

| 項目 | 結果 |
| --- | --- |
| `npm test` | 25 個測試檔，405 個測試全部通過；typecheck、lint、build 皆 exit 0 |
| 產生的 plist 以 `plutil -lint` 檢查 | OK；`ProgramArguments` 為 `/opt/homebrew/bin/node`、`dist/cli/index.js`、`run` |
| `ilearn service status`（本機，未安裝） | 「背景服務：未安裝」；`--json` 為 `{"installed":false,"method":null,"detail":"未安裝"}` |
| 非互動終端執行 `ilearn service install` | 「安裝背景服務需要在互動終端機執行」，exit 1 |

## 測試對照

| 項目 | 測試 |
| --- | --- |
| plist、systemd unit 內容與路徑跳脫 | `service.test.ts` launchdPlist、systemdUnits |
| macOS 安裝、載入失敗訊息、狀態、移除 | `service.test.ts` macOS |
| Linux systemd、crontab 備援、不重複、不動其他排程 | `service.test.ts` Linux |
| Windows 工作排程器參數 | `service.test.ts` Windows |
| 只能互動終端安裝、需要先設定 | `service.test.ts` ilearn service commands |
| Homebrew Node 路徑 | `service.test.ts` stableNodePath |
| 設定精靈詢問、已安裝不再問、失敗時說明 | `cli.test.ts` setup background service step |
| 介面安裝與移除 | `tui-pages.test.ts`、`tui-app.test.ts` background service |

## 真機項目

| 項目 | 狀態 |
| --- | --- |
| macOS 執行 `ilearn service install` 後 `ilearn service status` 為「已安裝（LaunchAgent）」，每 5 分鐘在 `logs/run.log` 留下紀錄 | PASS（使用者 2026-10-23 安裝，14:11 至 14:31 每 5 分鐘一筆） |
| 背景服務在 session 過期後自動以已保存密碼重新登入 | 修正後 TBD（見下方） |
| 重開機或睡眠喚醒後繼續執行 | TBD |
| `ilearn ui` 安裝、移除背景服務 | TBD |
| Linux systemd、crontab 與 Windows 工作排程器 | TBD（尚未在這些系統測試） |

## 真機發現的問題：session 過期未自動重新登入

使用者安裝背景服務後，`run.log` 每 5 分鐘出現「Unexpected token '<', "<!DOCTYPE "... is not valid JSON」，`last_sync_at` 停在 00:40。

| 層 | 實際情況 |
| --- | --- |
| iLearn API（無有效 session） | 302 轉址到 `tcidentity.thu.edu.tw` 的 CAS 登入頁（以不帶 cookie 的請求實測） |
| HTTP 層 | 跟隨轉址，最後得到 200 的 HTML |
| API 層 | 當成 JSON 解析而失敗 |
| 自動重新登入 | 只在 401 時觸發，因此沒有觸發，也沒有推送 `auth.expired` |

修正：API 請求被轉到 CAS 登入頁時視為 401（`src/ilearn/api.ts`）。測試 `ilearn.test.ts` expired session；以不帶 cookie 的請求實測，`activeSemesterCode()` 回傳 `ApiError 401`。下載轉到 `tcmedia.thu.edu.tw` 不受影響。
