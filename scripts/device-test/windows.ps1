# Windows 裝置測試：
#   powershell -ExecutionPolicy Bypass -File scripts\device-test\windows.ps1 [--mock] [--interactive] [--keep]
# 若 PowerShell 擋下腳本，可先執行 Set-ExecutionPolicy -Scope Process Bypass（只影響這個視窗）。
# 這支腳本不含任何帳密；帳密寫在 credentials.local（不會被 git 追蹤）。
$ErrorActionPreference = 'Stop'

$Here = $PSScriptRoot
$Repo = Resolve-Path (Join-Path $Here '..\..')
Set-Location $Repo

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error '找不到 node，請先安裝 Node 22.13 以上。'
  exit 1
}
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if ($LASTEXITCODE -ne 0) {
  Write-Error ('Node 版本是 ' + (node -p 'process.versions.node') + '，需要 22.13 以上。')
  exit 1
}

$Mock = $args -contains '--mock'
$Cred = Join-Path $Here 'credentials.local'

if (-not $Mock) {
  if (Test-Path $Cred) {
    foreach ($line in Get-Content -Path $Cred -Encoding UTF8) {
      $t = $line.Trim()
      if ($t -eq '' -or $t.StartsWith('#')) { continue }
      $i = $t.IndexOf('=')
      if ($i -lt 1) { continue }
      $key = $t.Substring(0, $i)
      $val = $t.Substring($i + 1)
      if ($key -eq 'ILEARN_TEST_USERNAME') { $env:ILEARN_TEST_USERNAME = $val }
      if ($key -eq 'ILEARN_TEST_PASSWORD') { $env:ILEARN_TEST_PASSWORD = $val }
    }
  } else {
    Copy-Item (Join-Path $Here 'credentials.example') $Cred
    Write-Host "已建立 $Cred，請用記事本填入學號（密碼可留空，執行時再輸入），存檔後重新執行。"
    exit 1
  }
}

if (-not (Test-Path (Join-Path $Repo 'node_modules'))) {
  npm ci
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

node (Join-Path $Here 'run.mjs') @args
exit $LASTEXITCODE
