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

目前尚未發布到 npm，請從 GitHub 安裝：

```sh
git clone https://github.com/AnsonHui6040/ilearn.git ~/thu-ilearn
cd ~/thu-ilearn
npm ci
npm run build
npm link
```

`npm link` 會建立 `ilearn` 指令；不連結時改用 `node ~/thu-ilearn/dist/cli/index.js`。

安裝後執行設定精靈：

```sh
ilearn setup
```

## 交給 AI agent 安裝

把下面的提示詞整段複製給你的 agent。學號與密碼一律由你自己在終端輸入，不要交給 agent。

### 終端機 code agent（Claude Code、Codex CLI 等）

```text
請幫我在這台電腦安裝 thu-ilearn（東海大學 iLearn 同步工具，原始碼：https://github.com/AnsonHui6040/ilearn ）。

1. 執行 node -v，確認版本為 22.13 以上；不符合就停下來告訴我，不要自行更換 Node 版本。
2. 執行：
   git clone https://github.com/AnsonHui6040/ilearn.git ~/thu-ilearn
   cd ~/thu-ilearn && npm ci && npm run build && npm link
   如果 npm link 因權限失敗，不要使用 sudo，把錯誤訊息告訴我。
3. 執行 ilearn --version 確認指令可用。
4. 停下來，請我自己在終端執行 ilearn setup。設定精靈會要求輸入學號與密碼，你不可以代為輸入，也不可以讀取或保存我的帳號密碼。等我回覆「設定完成」再繼續。
5. 把 thu-ilearn 加入你的 MCP 設定：名稱 thu-ilearn，指令 ilearn，參數 mcp。Claude Code 可以執行 claude mcp add thu-ilearn -- ilearn mcp。
6. 設定每 5 分鐘執行一次 ilearn run。先用 command -v node 與 command -v ilearn 取得絕對路徑，組成一行 crontab，例如：
   */5 * * * * /絕對路徑/node /絕對路徑/ilearn run
   修改 crontab 之前先把這一行給我確認。
7. 閱讀 ~/thu-ilearn/AGENTS.md，了解指令、事件格式與權限。如果你支援 Skill，把 ~/thu-ilearn/SKILL.md 加入你的 skill。
8. 執行 ilearn status --json 與 ilearn tasks --json，用三到五行告訴我同步狀態與未完成的作業數量。

之後的規則：
- 只讀取資料。不可以執行 ilearn setup、ilearn login、ilearn mark-teammate、ilearn rules edit、ilearn ui，也不可以修改 config.yaml 或 rules.yaml。
- 不可以讀取帳號、密碼、cookie 或 session 檔案。
- 指令回傳 exit code 2 時，提醒我自己執行 ilearn login。
```

### 自架 agent（Hermes、OpenClaw 等常駐的 agent）

先完成上面的安裝，讓 `ilearn` 指令在 agent 所在的機器可用，再把下面的提示詞交給你的 agent。

```text
你要負責把我的東海大學 iLearn 通知轉告給我。這台機器已經安裝 thu-ilearn，指令為 ilearn。先閱讀 ~/thu-ilearn/AGENTS.md。

接收通知（二選一）：
A. 每 5 分鐘執行 ilearn events --deliverable --agent hermes --json，逐則處理後執行 ilearn events ack hermes <event_id>。
B. 如果我已經在 ilearn ui 的「系統設定 > 推送方式」啟用本機指令 hook 或本機 webhook，事件 JSON 會主動送到你這邊（hook 經標準輸入，webhook 以 POST 送到本機位址）。處理完仍要執行 ilearn events ack hermes <event_id>。
hermes 是你的 agent 名稱，可以換成你自己的名稱，但之後都要用同一個。

處理規則：
- delivery 為 force_push：立即通知我。push：一般通知。record：不主動通知，只在我問的時候查詢。
- 同一個 reload_id 的事件合併成一則總覽。
- grade.posted 與 feedback.posted 只告訴我哪一科有新分數或評語；我問的時候再用 ilearn grades --json 查內容。
- 作業的 teammate_hint 為 true 時，提醒我「系統顯示隊員可能已交，請自己確認」；標記隊員已交要由我自己在 ilearn ui 操作。
- not_started 為 true 的作業還沒開放繳交，不要催促我。
- initial_sync_in_progress 為 true 時，資料還在提取中，不要說「沒有作業」。
- 指令回傳 exit code 2 時，提醒我自己執行 ilearn login。

通知格式：每則一到兩行，包含課程名稱、標題、截止時間（台北時間）與 iLearn 連結。

不可以：執行 ilearn setup、ilearn login、ilearn mark-teammate、ilearn rules edit、ilearn ui；修改 config.yaml 或 rules.yaml；讀取帳號、密碼、cookie 或 session 檔案；直接連線 iLearn。
```

