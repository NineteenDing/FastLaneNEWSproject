param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$bundle=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$app=Join-Path $bundle 'app'
$env:PATH=(Join-Path $bundle 'tools/node')+';'+(Join-Path $bundle 'tools/postgresql/bin')+';'+$env:PATH
Push-Location $app
try { & (Join-Path $bundle 'tools/node/node.exe') 'scripts/studio-local.ts' 'start';if($LASTEXITCODE -ne 0){throw 'Application exited with an error; inspect .local/run logs.'} } finally {Pop-Location}
