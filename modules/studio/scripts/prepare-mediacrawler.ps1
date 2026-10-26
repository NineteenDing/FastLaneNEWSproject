param([string]$Uv = 'uv', [string]$DownloadProxy = '')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../..')).Path
$runtimeRoot = Join-Path $projectRoot 'runtime'
$source = Join-Path $runtimeRoot 'mediacrawler-source'
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../vendor/mediacrawler/runtime.json') -Raw | ConvertFrom-Json
if ($env:OS -ne 'Windows_NT') { throw 'This preparation entry targets native Windows x64.' }
if ($DownloadProxy -and $DownloadProxy -notmatch '^http://127\.0\.0\.1:[0-9]{1,5}$') { throw 'Use only an explicitly supplied local HTTP download proxy.' }
$drive = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($projectRoot))
if ($drive.AvailableFreeSpace -lt 6700000000) { throw 'Need the 4.7GB free floor plus a 2GB installation peak allowance.' }
function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
  & $Executable @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Preparation command failed (exit $LASTEXITCODE). No runtime was enabled." }
}
$names = @('HTTP_PROXY', 'HTTPS_PROXY', 'UV_CACHE_DIR', 'UV_PROJECT_ENVIRONMENT')
$previous = @{}
foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
  if ($DownloadProxy) { $env:HTTP_PROXY = $DownloadProxy; $env:HTTPS_PROXY = $DownloadProxy }
  else { Remove-Item Env:HTTP_PROXY -ErrorAction SilentlyContinue; Remove-Item Env:HTTPS_PROXY -ErrorAction SilentlyContinue }
  $env:UV_CACHE_DIR = Join-Path $runtimeRoot 'uv-cache'
  $env:UV_PROJECT_ENVIRONMENT = Join-Path $runtimeRoot 'mediacrawler-env'
  $gitArgs = @()
  if ($DownloadProxy) { $gitArgs = @('-c', "http.proxy=$DownloadProxy") }
  if (-not (Test-Path -LiteralPath $source)) {
    Invoke-Checked 'git' ($gitArgs + @('clone', '--depth=1', '--filter=blob:none', '--no-checkout', '--config', 'core.autocrlf=false', $manifest.repository, $source))
    Invoke-Checked 'git' @('-C', $source, 'sparse-checkout', 'set', 'media_platform', 'model', 'config', 'api', 'base', 'cache', 'cmd_arg', 'constant', 'database', 'libs', 'media_downloader', 'proxy', 'store', 'tools')
    Invoke-Checked 'git' ($gitArgs + @('-C', $source, 'fetch', '--depth=1', 'origin', $manifest.commit))
    Invoke-Checked 'git' @('-C', $source, 'checkout', '--detach', $manifest.commit)
  }
  $revision = & git -C $source rev-parse HEAD
  if ($LASTEXITCODE -ne 0 -or $revision.Trim() -ne $manifest.commit) { throw 'Existing source version differs; preserve it and prepare a separate fixed source before use.' }
  $lockText = [IO.File]::ReadAllText((Join-Path $source 'uv.lock')).Replace("`r`n", "`n")
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $lockHash = ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($lockText)) | ForEach-Object { $_.ToString('x2') }) -join '' }
  finally { $sha.Dispose() }
  if ($lockHash -ne $manifest.lockSha256) { throw 'Upstream dependency lock differs from the reviewed version.' }
  Invoke-Checked $Uv @('python', 'install', $manifest.python, '--install-dir', (Join-Path $runtimeRoot 'python'), '--no-bin', '--no-registry', '--no-progress')
  $python = Join-Path $runtimeRoot "python/cpython-$($manifest.python)-windows-x86_64-none/python.exe"
  Invoke-Checked $Uv @('sync', '--project', $source, '--python', $python, '--locked', '--no-dev', '--no-install-project', '--no-editable', '--link-mode', 'copy', '--no-progress')
  if ($drive.AvailableFreeSpace -lt 4700000000) { throw 'Installation crossed the free-space floor; do not enable collection.' }
  Write-Output 'Fixed Python and MediaCrawler dependencies prepared. Browser downloads and collection were not started.'
} finally {
  foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
}
