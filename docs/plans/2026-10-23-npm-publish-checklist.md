# npm 發布前檢查清單

日期：2026-10-23。狀態：`thu-ilearn@0.1.0` 已於 2026-10-24 01:16（台北時間）發布。發布由使用者本人執行（`npm login`、`npm publish`），agent 不代為發布。

## 目前狀態

| 項目 | 狀態 |
| --- | --- |
| 已合併 | PR #1 至 #11：Phase 0–4、終端機介面、背景服務、session 過期修正、使用者回饋修正、系統更新介面與實作、npm 安裝的完全移除、背景服務路徑檢查、`prepublishOnly` |
| 已合併（2026-10-23） | PR #12 至 #14；PR #15 至 #20 合併到疊加的 branch，由 `claude/land-stack` 一次帶入 `main`。注意：README 已改為 npm 安裝，發布前 GitHub 上的安裝指令會失效 |
| 模擬驗證 | 本機模擬 registry 由 0.1.0 更新到 0.2.0 成功，見 `docs/verification/2026-10-23-npm-simulation.md` |
| 打包內容 | `npm pack --dry-run`：100 個檔案、145.1 kB，只有 `dist/`（94）、`schema/`、package.json、README、AGENTS.md、SKILL.md、LICENSE，沒有測試或個人資料 |
| 套件名稱 | `thu-ilearn` 在 npm 上尚未被使用 |

## 發布前必做

- [ ] 合併 `claude/land-stack` 的 PR，`main` 上 CI 通過後再發布
- [x] 合併 PR #11，`main` 上 `npm test`（452 項）、typecheck、lint、build 全部通過
- [x] 第一個版本號：`0.1.0`（使用者 2026-10-23 決定；package.json 已是 0.1.0，README 已註明為測試版）
- [x] README「安裝」改為 `npm install -g thu-ilearn`；git 安裝移到「開發」
- [x] README「交給 AI agent 安裝」兩段提示詞改為 npm 安裝，AGENTS.md 位置改用 `npm root -g` 查詢
- [x] README 新增「由 git 安裝改為 npm 安裝」
- [x] README 註明支援平台（三個平台裝置測試通過，Windows 背景服務未實機驗證）
- [ ] 再查一次東海大學資訊使用規範，確認公開發布可行；README 聲明保留
- [x] `npm pack --dry-run` 再確認內容與大小
- [ ] 使用者 `npm login`（建議開啟 2FA），`npm whoami` 確認帳號

## 發布前建議先完成的真機測試

| 項目 | 原因 |
| --- | --- |
| 完全移除（先選「只移除程式」） | 會刪除檔案，公開前要確認 |
| setup 中途中斷後重跑、密碼顯示 `*` | 新同學第一次接觸的流程 |
| 新增只適用某幾科的規則、nano 編輯規則 | 使用者回饋修正後未實測 |
| 背景服務在睡眠喚醒、重開機後繼續執行 | 沒有 agent 的同學依賴背景服務 |
| 首次提取中途 Ctrl-C 後 `ilearn sync` 續傳 | 自 Phase 2 起仍是 TBD |

## 發布後立即驗證

- [x] `npm view thu-ilearn` 顯示 0.1.0，`latest` 指向 0.1.0，108 個檔案、766.9 kB，`bin` 為 `ilearn`
- [x] 在暫存的 npm prefix 安裝 `thu-ilearn`，`ilearn --version` 為 0.1.0；`ilearn status --json` 正常；`ilearn service status` 正確提示背景服務仍指向 `~/thu-ilearn`
- [x] `ilearn update --check --json` 連到真正的 npm：`latest` 0.1.0、`available` false
- [ ] 發布 `0.1.1` 小改版，確認舊版 `ilearn update` 能更新、背景服務繼續執行
- [ ] git tag `v0.1.0` 對應版本號
- [ ] 第一個新套件會先出現 `0.0.0-stage` 佔位版本（npm staged publishing），可用 `npm deprecate thu-ilearn@0.0.0-stage "發布流程產生的佔位版本，請安裝最新版"` 標示

## 待使用者決定

| 項目 | 選項 |
| --- | --- |
| 鎖定 dependency 版本 | 使用 `npm-shrinkwrap.json`（會把 `package-lock.json` 改名，違反「不刪 lockfile」規則，需要使用者同意）；或維持現狀，依賴版本範圍 |
| 桌面 app 方向 | 不做；menu bar 小程式；或由背景服務發系統通知 |
