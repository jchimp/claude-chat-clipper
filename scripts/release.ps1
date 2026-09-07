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

.PARAMETER OutDir
    Directory to write the zip into. Defaults to dist/ at the repo root.

.PARAMETER DryRun
    Validate and report what would happen; write nothing.

.EXAMPLE
    .\scripts\release.ps1
    Build a zip at the current manifest version.

.EXAMPLE
    .\scripts\release.ps1 -Version 1.1.0 -Tag
    Bump the manifest to 1.1.0, build, and tag the commit v1.1.0.

.EXAMPLE
    .\scripts\release.ps1 -Version 1.1.0 -DryRun
    Show what a 1.1.0 release would contain, changing nothing.
#>

[CmdletBinding()]
param(
    [ValidatePattern('^\d+\.\d+(\.\d+){0,2}$')]
    [string]$Version,

    [switch]$Tag,

    [string]$OutDir,

    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

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

    $status = git -C $RepoRoot status --porcelain
    if ($status) {
        throw "-Tag requires a clean working tree. Commit or stash first:`n$status"
    }

    $existing = git -C $RepoRoot tag --list $TagName
    if ($existing) {
        throw "Tag $TagName already exists. Delete it or pick another version."
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

# ---------------------------------------------------------------------------

if ($DryRun) {
    Write-Host ""
    Write-Warn "DRY RUN - nothing will be written."
}

Write-Step "Reading manifest"
if ($Version) {
    Set-ManifestVersion -NewVersion $Version -WhatIf:$DryRun.IsPresent
}

$manifest = Read-Manifest
# On a dry run the manifest on disk is unchanged, so prefer the requested version.
$releaseVersion = if ($Version) { $Version } else { $manifest.version }
Write-Note "$($manifest.name) $releaseVersion (manifest v$($manifest.manifest_version))"

Write-Step "Validating"
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

if (-not $DryRun -and -not (Test-Path -LiteralPath $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}

foreach ($f in $files) { Write-Note $f }
New-ReleaseZip -Files $files -ZipPath $zipPath -WhatIf:$DryRun.IsPresent

if ($Tag) {
    Write-Step "Tagging"
    New-ReleaseTag -TagName "v$releaseVersion" -WhatIf:$DryRun.IsPresent
}

Write-Host ""
if ($DryRun) {
    Write-Warn "Dry run complete. Would have written $zipPath"
}
else {
    $zip = Get-Item -LiteralPath $zipPath
    $hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
    Set-Content -LiteralPath "${zipPath}.sha256" -Value "$hash  $zipName" -Encoding ASCII

    $sizeKb = [math]::Round($zip.Length / 1024, 1)

    Write-Step "Done"
    Write-Note "$zipPath  ($sizeKb KB)"
    Write-Note "SHA256 $hash"

    if ($Tag) {
        Write-Host ""
        Write-Note "Push the tag and publish when ready:"
        Write-Note "  git push origin v$releaseVersion"
        Write-Note "  gh release create v$releaseVersion `"$zipPath`" `"${zipPath}.sha256`" --generate-notes"
    }
}
Write-Host ""
