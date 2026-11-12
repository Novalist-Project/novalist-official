# Testing the unified writing branch

Open [Unified writing validation in GitHub Actions](https://github.com/Novalist-Project/novalist-official/actions/workflows/writing-feasibility.yml?query=branch%3Afeat%2Funified-writing-workspace)
and select a successful run for `feat/unified-writing-workspace`. Under
**Artifacts**, download the `novalist-preview-...` artifact for your computer.
You must be signed in to GitHub. Artifacts expire after 14 days.
`writing-feasibility-evidence` contains automated test results, not the app.

Extract the downloaded artifact ZIP. It contains the application package,
`BUILD.txt` identifying the branch, commit, and version, and these instructions.
The application bundles its runtime; Node.js and .NET do not need to be installed.

| Computer | Package | Launch |
| --- | --- | --- |
| Windows x64 | `novalist-preview-windows-x64.zip` | Extract this inner ZIP completely, then open `Novalist.exe`. No installer is needed. |
| macOS Intel | `novalist-preview-macos-x64.dmg` | Open the DMG, copy Novalist into a separate test folder, then open it there. |
| macOS Apple Silicon | `novalist-preview-macos-arm64.dmg` | Open the DMG, copy Novalist into a separate test folder, then open it there. |
| Linux x64 | `novalist-preview-linux-x86_64.AppImage` | Run `chmod +x novalist-preview-linux-x86_64.AppImage`, then `./novalist-preview-linux-x86_64.AppImage`. |

Quit your installed Novalist before launching the preview. These builds share
its settings and cannot run alongside it. Keep the macOS preview in a separate
folder so it does not replace the installed application. Windows previews are
unsigned. macOS signing and notarization use the repository's Developer ID
credentials when configured; unsigned macOS builds may be blocked by Gatekeeper.

Use a dummy project or a disposable copy of a backed-up project. This branch is
still in development. For Arabic testing, select Arabic in Settings and try RTL
typing, mixed Arabic/English text, punctuation, navigation, and keyboard shortcuts.
Include the commit from `BUILD.txt`, your OS, and reproduction steps in reports
on [issue #78](https://github.com/Novalist-Project/novalist-official/issues/78).

Maintainers: pushes to this branch build previews after the production editor
checks pass. The workflow can also be dispatched for the branch. Each successful
packaging job uploads its own artifact, even if another platform fails. These
builds are not published as GitHub releases or sent to app stores.
