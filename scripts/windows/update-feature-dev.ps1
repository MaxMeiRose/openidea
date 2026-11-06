[CmdletBinding()]
param(
    [string]$Repository = 'MaxMeiRose/openidea',
    [string]$InstallDirectory = "$env:LOCALAPPDATA\OpenIDEA",
    [string]$StateDirectory = "$env:LOCALAPPDATA\OpenIDEA-FeatureDev",
    [string]$Tag,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$gh = (Get-Command gh.exe -ErrorAction Stop).Source
$exe = Join-Path $InstallDirectory 'openidea.exe'
$statePath = Join-Path $StateDirectory 'installed.json'
New-Item -ItemType Directory -Force -Path $StateDirectory | Out-Null
$logPath = Join-Path $StateDirectory 'update.log'
$mutex = [Threading.Mutex]::new($false, 'Local\OpenIDEA-FeatureDev-Update')
$acquired = $false

function Write-UpdateLog([string]$Message) {
    $line = "$(Get-Date -Format o) $Message"
    Add-Content -LiteralPath $logPath -Value $line -Encoding utf8
    Write-Output $line
}

function Invoke-Gh([string[]]$Arguments) {
    $result = & $gh @Arguments
    if ($LASTEXITCODE -ne 0) { throw "GitHub CLI failed: $($Arguments[0]) (exit $LASTEXITCODE)" }
    return $result
}

function Test-AppRunning {
    $resolvedExe = [IO.Path]::GetFullPath($exe)
    return @(Get-CimInstance Win32_Process -Filter "Name = 'openidea.exe'" |
        Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $resolvedExe }).Count -gt 0
}

try {
    $acquired = $mutex.WaitOne(0)
    if (!$acquired) { Write-UpdateLog 'Another update is running; skipped.'; exit 0 }
    if (!$CheckOnly -and (Test-AppRunning)) {
        Write-UpdateLog 'OpenIDEA is running; installation deferred until the next check.'
        exit 0
    }
    if (!$Tag) {
        $releases = Invoke-Gh -Arguments @('api', "repos/$Repository/releases?per_page=100") | ConvertFrom-Json
        $release = $releases | Where-Object { !$_.draft -and $_.tag_name -match '^feature-dev-[a-f0-9]{12}-[0-9]+-[0-9]+$' } |
            Sort-Object published_at -Descending | Select-Object -First 1
        if (!$release) { Write-UpdateLog 'No tested feature-dev release is available yet.'; exit 0 }
        $Tag = $release.tag_name
    }
    if ($Tag -notmatch '^feature-dev-[a-f0-9]{12}-[0-9]+-[0-9]+$') { throw 'Invalid feature-dev release tag' }
    $downloadDirectory = Join-Path (Join-Path $StateDirectory 'downloads') $Tag
    New-Item -ItemType Directory -Force -Path $downloadDirectory | Out-Null
    Invoke-Gh -Arguments @('release', 'download', $Tag, '--repo', $Repository, '--dir', $downloadDirectory, '--pattern', 'build-info.json', '--clobber') | Out-Null
    $manifest = Get-Content -LiteralPath (Join-Path $downloadDirectory 'build-info.json') -Raw | ConvertFrom-Json
    if ($manifest.schema -ne 1 -or $manifest.repository -ne $Repository -or $manifest.branch -ne 'feature-dev' -or
        $manifest.tag -ne $Tag -or $manifest.platform -ne 'windows-x86_64' -or $manifest.commit -notmatch '^[a-f0-9]{40}$' -or
        $manifest.installerName -notmatch '^OpenIDEA_[0-9A-Za-z.+-]+_x64-setup\.exe$' -or
        $manifest.installerSha256 -notmatch '^[a-f0-9]{64}$' -or $manifest.executableSha256 -notmatch '^[a-f0-9]{64}$') {
        throw 'Invalid build manifest'
    }
    if ((Test-Path -LiteralPath $exe) -and (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -eq $manifest.executableSha256) {
        Write-UpdateLog "Already installed: $Tag ($($manifest.commit))."
        exit 0
    }
    if ($CheckOnly) { Write-UpdateLog "Available: $Tag ($($manifest.commit)); no installation requested."; exit 0 }
    Invoke-Gh -Arguments @('release', 'download', $Tag, '--repo', $Repository, '--dir', $downloadDirectory, '--pattern', $manifest.installerName, '--clobber') | Out-Null
    $installer = Join-Path $downloadDirectory $manifest.installerName
    if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne $manifest.installerSha256) {
        throw 'Installer SHA-256 does not match the published build manifest'
    }
    if (Test-AppRunning) { Write-UpdateLog 'OpenIDEA started during download; installation deferred.'; exit 0 }
    $backupDirectory = Join-Path (Join-Path $StateDirectory 'backups') (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
    New-Item -ItemType Directory -Force -Path $backupDirectory | Out-Null
    if (Test-Path -LiteralPath $exe) { Copy-Item -LiteralPath $exe -Destination (Join-Path $backupDirectory 'openidea.exe') }
    if (Test-Path -LiteralPath $statePath) { Copy-Item -LiteralPath $statePath -Destination (Join-Path $backupDirectory 'installed.json') }
    Write-UpdateLog "Installing $Tag; executable backup: $backupDirectory"
    try {
        # NSIS requires /D to be last and takes the remaining text as the directory.
        $process = Start-Process -FilePath $installer -ArgumentList "/S /D=$InstallDirectory" -WindowStyle Hidden -Wait -PassThru
        if ($process.ExitCode -ne 0) { throw "Installer failed with exit $($process.ExitCode)" }
        if (!(Test-Path -LiteralPath $exe) -or (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -ne $manifest.executableSha256) {
            throw 'Installed executable does not match the tested release'
        }
        $manifest | Add-Member -NotePropertyName installedAt -NotePropertyValue (Get-Date -Format o)
        $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statePath -Encoding utf8
        Write-UpdateLog "Installed and verified: $Tag ($($manifest.commit))."
    } catch {
        $backupExe = Join-Path $backupDirectory 'openidea.exe'
        if ((Test-Path -LiteralPath $backupExe) -and !(Test-AppRunning)) {
            Copy-Item -LiteralPath $backupExe -Destination $exe -Force
            Write-UpdateLog 'Restored the previous executable after installation failure.'
        }
        throw
    }
} catch {
    Write-UpdateLog "ERROR: $($_.Exception.Message)"
    exit 1
} finally {
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
