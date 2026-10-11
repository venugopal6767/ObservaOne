<#
.SYNOPSIS
  ObservaOne Agent installer for Windows Server 2016+ / Windows 10+ (Windows PowerShell 5.1, run as Administrator).

.DESCRIPTION
  Installs windows_exporter (local only, 127.0.0.1:9182) and the ObservaOne Agent service, which sends
  metrics, event logs, log files and OpenTelemetry traces to ObservaOne over HTTPS.
  Every download is checked against a fixed SHA-256 before it is used.

.EXAMPLE
  .\install.ps1 -Server https://monitor.example.local -Token oat_xxx
  .\install.ps1 -Server https://monitor.example.local -Token oat_xxx -CaSha256 <fingerprint> -Env prod -Role sql
  .\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]$Server,
  [string]$Token,
  [string]$CaSha256,         # trust the server's own (self-signed) certificate with this SHA-256 fingerprint
  [string]$CaFile,           # or trust this CA certificate file (your company CA)
  [string]$HostName,         # name shown in ObservaOne (default: computer name)
  [Alias('Env')][string]$Environment = '',   # prod / uat / dev ...
  [string]$Role = '',        # web / sql / app ...
  [string]$Logs = '',        # extra log files, comma separated: "C:\inetpub\logs\LogFiles\*\*.log,D:\App\logs\*.log"
  [switch]$SecurityLog,      # also send the Security event log (large)
  [string]$FilesDir,         # take downloads from this folder (no internet)
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with the progress bar

$AgentVersion   = '1.0.0'
$OtelVersion    = '0.162.0'
$WinExpVersion  = '0.31.8'
$Sha256 = @{
  "otelcol-contrib_${OtelVersion}_windows_amd64.tar.gz" = 'b371829181e89947a1a6570b8b6c38c20d85e2d215b76bf042f89b365b9e5c3d'
  "windows_exporter-${WinExpVersion}-amd64.msi"         = '0aadce6afb20182b678bfca9e8f2e8464ef48c469b28b4cf02e99d82158f5d40'
}
$ServiceName = 'ObservaOneAgent'
$ProgramDir  = Join-Path $env:ProgramFiles 'ObservaOne\Agent'
$DataDir     = 'C:\ProgramData\ObservaOne\Agent'
$Exe         = Join-Path $ProgramDir 'otelcol-contrib.exe'

function Say($m)  { Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host " OK $m" -ForegroundColor Green }
# throw (not exit): when pasted into an open PowerShell window, exit would close the window
function Fail($m) { throw "ObservaOne Agent: $m" }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail 'Run PowerShell as Administrator.' }
if ($PSVersionTable.PSVersion.Major -gt 5) { Write-Host ' !! Tested with Windows PowerShell 5.1. If something fails, run it in "powershell.exe".' -ForegroundColor Yellow }

# ------------------------------------------------------------------ uninstall
if ($Uninstall) {
  Say 'Removing ObservaOne Agent'
  if (Get-Service $ServiceName -ErrorAction SilentlyContinue) {
    Stop-Service $ServiceName -Force -ErrorAction SilentlyContinue
    & sc.exe delete $ServiceName | Out-Null
  }
  if (Test-Path (Join-Path $DataDir 'installed-windows-exporter')) {
    $p = Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -like 'windows_exporter*' } | Select-Object -First 1
    if ($p) { Start-Process msiexec.exe -ArgumentList "/x $($p.PSChildName) /qn /norestart" -Wait }
  }
  Remove-Item -Recurse -Force $ProgramDir, $DataDir -ErrorAction SilentlyContinue
  Ok 'Agent removed. Forget it on the Agents page if you do not reinstall it.'
  return
}

