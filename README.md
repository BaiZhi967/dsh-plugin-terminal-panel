<p align="center">
  <img src="assets/banner.svg" width="900" alt="dsh-plugin-terminal-panel banner"/>
</p>

# dsh-plugin-terminal-panel

[English](README_EN.md) | 中文

[![npm](https://img.shields.io/npm/v/dsh-terminal-panel)](https://www.npmjs.com/package/dsh-terminal-panel)
[![license](https://img.shields.io/github/license/BaiZhi967/dsh-plugin-terminal-panel)](LICENSE)
[![stars](https://img.shields.io/github/stars/BaiZhi967/dsh-plugin-terminal-panel?style=flat)](https://github.com/BaiZhi967/dsh-plugin-terminal-panel)

**在 DSH 网页里开终端**：侧栏点一下，主区域就多出一个和「对话」同级的终端面板，里面是**真 PTY**（node-pty / ConPTY），不是假的输出框，也不弹系统窗口。

- 终端跑在 **DSH 宿主进程**里，输出通过 SSE 实时推给页面；
- 关掉页面、刷新页面都不掉线，PTY 存活并**回放最近 256 K 字符输出**，回来画面还在；
- 面板宽度变化会自动 `resize` PTY，shell 的重绘跟着走；
- 面板里的终端**同时也是一个 Agent 工具集**：模型可以自己开终端、跑命令、读输出。

## ✨ 功能

| 能力 | 说明 |
|---|---|
| **侧栏入口** | 左栏面板图标区多一个终端图标，与「插件」图标同级；点它主区域切到终端面板，机制与「对话」面板完全一致 |
| **活跃计数** | 图标右上角实时显示运行中的终端数量，为 0 时自动隐藏；悬停提示同步带上数量 |
| **按设备认终端类型** | 宿主先实测**本机真正装了什么**再列出来：Windows 上是 PowerShell 7 / Windows PowerShell / 命令提示符 / Git Bash / **每个 WSL 发行版各一条** / Nushell；macOS 上是登录 shell（`$SHELL`，排最前）/ zsh / bash / fish / sh / Nushell / PowerShell 7 / ksh / tcsh；Linux 上是 `PATH` 与 `/etc/shells` 里能找到的那些。列表按**终端类型**分组（PowerShell / Windows / WSL / Bash / Zsh …），每条写着它是什么、装在哪；本机没有的类型进「未安装」，绝不假装能用 |
| **选择 shell** | 「+ 新建终端 ▾」是一体式分段按钮：左半直接开，右半展开菜单（顶部是本机设备：名称 · 架构 · 主机名），选类型 / 填工作目录；选中的即成为默认，新装了 shell 点 ⟳ 重新探测即可 |
| **设置面板** | 面板头部的 ⚙ 打开设置：**默认终端类型**（自动 / 指定某个已安装 shell，同样按类型分组、并标出本机设备与未安装类型）与**给 Agent 注入终端工具**开关；设置写在 `<DSH_HOME>/terminal-panel/settings.json`，重启、换浏览器都还在 |
| **默认工作目录** | 新终端默认落在**用户主目录**（`C:\Users\<你>` / `~`），和系统里新开一个终端一样；也可以在新建菜单里填任意目录（支持 `~` 与相对路径），或让模型用 `cwd` 指定 |
| **多标签** | 一个面板里开多个终端（上限 12 个），每个一个标签，带状态点和关闭按钮；标签上悬停可看到 shell 与目录，头部显示当前终端的 shell · 目录 |
| **重命名** | 双击标签名，或点标签上的 ✎；`Enter` 提交、`Esc` 取消、失焦自动提交（中文 / emoji 正常） |
| **自绘终端** | 内置一个小型 VT 引擎：ANSI 颜色（16 / 256 / 真彩）、光标定位、清行清屏、备用屏幕、滚动区域、宽字符 |
| **跟随主题** | 亮 / 暗两套 ANSI 调色板：亮色主题下 `37`／`93` 映射为深灰 / 深黄，白底上也能看清（PowerShell 的输入高亮不再"隐形"） |
| **文本选择** | 标签栏 ⧉ 一键切到「选择文本」模式（暂停键盘输入），可直接框选复制输出 |
| **中文输入** | 独立输入通道，IME 组合输入、中文、emoji 都能正确送进 PTY |
| **Agent 工具** | 注册 9 个 `terminal_*` 工具（新建 / 列表 / 读内容 / 执行命令 / 发送按键 / 改名 / 改尺寸 / 关闭 / 探测已装 shell），模型和用户共用同一批终端；可在设置里一键关闭注入 |
| **热重载** | 改 `impl.js` 后 `POST /__reload` 即可生效（**工具定义也随之更新**），不用重启 DSH；已经开着的终端不会被换掉，继续可读可写 |

## 📦 安装

从 npm 安装（包名 [`dsh-terminal-panel`](https://www.npmjs.com/package/dsh-terminal-panel)）：

```sh
dsh plugin --profile web add dsh-terminal-panel
dsh --profile web
```

装好后刷新一次页面（或直接看侧栏），左栏面板图标区就会出现终端图标。

> 纯 JS 实现：无构建步骤、无运行时依赖。
> 若提示找不到包，通常是镜像尚未同步新版本 —— 可指定官方源再装一次，或稍后重试：
> `dsh plugin --profile web add dsh-terminal-panel --registry=https://registry.npmjs.org/`
> 环境要求：DSH `>= 0.2.0-rc.2`、Node `^22.19.0 || >=24.0.0`；宿主进程需要有可用 PTY（本插件用 `subprocess.spawnTerminal`，即宿主自带的 node-pty）。

## 🚀 用法

1. 点左栏的**终端图标** → 主区域打开终端面板；
2. 点 **+ 新建终端** → 立即用「上次选过的 shell / 默认 shell」在主目录开一个 PTY；点右边的 **▾** 展开菜单：顶部是本机设备，下面按终端类型分组列出实测可用的 shell，未安装的类型单列一块，可以选类型、填工作目录，或点 ⟳ 重新探测；
3. 直接在面板里敲命令（点击面板即聚焦输入）；
4. 双击标签名改名；✎ 也是改名；✕ 关闭（进程树会被终止）；
5. 面板随窗口变化自动 `resize`。

### 打开 Git Bash / cmd

不需要开关：宿主会去 `PATH`、`%ProgramFiles%\Git\bin\bash.exe`、`%LOCALAPPDATA%\Programs\Git\bin\bash.exe`、scoop 目录，以及 `git.exe` 所在位置反推 `..\bin\bash.exe` 逐个验证。**装有 Git for Windows 才会出现 Git Bash 选项**，没装就不会列出来；`C:\Windows\System32\bash.exe`（WSL 启动器）会被明确排除，绝不拿 WSL 的 bash 冒充 Git Bash。`powershell.exe` / `cmd.exe` 同理，一律实测。

### 终端类型是怎么认出来的

「这台机器上有哪些终端」是宿主进程**实测**出来的，不是写死的清单；面板打开、点 ⟳ 重新探测、保存设置时都会重新走一遍：

| 平台 | 去哪找 |
|---|---|
| Windows | `PATH`、`%ProgramFiles%\PowerShell\7\pwsh.exe`、`%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe`、`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`、`%COMSPEC%`、Git for Windows 安装树（含从 `git.exe` 反推的 `..\bin\bash.exe`，并排除 `System32\bash.exe` 这个 WSL 启动器），以及**逐个 WSL 发行版**（`wsl.exe --list`，每个发行版一条 `wsl:<名字>`，用 `wsl.exe -d <名字>` 启动） |
| macOS | `$SHELL`（登录 shell 提到最前，也就是「自动」的默认）、`/etc/shells`，以及 `/opt/homebrew/bin`、`/usr/local/bin`、`/opt/local/bin`、`/usr/bin`、`/bin` 下的 zsh / bash / fish / sh / Nushell / PowerShell 7 / ksh / tcsh |
| Linux | `$SHELL`、`/etc/shells`，以及 `/usr/local/bin`、`/usr/bin`、`/bin`、`/snap/bin`、`/run/current-system/sw/bin` 下的 bash / zsh / fish / sh / Nushell / PowerShell 7 / ksh / tcsh |

找不到的类型进 `missingShells`：界面显示在「未安装」区块（带一句它是什么），工具输出里是 `Not installed: …` 一行。设备本身（名称 · 架构 · 主机名 · 登录 shell）也由宿主探测后一并返回，所以**同一份配置在不同机器上会列出不同的类型**。

## 🧰 提供给 Agent 的工具

插件加载后会向 DSH 工具注册表注册以下工具（默认全局可见，`native` 与 `ptc` 预设下都能调用）：

| 工具 | 作用 |
|---|---|
| `terminal_shells` | 本机**实际可用**的 shell（带 `family` 类型与 `about` 说明）、默认 shell、默认工作目录，外加本机设备信息（`device`：名称 / 架构 / 主机名 / 登录 shell / 是否 WSL）与**未安装**的类型（`missingShells`）；调用前先看这个就知道能不能用 Git Bash |
| `terminal_list` | 当前所有终端：id、标题、shell、目录、状态、行列 |
| `terminal_create` | 新建终端，可指定 `shell` / `cwd`（支持 `~` 与相对路径）/ `title` / 尺寸，返回终端 id |
| `terminal_read` | 读某个终端的输出（自动去掉 ANSI 与 `\r` 重绘），**按 offset 增量读**，不消耗缓冲 |
| `terminal_write` | 往终端发原始按键：文本、`\u0003`（Ctrl+C）、`\u001b[A`（方向键）等 |
| `terminal_exec` | 在指定终端里**执行一条命令**并等它跑完，返回这段输出；交互式 shell 状态（cwd、变量、历史）在多次调用间保持 |
| `terminal_resize` | 改终端行列数 |
| `terminal_rename` | 给终端改名，用户和模型都能一眼分清 |
| `terminal_close` | 关闭终端（可顺带从面板列表移除） |

关于「等命令跑完」：PTY 没有 shell 集成协议，所以这是一个**启发式**，结果里的 `settled` 会说明依据 —— `idle`（子进程结束且不再输出）、`quiet`（只是安静了，长时间不打印的命令可能还在跑）、`exited`、`timeout`。超时**不会**杀掉命令，可以用 `terminal_read(offset=nextOffset)` 继续看，或用更大的 `idleMs` / `timeoutMs` 再等一次。

模型创建的终端和用户手动创建的终端**在同一个列表里**：模型跑的命令，你可以在面板上实时看到，也可以接着手动敲。

## ⚙️ 设置

点面板头部的 **⚙**（没有终端时也在）打开设置面板，两项设置：

| 设置 | 说明 |
|---|---|
| **默认终端类型** | 「自动」= 取**本机推荐顺序**里的第一个可用终端：Windows 是 `pwsh → powershell → cmd → Git Bash → WSL → Nushell → bash`，macOS / Linux 优先用设备的登录 shell（`$SHELL`）。也可以指定某个已安装的 shell。它同时决定面板「+ 新建终端」用哪个 shell，以及 Agent 调 `terminal_create` 且不指定 `shell` 时用哪个。原来指定的 shell 被卸载后会自动回退到「自动」，并在设置里提示 |
| **给 Agent 注入终端工具** | 打开：模型可以调用 9 个 `terminal_*` 工具；关闭：**立即**从工具注册表移除，下一次模型调用就看不到它们了（不需要重启，也不用改配置）。**正在运行的终端和已经创建的对话都不受影响**，随时可以再打开 |

设置保存在 `%DSH_HOME%\terminal-panel\settings.json`（默认 `~/.dsh/terminal-panel/settings.json`），写入失败时只对本次运行生效并在界面上提示。设置是宿主侧的状态，因此换了浏览器、重启 DSH 之后依然有效。

## 🧱 结构

```
dsh-plugin-terminal-panel/
├── host.js           # 宿主入口：承载路由 + 把工具注册交给 impl.js + 热重载外壳
├── impl.js           # 宿主实现：PTY 生命周期、shell 探测、SSE 推送、agent 工具定义
├── client.js         # 客户端：终端面板、侧栏图标、VT 引擎、新建终端菜单
├── cordis.patch.yml  # bundle 补丁：向 profile 插入插件行
└── package.json      # dsh.bundle.patch + dsh.client 声明
```

两侧如何协作：

```
侧栏图标 / 终端面板 (client.js)
        │  同源 HTTP（回环地址）
        ▼
GET  /system-terminals/api/stream?id=…   ← SSE：先回放缓冲，再推实时输出
POST /system-terminals/api/{list,shells,create,write,read,exec,resize,close,rename,remove}
        ▼
impl.js ── subprocess.spawnTerminal() ──► 真 PTY（node-pty / ConPTY）
        ▲
        └── ctx.tools.register(terminal_*) ──► Agent 工具（native / ptc 均可见）
```

设计上有意分成两个文件：**加载过的 ESM 模块会在宿主进程里被永久缓存**，所以 `host.js` 保持极简、把逻辑放进 `impl.js`，由 `host.js` 用带缓存参数的动态 `import()` 拉取 —— 这样替换 `impl.js` 后一次 `POST /__reload` 就能生效，无需重启 DSH。终端注册表与工具注册都放在 `impl.js` 侧：重载时会**接管**上一份注册（先注销旧工具再注册新的），既不会出现重名注册失败，也不会让已经开着的终端变成孤儿进程。

### 本地 API

路由前缀 `/system-terminals/api`，仅监听 DSH 自己的回环地址，无需登录态（与生态内其他插件的私有路由一致）。
**写操作（`POST`）必须带 `x-dsh-terminal: 1` 请求头**：跨站页面无法自定义请求头（预检不会被放行），因此在浏览器里打开的任意第三方页面都无法驱动你的终端——这也是 `POST /exec` 这种「直接执行命令」接口的安全底线。

| 方法 | 作用 |
|---|---|
| `GET /health` | 版本、平台、可用 shell、默认目录、PTY 可用性、工具注册状态（`host` 字段） |
| `GET /shells` | 探测本机 shell：`{platform, osKind, device, shells:[{id,label,family,about,path,args,source,default}], missing:[…], missingShells:[{id,label,family,about}], defaultShell, defaultCwd, sessions}`；`POST {refresh:true}` 强制重新探测 |
| `GET /settings` | 当前设置：`{defaultShell, effectiveShell, autoShell, toolsEnabled, toolsRegistered, settingsPath, shells…}` |
| `POST /settings` | `{defaultShell?: 已安装的 shell id 或 "auto", toolsEnabled?: boolean}` → 保存并立即生效 |
| `GET /list` | 终端列表（id、标题、shell、cwd、pid、行列、状态、是否可 resize） |
| `POST /create` | `{shell?, cwd?, title?, cols?, rows?}` → 新建终端 |
| `POST /write` | `{id, data}` → 写入 PTY（原始字节，UTF-8） |
| `POST /read` | `{id, offset?, maxChars?, lines?}` → 纯文本增量读取 |
| `POST /exec` | `{id, command, wait?, timeoutMs?, idleMs?, maxChars?, lines?}` → 执行并等待 |
| `POST /resize` | `{id, cols, rows}` |
| `POST /close` | `{id, remove?}` → 终止进程（`remove:true` 顺带从列表移除） |
| `POST /rename` | `{id, title}` → 改名（去空白、上限 60 字） |
| `POST /remove` | `{id}` → 从列表移除已退出的终端 |
| `GET /tools` | 当前会注册的 agent 工具清单（名称 / 描述 / 参数 schema） |
| `GET /stream?id=` | SSE：`history` / `data` / `status` / `exit` 事件，base64 负载 |
| `POST /__reload` | 开发用：重新加载 `impl.js`（含工具重注册） |

## 📝 更新记录

见 [CHANGELOG.md](CHANGELOG.md)（英文）。

## 📄 License

[MIT](LICENSE) © 2026 BaiZhi967
