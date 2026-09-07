<#
.SYNOPSIS
    Builds a distributable zip of the Claude Chat Clipper extension.

.DESCRIPTION
    There is no bundler in this project - it is a plain unpacked MV3 extension -
    so "build" here means validate, stage, and zip. The script:

      1. Reads the version from manifest.json (or sets it, with -Version).
      2. Validates the manifest and resolves every file that must ship.
      3. Stages those files in a temp tree, so the zip contains exactly what
         was declared and nothing else.
      4. Writes dist/claude-chat-clipper-<version>.zip plus a SHA256 sidecar.
      5. Optionally creates the matching annotated git tag (-Tag).

    Nothing happens without -Apply. Run with no switches to see exactly what a
    release would do; add -Apply once the report looks right.

    The shipped file list is derived from source rather than hardcoded:
    icon paths come from manifest.json, and the injected page bundle comes
    from the PAGE_FILES array in popup.js. Anything not on that resolved list
    is excluded - notably test/fixtures/, which holds real conversations.

.PARAMETER Version
    Set the extension version. Rewrites manifest.json, then builds. Omit to
    build at whatever version manifest.json already declares.

.PARAMETER Tag
    After a successful build, create the annotated git tag v<version>.
    Requires a clean working tree. Does not push - see the printed hint.

.PARAMETER Publish
    Do the whole release: build, tag, push the tag, then create the GitHub
    release and upload the zip and its checksum as assets. Implies -Tag.
    Needs the gh CLI, authenticated (gh auth login).

.PARAMETER OutDir
    Directory to write the zip into. Defaults to dist/ at the repo root.

.PARAMETER ReleaseBranch
    Branch releases are cut from. Defaults to whatever the remote reports as
    its default branch, falling back to main. Only consulted with -Publish.

.PARAMETER Apply
    Actually do the work. Without it the script is a dry run: it validates and
    reports exactly what would happen, but writes, tags and publishes nothing.

.PARAMETER DryRun
    Accepted but redundant - a dry run is already the default. Kept so the
    habit of typing it is never punished.

.EXAMPLE
    .\scripts\release.ps1
    Dry run: report what a build at the current manifest version would ship.

.EXAMPLE
    .\scripts\release.ps1 -Apply
    Build the zip at the current manifest version.

.EXAMPLE
    .\scripts\release.ps1 -Version 1.2.0 -Tag -Apply
    Bump the manifest to 1.2.0, build, and tag the commit v1.2.0.

.EXAMPLE
    .\scripts\release.ps1 -Version 1.2.0 -Publish
    Rehearse the full release and print every step it would take. Nothing
    is written, tagged or pushed.

.EXAMPLE
    .\scripts\release.ps1 -Version 1.2.0 -Publish -Apply
    Bump, build, tag, push the tag, and publish the GitHub release with the
    zip attached. This is the one-command release.

#>

[CmdletBinding()]
param(
    [ValidatePattern('^\d+\.\d+(\.\d+){0,2}$')]
    [string]$Version,

    [switch]$Tag,

    [switch]$Publish,

    [string]$OutDir,

    # Branch releases are cut from. Defaults to the remote's default branch.
    [string]$ReleaseBranch,

    [switch]$Apply,

    # Redundant: dry run is the default. Accepted so typing it still works.
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Safe by default: this script only writes, tags or publishes with -Apply.
# $DryRun is accepted but adds nothing, since its behaviour is already the
# default. Everything below branches on $isDryRun, never on the parameters.
$isDryRun = -not $Apply

# This script lives in scripts/, so the repo root is one level up. Every
# path in this file is resolved against $RepoRoot, not the script dir.
$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $RepoRoot "dist" }


# Files that always ship, independent of manifest contents. The injected page
# bundle and the icons are resolved from source further down.
$StaticFiles = @(
    "manifest.json",
    "popup.html",
    "popup.js",
    "LICENSE"
)