# ------------------------------------------------------------------ checks
if (-not $Server) { Fail '-Server is required, e.g. -Server https://monitor.example.local' }
$Server = $Server.TrimEnd('/')
if ($Server -notmatch '^https://') { Fail '-Server must start with https://' }
$tokenFile = Join-Path $DataDir 'token'
if (-not $Token -and (Test-Path $tokenFile)) { $Token = (Get-Content $tokenFile -Raw).Trim(); Say 'Re-using the token already on this server' }
if (-not $Token) {
  # asked here, hidden, so the token is not in the command, PowerShell history or the process list
  $sec = Read-Host -AsSecureString 'Paste the enrollment token from the Agents page (input hidden)'
  $Token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)).Trim()
}
if ($Token -notmatch '^oat_[0-9a-f]{8}_[A-Za-z0-9_-]{20,64}$') { Fail 'The token must look like oat_... (create one on Agents > Windows > Install)' }
if (-not $HostName) { $HostName = $env:COMPUTERNAME.ToLower() }
$HostName = $HostName -replace '[^A-Za-z0-9._-]', ''
if (($Environment + $Role) -notmatch '^[A-Za-z0-9._-]*$') { Fail '-Env and -Role may only use letters, digits, . _ -' }
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { Fail "Only 64-bit x86 Windows is supported (this is $($env:PROCESSOR_ARCHITECTURE))." }
$os = (Get-CimInstance Win32_OperatingSystem).Caption -replace '^Microsoft ', ''

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Enable-CertPin([string]$fp, [string]$pinHost) {
  # Pinned fingerprint for the ObservaOne server ONLY; every other site (GitHub downloads) keeps the normal
  # Windows certificate check. Compiled: a script-block callback fails in Windows PowerShell 5.1.
  if (-not ('ObservaOneCertPin' -as [type])) {
    Add-Type @"
using System; using System.Net; using System.Net.Security;
using System.Security.Cryptography; using System.Security.Cryptography.X509Certificates;
public static class ObservaOneCertPin {
  static string fp; static string host;
  static bool Check(object s, X509Certificate c, X509Chain ch, SslPolicyErrors e) {
    var req = s as HttpWebRequest;
    bool ours = req != null && string.Equals(req.RequestUri.Host, host, StringComparison.OrdinalIgnoreCase);
    if (!ours) return e == SslPolicyErrors.None;
    if (c == null || fp == null) return false;
    using (var h = SHA256.Create()) return BitConverter.ToString(h.ComputeHash(c.GetRawCertData())).Replace("-", "").ToLower() == fp;
  }
  public static void Enable(string f, string hst) { fp = f; host = hst; ServicePointManager.ServerCertificateValidationCallback = Check; }
}
"@
  }
  [ObservaOneCertPin]::Enable($fp, $pinHost)
}

function Get-DerSha256([byte[]]$der) {
  $sha = [Security.Cryptography.SHA256]::Create()
  ($sha.ComputeHash($der) | ForEach-Object { $_.ToString('x2') }) -join ''
}

