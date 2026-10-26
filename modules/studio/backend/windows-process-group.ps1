$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    $configuration = [Console]::In.ReadLine() | ConvertFrom-Json
    Add-Type -Path (Join-Path $PSScriptRoot 'windows-process-group.cs')
    [FastLaneProcessGroup]::Run($configuration.executable, [string[]]$configuration.args,
        $configuration.cwd, [uint32]($configuration.cpuPercent * 100), [uint64]$configuration.memoryLimitBytes)
} catch {
    [Console]::Out.WriteLine('{"type":"error"}')
    exit 1
}
