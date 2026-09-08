#Requires -Version 5.1
<#
.SYNOPSIS
    Builds, tags and publishes a versioned release of this Node/TypeScript project.

.DESCRIPTION
    One command, nine steps, in this order: version, preflight, tests, build,
    stage, package, tag, publish, done. Every release.ps1 in every one of my
    repos runs those same nine steps - only the build seam differs.

    Nothing happens without -Apply. Run any command without it to see exactly
    what a release would do; add -Apply once the report looks right.

    package.json is the source of truth for the version. Bump and commit it
    before releasing, which is what makes the clean-tree check worth having.

.PARAMETER Version
    Set the release version. Rewrites package.json, then builds. Omit to build
    at whatever version package.json already declares.

.PARAMETER Tag
    After a successful build, create the annotated git tag v<version>. Requires
    a clean working tree. Does not push.

.PARAMETER Publish
    Build, tag, push the tag, create the GitHub release, and upload the zip and
    its checksum as assets. Implies -Tag. Needs gh, authenticated.

.PARAMETER Apply
    Actually do the work. Without it the script writes, tags and publishes
    nothing.

.PARAMETER DryRun
    Accepted but redundant - a dry run is already the default.

.PARAMETER SkipTests
    Skip the test run. For iterating on this script, not for real releases.

.PARAMETER Force
    Replace an artifact that already exists for this version.

.PARAMETER OutDir
    Where the zip lands. Defaults to release/ at the repo root.

.PARAMETER ReleaseBranch
    Branch releases are cut from. Defaults to the remote's default branch.

.EXAMPLE
    .\scripts\release.ps1
    Rehearse a build at the current package.json version.

.EXAMPLE
    .\scripts\release.ps1 -Apply
    Build and zip locally. Nothing is tagged or pushed.

.EXAMPLE
    .\scripts\release.ps1 -Version 1.2.0 -Publish
    Rehearse the full release and print every step it would take.

.EXAMPLE
    .\scripts\release.ps1 -Version 1.2.0 -Publish -Apply
    The one-command release.
#>

[CmdletBinding()]
param(
    # Set the release version. Rewrites the project's version file, then builds.
    # Omit to build at whatever version the project already declares.
    [ValidatePattern('^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$')]
    [string] $Version,

    # After a successful build, create the annotated git tag v<version>.
    [switch] $Tag,

    # Build, tag, push the tag, create the GitHub release, upload the assets.
    # Implies -Tag. Needs the gh CLI, authenticated.
    [switch] $Publish,

    # Actually do the work. Without it this is a rehearsal that writes nothing.
    [switch] $Apply,

    # Redundant: a dry run is already the default. Accepted so typing it still works.
    [switch] $DryRun,

    # Skip the test run. For iterating on this script, not for real releases.
    [switch] $SkipTests,

    # Allow overwriting an artifact that already exists for this version.
    [switch] $Force,

    # Directory the release zip is written to. Defaults to release/ at the repo
    # root - deliberately not dist/, which is where build output lives in most
    # ecosystems: an artifact directory that the build also wipes would delete
    # the previous release, and one the build fills would fold last release's
    # zip into this one.
    [string] $OutDir,

    # Branch releases are cut from. Defaults to the remote's default branch,
    # falling back to main. Only consulted with -Publish.
    [string] $ReleaseBranch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Safe by default: this script only writes, tags or publishes with -Apply.
# $DryRun adds nothing, since its behaviour is already the default. Everything
# below branches on $isDryRun, never on the raw parameters.
$isDryRun = -not $Apply

# Resolved here rather than as a param default: $PSScriptRoot is not reliably
# populated while param defaults are being evaluated under `powershell -File`.
$here     = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $here '..')).Path
if (-not $OutDir) { $OutDir = Join-Path $RepoRoot 'release' }

# ---- PROJECT CONFIG -------------------------------------------------------
# The only region you edit after copying this file into a new repo.

# Zip is named <ProjectName>-<version>.zip.
$ProjectName = 'claude-chat-clipper'

# Where the version lives, repo-relative. Shown in messages; the seam
# functions below read and write it.
$VersionFile = 'manifest.json'

# Directory the build produces, repo-relative. Its *contents* go at the root
# of the zip.
$BuildDir = 'dist'

# Extra files and directories folded into the zip alongside the build output.
# A trailing slash means "recurse this directory"; it lands in the zip under
# its own name. Every entry must exist or the release fails before it builds.
$ExtraPayload = @(
    'README.md'
    'LICENSE'
    'INSTALL.md'
    # 'config/'
    # 'docs/'
)

# The package manager to use. npm, pnpm and yarn all work; the clean-install
# and run verbs differ, so change all three together.
$PkgMgr        = ''
$PkgInstallCmd = @('')

# How the release is packaged. 'zip' stages the build output plus
# $ExtraPayload into one archive. See the electron template for the
# 'artifacts' alternative, where the build already emits shippable files.
$PackageMode = 'zip'
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Shared helpers. Identical in every release.ps1 template - if you fix a bug
# here, fix it in templates/_src/shared/30-helpers.part and re-assemble.
# ---------------------------------------------------------------------------