function Write-Step  { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Note  { param([string]$Message) Write-Host "    $Message" -ForegroundColor DarkGray }
function Write-Warn  { param([string]$Message) Write-Host "  ! $Message" -ForegroundColor Yellow }

function Get-RepoPath {
    <# Resolves a repo-relative path and fails loudly if it is missing. #>
    param([Parameter(Mandatory)][string]$RelativePath)

    $full = Join-Path $RepoRoot $RelativePath
    if (-not (Test-Path -LiteralPath $full)) {
        throw "Required file is missing: $RelativePath"
    }
    return $full
}

function Read-Manifest {
    $path = Get-RepoPath "manifest.json"
    try {
        return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    }
    catch {
        throw "manifest.json is not valid JSON: $($_.Exception.Message)"
    }
}

function Set-ManifestVersion {
    <#
        Rewrites only the version line. A full ConvertTo-Json round-trip would
        reorder and reformat the manifest, so patch the text in place instead.
    #>
    param(
        [Parameter(Mandatory)][string]$NewVersion,
        [Parameter(Mandatory)][bool]$WhatIf
    )

    $path = Get-RepoPath "manifest.json"
    $text = Get-Content -LiteralPath $path -Raw
    $pattern = '(?m)^(\s*"version"\s*:\s*")[^"]*(")'

    if ($text -notmatch $pattern) {
        throw "Could not find a version field in manifest.json to update."
    }

    $updated = [regex]::Replace($text, $pattern, "`${1}$NewVersion`${2}", 1)
    if ($WhatIf) {
        Write-Note "would set manifest.json version to $NewVersion"
    }
    else {
        Set-Content -LiteralPath $path -Value $updated -NoNewline -Encoding UTF8
        Write-Note "manifest.json version set to $NewVersion"
    }
}

function Get-IconFiles {
    <#
        Pulls icon paths out of the manifest so unreferenced icon sets (e.g.
        icons/coral/) are never packaged. Also ships the .svg source sitting
        beside the PNGs, when there is one.
    #>
    param([Parameter(Mandatory)]$Manifest)

    $paths = [System.Collections.Generic.List[string]]::new()

    foreach ($block in @($Manifest.icons, $Manifest.action.default_icon)) {
        if ($null -eq $block) { continue }
        foreach ($prop in $block.PSObject.Properties) {
            $paths.Add($prop.Value)
        }
    }

    if ($paths.Count -eq 0) {
        throw "manifest.json declares no icons."
    }

    # Include the vector source from each directory the PNGs live in.
    foreach ($dir in ($paths | Split-Path -Parent | Sort-Object -Unique)) {
        $svg = Join-Path (Join-Path $RepoRoot $dir) "icon.svg"
        if (Test-Path -LiteralPath $svg) {
            $paths.Add((Join-Path $dir "icon.svg").Replace('\', '/'))
        }
    }

    return $paths | Sort-Object -Unique
}

function Get-PageBundleFiles {
    <#
        popup.js is the single source of truth for what gets injected into the
        page. Parse its PAGE_FILES array rather than duplicating the list here,
        so adding a module to the extension does not silently omit it from a
        release.
    #>
    $path = Get-RepoPath "popup.js"
    $text = Get-Content -LiteralPath $path -Raw

    if ($text -notmatch '(?s)const\s+PAGE_FILES\s*=\s*\[(.*?)\]') {
        throw "Could not find the PAGE_FILES array in popup.js. If it was renamed, update release.ps1."
    }

    $files = [regex]::Matches($Matches[1], '"([^"]+)"') | ForEach-Object { $_.Groups[1].Value }
    if (-not $files) {
        throw "PAGE_FILES in popup.js parsed as empty."
    }
    return $files
}

function Assert-IconDimensions {
    <#
        A manifest that declares a 48px icon pointing at a 16px PNG loads
        without complaint and just looks wrong, so verify the PNG headers.
        Only the size-keyed entries can be checked this way.
    #>
    param([Parameter(Mandatory)]$Manifest)

    foreach ($block in @($Manifest.icons, $Manifest.action.default_icon)) {
        if ($null -eq $block) { continue }

        foreach ($prop in $block.PSObject.Properties) {
            $declared = 0
            if (-not [int]::TryParse($prop.Name, [ref]$declared)) { continue }
            if ($prop.Value -notmatch '\.png$') { continue }

            $full = Get-RepoPath $prop.Value
            $bytes = [System.IO.File]::ReadAllBytes($full)
            if ($bytes.Length -lt 24) {
                throw "$($prop.Value) is too small to be a valid PNG."
            }

            # PNG IHDR: width and height are big-endian uint32 at offsets 16 and 20.
            $width  = [System.BitConverter]::ToUInt32($bytes[19..16], 0)
            $height = [System.BitConverter]::ToUInt32($bytes[23..20], 0)

            if ($width -ne $declared -or $height -ne $declared) {
                throw "$($prop.Value) is declared as ${declared}px but is ${width}x${height}."
            }
        }
    }
}

function New-ReleaseZip {
    param(
        [Parameter(Mandatory)][string[]]$Files,
        [Parameter(Mandatory)][string]$ZipPath,
        [Parameter(Mandatory)][bool]$WhatIf
    )

    if ($WhatIf) { return }

    # Stage into a temp tree so the archive holds exactly the resolved list,
    # with the directory structure the extension expects.
    $staging = Join-Path ([System.IO.Path]::GetTempPath()) ("clipper-release-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $staging -Force | Out-Null

    try {
        foreach ($file in $Files) {
            $dest = Join-Path $staging $file
            $destDir = Split-Path -Parent $dest
            if (-not (Test-Path -LiteralPath $destDir)) {
                New-Item -ItemType Directory -Path $destDir -Force | Out-Null
            }
            Copy-Item -LiteralPath (Join-Path $RepoRoot $file) -Destination $dest
        }

        if (Test-Path -LiteralPath $ZipPath) {
            Remove-Item -LiteralPath $ZipPath -Force
        }

        Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $ZipPath -CompressionLevel Optimal
    }
    finally {
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function New-ReleaseTag {
    param(
        [Parameter(Mandatory)][string]$TagName,
        [Parameter(Mandatory)][bool]$WhatIf
    )

    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw "-Tag was requested but git is not on PATH."
    }

    # As with the publish checks: a dry run reports these rather than stopping,
    # so one rehearsal surfaces everything standing between you and a release.
    $problems = [System.Collections.Generic.List[string]]::new()

    $status = git -C $RepoRoot status --porcelain
    if ($status) {
        $problems.Add("-Tag requires a clean working tree. Commit or stash first:`n$status")
    }

    # Local and remote tags are separate things, and deleting a release on
    # GitHub leaves the local tag behind. Report which copy is in the way, so
    # the fix is not a guess.
    $localTag = [bool](git -C $RepoRoot tag --list $TagName)

    $remoteTag = $false
    $hasRemote = [bool](git -C $RepoRoot remote 2>$null)
    if ($hasRemote) {
        $lsRemote = $null
        $exit = Invoke-Native -What "git ls-remote" -AllowFailure -Command {
            $script:lsRemote = git -C $RepoRoot ls-remote --tags origin $TagName 2>$null
        }
        if ($exit -eq 0) { $remoteTag = [bool]$lsRemote }
        else { Write-Warn "could not reach the remote to check for tag $TagName" }
    }

    if ($localTag -and $remoteTag) {
        $problems.Add("Tag $TagName already exists locally and on the remote. Pick another version, or:`n" +
                      "    gh release delete $TagName --cleanup-tag --yes`n" +
                      "    git tag -d $TagName")
    }
    elseif ($localTag) {
        $problems.Add("Tag $TagName exists locally but not on the remote. If you deleted it on GitHub, " +
                      "remove the local copy too:`n    git tag -d $TagName")
    }
    elseif ($remoteTag) {
        $problems.Add("Tag $TagName already exists on the remote. Pick another version, or:`n" +
                      "    gh release delete $TagName --cleanup-tag --yes")
    }

    if ($problems.Count -gt 0) {
        if (-not $WhatIf) { throw ($problems -join "`n") }
        foreach ($p in $problems) { Write-Warn "would fail: $p" }
    }

    if ($WhatIf) {
        Write-Note "would create annotated tag $TagName"
        return
    }

    git -C $RepoRoot tag -a $TagName -m "Release $TagName"
    if ($LASTEXITCODE -ne 0) {
        throw "git tag failed with exit code $LASTEXITCODE."
    }
    Write-Note "created annotated tag $TagName"
}

function Invoke-Native {
    <#
        Runs a native command and checks its exit code.

        $ErrorActionPreference = "Stop" turns anything a native command writes
        to stderr into a terminating error, and git and gh both write ordinary
        progress there on success. So drop to Continue for the call itself and
        judge the result by exit code, which is the only reliable signal.
    #>
    param(
        [Parameter(Mandatory)][scriptblock]$Command,
        [Parameter(Mandatory)][string]$What,
        [switch]$AllowFailure
    )

    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try { & $Command } finally { $ErrorActionPreference = $previous }

    if (-not $AllowFailure -and $LASTEXITCODE -ne 0) {
        throw "$What failed with exit code $LASTEXITCODE."
    }
    return $LASTEXITCODE
}

function Get-GitOutput {
    <#
        Runs git and returns its trimmed stdout, or $null if the command
        failed. Never throws.

        Needed because plenty of legitimate git queries fail by design - a ref
        that does not exist, a repo with no origin/HEAD - and under
        $ErrorActionPreference = "Stop" their stderr becomes a terminating
        error even with 2>$null. Asking a question should not be fatal.
    #>
    param([Parameter(Mandatory)][string[]]$Arguments)

    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        # Merge stderr into the pipeline and drop it. "2>$null" alone still
        # surfaces a NativeCommandError in Windows PowerShell; folding stderr
        # into objects and filtering them out is what actually silences it.
        $out = & git -C $RepoRoot @Arguments 2>&1 |
               Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }

        if ($LASTEXITCODE -ne 0 -or $null -eq $out) { return $null }
        return ($out | Out-String).Trim()
    }
    finally { $ErrorActionPreference = $previous }
}

function Resolve-ReleaseBranch {
    <#
        Ask the remote what its default branch is rather than assuming "main".
        Many clones have no origin/HEAD, so fall back rather than fail.
    #>
    if ($script:ReleaseBranch) { return }

    $originHead = Get-GitOutput @("symbolic-ref", "--short", "refs/remotes/origin/HEAD")
    $script:ReleaseBranch = if ($originHead) { $originHead -replace '^origin/', '' } else { "main" }
}

function Assert-PublishReady {
    <#
        Checked before anything is built, so a missing prerequisite fails in
        two seconds rather than after a tag has already been created.

        On a dry run these are reported as warnings instead of throwing: the
        point of a rehearsal is to see the whole plan, including the parts you
        are not set up for yet.
    #>
    param([Parameter(Mandatory)][bool]$Soft)

    Resolve-ReleaseBranch

    $problems = [System.Collections.Generic.List[string]]::new()

    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        $problems.Add("-Publish needs the GitHub CLI. Install it, then run: gh auth login")
    }
    else {
        $authed = Invoke-Native -What "gh auth status" -AllowFailure -Command { gh auth status *> $null }
        if ($authed -ne 0) {
            $problems.Add("-Publish needs an authenticated gh. Run: gh auth login")
        }
    }

    # Refresh the remote-tracking refs first, or "behind" is measured against
    # whatever this clone last happened to see.
    $fetched = Invoke-Native -What "git fetch" -AllowFailure -Command {
        git -C $RepoRoot fetch --quiet origin $ReleaseBranch 2>$null
    }
    if ($fetched -ne 0) {
        Write-Warn "could not fetch origin - branch checks use possibly stale refs"
    }

    # The release is cut from whatever commit gets tagged, so pin down exactly
    # which commit that is: the right branch, and level with its remote.
    $branch = Get-GitOutput @("rev-parse", "--abbrev-ref", "HEAD")

    if ($branch -eq "HEAD") {
        $problems.Add("Detached HEAD. Check out $ReleaseBranch before releasing.")
    }
    elseif ($branch -ne $ReleaseBranch) {
        $problems.Add("On branch '$branch', but releases are cut from '$ReleaseBranch'.`n" +
                      "    git switch $ReleaseBranch    (or pass -ReleaseBranch $branch)")
    }

    # Compare HEAD against the remote tip rather than asking whether HEAD is
    # merely an ancestor of it - being behind would pass that weaker test and
    # quietly ship stale code.
    $remoteRef = "origin/$ReleaseBranch"
    $localSha  = Get-GitOutput @("rev-parse", "HEAD")
    $remoteSha = Get-GitOutput @("rev-parse", $remoteRef)

    if (-not $remoteSha) {
        $problems.Add("No $remoteRef. Push the branch first: git push -u origin $ReleaseBranch")
    }
    elseif ($localSha -ne $remoteSha) {
        # Which way are we out of step? The fix differs.
        $ahead  = [int](Get-GitOutput @("rev-list", "--count", "$remoteRef..HEAD"))
        $behind = [int](Get-GitOutput @("rev-list", "--count", "HEAD..$remoteRef"))

        if ($ahead -gt 0 -and $behind -gt 0) {
            $problems.Add("HEAD and $remoteRef have diverged ($ahead ahead, $behind behind). Reconcile before releasing.")
        }
        elseif ($ahead -gt 0) {
            $problems.Add("$ahead commit(s) not pushed. The release is cut from the tagged commit:`n" +
                          "    git push origin $ReleaseBranch")
        }
        else {
            $problems.Add("$behind commit(s) behind $remoteRef. You would release stale code:`n" +
                          "    git pull")
        }
    }

    if ($problems.Count -eq 0) {
        Write-Note "gh authenticated, HEAD is on the remote"
        return
    }

    if (-not $Soft) { throw ($problems -join "`n") }

    foreach ($p in $problems) { Write-Warn "would fail: $p" }
}

function Publish-Release {
    param(
        [Parameter(Mandatory)][string]$TagName,
        [Parameter(Mandatory)][string[]]$Assets,
        [Parameter(Mandatory)][bool]$WhatIf
    )

    if ($WhatIf) {
        Write-Note "would push $TagName and create the GitHub release"
        foreach ($a in $Assets) { Write-Note "  asset: $(Split-Path -Leaf $a)" }
        return
    }

    Write-Note "pushing $TagName"
    Invoke-Native -What "git push origin $TagName" -Command {
        git -C $RepoRoot push origin $TagName
    } | Out-Null

    Write-Note "creating GitHub release"
    $exit = Invoke-Native -What "gh release create" -AllowFailure -Command {
        gh release create $TagName @Assets --title $TagName --generate-notes --repo $RepoRoot
    }
    if ($exit -ne 0) {
        throw ("gh release create failed with exit code $exit. The tag is pushed, so " +
               "fix the cause and finish with:`n" +
               "  gh release create $TagName " + ($Assets -join ' ') + " --generate-notes")
    }
}

# ---------------------------------------------------------------------------

# -Publish is -Tag plus the remote half.
if ($Publish) { $Tag = $true }

if ($isDryRun) {
    Write-Host ""
    Write-Warn "DRY RUN - nothing will be written, tagged or published."
    Write-Warn "Re-run the same command with -Apply to do it for real."
}

Write-Step "Reading manifest"
if ($Version) {
    Set-ManifestVersion -NewVersion $Version -WhatIf:$isDryRun
}

$manifest = Read-Manifest
# On a dry run the manifest on disk is unchanged, so prefer the requested version.
$releaseVersion = if ($Version) { $Version } else { $manifest.version }
Write-Note "$($manifest.name) $releaseVersion (manifest v$($manifest.manifest_version))"

Write-Step "Validating"
if ($Publish) { Assert-PublishReady -Soft:$isDryRun }
Assert-IconDimensions -Manifest $manifest
Write-Note "icon dimensions match their declared sizes"

$files = [System.Collections.Generic.List[string]]::new()
foreach ($f in $StaticFiles)          { $files.Add($f) }
foreach ($f in (Get-PageBundleFiles)) { $files.Add($f) }
foreach ($f in (Get-IconFiles -Manifest $manifest)) { $files.Add($f) }

$files = $files | Sort-Object -Unique
foreach ($f in $files) { Get-RepoPath $f | Out-Null }
Write-Note "$($files.Count) files resolved and present"

Write-Step "Packaging"
$zipName = "claude-chat-clipper-$releaseVersion.zip"
$zipPath = Join-Path $OutDir $zipName

if (-not $isDryRun -and -not (Test-Path -LiteralPath $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}

foreach ($f in $files) { Write-Note $f }
New-ReleaseZip -Files $files -ZipPath $zipPath -WhatIf:$isDryRun

if ($Tag) {
    Write-Step "Tagging"
    New-ReleaseTag -TagName "v$releaseVersion" -WhatIf:$isDryRun
}

Write-Host ""
if ($isDryRun) {
    if ($Publish) {
        Write-Step "Publishing"
        Publish-Release -TagName "v$releaseVersion" `
                        -Assets @($zipPath, "${zipPath}.sha256") -WhatIf:$true
        Write-Host ""
    }
    Write-Warn "Dry run complete. Would have written $zipPath"
    Write-Warn "Nothing was changed. Add -Apply to run it for real."

}
else {
    $zip = Get-Item -LiteralPath $zipPath
    $hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
    Set-Content -LiteralPath "${zipPath}.sha256" -Value "$hash  $zipName" -Encoding ASCII

    $sizeKb = [math]::Round($zip.Length / 1024, 1)

    Write-Note "$zipPath  ($sizeKb KB)"
    Write-Note "SHA256 $hash"

    if ($Publish) {
        Write-Step "Publishing"
        Publish-Release -TagName "v$releaseVersion" -Assets @($zipPath, "${zipPath}.sha256") -WhatIf:$false
        Write-Step "Done"
        Write-Note "Release v$releaseVersion is live with the zip attached."
        Write-Note "  gh release view v$releaseVersion --web"
    }
    elseif ($Tag) {
        Write-Step "Done"
        Write-Host ""
        Write-Note "Tag created locally. Push and publish when ready:"
        Write-Note "  git push origin v$releaseVersion"
        Write-Note "  gh release create v$releaseVersion `"$zipPath`" `"${zipPath}.sha256`" --generate-notes"
        Write-Note "Or re-run with -Publish next time to do both."
    }
    else {
        Write-Step "Done"
    }
}
Write-Host ""