# ------------------------------------------------------------------ trust the server
$caPath = ''
$tmp = Join-Path $env:TEMP ("observaone-" + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  if ($CaFile) {
    if (-not (Test-Path $CaFile)) { Fail "CA file $CaFile not found" }
    $caPath = $CaFile
  } elseif ($CaSha256) {
    $want = ($CaSha256 -replace ':', '').ToLower()
    # accept exactly this certificate for the rest of this PowerShell session
    $script:PinnedFingerprint = $want
    # compiled check: a PowerShell script block as the callback fails in Windows PowerShell 5.1
    # ("unexpected error occurred on a send") because it can run on a thread without a runspace
    Enable-CertPin $want ([Uri]$Server).Host
    Say 'Fetching the server certificate'
    $crt = Join-Path $tmp 'server.crt'
    Invoke-WebRequest -UseBasicParsing -Uri "$Server/agent/server.crt" -OutFile $crt
    $pem = Get-Content $crt -Raw
    $b64 = ([regex]::Match($pem, '-----BEGIN CERTIFICATE-----(.+?)-----END CERTIFICATE-----', 'Singleline')).Groups[1].Value -replace '\s', ''
    if ((Get-DerSha256 ([Convert]::FromBase64String($b64))) -ne $want) { Fail 'Certificate fingerprint does not match. Do not continue: you may not be talking to your ObservaOne server.' }
    $caPath = $crt
    Ok 'Server certificate fingerprint matches'
  }

  # ---------------------------------------------------------------- agent id (kept across re-installs)
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  $idFile = Join-Path $DataDir 'agent-id'
  if (-not (Test-Path $idFile)) { Set-Content -Path $idFile -Value ([guid]::NewGuid().ToString()) -NoNewline }
  $agentId = (Get-Content $idFile -Raw).Trim()

  # ---------------------------------------------------------------- test the token first
  Say "Checking the token with $Server"
  $hdr = @{ Authorization = "Bearer $Token"; 'X-Agent-Id' = $agentId; 'X-Agent-Host' = $HostName; 'X-Agent-Platform' = 'windows';
            'X-Agent-Version' = $AgentVersion; 'X-Agent-Os' = $os; 'X-Agent-Arch' = 'amd64'; 'X-Agent-Env' = $Environment; 'X-Agent-Role' = $Role }
  $code = 0
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$Server/ingest/agent/metrics" -Headers $hdr -ContentType 'application/x-protobuf' -Body ([byte[]]@())
    $code = [int]$r.StatusCode
  } catch [Net.WebException] {
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode } else { $code = 0 }
  }
  switch ($code) {
    { $_ -ge 200 -and $_ -lt 300 -or $_ -eq 400 } { Ok 'Token accepted'; break }
    401 { Fail 'The server refused the token (wrong, revoked or expired). Create a new one on the Agents page.' }
    403 { Fail 'This agent is blocked on the Agents page.' }
    0   { Fail "Cannot connect to $Server over HTTPS. Check DNS, firewall (port 443) and the certificate (-CaSha256 / -CaFile)." }
    default { Fail "Unexpected answer from the server (HTTP $code)." }
  }

  # ---------------------------------------------------------------- downloads
  function Get-Checked([string]$name, [string]$github) {
    $out = Join-Path $tmp $name
    if ($FilesDir -and (Test-Path (Join-Path $FilesDir $name))) {
      Copy-Item (Join-Path $FilesDir $name) $out
    } else {
      try { Invoke-WebRequest -UseBasicParsing -Uri "$Server/agent/files/$name" -OutFile $out }
      catch {
        Say "Downloading $name from GitHub"
        try { Invoke-WebRequest -UseBasicParsing -Uri $github -OutFile $out }
        catch { Fail "Download failed: $github (no internet? use -FilesDir, or ask the admin to run scripts/fetch-agent-files.sh)" }
      }
    }
    $got = (Get-FileHash -Algorithm SHA256 $out).Hash.ToLower()
    if ($got -ne $Sha256[$name]) { Fail "Checksum mismatch for $name (got $got). The file is damaged or was changed. Not installing." }
    Ok "$name verified"
    return $out
  }

  # extract one file from a .tar.gz (tar.exe when present, otherwise a small built-in reader)
  function Expand-OneFromTarGz([string]$archive, [string]$entry, [string]$dest) {
    $tarExe = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (Test-Path $tarExe) {
      & $tarExe -xzf $archive -C (Split-Path $dest) $entry
      if ($LASTEXITCODE -ne 0) { Fail "Could not unpack $archive" }
      if ((Join-Path (Split-Path $dest) $entry) -ne $dest) { Move-Item -Force (Join-Path (Split-Path $dest) $entry) $dest }
      return
    }
    $in = [IO.File]::OpenRead($archive)
    $gz = New-Object IO.Compression.GZipStream($in, [IO.Compression.CompressionMode]::Decompress)
    try {
      $hdr = New-Object byte[] 512
      while ($true) {
        $n = 0; while ($n -lt 512) { $k = $gz.Read($hdr, $n, 512 - $n); if ($k -le 0) { break }; $n += $k }
        if ($n -lt 512 -or $hdr[0] -eq 0) { break }
        $name = [Text.Encoding]::ASCII.GetString($hdr, 0, 100).Trim([char]0)
        $size = [Convert]::ToInt64(([Text.Encoding]::ASCII.GetString($hdr, 124, 12).Trim([char]0, ' ')), 8)
        $pad = (512 - ($size % 512)) % 512
        $target = if ($name -eq $entry) { [IO.File]::Create($dest) } else { $null }
        $buf = New-Object byte[] 65536; $left = $size
        while ($left -gt 0) {
          $k = $gz.Read($buf, 0, [Math]::Min($buf.Length, $left)); if ($k -le 0) { break }
          if ($target) { $target.Write($buf, 0, $k) }; $left -= $k
        }
        if ($target) { $target.Close(); return }
        $skip = $pad; while ($skip -gt 0) { $k = $gz.Read($buf, 0, $skip); if ($k -le 0) { break }; $skip -= $k }
      }
    } finally { $gz.Close(); $in.Close() }
    Fail "$entry not found in $archive"
  }

  Say "Installing ObservaOne Agent $AgentVersion on $HostName ($os)"
  New-Item -ItemType Directory -Force -Path $ProgramDir, $DataDir | Out-Null

  # ---------------------------------------------------------------- windows_exporter
  $exporterPort = 9182
  $existing = Get-CimInstance Win32_Service -Filter "Name='windows_exporter'" -ErrorAction SilentlyContinue
  if ($existing) {
    if ($existing.PathName -match 'listen-address[= ]"?[^:" ]*:(\d+)') { $exporterPort = [int]$Matches[1] }
    Ok "windows_exporter is already installed - using it (port $exporterPort)"
    if ($existing.State -ne 'Running') { Start-Service windows_exporter }
  } else {
    $msi = Get-Checked "windows_exporter-${WinExpVersion}-amd64.msi" "https://github.com/prometheus-community/windows_exporter/releases/download/v${WinExpVersion}/windows_exporter-${WinExpVersion}-amd64.msi"
    Say 'Installing windows_exporter (listens on 127.0.0.1 only, no firewall opening)'
    $p = Start-Process msiexec.exe -Wait -PassThru -ArgumentList "/i `"$msi`" /qn /norestart LISTEN_ADDR=127.0.0.1 LISTEN_PORT=$exporterPort"
    if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { Fail "windows_exporter setup failed (msiexec exit code $($p.ExitCode))" }
    Set-Content -Path (Join-Path $DataDir 'installed-windows-exporter') -Value $WinExpVersion
    Ok 'windows_exporter installed'
  }

  # ---------------------------------------------------------------- the agent
  $tgz = Get-Checked "otelcol-contrib_${OtelVersion}_windows_amd64.tar.gz" "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${OtelVersion}/otelcol-contrib_${OtelVersion}_windows_amd64.tar.gz"
  if (Get-Service $ServiceName -ErrorAction SilentlyContinue) {
    Stop-Service $ServiceName -Force -ErrorAction SilentlyContinue
    & sc.exe delete $ServiceName | Out-Null
    Start-Sleep -Seconds 2
  }
  Expand-OneFromTarGz $tgz 'otelcol-contrib.exe' $Exe
  Set-Content -Path (Join-Path $ProgramDir 'VERSION') -Value $AgentVersion
  Invoke-WebRequest -UseBasicParsing -Uri "$Server/agent/configs/windows.yaml" -OutFile (Join-Path $DataDir 'config.yaml')

  # settings, token (only SYSTEM and Administrators can read it), agent id
  [IO.File]::WriteAllText($tokenFile, $Token)
  $acl = New-Object Security.AccessControl.FileSecurity
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($who in 'NT AUTHORITY\SYSTEM', 'BUILTIN\Administrators') {
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($who, 'FullControl', 'Allow')))
  }
  Set-Acl -Path $tokenFile -AclObject $acl
  $caDest = ''
  if ($caPath) { $caDest = Join-Path $DataDir 'ca.crt'; Copy-Item -Force $caPath $caDest; $caDest = $caDest -replace '\\', '/' }

  $files = @()
  foreach ($f in ($Logs -split ',')) { $f = $f.Trim(); if ($f) { $files += '"' + ($f -replace '\\', '/') + '"' } }
  if (-not $files) { $files = @('"C:/ProgramData/ObservaOne/Agent/none.log"') }
  $receivers = @('windows_event_log/application', 'windows_event_log/system', 'file_log')
  if ($SecurityLog) { $receivers += 'windows_event_log/security' }

  $envVars = [ordered]@{
    OBSERVA_SERVER            = $Server
    OBSERVA_HOST              = $HostName
    OBSERVA_AGENT_ID          = $agentId
    OBSERVA_ENV               = $Environment
    OBSERVA_ROLE              = $Role
    OBSERVA_OS                = $os
    OBSERVA_ARCH              = 'amd64'
    OBSERVA_AGENT_VERSION     = $AgentVersion
    OBSERVA_CA_FILE           = $caDest
    OBSERVA_WINDOWS_EXPORTER  = "127.0.0.1:$exporterPort"
    OBSERVA_LOG_FILES         = '[' + ($files -join ', ') + ']'
    OBSERVA_LOG_RECEIVERS     = '[' + ($receivers -join ', ') + ']'
  }

  Say 'Checking the configuration'
  foreach ($k in $envVars.Keys) { Set-Item -Path "Env:$k" -Value $envVars[$k] }
  $cfg = Join-Path $DataDir 'config.yaml'
  & $Exe validate "--config=$cfg"
  if ($LASTEXITCODE -ne 0) { Fail 'The agent configuration is not valid (see above).' }

  Say 'Creating the ObservaOneAgent service'
  New-Service -Name $ServiceName -DisplayName 'ObservaOne Agent' -StartupType Automatic `
    -Description 'Sends metrics, event logs and traces to ObservaOne.' `
    -BinaryPathName "`"$Exe`" --config=`"$cfg`"" | Out-Null
  $svcKey = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName"
  $multi = @($envVars.Keys | ForEach-Object { "$_=$($envVars[$_])" })
  New-ItemProperty -Path $svcKey -Name Environment -PropertyType MultiString -Value $multi -Force | Out-Null
  & sc.exe failure $ServiceName reset= 86400 actions= restart/10000/restart/30000/restart/60000 | Out-Null
  try { if (-not [Diagnostics.EventLog]::SourceExists($ServiceName)) { New-EventLog -LogName Application -Source $ServiceName } } catch { }
  Start-Service $ServiceName

  $healthy = $false
  foreach ($i in 1..30) {
    try { Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:13133/' -TimeoutSec 2 | Out-Null; $healthy = $true; break } catch { Start-Sleep 1 }
  }
  if (-not $healthy) { Fail "The agent did not start. Look in Event Viewer > Windows Logs > Application (source $ServiceName)." }

  Ok "ObservaOne Agent is running. $HostName appears on the Agents page within a minute."
  Write-Host ''
  Write-Host "  Status : Get-Service $ServiceName"
  Write-Host "  Config : $cfg  (settings: registry $svcKey\Environment)"
  Write-Host '  Traces : send OpenTelemetry to 127.0.0.1:4317 (gRPC) or http://127.0.0.1:4318 (HTTP)'
  Write-Host "  Remove : .\install.ps1 -Uninstall"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  [Net.ServicePointManager]::ServerCertificateValidationCallback = $null   # stop trusting the pinned cert in this window
}
