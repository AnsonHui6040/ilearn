# thu-ilearn

把東海大學 iLearn 的課程、作業、公告、考試、影片進度與教材檔案同步到你自己的電腦，並提供讓 AI agent 讀取的指令與事件檔。指令名稱為 `ilearn`。

## 聲明

- 這是非官方工具，與東海大學沒有任何關係。
- 使用前請自行查閱學校的資訊使用規範，確認這樣的使用方式符合規定，責任由使用者自行承擔。
- 資料只存在你的電腦，不會上傳到任何伺服器。
- 不收集遙測，不回傳任何使用紀錄。
- 本工具只用 GET 讀取 iLearn，唯一的 POST 是登入；不會修改 iLearn 上的任何資料，也不會替你繳交作業。
- 核心不呼叫任何 LLM。
- 原始碼公開，歡迎檢查帳號密碼是如何處理的。

## 需求

- Node.js 22.13 以上
- 東海大學學號與 iLearn 密碼

## 安裝

```sh
npm install -g thu-ilearn
```

安裝後執行設定精靈：

```sh
ilearn setup
```

## 設定精靈

`ilearn setup` 依序進行：

1. 偵測環境（本機桌面或 VPS），可自行更改。
2. 輸入學號與密碼（輸入時不會顯示）。登入失敗會顯示原因並讓你重試。
3. 選擇是否保存密碼。桌面環境存入系統憑證庫；VPS 會先顯示風險提醒，確認後以加密檔案保存（權限 0600）。選擇不保存時只保存 session，過期後需要執行 `ilearn login`。
4. 開始第一次完整提取：本學期所有課程、作業、公告、考試、分數與教材檔案。過程在背景進行，不必等待。
5. 提取期間完成其餘設定：啟用的介面、推送方式、通知規則、每科摘要。
6. 顯示完成摘要：課程數、未完成作業、3 日內截止與考試、下載結果。

第一次提取可以用 Ctrl-C 中斷，下次執行 `ilearn setup` 或 `ilearn sync` 會從中斷處繼續。第一次提取本身不會推送任何通知；要把目前需要處理的事項推送給 agent，請執行 `ilearn reload`。

背景服務註冊會在後續階段提供，目前請用 cron 定時執行。

## 定時執行

```cron
*/5 * * * * ilearn run
```

`ilearn run` 每次都會檢查提醒，並且只在同步時間到了才連線 iLearn（07:00 到 24:00 每小時一次，另加 03:30，每次隨機延遲 0 到 5 分鐘）。如果想要常駐程序，可以改用 `ilearn daemon`。

## 常用指令

| 指令 | 用途 |
| --- | --- |
| `ilearn setup` | 首次設定精靈 |
| `ilearn login` / `ilearn logout` | 重新登入；刪除 session 與已保存的密碼 |
| `ilearn sync [--force]` | 立即同步並下載檔案 |
| `ilearn run` | 給 cron 使用 |
| `ilearn daemon` | 常駐，每 5 分鐘做一次 `run` |
| `ilearn reload [--yes]` | 先同步，再把目前需要處理的事項推送出去 |
| `ilearn tasks [--json]` | 未完成的作業與影片 |
| `ilearn courses [--json]`、`ilearn course <id> [--json]` | 課程列表；單一課程的全部資料 |
| `ilearn announcements [--category <代碼>] [--json]` | 公告 |
| `ilearn grades [--course <id>] [--json]` | 分數與評語 |
| `ilearn events [--deliverable] [--agent <名稱>] [--type <類型>] [--json]` | 查詢事件 |
| `ilearn events ack <名稱> <event_id>` | 標記 agent 已處理到此事件 |
| `ilearn files search <關鍵字>`、`ilearn file text <id>` | 以檔名搜尋；輸出 .txt 與 .md 的文字 |
| `ilearn mark-teammate <item_id> [--undo]` | 標記小組作業「隊員已交」，只能由你在互動終端操作 |
| `ilearn rules list`、`ilearn rules test [檔案]`、`ilearn rules edit` | 列出、試算、編輯關鍵詞規則 |
| `ilearn status [--json]` | 同步狀態、最近錯誤、首次同步進度 |

加上 `--json` 時，標準輸出只會有一個 JSON 值；錯誤以 exit code 1 與標準錯誤輸出的中文訊息表示。登入過期且沒有保存密碼時 exit code 為 2。

## 資料位置

預設在 `~/.thu-ilearn`，可用環境變數 `ILEARN_HOME` 更改。目錄權限 0700，檔案權限 0600。

```text
<資料根>/
├── config.yaml
├── rules.yaml                 自訂規則（沒有這個檔案時使用內建規則）
├── files/<學期>/<課程>/<分類>/<檔名>
├── outbox/
│   ├── events/YYYY-MM-DD.jsonl
│   ├── cursors/<agent>.json
│   ├── schema/event.v1.json
│   └── 通知.md
└── data/ilearn.sqlite3
```

教材檔案如果老師關閉了下載權限，預設只記錄檔名與 iLearn 連結，不會下載。想要嘗試下載，請在 `config.yaml` 設定：

```yaml
files:
  download_disallowed: download
```

## 給 AI agent

請看 [AGENTS.md](AGENTS.md)，內有指令、事件格式與 agent 權限。

## 開發

```sh
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

## 授權

MIT
