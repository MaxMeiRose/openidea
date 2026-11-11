[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ManifestPath,
    [Parameter(Mandatory)][string]$Commit,
    [string]$Repository = 'MaxMeiRose/openidea'
)

$ErrorActionPreference = 'Stop'
$channel = 'feature-dev-latest'
$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
if ($Commit -notmatch '^[a-f0-9]{40}$' -or
    $manifest.version -notmatch '^\d+\.\d+\.\d+-feature-dev\.[1-9]\d*\.[1-9]\d*$' -or
    !$manifest.platforms.'windows-x86_64'.signature -or
    !$manifest.platforms.'windows-x86_64'.url.StartsWith("https://github.com/$Repository/releases/download/feature-dev-")) {
    throw 'Invalid feature-dev update manifest'
}
$latestCommit = gh api "repos/$Repository/git/ref/heads/feature-dev" --jq .object.sha
if ($LASTEXITCODE -ne 0) { throw 'Cannot verify the current branch' }
if ($latestCommit.Trim() -ne $Commit) {
    Write-Output 'A newer commit exists; this build will not change the update channel.'
    return
}
gh release view $channel --repo $Repository *> $null
if ($LASTEXITCODE -eq 0) {
    gh release upload $channel $ManifestPath --repo $Repository --clobber
} else {
    gh release create $channel $ManifestPath --repo $Repository --target $Commit --prerelease --latest=false --title 'OpenIDEA feature-dev updates' --notes 'Signed update manifest for the feature-dev channel. Installers are attached to the versioned feature-dev releases.'
}
if ($LASTEXITCODE -ne 0) { throw 'Cannot publish the feature-dev update manifest' }
gh api --method PATCH "repos/$Repository/git/refs/tags/$channel" -f "sha=$Commit" -F force=true --silent
if ($LASTEXITCODE -ne 0) { throw 'Cannot update the feature-dev channel tag' }
Write-Output "Update channel published: $($manifest.version)"
