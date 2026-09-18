<p align="center">
  <img src="assets/banner.svg" width="900" alt="dsh-plugin-terminal-panel banner"/>
</p>

# dsh-plugin-terminal-panel

English | [中文](README.md)

[![npm](https://img.shields.io/npm/v/dsh-terminal-panel)](https://www.npmjs.com/package/dsh-terminal-panel)
[![license](https://img.shields.io/github/license/BaiZhi967/dsh-plugin-terminal-panel)](LICENSE)
[![stars](https://img.shields.io/github/stars/BaiZhi967/dsh-plugin-terminal-panel?style=flat)](https://github.com/BaiZhi967/dsh-plugin-terminal-panel)

**Terminals inside the DSH web UI.** Click the sidebar icon and a terminal panel opens in the main column, as a peer of the Conversation panel. It is a **real PTY** (node-pty / ConPTY) — not a fake output box, and never an OS window.

- Terminals live in the **DSH host process**; output is streamed to the page over SSE.
- Refreshing or closing the page does not kill them: the PTY survives and **replays the last 256 KB**, so the screen comes back.
- Resizing the panel resizes the PTY, so the shell redraws at the new width.

## ✨ Features

| Feature | Detail |
|---|---|
| **Sidebar entry** | One terminal icon in the sidebar's panel-icon row, next to the built-in Plugins icon. Clicking it switches the main column to the terminal panel — the same mechanism the Conversation panel uses |
| **Active count** | A live badge on the icon shows how many terminals are running (hidden at zero); the tooltip carries the count too |
| **Tabs** | Several terminals in one panel (up to 12), each with a status dot and a close button |
| **Rename** | Double-click a tab, or use its ✎ button; `Enter` commits, `Esc` cancels, blur commits. CJK and emoji round-trip correctly |
| **Own VT engine** | A small terminal renderer written for this plugin: ANSI colour (16 / 256 / truecolor), cursor addressing, erase, alternate screen, scroll regions, wide characters |
| **Theme aware** | Separate light and dark ANSI palettes: on a light theme `37` / `93` map to dark grey / dark yellow, so PowerShell's input highlighting stays readable |
| **Text selection** | The ⧉ button in the tab bar pauses keyboard input so you can select and copy output |
| **IME input** | A dedicated input channel: composed Chinese, CJK and emoji reach the PTY correctly |
| **Live reload** | Edit `impl.js` and `POST /__reload` — no DSH restart. Client-side edits are hot-updated by DSH's module table |

## 📦 Install

Install from npm (package [`dsh-terminal-panel`](https://www.npmjs.com/package/dsh-terminal-panel)):

```sh
dsh plugin --profile web add dsh-terminal-panel
dsh --profile web
```

Reload the page once and the terminal icon appears in the sidebar.

> Plain JavaScript: no build step, no runtime dependencies.
> If the package cannot be resolved, the mirror usually has not synced the latest version yet — install once against the official registry, or retry later:
> `dsh plugin --profile web add dsh-terminal-panel --registry=https://registry.npmjs.org/`
> Requirements: DSH `>= 0.1.6-alpha.2`, Node `^22.19.0 || >=24.0.0`, and a host with a working PTY (this plugin uses `subprocess.spawnTerminal`, i.e. the bundled node-pty).

## 🚀 Usage

1. Click the **terminal icon** in the sidebar → the terminal panel opens in the main column.
2. Click **+ New Terminal** → a PTY is allocated immediately. The shell is picked as `pwsh` → `powershell` → the host default, and the working directory defaults to the newest workspace.
3. Type directly in the panel (clicking it focuses the input).
4. Double-click a tab (or use ✎) to rename; ✕ closes the terminal and terminates its process tree.
5. The panel resizes the PTY automatically as the window changes.

## 🧱 Layout

```
dsh-plugin-terminal-panel/
├── host.js           # host entry: the route carrier + reload shell only
├── impl.js           # host implementation: PTY lifecycle, SSE, write/resize/close/rename
├── client.js         # client: terminal panel, sidebar icon, VT engine, input handling
├── cordis.patch.yml  # bundle patch: inserts the plugin row into a profile
└── package.json      # dsh.bundle.patch + dsh.client declarations
```

How the halves talk:

```
sidebar icon / terminal panel (client.js)
        │  same-origin HTTP on the loopback listener
        ▼
GET  /system-terminals/api/stream?id=…   ← SSE: replay buffer first, then live output
POST /system-terminals/api/{list,create,write,resize,close,rename,remove}
        ▼
impl.js ── subprocess.spawnTerminal() ──► real PTY (node-pty / ConPTY)
```

The two-file host split is deliberate: **a loaded ES module stays cached in the host process for its lifetime**, so `host.js` stays minimal and pulls the implementation in through a cache-busted dynamic `import()`. Replacing `impl.js` then takes effect with one `POST /__reload`, no DSH restart.

### Local API

Prefix `/system-terminals/api`, bound to DSH's own loopback listener, no session auth — the same shape other plugins in this ecosystem use for their private routes:

| Method | Purpose |
|---|---|
| `GET /health` | Version, platform, shell, PTY availability |
| `GET /list` | Terminals: id, title, cwd, pid, cols/rows, status, resizable |
| `POST /create` | `{cwd?, cols?, rows?}` → open a terminal |
| `POST /write` | `{id, data}` → write raw UTF-8 bytes to the PTY |
| `POST /resize` | `{id, cols, rows}` |
| `POST /close` | `{id}` → terminate the process |
| `POST /rename` | `{id, title}` → rename (whitespace collapsed, 60 chars max) |
| `POST /remove` | `{id}` → drop an exited terminal from the list |
| `GET /stream?id=` | SSE: `history` / `data` / `status` / `exit` events, base64 payloads |
| `POST /__reload` | Development: reload `impl.js` |

## 📄 License

[MIT](LICENSE) © 2026 BaiZhi967
