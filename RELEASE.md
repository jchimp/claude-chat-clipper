# Releasing

One command builds the zip, tags the commit, pushes the tag, and publishes the
GitHub release with the zip attached. You keep a copy in `dist/` either way.

## Once per machine

```powershell
gh auth login
```

That is the only setup. There is no CI to configure and no secrets to store.

## Cut a release

```powershell
git push origin main                              # 1. get the commit on the remote
.\scripts\release.ps1 -Version 1.2.0 -Publish     # 2. everything else
```

Step 2 does, in order:

1. Sets `version` in `manifest.json` to 1.2.0.
2. Validates the manifest and checks every file it is about to ship exists.
3. Writes `dist/claude-chat-clipper-1.2.0.zip` and a `.sha256` beside it.
4. Creates the annotated tag `v1.2.0` and pushes it.
5. Creates the GitHub release and uploads both files as assets.

The commit has to be pushed first because the release is cut from the tagged
commit. The script checks this and stops before building if `HEAD` is not on the
remote yet.

## Look before you leap

```powershell
.\scripts\release.ps1 -Version 1.2.0 -DryRun
```

Prints the version, the exact file list that would ship, and where the zip would
go. Writes nothing, tags nothing, publishes nothing.

## Build without publishing

```powershell
.\scripts\release.ps1                  # zip at the current manifest version
.\scripts\release.ps1 -Version 1.2.0   # bump and zip, no tag, no release
```

## When it stops

The script fails rather than shipping something wrong. What each refusal means:

| Message | Fix |
|---|---|
| `-Publish needs an authenticated gh` | `gh auth login` |
| `HEAD is not on the remote yet` | `git push origin main`, then re-run |
| `-Tag requires a clean working tree` | Commit or stash first |
| `Tag v1.2.0 already exists` | That version shipped. Pick the next one |
| `icon-48.png is declared as 48px but is 16x16` | The manifest and the actual PNG disagree |
| `Required file is missing: x.js` | A file the manifest or `popup.js` references is gone |
| `Could not find the PAGE_FILES array in popup.js` | It was renamed. Update `scripts/release.ps1` |

If `gh release create` fails *after* the tag is pushed, the script prints the
exact command to finish by hand. Nothing needs re-building.

## Undoing a release

```powershell
gh release delete v1.2.0 --cleanup-tag --yes   # removes release AND remote tag
git tag -d v1.2.0                              # local tag
```

Prefer bumping to a new patch version over re-cutting one people may already
have downloaded.

## What ships

The zip contains only what the extension needs at runtime. The list is derived
from source, not kept in the script:

- Icons come from the paths in `manifest.json`, so unreferenced sets are excluded.
- The injected bundle comes from the `PAGE_FILES` array in `popup.js`, so adding
  a module does not silently omit it.
- Everything else is a short allowlist in `scripts/release.ps1`.

That is what keeps `test/fixtures/` — which holds real conversations — out of a
published artifact.

## Reusing this in another repo

The portable part is the last step, not the script. In any repo:

```powershell
gh release create v1.2.0 dist\thing-1.2.0.zip --title v1.2.0 --generate-notes
```

That single command is what turns a tag into a release with a real download
attached. A tag on its own only gives GitHub's auto-generated source archives.
Everything else in `scripts/release.ps1` is this project's build and validation;
swap it for `npm run build` or `python -m build` and keep the same final line.
