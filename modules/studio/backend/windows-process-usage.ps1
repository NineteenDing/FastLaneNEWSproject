# Read-only snapshot. Process IDs and paths stay inside this authenticated local observer.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    $taskInput = [Console]::In.ReadLine() | ConvertFrom-Json
    function ReadOwnership {
        # Share-delete keeps this read from blocking the controller's atomic state publication.
        $taskStream = [IO.File]::Open($taskInput.ownershipFile,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        if ($taskStream.Length -gt 131072) { $taskStream.Dispose(); throw 'Job ownership record too large' }
        $taskReader = New-Object IO.StreamReader($taskStream)
        try { $taskRecord = $taskReader.ReadToEnd() | ConvertFrom-Json }
        finally { $taskReader.Dispose() }
        $taskNowMs = ([DateTime]::UtcNow - [DateTime]::SpecifyKind([DateTime]'1970-01-01',[DateTimeKind]::Utc)).TotalMilliseconds
        $taskIds = @($taskRecord.status.processIds)
        if ($taskRecord.id -ne $taskInput.ownershipId -or $taskRecord.status.rootProcessId -ne $taskInput.rootPid `
            -or [math]::Abs($taskNowMs-$taskRecord.updatedAt) -gt 3000 -or $taskIds.Count -lt 1 -or $taskIds.Count -gt 8192 `
            -or $taskIds.Count -ne $taskRecord.status.activeProcesses -or @($taskIds | Sort-Object -Unique).Count -ne $taskIds.Count) { throw 'Job ownership unavailable' }
        foreach ($taskId in $taskIds) { if ($taskId -lt 1 -or $taskId -gt [uint32]::MaxValue -or [math]::Floor($taskId) -ne $taskId) { throw 'Job member unavailable' } }
        return @($taskIds | Sort-Object)
    }
    $taskDeadline = [DateTime]::UtcNow.AddSeconds(2)
    do {
        $taskJobIds = @(ReadOwnership)
        if ($taskJobIds -contains [uint32]$PID) { break }
        if ([DateTime]::UtcNow -ge $taskDeadline) { throw 'Observer ownership unavailable' }
        Start-Sleep -Milliseconds 50
    } while ($true)
    if ($taskJobIds -notcontains [uint32]$taskInput.rootPid -or $taskJobIds -notcontains [uint32]$PID) { throw 'Job identity unavailable' }
    $taskAll = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate,PrivatePageCount,KernelModeTime,UserModeTime,ExecutablePath)
    if ($taskAll.Count -gt 8192) { throw 'process inventory too large' }
    $taskAfterJobIds = @(ReadOwnership)
    if ($taskJobIds.Count -ne $taskAfterJobIds.Count -or $null -ne (Compare-Object $taskJobIds $taskAfterJobIds)) { throw 'Job inventory changed during observation' }
    $taskById = @{}
    foreach ($taskItem in $taskAll) { $taskById[[int]$taskItem.ProcessId] = $taskItem }
    function SameImage($taskItem, [string]$taskExpected) {
        return $null -ne $taskItem -and [string]::Equals($taskItem.ExecutablePath,$taskExpected,[StringComparison]::OrdinalIgnoreCase)
    }
    function ChildOf($taskChild, $taskParent) {
        return $null -ne $taskChild -and $null -ne $taskParent -and $taskChild.ParentProcessId -eq $taskParent.ProcessId `
            -and $null -ne $taskChild.CreationDate -and $null -ne $taskParent.CreationDate -and $taskChild.CreationDate -ge $taskParent.CreationDate
    }
    $taskRoot = $taskById[[int]$taskInput.rootPid]
    if (-not (SameImage $taskRoot $taskInput.executable)) { throw 'runtime identity unavailable' }
    $taskController = $taskById[[int]$taskRoot.ParentProcessId]
    if (-not (SameImage $taskController (Join-Path $PSHOME 'powershell.exe')) -or -not (ChildOf $taskRoot $taskController)) { throw 'controller identity unavailable' }
    $taskLauncher = $taskById[[int]$taskController.ParentProcessId]
    if (-not (SameImage $taskLauncher $taskInput.executable) -or -not (ChildOf $taskController $taskLauncher)) { throw 'launcher identity unavailable' }

    # The SQL connection remains open while this snapshot is taken. Follow its actual backend,
    # checking image and birth order, rather than trusting a stale postmaster.pid or name match.
    $taskDatabaseRoot = $taskById[[int]$taskInput.backendPid]
    if ($null -eq $taskDatabaseRoot -or $taskDatabaseRoot.Name -ne 'postgres.exe' -or -not $taskDatabaseRoot.ExecutablePath) { throw 'database identity unavailable' }
    $taskDatabaseImage = $taskDatabaseRoot.ExecutablePath
    $taskDepth = 0
    while (SameImage $taskById[[int]$taskDatabaseRoot.ParentProcessId] $taskDatabaseImage) {
        $taskParent = $taskById[[int]$taskDatabaseRoot.ParentProcessId]
        if (-not (ChildOf $taskDatabaseRoot $taskParent) -or ++$taskDepth -gt 32) { throw 'database ancestry unavailable' }
        $taskDatabaseRoot = $taskParent
    }
    $taskEpoch = [DateTime]::SpecifyKind([DateTime]'1970-01-01',[DateTimeKind]::Utc)
    $taskCreatedMs = ($taskDatabaseRoot.CreationDate.ToUniversalTime() - $taskEpoch).TotalMilliseconds
    if ([math]::Abs($taskCreatedMs - $taskInput.databaseStartedAtMs) -gt 5000) { throw 'database birth mismatch' }

    function Tree($taskTreeRoot) {
        $taskMembers = @{}; $taskMembers[[int]$taskTreeRoot.ProcessId] = $taskTreeRoot
        do {
            $taskPreviousCount = $taskMembers.Count
            foreach ($taskItem in $taskAll) {
                if (-not $taskMembers.ContainsKey([int]$taskItem.ProcessId) -and $taskMembers.ContainsKey([int]$taskItem.ParentProcessId)) {
                    if (-not (ChildOf $taskItem $taskMembers[[int]$taskItem.ParentProcessId])) { throw 'process ancestry unavailable' }
                    $taskMembers[[int]$taskItem.ProcessId] = $taskItem
                }
            }
        } while ($taskMembers.Count -gt $taskPreviousCount)
        return @($taskMembers.Values)
    }
    $taskRuntime = @(foreach ($taskMemberId in $taskJobIds) {
        $taskMember = $taskById[[int]$taskMemberId]
        if ($null -eq $taskMember -or $null -eq $taskMember.CreationDate -or $taskMember.CreationDate -lt $taskRoot.CreationDate) { throw 'Job member counters unavailable' }
        $taskMember
    })
    $taskDatabase = @(Tree $taskDatabaseRoot)
    if ($taskRuntime.ProcessId -contains $taskDatabaseRoot.ProcessId) { throw 'overlapping ownership' }
    function Component([string]$taskRole, $taskMembers) {
        [decimal]$taskPrivate = 0; [decimal]$taskCpu = 0
        foreach ($taskMember in $taskMembers) {
            if ($null -eq $taskMember.PrivatePageCount -or $null -eq $taskMember.KernelModeTime -or $null -eq $taskMember.UserModeTime) { throw 'process counters unavailable' }
            $taskPrivate += [decimal]$taskMember.PrivatePageCount
            $taskCpu += [decimal]$taskMember.KernelModeTime + [decimal]$taskMember.UserModeTime
        }
        return @{role=$taskRole;processes=@($taskMembers).Count;privateBytes=$taskPrivate;cpuTimeMs=[math]::Floor($taskCpu/10000)}
    }
    $taskResult = @{components=@((Component 'runtime' $taskRuntime),(Component 'launcher' @($taskLauncher)),(Component 'job_controller' @($taskController)),(Component 'database' $taskDatabase))}
    [Console]::Out.WriteLine(($taskResult | ConvertTo-Json -Depth 5 -Compress))
} catch {
    [Console]::Out.WriteLine('{"state":"unavailable"}')
    exit 1
}
