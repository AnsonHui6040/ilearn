# 裝置測試

在你自己的電腦上，用真實的 iLearn 帳號跑完 `docs/verification/2026-10-23-launch-features.md`「真機測試步驟」中能自動化的部分，並產生可以回傳的報告與日誌。

## 測試什麼

| 步驟 | 內容 |
| --- | --- |
| 0 安全檢查 | 建立全新的空暫存資料夾；確認沒有指向 `~/.thu-ilearn`；記錄開始與結束時的背景服務狀態並比對 |
| 1 設定精靈 | 以腳本回答真正的 `runSetup`：確認畫面共 8 行、第 2 行只有「已登入」、輸出沒有學號；修改第 5 步後模擬 Ctrl-C；重跑時只剩確認畫面；確認完成後進度檔標記完成 |
| 2 資料夾檢視 | `總覽.md` 與 `課程/` 每科一個檔案，檔頭有「唯讀檢視」說明 |
| 3 老師關閉下載的教材 | 狀態為略過的檔案沒有出現在 `files/`；帳號裡沒有這類檔案時記為 SKIP |
| 4 摘要 | 啟用一門有公告的課程的公告摘要，寫入測試摘要後出現在課程 JSON 與 `課程/<科名>.md`；錯誤的 hash 被拒絕 |
| 5 agent 修改設定 | `quiet_hours.start` 改為 23:30 並回傳舊值與新值；首頁、3 提醒與 `總覽.md` 都列出；`delivery.hook.command` 與 `agent_permissions.settings` 被拒絕；關閉權限後被拒絕 |
| 6 人工目視（選用） | 加上 `--interactive` 時，可開啟 `ilearn ui` 與檔案管理員，由你自己回答 y/N |

## 不測試什麼

以下項目需要另外人工測試：

- 新學期切換
- 與 agent 的真實對話
- 密碼輸入時 `*` 的畫面
- 背景服務的睡眠與喚醒
- 完全移除

## 安全

- 所有資料寫在系統暫存目錄的全新資料夾（`thu-ilearn-device-test-…`），結束後自動刪除；加上 `--keep` 才保留。
- 不碰正式的 `~/.thu-ilearn`，也不安裝、移除或修改背景服務，只唯讀查詢狀態。
- 不保存密碼，不使用系統憑證庫。
- 第一次同步會把本學期的教材下載到暫存資料夾，需要一些網路時間與磁碟空間，結束後一併刪除。
- 報告、日誌與終端機輸出一律把學號、密碼，以及看起來像 cookie 或 session token 的字串換成 `***`。

## 執行

先複製帳密檔並填寫（第一次執行時，腳本也會自動複製並提醒你）：

```sh
cp scripts/device-test/credentials.example scripts/device-test/credentials.local
```

`credentials.local` 填 `ILEARN_TEST_USERNAME`；`ILEARN_TEST_PASSWORD` 可以留空，執行時會要求輸入（不會顯示）。這個檔案不會被 git 追蹤，填好後不要分享或上傳。

建議用 `nano scripts/device-test/credentials.local` 編輯：等號後直接寫值，不要加引號或空白。TextEdit 可能把檔案存成 RTF，或把引號、連字號自動換成全形，造成登入失敗。腳本會先試登入一次，失敗就停止並列出可能原因（不顯示帳密內容）。

| 系統 | 指令 |
| --- | --- |
| macOS | `./scripts/device-test/macos.sh [--interactive] [--keep]` |
| Linux | `./scripts/device-test/linux.sh [--interactive] [--keep]` |
| Windows | `powershell -ExecutionPolicy Bypass -File scripts\device-test\windows.ps1 [--interactive] [--keep]` |

需要 Node 22.13 以上。腳本只在缺少 `node_modules` 時執行 `npm ci`，每次都會 `npm run build`。

### 乾跑

加上 `--mock` 會改用內建的假 API，不連線、不需要帳密，用來確認腳本本身沒問題：

```sh
./scripts/device-test/macos.sh --mock
```

## 結果與回傳

結束時終端機會印出兩個檔案的完整路徑：

```
報告：<路徑>
日誌：<路徑>
```

兩個檔案都在 `scripts/device-test/logs/`：

- 報告：`report-<系統>-<YYYYMMDD-HHmm>.md`，有日期、系統、Node 版本、git commit 與每一項的 PASS、FAIL、SKIP。
- 日誌：`run-<系統>-<YYYYMMDD-HHmm>.log`，每個事件一行，開頭是台北時間；包含步驟開始與結束、每項檢查的結果與原因，以及每個錯誤的訊息與堆疊。

兩個檔案都已遮蔽學號、密碼與 cookie 或 token，可以直接回傳。`logs/` 資料夾不會被 git 追蹤。

結束代碼為 0 代表沒有任何 FAIL。
