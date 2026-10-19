# Native WebView2 tests need the driver matching the installed runtime,
# which can differ from the standalone Edge browser's version.
$ErrorActionPreference = 'Stop'
& cargo install tauri-driver --version 2.1.0 --locked
if ($LASTEXITCODE -ne 0) { throw 'tauri-driver installation failed' }
& cargo install --git https://github.com/chippers/msedgedriver-tool --rev 8c4b34f51b45f5cf08013366d703de464ab871d1 --locked
if ($LASTEXITCODE -ne 0) { throw 'msedgedriver-tool installation failed' }
$driverDir = Join-Path ([IO.Path]::GetTempPath()) 'anypick-webdriver'
New-Item -ItemType Directory -Force -Path $driverDir | Out-Null
Push-Location $driverDir
try {
  & (Join-Path $HOME '.cargo/bin/msedgedriver-tool.exe')
  if ($LASTEXITCODE -ne 0) { throw 'WebView2 driver download failed' }
} finally {
  Pop-Location
}
$env:PATH = "$driverDir;$env:PATH"
if ($env:GITHUB_PATH) { $driverDir | Out-File -Append -Encoding utf8 $env:GITHUB_PATH }
