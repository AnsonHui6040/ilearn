# npm 發布前檢查清單

日期：2026-10-23。狀態：尚未發布。發布由使用者本人執行（`npm login`、`npm publish`），agent 不代為發布。

## 目前狀態

| 項目 | 狀態 |
| --- | --- |
| 已合併 | PR #1 至 #10：Phase 0–4、終端機介面、背景服務、session 過期修正、使用者回饋修正、系統更新介面 |
| 待合併 | PR #11：系統更新實作、npm 安裝的完全移除、背景服務路徑檢查、`prepublishOnly`、版本號改讀 package.json |
| 模擬驗證 | 本機模擬 registry 由 0.1.0 更新到 0.2.0 成功，見 `docs/verification/2026-10-23-npm-simulation.md` |
| 打包內容 | `npm pack --dry-run`：98 個檔案、約 141 kB，只有 `dist/`、`schema/`、README、AGENTS.md、SKILL.md、LICENSE，沒有測試或個人資料 |
| 套件名稱 | `thu-ilearn` 在 npm 上尚未被使用 |

## 發布前必做

- [ ] 合併 PR #11，`main` 上 `npm test`、typecheck、lint、build 全部通過
- [ ] 決定第一個版本號（建議 `0.1.0`，README 註明為測試版）
- [ ] README「安裝」改為 `npm install -g thu-ilearn`；git 安裝改列為「開發用」
- [ ] README「交給 AI agent 安裝」兩段提示詞改為 npm 安裝
- [ ] README 新增「由 git 安裝改為 npm 安裝」：`npm install -g thu-ilearn` → `ilearn service install` → `ilearn service status` 確認沒有「另一份程式」提示 → 確認後刪除 `~/thu-ilearn`
- [ ] README 註明 Windows 尚未測試、每科摘要尚未提供
- [ ] 再查一次東海大學資訊使用規範，確認公開發布可行；README 聲明保留
- [ ] `npm pack --dry-run` 再確認內容與大小
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

- [ ] `npm view thu-ilearn version` 顯示剛發布的版本
- [ ] 在乾淨位置安裝：`npm install -g thu-ilearn`，`ilearn --version` 正確
- [ ] `ilearn update --check` 能連到真正的 npm（「已是最新版本」）
- [ ] 發布 `0.1.1` 小改版，確認舊版 `ilearn update` 能更新、背景服務繼續執行
- [ ] git tag 對應版本號

## 待使用者決定

| 項目 | 選項 |
| --- | --- |
| 鎖定 dependency 版本 | 使用 `npm-shrinkwrap.json`（會把 `package-lock.json` 改名，違反「不刪 lockfile」規則，需要使用者同意）；或維持現狀，依賴版本範圍 |
| 桌面 app 方向 | 不做；menu bar 小程式；或由背景服務發系統通知 |
