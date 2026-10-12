# Changelog

All notable changes to `dsh-terminal-panel` are recorded here.
This is the first entry: it bundles everything that happened after the 1.0.x line
(npm still serves 1.0.1, the git history stopped at 1.0.4).

## [1.3.0] — 2026-10-12

Per-device shell detection, a settings panel and an agent tool set.

### Added

- **Per-device shell detection.** The host probes what this machine really has instead of
  offering a hard-coded list. Windows: `PATH`, `%ProgramFiles%\PowerShell\7\pwsh.exe`,
  `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe`,
  `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, `%COMSPEC%`, the Git for
  Windows tree (the `System32\bash.exe` WSL launcher is excluded) and every WSL distribution
  (`wsl.exe --list`, one `wsl:<name>` entry per distribution). macOS / Linux: `$SHELL`,
  `/etc/shells` and the usual binary directories. Every hit keeps its family, label, `about`
  line and resolved path; everything that was not found is reported as `missingShells`.
- **Device summary** — name · arch · hostname · login shell · WSL — surfaced in
  `terminal_shells`, `GET /shells`, the new-terminal menu header and the settings panel.
- **New-terminal picker**: the segmented "+ New Terminal ▾" button opens a family-grouped menu
  with per-entry descriptions, a working-directory field and a ⟳ re-detect action; the type you
  pick becomes the default.
- **Settings panel** (⚙): default shell (`auto` or a pinned installed shell, with an automatic
  fallback when the pinned shell disappears) and the "inject terminal tools into the agent"
  switch. Stored in `<DSH_HOME>/terminal-panel/settings.json`.
- **Nine `terminal_*` agent tools** (`shells`, `list`, `create`, `read`, `write`, `exec`,
  `resize`, `rename`, `close`) registered through `ctx.tools`, re-registered by
  `POST /__reload` and removable at runtime.
- New routes `GET /shells`, `GET /settings`, `POST /settings`, `GET /tools`.

### Fixed

- The new-terminal menu no longer stays invisible in the empty state. The big button's
  `filter: brightness(1.06)` hover style made the button a containing block for the
  `position: fixed` menu, and its `overflow: hidden` clipped that menu away; moving the mouse
  off the button brought it back. The menu is now rendered as a sibling of the button, the hover
  highlight uses a gradient instead of a filter, and a click inside the menu no longer counts as
  a click outside.
- A `pwsh.exe` that only exists as a Microsoft Store App Execution Alias is now detected and
  launched through the alias path, even though it cannot be `stat()`ed.
- An unrecognised platform name coming back from the subprocess service (`win32`, …) no longer
  makes the device look like it has zero shells.

### Changed

- On a fresh install the default shell is the first available entry in this device's order
  (Windows: `pwsh → powershell → cmd → gitbash → wsl → nu → bash`), i.e. PowerShell 7 once it is
  installed; macOS / Linux prefer the login shell.
- Shell ids are namespaced per distribution (`wsl:<distro>`); `terminal_create` refuses a shell
  that is not installed on this machine.