## 設定精靈

`ilearn setup` 依序進行，每一題前都有「步驟 N／8」標題，每個答案回答後立刻存檔，中途 Ctrl-C 不會遺失已回答的內容。重跑時會帶入上次的答案；若目前登入仍有效，可選擇沿用，不必重新輸入學號與密碼。

1. 偵測環境（本機桌面或 VPS），可自行更改。
2. 輸入學號與密碼（輸入時不會顯示）。登入失敗會顯示原因並讓你重試。
3. 選擇是否保存密碼。桌面環境存入系統憑證庫；VPS 會先顯示風險提醒，確認後以加密檔案保存（權限 0600）。選擇不保存時只保存 session，過期後需要執行 `ilearn login`。
4. 開始第一次完整提取：本學期所有課程、作業、公告、考試、分數與教材檔案。過程在背景進行，不必等待。
5. 提取期間完成其餘設定：啟用的介面、推送方式（outbox 檔案必備，可另選本機指令 hook 或本機 webhook）、通知規則、每科摘要。
6. 顯示完成摘要：課程數、未完成作業、3 日內截止與考試、下載結果。

第一次提取可以用 Ctrl-C 中斷，下次執行 `ilearn setup` 或 `ilearn sync` 會從中斷處繼續。第一次提取本身不會推送任何通知；要把目前需要處理的事項推送給 agent，請執行 `ilearn reload`。

背景服務註冊會在後續階段提供，目前請用 cron 定時執行。

## 定時執行

```cron
*/5 * * * * ilearn run
```

`ilearn run` 每次都會檢查提醒，並且只在同步時間到了才連線 iLearn（07:00 到 24:00 每小時一次，另加 03:30，每次隨機延遲 0 到 5 分鐘）。如果想要常駐程序，可以改用 `ilearn daemon`。

## 推送給 agent

需要通知的事件一律寫入 `outbox/events/`，agent 可隨時用 `ilearn events --deliverable` 讀取。另外可以在 `ilearn ui` 的「系統設定 > 推送方式」、`ilearn setup` 第 5 步，或直接在 `config.yaml` 啟用主動推送：

```yaml
delivery:
  hook:
    enabled: true
    command: my-agent notify   # 每則事件執行一次，事件 JSON 經標準輸入傳入
  webhook:
    enabled: true
    url: http://127.0.0.1:8787/ilearn   # 只接受本機位址
```

`ilearn run`、`daemon`、`sync` 及 `reload` 結束時會送出到期的事件；`record` 等級不會送出。送不出去時依序等 5、10、20、40 分鐘，之後每 60 分鐘再試，超過 24 小時就放棄，事件仍保留在 outbox。`ilearn status` 會顯示重試中及已放棄的數量。

## 常用指令

| 指令 | 用途 |
| --- | --- |
| `ilearn setup` | 首次設定精靈 |
| `ilearn ui` | 全螢幕介面：查看待辦、課程、提醒，並修改設定（只能在互動終端使用） |
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
| `ilearn status [--json]` | 同步狀態、最近錯誤、首次同步進度、推送狀態 |
| `ilearn mcp` | 以 stdio 啟動 MCP server，供支援 MCP 的 agent 使用 |

## 全螢幕介面

沒有使用 AI agent 時，可以用 `ilearn ui` 直接查看與設定。介面分 5 頁：

| 按鍵 | 頁面 | 內容 |
| --- | --- | --- |
| 1 | 首頁 | 需要處理的作業與影片：逾期、7 日內、之後、尚未開放 |
| 2 | 課程 | 代號、上課時間、教室；按 Enter 進入課程，查看待辦、公告、教材檔案、分數等 |
| 3 | 提醒 | 系統提示、今天起會發出的截止提醒、今天起發布的公告 |
| 4 | 課程設定 | 每科的通知規則與截止提醒 |
| 5 | 系統設定 | Reload、立即同步、介面、推送方式、夜間時段、截止提醒、通知規則（含關鍵詞與試算）、帳號、Reset |

操作方式：方向鍵移動或切換左右欄，空白鍵剔選，Enter 確認或開啟，Esc 返回，q 離開。剔選後要再按 Enter 看過「將變更 N 項」並確認才會寫入。終端寬度不足 80 欄時改為單欄。

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

請看 [AGENTS.md](AGENTS.md)，內有指令、MCP 工具、事件格式與 agent 權限。`ilearn ui` 只供本人在互動終端使用，agent 在非互動環境執行會被拒絕。支援 Skill 的 agent 可以使用 [SKILL.md](SKILL.md)。

MCP 客戶端設定範例：

```json
{
  "mcpServers": {
    "thu-ilearn": { "command": "ilearn", "args": ["mcp"] }
  }
}
```

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