function Write-Step { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Note { param([string]$Message) Write-Host "    $Message" -ForegroundColor DarkGray }
function Write-Warn { param([string]$Message) Write-Host "  ! $Message" -ForegroundColor Yellow }

function Get-RepoPath {
    <# Resolves a repo-relative path and fails loudly if it is missing. #>
    param([Parameter(Mandatory)][string]$RelativePath)

    $full = Join-Path $RepoRoot $RelativePath
    if (-not (Test-Path -LiteralPath $full)) {
        throw "Required path is missing: $RelativePath"
    }
    return $full
}

function Invoke-Native {
    <#
        Runs a native command and checks its exit code.

        $ErrorActionPreference = 'Stop' turns anything a native command writes
        to stderr into a terminating error, and git, gh, npm and dotnet all
        write ordinary progress there on success. So drop to Continue for the
        call itself and judge the result by exit code, which is the only
        reliable signal.
    #>
    param(
        [Parameter(Mandatory)][scriptblock]$Command,
        [Parameter(Mandatory)][string]$What,
        [switch]$AllowFailure
    )

    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        # Send whatever the command prints straight to the console. Letting it
        # fall into this function's output stream would concatenate it with the
        # exit code returned below, so a caller comparing the result to 0 would
        # be comparing an array - and a successful command would look failed.
        & $Command | Out-Host
    }
    finally { $ErrorActionPreference = $previous }

    $code = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }

    if (-not $AllowFailure -and $code -ne 0) {
        throw "$What failed with exit code $code."
    }
    return $code
}

