# Target-OS payload smoke for the staged Windows installers. The MSI is
# administratively extracted (no system install), the bundled Go helper is
# located and run. Both MSI and NSIS payloads must also run the native GUI,
# production Rust host and Go sidecar under WebDriver, in an isolated profile.
#
# usage: windows-payload.ps1 -Stage STAGE_DIR -Version VERSION

param(
  [Parameter(Mandatory = $true)][string]$Stage,
  [Parameter(Mandatory = $true)][string]$Version
)

$ErrorActionPreference = 'Stop'
$work = Join-Path $env:RUNNER_TEMP 'anypick-windows-smoke'
if (Test-Path $work) { Remove-Item -Recurse -Force $work }
New-Item -ItemType Directory -Path $work | Out-Null

function Invoke-HelperSmoke {
  param([string]$Helper, [string]$Label)
  if (-not (Test-Path $Helper)) {
    throw "$Label payload has no anypick-core.exe helper"
  }
  $smokeHome = Join-Path $work "home-$Label"
  New-Item -ItemType Directory -Path $smokeHome -Force | Out-Null
  # os.UserHomeDir reads USERPROFILE on Windows; HOME alone would leave the
  # helper pointed at the runner's real profile.
  $previous = @{}
  foreach ($key in @('USERPROFILE', 'HOME', 'ANYPICK_HOME')) { $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
  try {
    $env:USERPROFILE = $smokeHome
    $env:HOME = $smokeHome
    $env:ANYPICK_HOME = Join-Path $smokeHome '.anypick'
    $out = ("$(& $Helper --version)").Trim()
    if ($out -ne "anypick-go $Version") {
      throw "$Label helper reports '$out', want 'anypick-go $Version'"
    }
    & $Helper providers | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "$Label helper providers exited $LASTEXITCODE" }
    Write-Host "smoke ok: $Label helper ($out)"
  } finally {
    foreach ($key in $previous.Keys) { [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process') }
  }
}

$msi = Get-ChildItem -Path $Stage -Filter *.msi | Select-Object -First 1
if ($null -eq $msi) { throw 'no MSI staged for the Windows payload smoke' }
$extract = Join-Path $work 'msi'
# Start-Process does not quote array elements reliably, so quote the paths.
$arguments = "/a `"$($msi.FullName)`" /qn TARGETDIR=`"$extract`" REBOOT=ReallySuppress"
$process = Start-Process msiexec.exe -ArgumentList $arguments -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "msiexec /a exited $($process.ExitCode)" }

$helper = Get-ChildItem -Path $extract -Recurse -Filter 'anypick-core.exe' -File | Select-Object -First 1
if ($null -eq $helper) {
  Get-ChildItem -Path $extract -Recurse | Select-Object -First 60 -ExpandProperty FullName |
    Out-String | Write-Error
  throw 'MSI payload has no anypick-core.exe'
}
Invoke-HelperSmoke -Helper $helper.FullName -Label 'msi'

if (Get-Command go -ErrorAction SilentlyContinue) {
  Push-Location (Join-Path $env:GITHUB_WORKSPACE 'src/go')
  try {
    $env:GOPATH = if ($env:GOPATH) { $env:GOPATH } else { Join-Path $env:USERPROFILE 'go' }
    $env:GOTOOLCHAIN = 'auto'
    & go run ./cmd/anypick-artifact node-free $extract
    if ($LASTEXITCODE -ne 0) { throw 'anypick-artifact node-free failed on the MSI payload' }
  } finally {
    Pop-Location
  }
}

$nsis = Get-ChildItem -Path $Stage -Filter *.exe |
  Where-Object { $_.Name -notlike 'anypick-core*' } | Select-Object -First 1
if ($null -eq $nsis) { throw 'no NSIS installer staged for the Windows payload smoke' }
Write-Host "smoke ok: NSIS installer present ($($nsis.Name))"
$nsisExtract = Join-Path $work 'nsis'
& 7z x -y "-o$nsisExtract" $nsis.FullName | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'NSIS payload extraction failed' }
$nsisHelper = Get-ChildItem -Path $nsisExtract -Recurse -Filter 'anypick-core.exe' -File | Select-Object -First 1
if ($null -eq $nsisHelper) { throw 'NSIS payload has no anypick-core.exe' }
Invoke-HelperSmoke -Helper $nsisHelper.FullName -Label 'nsis'

foreach ($payload in @($extract, $nsisExtract)) {
  $app = Get-ChildItem -Path $payload -Recurse -Filter 'anypick.exe' -File | Select-Object -First 1
  if ($null -eq $app) { throw "No desktop executable in $payload" }
  $e2e = Join-Path $env:GITHUB_WORKSPACE 'src/tauri/ui/scripts/desktop-e2e.mjs'
  & node $e2e $app.FullName
  if ($LASTEXITCODE -ne 0) { throw "Native desktop E2E failed for $payload" }
}
