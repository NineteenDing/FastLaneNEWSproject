param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$bundle=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$app=Join-Path $bundle 'app'
$node=Join-Path $bundle 'tools/node/node.exe'
$uv=Join-Path $bundle 'tools/uv.exe'
$env:PATH=(Join-Path $bundle 'tools/node')+';'+(Join-Path $bundle 'tools/postgresql/bin')+';'+$env:PATH
$env:UV_CACHE_DIR=Join-Path $app 'runtime/uv-cache'
$env:UV_PYTHON_INSTALL_DIR=Join-Path $app 'runtime/python'
$env:UV_PYTHON_DOWNLOADS='never'
$env:UV_OFFLINE='true'
$env:COREPACK_ENABLE_NETWORK='0'
$env:PLAYWRIGHT_BROWSERS_PATH=Join-Path $app 'runtime/browsers'
function Checked([string]$Exe,[string[]]$Arguments) { & $Exe @Arguments; if($LASTEXITCODE -ne 0){throw "Command failed ($LASTEXITCODE): $Exe"} }
$drive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($bundle));if($drive.AvailableFreeSpace -lt 10000000000){throw 'Need at least 10GB free before dependency installation; 4.7GB must remain.'}
Push-Location $app
try {
 Checked $node @((Join-Path $bundle 'tools/node/node_modules/npm/bin/npm-cli.js'),'ci','--offline','--no-audit','--no-fund','--cache',(Join-Path $bundle 'offline/npm-cache'))
 $python=Join-Path $app 'runtime/python/cpython-3.12.14-windows-x86_64-none/python.exe'
 $env:UV_PROJECT_ENVIRONMENT=Join-Path $app 'runtime/mediacrawler-env'
 Checked $uv @('sync','--project',(Join-Path $app 'runtime/mediacrawler-source'),'--python',$python,'--locked','--no-dev','--no-install-project','--no-editable','--link-mode','copy','--offline')
 $asr=Join-Path $app 'runtime/asr-env'
 if(-not(Test-Path -LiteralPath (Join-Path $asr 'Scripts/python.exe'))){Checked $uv @('venv','--python',$python,$asr,'--offline')}
 Checked $uv @('pip','sync','--python',(Join-Path $asr 'Scripts/python.exe'),'--require-hashes','--only-binary',':all:','--link-mode','copy','--offline',(Join-Path $app 'modules/studio/vendor/faster-whisper/requirements-windows.lock'))
 if(-not(Test-Path -LiteralPath (Join-Path $app 'runtime/rsshub'))){Checked $node @('modules/studio/scripts/install-rsshub.ts','--source','runtime/rsshub-build','--target','runtime/rsshub','--store','runtime/rsshub-store','--pnpm',(Join-Path $bundle 'tools/pnpm/node_modules/pnpm/bin/pnpm.cjs'),'--offline')}
 Checked $node @((Join-Path $bundle 'tools/node/node_modules/npm/bin/npm-cli.js'),'run','build','-w','@aihot/web')
 if($drive.AvailableFreeSpace -lt 4700000000){throw 'Free-space floor reached; do not start collection.'}
 Write-Output 'Offline dependencies and frontend build complete. No platform or paid model tasks enabled.'
} finally {Pop-Location}