function Get-GitOutput {
    <#
        Runs git and returns its trimmed stdout, or $null if the command
        failed. Never throws.

        Needed because plenty of legitimate git queries fail by design - a ref
        that does not exist, a repo with no origin/HEAD - and under
        $ErrorActionPreference = 'Stop' their stderr becomes a terminating
        error even with 2>$null. Asking a question should not be fatal.
    #>
    param([Parameter(Mandatory)][string[]]$Arguments)

    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
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
        Ask the remote what its default branch is rather than assuming 'main'.
        Many clones have no origin/HEAD, so fall back rather than fail.
    #>
    if ($script:ReleaseBranch) { return }

    $originHead = Get-GitOutput @('symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
    $script:ReleaseBranch = if ($originHead) { $originHead -replace '^origin/', '' } else { 'main' }
}

function ConvertTo-RepoRelativePath {
    <# Strips the repo root off an absolute path. Anything else is returned as-is. #>
    param([Parameter(Mandatory)][string]$Path)

    if ([System.IO.Path]::IsPathRooted($Path) -and
        $Path.StartsWith($RepoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $Path.Substring($RepoRoot.Length).TrimStart('\', '/')
    }
    return $Path
}

function Get-GhAssetArguments {
    <#
        Turns asset paths into arguments gh will actually accept.

        gh release create reads each asset as "path#label": everything after the
        first '#' is a display label for the upload, and there is no escape for
        a '#' that is part of the filename. So an artifact under a path like
        C:\Users\me\Source\C#\myapp is silently cut down to C:\Users\me\Source\C
        and gh reports it cannot find that file - after the tag is already
        pushed, which is the worst possible moment.

        gh runs with the repo root as its working directory, so passing
        repo-relative paths keeps any '#' in the parent directories out of the
        argument altogether.
    #>
    param([Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Assets)

    $ghArgs = [System.Collections.Generic.List[string]]::new()

    foreach ($asset in $Assets) {
        $arg = ConvertTo-RepoRelativePath $asset

        if ($arg.Contains('#')) {
            throw ("Cannot upload $(Split-Path -Leaf $asset): the path gh would receive " +
                   "('$arg') contains a '#', which gh reads as the start of an asset " +
                   "display label rather than as part of the filename, and it has no " +
                   "escape for that. Put the artifact directory somewhere without a '#' " +
                   "in the name - -OutDir moves it.")
        }

        $ghArgs.Add($arg)
    }

    return $ghArgs.ToArray()
}

function Format-CommandArguments {
    <# Quotes arguments containing spaces, so a printed command is paste-able. #>
    param([Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Arguments)

    return (($Arguments | ForEach-Object { if ($_ -match '\s') { "`"$_`"" } else { $_ } }) -join ' ')
}

function Assert-ArtifactDirIgnored {
    <#
        The directory artifacts are written to has to be gitignored, or the
        release dirties its own working tree: the zip lands there, git reports
        it as untracked, and the clean-tree check in the tagging step then
        refuses to tag - after the entire build has already run.

        Enforced only when a tag is actually being created, since that is the
        step it breaks. Otherwise it is a warning: building into a visible
        directory is untidy, not wrong.
    #>
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Paths,
        [Parameter(Mandatory)][bool]$Soft
    )

    # Not a repo, so there is no .gitignore for anything to be missing from.
    if (-not (Get-GitOutput @('rev-parse', '--git-dir'))) { return }

    foreach ($path in $Paths) {
        if (-not $path) { continue }

        # check-ignore wants a repo-relative path.
        $rel = ConvertTo-RepoRelativePath $path
        if (-not $rel) { continue }

        # Exit 0 and echoes the path when ignored; exit 1 and silent when not,
        # which Get-GitOutput reports as $null.
        if (Get-GitOutput @('check-ignore', $rel)) { continue }

        $msg = ("$rel is not gitignored. The release writes artifacts there, which makes " +
                "the working tree dirty, and -Tag then refuses to tag it - after the whole " +
                "build has run. Add it:`n" +
                "    Add-Content .gitignore '$rel/'")
        if ($Soft) { Write-Warn "would fail: $msg" } else { throw $msg }
    }
}

function Assert-ExtraPayload {
    <#
        Every entry in $ExtraPayload has to exist, checked before anything is
        built. A typo here would otherwise produce a quietly thinner zip that
        still looks like a successful release.
    #>
    foreach ($entry in $ExtraPayload) {
        $rel = $entry.TrimEnd('/', '\')
        if (-not $rel) { throw "Empty entry in the ExtraPayload list." }
        Get-RepoPath $rel | Out-Null
    }
    if (@($ExtraPayload).Count -gt 0) {
        Write-Note "$(@($ExtraPayload).Count) extra payload entries resolved"
    }
}

function Assert-PublishReady {
    <#
        Checked before anything is built, so a missing prerequisite fails in
        two seconds rather than after a tag has already been created.

        On a dry run these are reported as warnings instead of throwing: the
        point of a rehearsal is to see the whole plan, including the parts you
        are not set up for yet. Problems accumulate rather than stopping at the
        first, so one rehearsal surfaces everything.
    #>
    param(
        [Parameter(Mandatory)][bool]$Soft,
        [Parameter(Mandatory)][string]$ArtifactDir
    )

    Resolve-ReleaseBranch

    $problems = [System.Collections.Generic.List[string]]::new()

    # Checked here, before the build, because the alternative is finding out
    # after the tag has been pushed - see Get-GhAssetArguments.
    $relArtifact = ConvertTo-RepoRelativePath $ArtifactDir
    if ($relArtifact.Contains('#')) {
        $problems.Add("Artifacts land in '$relArtifact', and gh reads a '#' in an asset path as " +
                      "the start of a display label, with no way to escape it. Move the artifact " +
                      "directory, or pass -OutDir to put it somewhere without a '#'.")
    }

    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        $problems.Add("-Publish needs the GitHub CLI. Install it, then run: gh auth login")
    }
    else {
        $authed = Invoke-Native -What 'gh auth status' -AllowFailure -Command { gh auth status *> $null }
        if ($authed -ne 0) {
            $problems.Add("-Publish needs an authenticated gh. Run: gh auth login")
        }
    }

    # Refresh the remote-tracking refs first, or 'behind' is measured against
    # whatever this clone last happened to see.
    $fetched = Invoke-Native -What 'git fetch' -AllowFailure -Command {
        git -C $RepoRoot fetch --quiet origin $ReleaseBranch 2>$null
    }
    if ($fetched -ne 0) {
        Write-Warn "could not fetch origin - branch checks use possibly stale refs"
    }

    # The release is cut from whatever commit gets tagged, so pin down exactly
    # which commit that is: the right branch, and level with its remote.
    $branch = Get-GitOutput @('rev-parse', '--abbrev-ref', 'HEAD')

    if ($branch -eq 'HEAD') {
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
    $localSha  = Get-GitOutput @('rev-parse', 'HEAD')
    $remoteSha = Get-GitOutput @('rev-parse', $remoteRef)

    if (-not $remoteSha) {
        $problems.Add("No $remoteRef. Push the branch first: git push -u origin $ReleaseBranch")
    }
    elseif ($localSha -ne $remoteSha) {
        # Which way are we out of step? The fix differs.
        $ahead  = [int](Get-GitOutput @('rev-list', '--count', "$remoteRef..HEAD"))
        $behind = [int](Get-GitOutput @('rev-list', '--count', "HEAD..$remoteRef"))

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

function New-StagingTree {
    <#
        Builds the exact tree that becomes the zip: the build output at the
        root, plus every $ExtraPayload entry. Staging rather than zipping the
        build directory in place means the archive holds what was declared and
        nothing else - no stray .pdb, no leftover from a previous build.

        A trailing slash on an $ExtraPayload entry means "recurse this
        directory", and it lands in the zip under its own name.

        The caller is responsible for removing the returned directory.
    #>
    param([Parameter(Mandatory)][string]$BuildOutput)

    $staging = Join-Path ([System.IO.Path]::GetTempPath()) ("release-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $staging -Force | Out-Null

    try {
        if (-not (Test-Path -LiteralPath $BuildOutput)) {
            throw "The build reported success but produced nothing at $BuildOutput."
        }
        Copy-Item -Path (Join-Path $BuildOutput '*') -Destination $staging -Recurse -Force

        foreach ($entry in $ExtraPayload) {
            $isDir  = $entry -match '[/\\]$'
            $rel    = $entry.TrimEnd('/', '\')
            $source = Get-RepoPath $rel
            $dest   = Join-Path $staging (Split-Path -Leaf $rel)

            if ($isDir) {
                Copy-Item -LiteralPath $source -Destination $dest -Recurse -Force
            }
            else {
                Copy-Item -LiteralPath $source -Destination $dest -Force
            }
        }
    }
    catch {
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
        throw
    }

    return $staging
}

function New-ReleaseZip {
    <#
        Not Compress-Archive, for two reasons that each cost a release run to
        find. It opens each entry without FileShare.Read, so anything holding a
        file open - Dropbox indexing the folder, an antivirus scan, a
        just-tested process still tearing down - fails the archive. Worse, it
        reports that as a *non-terminating* error, which sails straight past
        $ErrorActionPreference = 'Stop' and leaves the script exiting 0 with no
        zip.

        Not ZipFile::CreateFromDirectory either, for a third reason: on .NET
        Framework it writes entry names with the platform separator, so a
        nested path is stored as "config\app.conf". Windows tools cope; unzip
        on macOS and Linux treats the backslash as part of the filename and
        drops the whole tree into one oddly named file. The zip spec says
        forward slashes, so the entries are added one at a time and named
        explicitly here.
    #>
    param(
        [Parameter(Mandatory)][string]$SourceDir,
        [Parameter(Mandatory)][string]$ZipPath
    )

    if (Test-Path -LiteralPath $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }

    # Both assemblies: ZipFile and ZipFileExtensions live in the FileSystem
    # one, ZipArchive and ZipArchiveMode in the other. Loading only the first
    # fails at the ZipArchiveMode reference with a TypeNotFound.
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $level  = [System.IO.Compression.CompressionLevel]::Optimal
    $prefix = (Resolve-Path -LiteralPath $SourceDir).Path.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    $files  = @(Get-ChildItem -LiteralPath $SourceDir -Recurse -File)

    if ($files.Count -eq 0) { throw "Nothing to package: $SourceDir is empty." }

    $attempt = 0
    while ($true) {
        $attempt++
        try {
            $archive = [System.IO.Compression.ZipFile]::Open(
                $ZipPath, [System.IO.Compression.ZipArchiveMode]::Create)
            try {
                foreach ($file in $files) {
                    $entryName = $file.FullName.Substring($prefix.Length).Replace('\', '/')
                    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                        $archive, $file.FullName, $entryName, $level) | Out-Null
                }
            }
            finally { $archive.Dispose() }
            break
        }
        catch [System.IO.IOException] {
            if (Test-Path -LiteralPath $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }
            if ($attempt -ge 5) { throw "Could not package after $attempt attempts: $($_.Exception.Message)" }
            Write-Warn "packaging attempt $attempt hit a locked file; retrying in 3s"
            Start-Sleep -Seconds 3
        }
    }

    # Belt and braces: the step above must not be able to report success
    # without producing a file.
    if (-not (Test-Path -LiteralPath $ZipPath)) {
        throw "Packaging reported success but $ZipPath does not exist."
    }
}

function Set-ManifestText {
    <#
        Writes a version-bumped manifest back to disk, preserving whether the
        file had a byte order mark.

        Not Set-Content -Encoding UTF8, which in Windows PowerShell 5.1 means
        UTF-8 *with* a BOM. That is not cosmetic: electron-builder's Go-based
        app-builder rejects a package.json starting with one outright -
        "readObjectStart: expect { or n" - and it upsets enough other non-.NET
        tooling that a version bump should never introduce one.

        Preserving rather than always stripping, because re-encoding a file the
        project deliberately saved with a BOM is not this script's decision to
        make.
    #>
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Text
    )

    $existing = [System.IO.File]::ReadAllBytes($Path)
    $hadBom   = $existing.Length -ge 3 -and
                $existing[0] -eq 0xEF -and $existing[1] -eq 0xBB -and $existing[2] -eq 0xBF

    if ($hadBom) {
        Write-Warn ("$(Split-Path -Leaf $Path) already has a byte order mark, which is kept. " +
                    "Some non-.NET tooling refuses to parse it - strip it if a build complains.")
    }

    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($hadBom)))
}

function New-ChecksumSidecar {
    <#
        Writes "<hash>  <filename>" beside the file, in the format sha256sum -c
        and CertUtil-adjacent tooling expect - two spaces, and the bare
        filename rather than a path, so verification works from whatever
        directory the file was downloaded into.
    #>
    param([Parameter(Mandatory)][string]$FilePath)

    $name = Split-Path -Leaf $FilePath
    $hash = (Get-FileHash -LiteralPath $FilePath -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -LiteralPath "$FilePath.sha256" -Value "$hash  $name" -Encoding ASCII

    $sizeMb = [math]::Round((Get-Item -LiteralPath $FilePath).Length / 1MB, 2)
    Write-Note "$name  ($sizeMb MB)"
    Write-Note "  sha256 $hash"

    return "$FilePath.sha256"
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

    $status = Get-GitOutput @('status', '--porcelain')
    if ($status) {
        $problems.Add("-Tag requires a clean working tree. Commit or stash first:`n$status")
    }

    # Local and remote tags are separate things, and deleting a release on
    # GitHub leaves the local tag behind. Report which copy is in the way, so
    # the fix is not a guess.
    $localTag = [bool](Get-GitOutput @('tag', '--list', $TagName))

    $remoteTag = $false
    if (Get-GitOutput @('remote')) {
        # Distinguish "no such tag" from "could not ask": both come back empty,
        # but only one of them means the tag is free to use.
        $reachable = Get-GitOutput @('ls-remote', '--exit-code', '--tags', 'origin', $TagName)
        if ($reachable) {
            $remoteTag = $true
        }
        elseif ($null -eq (Get-GitOutput @('ls-remote', '--heads', 'origin'))) {
            $problems.Add("Could not reach the remote to check whether tag $TagName is free.")
        }
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

    Invoke-Native -What "git tag $TagName" -Command {
        git -C $RepoRoot tag -a $TagName -m "Release $TagName"
    } | Out-Null
    Write-Note "created annotated tag $TagName"
}

function Publish-Release {
    param(
        [Parameter(Mandatory)][string]$TagName,

        # AllowEmptyCollection because a rehearsal in 'artifacts' mode has
        # nothing to list: the installers do not exist until something is
        # actually built. A mandatory [string[]] rejects an empty array before
        # the function body ever runs, which turned an ordinary dry run into a
        # parameter binding error.
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Assets,

        [Parameter(Mandatory)][bool]$WhatIf
    )

    if ($WhatIf) {
        Write-Note "would push $TagName and create the GitHub release"
        if ($Assets.Count -eq 0) {
            Write-Note "  assets: none yet - nothing is built, so this rehearsal cannot name them"
            Write-Note "  run with -Apply, or build first, to see the real list"
        }
        foreach ($a in $Assets) { Write-Note "  asset: $(Split-Path -Leaf $a)" }
        return
    }

    # A release with no downloads is worse than no release: it looks published.
    if ($Assets.Count -eq 0) {
        throw "Refusing to publish $TagName with no assets. The build produced nothing to upload."
    }

    Write-Note "pushing $TagName"
    $pushExit = Invoke-Native -What "git push origin $TagName" -AllowFailure -Command {
        git -C $RepoRoot push origin $TagName
    }
    if ($pushExit -ne 0) {
        throw ("Pushing the tag $TagName failed with exit code $pushExit. The tag exists " +
               "locally but not on the remote, and no release was created - so nothing is " +
               "half-published.`n" +
               "Common causes: the tag is already on the remote (a previous release was " +
               "deleted without --cleanup-tag), no push access, or a tag protection rule.`n" +
               "  git ls-remote --tags origin $TagName   # is it already there?`n" +
               "  git tag -d $TagName                    # drop the local tag and start over")
    }

    Write-Note "creating GitHub release"
    $releaseExists = $false

    # Repo-relative, so a '#' anywhere above the repo root cannot be mistaken
    # for gh's asset-label separator.
    $ghAssets = Get-GhAssetArguments -Assets $Assets

    # gh resolves the repo from the git remote of its working directory, so run
    # it there. (--repo takes OWNER/REPO, never a filesystem path.) That working
    # directory is also what the relative asset paths above are resolved against.
    Push-Location $RepoRoot
    try {
        $exit = Invoke-Native -What 'gh release create' -AllowFailure -Command {
            gh release create $TagName @ghAssets --title $TagName --generate-notes
        }

        if ($exit -ne 0) {
            # Which recovery command to use depends on whether the release got
            # created before the failure, so find out rather than guess: a
            # release that exists cannot be created again, and telling someone
            # to retry a command that is guaranteed to fail wastes their time.
            $releaseExists = 0 -eq (Invoke-Native -What 'gh release view' -AllowFailure -Command {
                gh release view $TagName *> $null
            })
        }
    }
    finally { Pop-Location }

    if ($exit -ne 0) {
        $assetList = Format-CommandArguments -Arguments $ghAssets

        $lines = [System.Collections.Generic.List[string]]::new()
        $lines.Add("gh release create failed with exit code $exit.")
        $lines.Add("The tag $TagName is already pushed and the artifacts are built, so")
        $lines.Add('nothing needs redoing - only the upload has to be finished.')
        $lines.Add('')
        $lines.Add("Run from $RepoRoot")
        $lines.Add('')

        if ($releaseExists) {
            $lines.Add("The release $TagName EXISTS - it was created before the failure, so")
            $lines.Add('creating it again will fail. Finish the upload instead:')
            $lines.Add("    gh release upload $TagName $assetList --clobber")
        }
        else {
            $lines.Add('The release was not created. Retry it:')
            $lines.Add("    gh release create $TagName $assetList --title $TagName --generate-notes")
        }

        $lines.Add('')
        $lines.Add('Common causes: the gh token lost its workflow/repo scope (gh auth refresh),')
        $lines.Add('an asset larger than 2 GB, or a release someone created on the web already.')
        $lines.Add('')
        $lines.Add('To back the whole release out instead:')
        $lines.Add("    gh release delete $TagName --cleanup-tag --yes")
        $lines.Add("    git tag -d $TagName")

        throw ($lines -join "`n")
    }
}

# ---------------------------------------------------------------------------
# Ecosystem seam: Node / TypeScript.
#
# These four functions are the only difference between this script and the
# python, dotnet, powershell and electron templates. Everything above and
# below is identical across all five.
# ---------------------------------------------------------------------------

function Get-PackageJson {
    $path = Get-RepoPath $VersionFile
    try {
        return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    }
    catch {
        throw "$VersionFile is not valid JSON: $($_.Exception.Message)"
    }
}

function Test-NpmScript {
    <# True if package.json declares the named script. #>
    param([Parameter(Mandatory)][string]$Name)

    $pkg = Get-PackageJson
    if (-not $pkg.PSObject.Properties['scripts']) { return $false }
    return [bool]$pkg.scripts.PSObject.Properties[$Name]
}

function Get-ProjectVersion {
    $pkg = Get-PackageJson
    if (-not $pkg.PSObject.Properties['version']) {
        throw "No version field in $VersionFile. Add one, or pass -Version explicitly."
    }

    $value = "$($pkg.version)".Trim()
    if ($value -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') {
        throw "version in $VersionFile is '$value', which is not x.y.z. Fix it, or pass -Version explicitly."
    }
    return $value
}

function Set-ProjectVersion {
    <#
        Rewrites only the version line. A ConvertTo-Json round-trip would
        reorder the keys and reformat the whole file, so patch the text in
        place instead. `npm version` is avoided for the same reason, plus it
        creates its own commit and tag.
    #>
    param(
        [Parameter(Mandatory)][string]$NewVersion,
        [Parameter(Mandatory)][bool]$WhatIf
    )

    $path    = Get-RepoPath $VersionFile
    $text    = Get-Content -LiteralPath $path -Raw
    $pattern = '(?m)^(\s*"version"\s*:\s*")[^"]*(")'

    if ($text -notmatch $pattern) {
        throw "Could not find a version field in $VersionFile to update."
    }

    if ($WhatIf) {
        Write-Note "would set $VersionFile version to $NewVersion"
        return
    }

    $updated = [regex]::Replace($text, $pattern, "`${1}$NewVersion`${2}", 1)
    Set-ManifestText -Path $path -Text $updated
    Write-Note "$VersionFile version set to $NewVersion"

    # package-lock.json carries the version too, and npm rewrites it on the
    # next install. Left alone it just goes stale; flagged here so it is a
    # choice rather than a surprise in the diff.
    if (Test-Path -LiteralPath (Join-Path $RepoRoot 'package-lock.json')) {
        Write-Note "package-lock.json still holds the old version; it updates on the next install"
    }
}

$script:DepsInstalled = $false

function Install-ProjectDependencies {
    <#
        Dependencies must be present before the TESTS run, not merely before
        the build. On a fresh clone - or after an interrupted `npm ci` left
        node_modules half-written - `npm test` fails with something like
        "'vitest' is not recognized", which reads as a broken test suite rather
        than a missing install, and sends you looking in the wrong place.

        Idempotent via $script:DepsInstalled, because `npm ci` deletes and
        rebuilds node_modules from scratch: running it once per release rather
        than once per step that needs it is the difference between one install
        and two.
    #>
    param([Parameter(Mandatory)][bool]$WhatIf)

    if ($script:DepsInstalled) { return }

    # npm ci without a lockfile fails with 40 lines of usage text that never
    # says what is actually wrong, so say it here - and say it on a rehearsal,
    # which is the whole point of having one.
    if ($PkgInstallCmd -contains 'ci' -and -not (Test-Path -LiteralPath (Join-Path $RepoRoot 'package-lock.json'))) {
        $msg = ("No package-lock.json, so a clean install is impossible and the build " +
                "would not be reproducible. Run npm install and commit the lockfile, " +
                "or change the install command in the config block above.")
        if ($WhatIf) { Write-Warn "would fail: $msg" } else { throw $msg }
    }

    if ($WhatIf) {
        Write-Note "would run $PkgMgr $($PkgInstallCmd -join ' ')"
        $script:DepsInstalled = $true
        return
    }

    Push-Location $RepoRoot
    try {
        # A clean install rather than a plain install: the lockfile is what
        # makes the artifact reproducible, and `npm install` will happily
        # rewrite it mid-release.
        Invoke-Native -What "$PkgMgr $($PkgInstallCmd -join ' ')" -Command {
            & $PkgMgr @PkgInstallCmd
        } | Out-Null
    }
    finally { Pop-Location }

    $script:DepsInstalled = $true
}

function Invoke-ProjectTests {
    param([Parameter(Mandatory)][bool]$WhatIf)

    if (-not (Test-NpmScript 'test')) {
        Write-Note "no 'test' script in $VersionFile - skipping"
        return
    }

    Install-ProjectDependencies -WhatIf:$WhatIf

    if ($WhatIf) { Write-Note "would run $PkgMgr test"; return }

    # Push-Location rather than npm's --prefix: pnpm and yarn do not take it,
    # and this seam is meant to survive swapping $PkgMgr.
    Push-Location $RepoRoot
    try {
        Invoke-Native -What "$PkgMgr test" -Command { & $PkgMgr test } | Out-Null
    }
    finally { Pop-Location }
}

function Invoke-ProjectBuild {
    <#
        Returns the absolute path to the directory whose contents become the
        zip. Always returns it, dry run or not, so the packaging step can
        report where the artifact would have come from.
    #>
    param(
        [Parameter(Mandatory)][string]$ReleaseVersion,
        [Parameter(Mandatory)][bool]$WhatIf
    )

    $outPath = Join-Path $RepoRoot $BuildDir

    # No-op when the test step already did it. On a rehearsal this is what
    # prints the install line, in the step where it actually happens.
    Install-ProjectDependencies -WhatIf:$WhatIf

    if ($WhatIf) {
        Write-Note "would run $PkgMgr run build"
        Write-Note "would produce $outPath"
        return $outPath
    }

    Push-Location $RepoRoot
    try {
        if (Test-NpmScript 'build') {
            # Wipe first: a stale file from a previous build is otherwise
            # indistinguishable from a current one and ships in the zip.
            if (Test-Path -LiteralPath $outPath) {
                Remove-Item -LiteralPath $outPath -Recurse -Force
            }

            Invoke-Native -What "$PkgMgr run build" -Command {
                & $PkgMgr run build
            } | Out-Null
        }
        else {
            Write-Note "no 'build' script in $VersionFile - packaging $BuildDir as it stands"
        }
    }
    finally { Pop-Location }

    return $outPath
}

# Optional: uncomment and adapt when the shipped file list is derived from
# source rather than from whatever the build happens to emit. The point is
# that adding a module to the project cannot silently omit it from a release.
#
# function Assert-BundleComplete {
#     $entry    = Get-Content -LiteralPath (Get-RepoPath 'src/index.ts') -Raw
#     $declared = [regex]::Matches($entry, "from\s+'\./([^']+)'") |
#                 ForEach-Object { $_.Groups[1].Value }
#     foreach ($module in $declared) {
#         Get-RepoPath "$BuildDir/$module.js" | Out-Null
#     }
# }

# ---------------------------------------------------------------------------
# Main. Identical in every release.ps1 template. The nine steps below are the
# whole release, and they run in this order in every repo regardless of
# language - only the four seam functions above differ.
# ---------------------------------------------------------------------------

# -Publish is -Tag plus the remote half.
if ($Publish) { $Tag = $true }

if ($isDryRun) {
    Write-Host ""
    Write-Warn "DRY RUN - nothing will be built, written, tagged or published."
    Write-Warn "Re-run the same command with -Apply to do it for real."
}

# --- 1. version ------------------------------------------------------------

Write-Step "Version"
if ($Version) {
    Set-ProjectVersion -NewVersion $Version -WhatIf:$isDryRun
    # On a dry run the file on disk is unchanged, so use the requested version
    # rather than reading back what is still the old one.
    $releaseVersion = $Version
}
else {
    $releaseVersion = Get-ProjectVersion
    Write-Note "$releaseVersion (from $VersionFile)"
}

$tagName = "v$releaseVersion"
$zipName = "$ProjectName-$releaseVersion.zip"
$zipPath = Join-Path $OutDir $zipName

if ($PackageMode -eq 'zip') {
    # A version already in the artifact directory has been built, and probably
    # shipped. Rebuilding it under the same number produces a second artifact
    # with the same name and a different hash, which is the one thing a release
    # number exists to prevent.
    if ((Test-Path -LiteralPath $zipPath) -and -not $Force) {
        $msg = "$zipName already exists in $OutDir. Bump the version in $VersionFile, or re-run with -Force to replace it."
        if ($isDryRun) { Write-Warn "would fail: $msg" } else { throw $msg }
    }
}
else {
    # In artifacts mode the build output directory is wiped and rebuilt every
    # run, so there is no stale-artifact check to make here. The tag check in
    # step 7 is what stops a version being released twice.
}

# --- 2. preflight ----------------------------------------------------------

Write-Step "Preflight"

# Checked here rather than at the packaging step, which is eight minutes and a
# full build later. A typo ('artifacts ', 'zips') would otherwise fall through
# to the else branch and fail on a function that does not exist, and setting
# 'artifacts' in a template that has no Get-ReleaseArtifacts fails the same
# cryptic way.
if ($PackageMode -notin @('zip', 'artifacts')) {
    throw "`$PackageMode is '$PackageMode'. It must be 'zip' or 'artifacts'."
}
if ($PackageMode -eq 'artifacts' -and -not (Get-Command Get-ReleaseArtifacts -ErrorAction SilentlyContinue)) {
    throw ("`$PackageMode is 'artifacts', but this template defines no Get-ReleaseArtifacts. " +
           "Either set it to 'zip', or copy that function from the electron template - " +
           "artifacts mode needs it to decide which of the build's files are release assets.")
}

# Where artifacts land differs by mode, but either way it must be ignored.
$artifactDir = if ($PackageMode -eq 'zip') { $OutDir } else { Join-Path $RepoRoot (Resolve-BuilderOutput) }
Assert-ArtifactDirIgnored -Paths @($artifactDir) -Soft:($isDryRun -or -not $Tag)

Assert-ExtraPayload
if ($Publish) {
    Assert-PublishReady -Soft:$isDryRun -ArtifactDir $artifactDir
}
else {
    Write-Note "remote checks skipped (no -Publish)"
}

# --- 3. tests --------------------------------------------------------------

Write-Step "Tests"
if ($SkipTests) {
    Write-Warn "skipped (-SkipTests). Do not do this for a real release."
}
else {
    Invoke-ProjectTests -WhatIf:$isDryRun
}

# --- 4. build --------------------------------------------------------------

Write-Step "Build"
$buildOutput = Invoke-ProjectBuild -ReleaseVersion $releaseVersion -WhatIf:$isDryRun

# --- 5/6. stage + package --------------------------------------------------

Write-Step "Packaging"

# Two shapes of release, chosen by $PackageMode in the config block.
#
#   'zip'       The build produced a directory of files. Stage it with
#               $ExtraPayload and compress the result into one archive.
#
#   'artifacts' The build already produced finished, individually shippable
#               files - an installer, say. Re-zipping those would only force
#               the user to unpack an installer before running it, so they are
#               uploaded as they are.
#
# Either way the step ends with $assets holding everything to attach to the
# release, each file paired with a .sha256 sidecar.

if ($PackageMode -eq 'zip') {
    if ($isDryRun) {
        Write-Note "would package $buildOutput"
        foreach ($e in $ExtraPayload) { Write-Note "  + $e" }
        Write-Note "would write $zipPath and $zipName.sha256"
    }
    else {
        if (-not (Test-Path -LiteralPath $OutDir)) {
            New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
        }

        $staging = New-StagingTree -BuildOutput $buildOutput
        try {
            New-ReleaseZip -SourceDir $staging -ZipPath $zipPath
        }
        finally {
            Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
        }

        New-ChecksumSidecar -FilePath $zipPath | Out-Null
    }

    $assets = @($zipPath, "$zipPath.sha256")
}
else {
    $artifacts = Get-ReleaseArtifacts -BuildOutput $buildOutput `
                                      -ReleaseVersion $releaseVersion -WhatIf:$isDryRun

    if ($isDryRun) {
        foreach ($a in $artifacts) { Write-Note "would upload $(Split-Path -Leaf $a) and its .sha256" }
        $assets = @($artifacts | ForEach-Object { $_; "$_.sha256" })
    }
    else {
        $assets = [System.Collections.Generic.List[string]]::new()
        foreach ($artifact in $artifacts) {
            New-ChecksumSidecar -FilePath $artifact | Out-Null
            $assets.Add($artifact)
            $assets.Add("$artifact.sha256")
        }
        $assets = $assets.ToArray()
    }
}

# --- 7. tag ----------------------------------------------------------------

if ($Tag) {
    Write-Step "Tagging"
    New-ReleaseTag -TagName $tagName -WhatIf:$isDryRun
}

# --- 8. publish ------------------------------------------------------------

if ($Publish) {
    Write-Step "Publishing"
    Publish-Release -TagName $tagName -Assets $assets -WhatIf:$isDryRun
}

# --- 9. done ---------------------------------------------------------------

Write-Host ""
Write-Step "Done"

if ($isDryRun) {
    Write-Warn "Dry run complete. Nothing was changed."
    Write-Warn "Add -Apply to the same command to run it for real."
}
elseif ($Publish) {
    Write-Note "Release $tagName is live with the zip attached."
    Write-Note "  gh release view $tagName --web"
}
elseif ($Tag) {
    $quoted = ($assets | ForEach-Object { "`"$_`"" }) -join ' '
    Write-Note "Tag created locally. Push and publish when ready:"
    Write-Note "  git push origin $tagName"
    Write-Note "  gh release create $tagName $quoted --generate-notes"
    Write-Note "Or re-run with -Publish next time to do both."
}
else {
    Write-Note "Artifact built. Add -Tag to tag it, or -Publish to release it."
}
Write-Host ""
