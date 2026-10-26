param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$bundle=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if(-not([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run elevated PowerShell to register services.'}
$app=Join-Path $bundle 'app'
if(-not(Test-Path -LiteralPath (Join-Path $app '.env'))){throw 'Initialize server before service registration.'}
function Checked([string]$Exe,[string[]]$Arguments){& $Exe @Arguments;if($LASTEXITCODE -ne 0){throw "Service command failed: $Exe ($LASTEXITCODE)"}}
$pgCtl=Join-Path $bundle 'tools/postgresql/bin/pg_ctl.exe'
$pgData=Join-Path $app '.local/pgdata'
if(Get-Service -Name 'FastLaneNEWS-PostgreSQL','FastLaneNEWS' -ErrorAction SilentlyContinue){throw 'Services already registered. Preserve them; use Start/Stop-Service instead.'}
# Stop only this package's own cluster before transferring it to service management.
Checked $pgCtl @('-D',$pgData,'-m','fast','-w','stop')
Checked 'icacls.exe' @((Join-Path $app '.local'),'/inheritance:r','/grant:r','*S-1-5-18:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F','*S-1-5-20:(OI)(CI)M','/T','/Q')
Checked 'icacls.exe' @((Join-Path $app '.env'),'/inheritance:r','/grant:r','*S-1-5-18:F','*S-1-5-32-544:F','*S-1-5-20:R')
# Git checks repository ownership. Scope ownership to this immutable reviewed crawler checkout,
# rather than disabling Git safe-directory checks globally for every service/repository.
Checked 'icacls.exe' @((Join-Path $app 'runtime/mediacrawler-source'),'/setowner','*S-1-5-20','/T','/Q')
Checked $pgCtl @('register','-N','FastLaneNEWS-PostgreSQL','-D',$pgData,'-S','auto','-U','NT AUTHORITY\NetworkService')
$services=Join-Path $bundle 'services'
New-Item -ItemType Directory -Path $services -Force|Out-Null
Copy-Item -LiteralPath (Join-Path $bundle 'tools/WinSW-x64.exe') -Destination (Join-Path $services 'FastLaneNEWS.exe')
function XmlEscape([string]$Text){[Security.SecurityElement]::Escape($Text)}
$node=XmlEscape (Join-Path $bundle 'tools/node/node.exe')
$work=XmlEscape $app
$envPath=XmlEscape ((Join-Path $bundle 'tools/node')+';'+(Join-Path $bundle 'tools/postgresql/bin')+';'+$env:PATH)
$xml=@"
<service>
 <id>FastLaneNEWS</id><name>FastLaneNEWS</name><description>FastLaneNEWS web/API/worker with shared Windows resource group.</description>
 <executable>$node</executable><startarguments>scripts/studio-local.ts start</startarguments>
 <stopexecutable>$node</stopexecutable><stoparguments>scripts/studio-local.ts stop</stoparguments>
 <workingdirectory>$work</workingdirectory><env name="PATH" value="$envPath"/>
 <depend>FastLaneNEWS-PostgreSQL</depend><startmode>Automatic</startmode><delayedAutoStart>true</delayedAutoStart>
 <serviceaccount><username>NT AUTHORITY\NetworkService</username></serviceaccount>
 <stoptimeout>240sec</stoptimeout><onfailure action="restart" delay="15sec"/>
 <logpath>$work\.local\service-logs</logpath><log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>4</keepFiles></log>
</service>
"@
[IO.File]::WriteAllText((Join-Path $services 'FastLaneNEWS.xml'),$xml,[Text.UTF8Encoding]::new($false))
Checked (Join-Path $services 'FastLaneNEWS.exe') @('install')
Start-Service FastLaneNEWS-PostgreSQL
Start-Service FastLaneNEWS
Get-Service FastLaneNEWS-PostgreSQL,FastLaneNEWS | Select-Object Name,Status
Write-Output 'Services registered. Existing Nginx/site configuration was not modified.'
