/** Real OS deletion failure fixture. Callers pass only their own temporary files and restore in finally. */
export const windowsDeletePermissionScript = `param([string]$LockedFile,[switch]$Restore)
  $who=[Security.Principal.WindowsIdentity]::GetCurrent().Name
  $parent=Split-Path -LiteralPath $LockedFile
  if($Restore) { foreach($entry in @($LockedFile,$parent)) { if(Test-Path -LiteralPath $entry) { & icacls.exe $entry /remove:d $who | Out-Null } } }
  else { & icacls.exe $LockedFile /deny ($who+':(D)') | Out-Null; if($LASTEXITCODE -ne 0) { exit 1 }
    & icacls.exe $parent /deny ($who+':(DC)') | Out-Null; if($LASTEXITCODE -ne 0) { exit 1 } }`;
