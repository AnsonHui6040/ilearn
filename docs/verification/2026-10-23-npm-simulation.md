# npm 安裝模擬驗收紀錄

日期：2026-10-23。分支：`claude/npm-ready`。尚未發布到 npm，以本機模擬驗證只有 npm 安裝才會遇到的流程。

## 模擬方式

| 步驟 | 做法 |
| --- | --- |
| 打包 | `npm pack` 產生 `thu-ilearn-0.1.0.tgz`；另以同一份內容把版本號改為 0.2.0 再打包 |
| 模擬 registry | 本機 HTTP 伺服器只聽 127.0.0.1，提供 thu-ilearn 0.1.0 與 0.2.0，其他套件轉址到 registry.npmjs.org；10 分鐘自動結束，測完即停止 |
| 隔離安裝 | `npm_config_registry` 指向模擬 registry、`npm_config_prefix` 指向暫存資料夾、`ILEARN_HOME` 指向暫存資料根；不影響使用者的全域 npm、`~/thu-ilearn`、`~/.thu-ilearn` |

## 結果

| 項目 | 結果 |
| --- | --- |
| 以 npm 安裝 0.1.0 | `ilearn --version` 為 0.1.0 |
| `ilearn update --check` | 「有新版本 0.2.0（目前 0.1.0），執行 ilearn update 更新」；`--json` 輸出正確 |
| 非互動終端執行 `ilearn update` | 「更新需要在互動終端機執行」，exit 1 |
| 在終端（真 TTY）執行 `ilearn update` | 「已更新到 0.2.0；背景服務下一輪會使用新版本，介面請離開後重新開啟」；套件版本變為 0.2.0 |
| 更新後 `ilearn --version` | 原本仍顯示 0.1.0（版本號寫死在程式中），已改為讀取 package.json，重新模擬後為 0.2.0；MCP server 的版本號一併修正 |
| 背景檢查（每天） | 第一次檢查並寫入 `data/update.json`，同一天再執行不重複檢查 |
| npm 版的 `ilearn service status` | 「已安裝（LaunchAgent），但執行的是另一份程式：~/thu-ilearn/dist/cli/index.js」 |
| npm 版的完全移除清單 | 「程式資料夾由 npm rm -g 一併移除」，不再要求自行刪除 |
| `npm rm -g thu-ilearn` | 移除 150 個套件，`bin/ilearn` 與套件資料夾都已刪除 |
| 模擬後殘留程式 | 沒有（模擬 registry 已停止） |

## 自動驗證

`npm test` 27 個測試檔、452 個測試通過；typecheck、lint、build 皆 exit 0。

## 未做

- 以 shrinkwrap 鎖定 dependency 版本：會把 `package-lock.json` 改名，違反「不刪 lockfile」的規則，暫不處理。
- README 安裝方式改為 npm：發布當天再改。
