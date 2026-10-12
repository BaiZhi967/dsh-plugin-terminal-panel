/**
 * terminal-dock — Client half.
 *
 * Adds an in-page terminal panel: a `sidebar.panellist` icon addresses a `main`
 * panel (the same mechanism the Conversation panel uses), where every open
 * terminal is a tab and the active one renders a live screen. The
 * `shell.overlay` dock in the left column is the management surface — the
 * "new terminal" action plus the terminal list.
 *
 * The screen is rendered by the small VT engine below (no xterm.js is available
 * to a plain-JS client module), fed by the PTY output the host streams over
 * Server-Sent Events.
 */
window.__ModuleLoader__.load({
  id: 'dsh-terminal-panel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-terminal-panel';
    const API = '/system-terminals/api';
    const PANEL_KEY = 'terminal-panel';
    const POLL_MS = 4000;
    const MAX_COLS = 400;
    const MAX_ROWS = 120;

    const DICTS = {
      zh: {
        title: '终端',
        newTerminal: '新建终端',
        empty: '还没有终端',
        emptyHint: '点击“新建终端”在面板里打开一个终端',
        running: '运行中',
        exited: '已退出',
        close: '关闭该终端',
        remove: '从列表移除',
        rename: '重命名',
        renameHint: '双击标签重命名，或点 ✎',
        selectMode: '选择文本（暂停键盘输入）',
        inputMode: '返回键盘输入',
        activeLabel: '活跃终端',
        hostMissing: '宿主插件未响应，请刷新页面后重试',
        options: '新建终端选项',
        shell: '终端类型',
        workingDir: '工作目录',
        workingDirPlaceholder: '留空 = 默认目录',
        defaultDir: '默认目录',
        create: '创建',
        cancel: '取消',
        redetect: '重新检测已安装的终端',
        noShell: '没有检测到可用的 shell',
        shellInstalled: '已安装',
        thisDevice: '本机设备',
        detectedOn: '以下类型由本机系统与设备检测得出，换一台机器会不一样',
        notInstalled: '未安装',
        notInstalledHint: '本机没有找到这些类型的可执行文件；装好后点“重新检测”即可选用',
        settings: '终端设置',
        settingsTitle: '终端设置',
        close: '关闭',
        defaultShell: '默认终端类型',
        defaultShellHint: '新建终端默认使用的 shell，Agent 不指定 shell 时也用它',
        autoShell: '自动（推荐）',
        autoShellHint: '自动 = 本机推荐顺序（上面列表的顺序）里的第一个可用终端',
        shellMissing: '原先设置的 shell 现在检测不到了，已临时回退到「自动」',
        injectTools: '给 Agent 注入终端工具',
        injectToolsHint: '开启后模型可以新建终端、执行命令、读取输出；关闭后模型立即看不到这些工具',
        toolsOn: '已注入 {n} 个工具',
        toolsOff: '未注入：模型无法使用终端工具',
        toolsExisting: '正在运行的终端和已创建的对话都不受影响，随时可以再打开',
        settingsSaved: '已保存',
        settingsPath: '设置文件',
        notPersistent: '（无法写入磁盘，仅本次运行有效）',
        pickIsDefault: '选中即设为默认',
        autoShellShort: '自动',
      },
      en: {
        title: 'Terminals',
        newTerminal: 'New Terminal',
        empty: 'No terminals yet',
        emptyHint: 'Use “New Terminal” to open one in this panel',
        running: 'Running',
        exited: 'Exited',
        close: 'Close this terminal',
        remove: 'Remove from list',
        rename: 'Rename',
        renameHint: 'Double-click the tab to rename, or use ✎',
        selectMode: 'Select text (keyboard paused)',
        inputMode: 'Back to keyboard input',
        activeLabel: 'Active terminals',
        hostMissing: 'The host plugin did not respond: reload the page and try again',
        options: 'New terminal options',
        shell: 'Shell type',
        workingDir: 'Working directory',
        workingDirPlaceholder: 'Empty = default directory',
        defaultDir: 'Default directory',
        create: 'Create',
        cancel: 'Cancel',
        redetect: 'Re-detect installed shells',
        noShell: 'No usable shell was detected',
        shellInstalled: 'installed',
        thisDevice: 'This device',
        detectedOn: 'These types come from this device; another machine will list different ones',
        notInstalled: 'Not installed',
        notInstalledHint: 'No executable for these types was found here; install one and hit “Re-detect” to use it',
        settings: 'Terminal settings',
        settingsTitle: 'Terminal settings',
        close: 'Close',
        defaultShell: 'Default shell',
        defaultShellHint: 'Used by “New Terminal”, and by the agent when terminal_create omits shell',
        autoShell: 'Automatic (recommended)',
        autoShellHint: 'Automatic = the first available shell for this device, in the order listed above',
        shellMissing: 'The configured shell is no longer detected; falling back to Automatic',
        injectTools: 'Inject terminal tools into the agent',
        injectToolsHint: 'While on, the model can open terminals, run commands and read output; turning it off hides them immediately',
        toolsOn: '{n} tools injected',
        toolsOff: 'Not injected: the model cannot use the terminal tools',
        toolsExisting: 'Running terminals and existing conversations are unaffected; turn it back on any time',
        settingsSaved: 'Saved',
        settingsPath: 'Settings file',
        notPersistent: '(cannot write to disk; this run only)',
        pickIsDefault: 'Picking one makes it the default',
        autoShellShort: 'auto',
      },
    };

    const runtime = {
      t: (key) => (DICTS.en[key] !== undefined ? DICTS.en[key] : key),
      ctx: null,
      locale: null,
      scheme: 'dark',
    };

    /** Size the next terminal is allocated with, measured from the panel. */
    let panelSize = { cols: 100, rows: 28 };

    // ------------------------------------------------------------------ api

    async function api(method, payload) {
      const init = { method: 'GET', credentials: 'same-origin' };
      if (payload !== undefined) {
        init.method = 'POST';
        // The host requires this on every mutating route: a cross-origin page
        // cannot set a custom header without a preflight the host never grants.
        init.headers = { 'content-type': 'application/json', 'x-dsh-terminal': '1' };
        init.body = JSON.stringify(payload);
      }
      let response;
      try {
        response = await fetch(API + '/' + method, init);
      } catch (err) {
        throw new Error(runtime.t('hostMissing'));
      }
      let parsed = null;
      try {
        parsed = await response.json();
      } catch (err) {
        parsed = null;
      }
      if (!parsed || parsed.ok !== true) {
        const message = (parsed && parsed.error && parsed.error.message) || 'HTTP ' + response.status;
        throw new Error(message);
      }
      return parsed.value;
    }

    function messageOf(error) {
      return error && error.message ? error.message : String(error);
    }

    // ---------------------------------------------------------------- store

    const store = {
      snapshot: {
        items: [],
        activeId: null,
        error: null,
        notice: null,
        cwd: null,
        home: null,
        shells: [],
        defaultShell: null,
        device: null,
        osKind: null,
        missingShells: [],
        settings: null,
        settingsOpen: false,
        settingsBusy: false,
        settingsNotice: null,
        settingsError: false,
        ready: false,
        selectMode: false,
        scheme: 'dark',
      },
      listeners: new Set(),
      subscribe: (fn) => {
        store.listeners.add(fn);
        return () => {
          store.listeners.delete(fn);
        };
      },
      getSnapshot: () => store.snapshot,
      patch(next) {
        store.snapshot = Object.assign({}, store.snapshot, next);
        for (const fn of Array.from(store.listeners)) fn();
      },
    };

    function useStore() {
      return React.useSyncExternalStore(store.subscribe, store.getSnapshot);
    }

    async function refresh() {
      if (runtime.syncScheme) runtime.syncScheme();
      try {
        const value = await api('list');
        const items = value && Array.isArray(value.items) ? value.items : [];
        let activeId = store.snapshot.activeId;
        if (!activeId || !items.some((item) => item.id === activeId)) {
          const running = items.find((item) => item.status === 'running');
          activeId = running ? running.id : items.length ? items[0].id : null;
        }
        store.patch({
          items,
          activeId,
          cwd: (value && value.cwd) || null,
          home: (value && value.home) || null,
          defaultShell: (value && value.defaultShell) || null,
          error: null,
          ready: true,
        });
      } catch (error) {
        store.patch({ error: messageOf(error), ready: true });
      }
    }

    /** Which shells this machine can actually run, detected by the host. */
    let shellRequest = 0;
    async function refreshShells(force) {
      const ticket = (shellRequest += 1);
      try {
        const value = await api('shells', force ? { refresh: true } : undefined);
        // A slower earlier response must not overwrite a fresher list.
        if (ticket !== shellRequest) return value;
        const missing = value && Array.isArray(value.missingShells) && value.missingShells.length
          ? value.missingShells
          : value && Array.isArray(value.missing)
            ? value.missing.map((id) => ({ id }))
            : [];
        store.patch({
          shells: value && Array.isArray(value.shells) ? value.shells : [],
          missingShells: missing,
          device: (value && value.device) || store.snapshot.device,
          osKind: (value && value.osKind) || store.snapshot.osKind,
          defaultShell: (value && value.defaultShell) || store.snapshot.defaultShell,
          cwd: (value && value.defaultCwd) || store.snapshot.cwd,
          home: (value && value.home) || store.snapshot.home,
        });
        return value;
      } catch (error) {
        if (ticket === shellRequest) store.patch({ notice: messageOf(error) });
        return null;
      }
    }

    /** The effective default shell: the setting, or whatever the host picks. */
    function chosenShell(state) {
      const settings = state.settings || {};
      const shells = (settings.shells && settings.shells.length ? settings.shells : state.shells) || [];
      const wanted = settings.defaultShell || settings.effectiveShell || state.defaultShell;
      return shells.find((item) => item.id === wanted) || shells[0] || null;
    }

    /*
     * Shell families exist so a list that mixes the PowerShell pair, cmd, Git
     * Bash and one entry per WSL distribution still reads as "types you can
     * pick" instead of an undifferentiated pile. The host returns shells in
     * device-preference order, so grouping only names the groups; it never
     * reorders them.
     */
    const FAMILY_NAMES = {
      powershell: 'PowerShell',
      windows: 'Windows',
      wsl: 'WSL',
      bash: 'Bash',
      zsh: 'Zsh',
      fish: 'Fish',
      nu: 'Nushell',
      posix: 'POSIX',
      ksh: 'Korn',
      csh: 'C shell',
    };

    function familyName(family) {
      return FAMILY_NAMES[family] || family || runtime.t('shell');
    }

    /** Split an ordered shell list into family groups, keeping the given order. */
    function groupShells(shells) {
      const groups = [];
      const index = new Map();
      for (const shell of shells || []) {
        const family = shell.family || 'other';
        let group = index.get(family);
        if (!group) {
          group = { family, items: [] };
          index.set(family, group);
          groups.push(group);
        }
        group.items.push(shell);
      }
      return groups;
    }

    /** "Windows (build 26200) · x64 · PCW2400198", or '' when the host has not said. */
    function deviceSummary(state) {
      const device = state.device || (state.settings && state.settings.device) || null;
      if (!device) return '';
      const parts = [device.name || device.platform || ''];
      if (device.arch) parts.push(device.arch);
      if (device.hostname) parts.push(device.hostname);
      return parts.filter(Boolean).join(' · ');
    }

    async function refreshSettings() {
      try {
        const value = await api('settings');
        store.patch({ settings: value });
        return value;
      } catch (error) {
        store.patch({ settingsError: true, settingsNotice: messageOf(error) });
        return null;
      }
    }

    /** Persist one settings patch and apply it to the live host. */
    async function saveSettings(patch) {
      store.patch({ settingsBusy: true, settingsNotice: null, settingsError: false });
      try {
        const value = await api('settings', patch);
        store.patch({ settings: value, settingsBusy: false, settingsNotice: runtime.t('settingsSaved'), settingsError: false });
        await refresh();
        return true;
      } catch (error) {
        store.patch({ settingsBusy: false, settingsNotice: messageOf(error), settingsError: true });
        return false;
      }
    }

    function selectPanel() {
      const layout = runtime.ctx && runtime.ctx.get ? runtime.ctx.get('layout') : null;
      if (layout && typeof layout.selectPanel === 'function') {
        try {
          layout.selectPanel(PANEL_KEY);
        } catch (err) {
          /* the shell may not accept an unknown panel id; the icon still works */
        }
      }
    }

    async function createTerminal(options) {
      store.patch({ notice: null });
      const choice = options || {};
      try {
        const payload = { cols: panelSize.cols, rows: panelSize.rows };
        if (choice.shell) payload.shell = choice.shell;
        if (choice.cwd && choice.cwd.trim()) payload.cwd = choice.cwd.trim();
        const value = await api('create', payload);
        await refresh();
        if (value && value.item) store.patch({ activeId: value.item.id });
        selectPanel();
        return true;
      } catch (error) {
        store.patch({ notice: messageOf(error) });
        return false;
      }
    }

    async function closeTerminal(id) {
      store.patch({ notice: null });
      try {
        await api('close', { id });
      } catch (error) {
        store.patch({ notice: messageOf(error) });
      }
      await refresh();
    }

    async function removeTerminal(id) {
      store.patch({ notice: null });
      try {
        await api('remove', { id });
      } catch (error) {
        store.patch({ notice: messageOf(error) });
      }
      await refresh();
    }

    async function renameTerminal(id, title) {
      store.patch({ notice: null });
      try {
        await api('rename', { id, title });
      } catch (error) {
        store.patch({ notice: messageOf(error) });
      }
      await refresh();
    }

    function writeData(id, data) {
      if (!data) return;
      api('write', { id, data }).catch(() => undefined);
    }

    // ------------------------------------------------------------ VT engine

    const ATTR_BOLD = 1;
    const ATTR_DIM = 2;
    const ATTR_ITALIC = 4;
    const ATTR_UNDERLINE = 8;
    const ATTR_INVERSE = 16;
    const ATTR_STRIKE = 32;

    /**
     * Two ANSI palettes. The light one is not the dark one on a white sheet:
     * SGR 37 ("white") and 93 ("bright yellow") must stay readable on a light
     * background, so they map to dark grey / dark yellow there.
     */
    const PALETTES = {
      dark: [
        '#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
        '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
      ],
      light: [
        '#000000', '#cd3131', '#00bc00', '#949800', '#0451a5', '#bc05bc', '#0598bc', '#555555',
        '#666666', '#cd3131', '#14ce14', '#b5ba00', '#0451a5', '#bc05bc', '#0598bc', '#a5a5a5',
      ],
    };

    function palette() {
      return runtime.scheme === 'light' ? PALETTES.light : PALETTES.dark;
    }

    function createScreen(cols, rows) {
      const screen = {
        cols,
        rows,
        lines: [],
        x: 0,
        y: 0,
        savedX: 0,
        savedY: 0,
        fg: null,
        bg: null,
        attr: 0,
        top: 0,
        bottom: rows - 1,
        cursorVisible: true,
        dirty: true,
        alt: null,
      };
      blank(screen);
      return screen;
    }

    function blank(screen) {
      screen.lines = [];
      for (let y = 0; y < screen.rows; y += 1) screen.lines.push(new Array(screen.cols).fill(null));
    }

    /** Keep the overlapping region when the grid is rebuilt at another size. */
    function adoptScreen(previous, next) {
      for (let y = 0; y < Math.min(previous.rows, next.rows); y += 1) {
        for (let x = 0; x < Math.min(previous.cols, next.cols); x += 1) {
          next.lines[y][x] = previous.lines[y][x];
        }
      }
      next.x = Math.min(previous.x, next.cols - 1);
      next.y = Math.min(previous.y, next.rows - 1);
      next.fg = previous.fg;
      next.bg = previous.bg;
      next.attr = previous.attr;
    }

    function cellAt(screen, x, y) {
      const line = screen.lines[y];
      return line ? line[x] : null;
    }

    function writeCell(screen, x, y, ch, wide) {
      const line = screen.lines[y];
      if (!line || x < 0 || x >= screen.cols) return;
      line[x] = { ch, fg: screen.fg, bg: screen.bg, a: screen.attr };
      if (wide && x + 1 < screen.cols) line[x + 1] = { ch: '', fg: screen.fg, bg: screen.bg, a: screen.attr, wide: true };
    }

    function scrollUp(screen, top, bottom, count) {
      for (let n = 0; n < count; n += 1) {
        screen.lines.splice(top, 1);
        screen.lines.splice(bottom, 0, new Array(screen.cols).fill(null));
      }
    }

    function scrollDown(screen, top, bottom, count) {
      for (let n = 0; n < count; n += 1) {
        screen.lines.splice(bottom, 1);
        screen.lines.splice(top, 0, new Array(screen.cols).fill(null));
      }
    }

    function index(screen) {
      if (screen.y === screen.bottom) scrollUp(screen, screen.top, screen.bottom, 1);
      else if (screen.y < screen.rows - 1) screen.y += 1;
    }

    function isWide(cp) {
      return (
        (cp >= 0x1100 && cp <= 0x115f) ||
        (cp >= 0x2e80 && cp <= 0x303e) ||
        (cp >= 0x3041 && cp <= 0x33ff) ||
        (cp >= 0x3400 && cp <= 0x4dbf) ||
        (cp >= 0x4e00 && cp <= 0x9fff) ||
        (cp >= 0xa000 && cp <= 0xa4cf) ||
        (cp >= 0xac00 && cp <= 0xd7a3) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xfe30 && cp <= 0xfe6f) ||
        (cp >= 0xff00 && cp <= 0xff60) ||
        (cp >= 0xffe0 && cp <= 0xffe6) ||
        (cp >= 0x1f300 && cp <= 0x1f9ff) ||
        (cp >= 0x20000 && cp <= 0x3fffd)
      );
    }

    function put(screen, ch, cp) {
      const wide = isWide(cp);
      if (screen.x >= screen.cols) {
        screen.x = 0;
        index(screen);
      }
      if (wide && screen.x === screen.cols - 1) {
        screen.x = 0;
        index(screen);
      }
      writeCell(screen, screen.x, screen.y, ch, wide);
      screen.x += wide ? 2 : 1;
    }

    function applySgr(screen, params) {
      const list = params.length ? params : [0];
      for (let i = 0; i < list.length; i += 1) {
        const code = list[i];
        if (code === 0) {
          screen.fg = null;
          screen.bg = null;
          screen.attr = 0;
        } else if (code === 1) screen.attr |= ATTR_BOLD;
        else if (code === 2) screen.attr |= ATTR_DIM;
        else if (code === 3) screen.attr |= ATTR_ITALIC;
        else if (code === 4) screen.attr |= ATTR_UNDERLINE;
        else if (code === 7) screen.attr |= ATTR_INVERSE;
        else if (code === 9) screen.attr |= ATTR_STRIKE;
        else if (code === 22) screen.attr &= ~(ATTR_BOLD | ATTR_DIM);
        else if (code === 23) screen.attr &= ~ATTR_ITALIC;
        else if (code === 24) screen.attr &= ~ATTR_UNDERLINE;
        else if (code === 27) screen.attr &= ~ATTR_INVERSE;
        else if (code === 29) screen.attr &= ~ATTR_STRIKE;
        else if (code >= 30 && code <= 37) screen.fg = code - 30;
        else if (code === 39) screen.fg = null;
        else if (code >= 40 && code <= 47) screen.bg = code - 40;
        else if (code === 49) screen.bg = null;
        else if (code >= 90 && code <= 97) screen.fg = code - 90 + 8;
        else if (code >= 100 && code <= 107) screen.bg = code - 100 + 8;
        else if (code === 38 || code === 48) {
          const target = code === 38 ? 'fg' : 'bg';
          const mode = list[i + 1];
          if (mode === 5) {
            screen[target] = list[i + 2];
            i += 2;
          } else if (mode === 2) {
            const r = clamp255(list[i + 2]);
            const g = clamp255(list[i + 3]);
            const b = clamp255(list[i + 4]);
            screen[target] = '#' + hex(r) + hex(g) + hex(b);
            i += 4;
          }
        }
      }
    }

    function clamp255(value) {
      const number = typeof value === 'number' ? value : 0;
      return Math.max(0, Math.min(255, Math.round(number)));
    }

    function hex(value) {
      const text = clamp255(value).toString(16);
      return text.length === 1 ? '0' + text : text;
    }

    function eraseInLine(screen, mode) {
      const line = screen.lines[screen.y];
      if (!line) return;
      const from = mode === 0 ? screen.x : 0;
      const to = mode === 1 ? screen.x + 1 : screen.cols;
      for (let x = from; x < to; x += 1) line[x] = null;
    }

    function eraseInDisplay(screen, mode) {
      if (mode === 0 || mode === 2 || mode === 3) {
        const startY = mode === 0 ? screen.y : 0;
        const line = screen.lines[screen.y];
        if (mode === 0 && line) for (let x = screen.x; x < screen.cols; x += 1) line[x] = null;
        for (let y = startY + (mode === 0 ? 1 : 0); y < screen.rows; y += 1) {
          screen.lines[y] = new Array(screen.cols).fill(null);
        }
      }
      if (mode === 1) {
        for (let y = 0; y < screen.y; y += 1) screen.lines[y] = new Array(screen.cols).fill(null);
        const line = screen.lines[screen.y];
        if (line) for (let x = 0; x <= screen.x && x < screen.cols; x += 1) line[x] = null;
      }
      if (mode === 2 || mode === 3) {
        for (let y = 0; y < screen.rows; y += 1) screen.lines[y] = new Array(screen.cols).fill(null);
      }
    }

    function switchAlt(screen, on) {
      if (on) {
        if (screen.alt) return;
        screen.alt = { lines: screen.lines, x: screen.x, y: screen.y };
        blank(screen);
        screen.x = 0;
        screen.y = 0;
        screen.top = 0;
        screen.bottom = screen.rows - 1;
      } else if (screen.alt) {
        screen.lines = screen.alt.lines;
        screen.x = screen.alt.x;
        screen.y = screen.alt.y;
        screen.alt = null;
        screen.top = 0;
        screen.bottom = screen.rows - 1;
      }
    }

    function escapeAt(screen, text, start) {
      const next = text[start + 1];
      if (next === undefined) return text.length;
      if (next === '[') {
        let i = start + 2;
        let body = '';
        while (i < text.length && !/[@-~]/.test(text[i])) {
          body += text[i];
          i += 1;
        }
        const final = text[i];
        if (final !== undefined) csi(screen, body, final);
        return i + 1;
      }
      if (next === ']') {
        let i = start + 2;
        while (i < text.length) {
          if (text[i] === '\x07') return i + 1;
          if (text[i] === '\x1b' && text[i + 1] === '\\') return i + 2;
          i += 1;
        }
        return i;
      }
      if (next === '7') {
        screen.savedX = screen.x;
        screen.savedY = screen.y;
        return start + 2;
      }
      if (next === '8') {
        screen.x = screen.savedX;
        screen.y = screen.savedY;
        return start + 2;
      }
      if (next === 'c') {
        screen.fg = null;
        screen.bg = null;
        screen.attr = 0;
        blank(screen);
        screen.x = 0;
        screen.y = 0;
        return start + 2;
      }
      if (next === '(' || next === ')' || next === '*' || next === '+') return start + 3;
      if (next === '=' || next === '>' || next === 'M' || next === 'D' || next === 'E' || next === 'H') return start + 2;
      return start + 2;
    }

    function paramsOf(body) {
      const clean = body.replace(/^[?>!]+/, '');
      if (!clean) return [];
      return clean.split(';').map((part) => {
        const value = Number.parseInt(part, 10);
        return Number.isFinite(value) ? value : 0;
      });
    }

    function csi(screen, body, final) {
      const privateMode = body[0] === '?';
      const params = paramsOf(body);
      const first = params.length ? params[0] : 0;
      const amount = first === 0 ? 1 : first;
      switch (final) {
        case 'A':
          screen.y = Math.max(screen.top, screen.y - amount);
          break;
        case 'B':
          screen.y = Math.min(screen.bottom, screen.y + amount);
          break;
        case 'C':
          screen.x = Math.min(screen.cols - 1, screen.x + amount);
          break;
        case 'D':
          screen.x = Math.max(0, screen.x - amount);
          break;
        case 'E':
          screen.x = 0;
          screen.y = Math.min(screen.bottom, screen.y + amount);
          break;
        case 'F':
          screen.x = 0;
          screen.y = Math.max(screen.top, screen.y - amount);
          break;
        case 'G':
          screen.x = Math.max(0, Math.min(screen.cols - 1, (first || 1) - 1));
          break;
        case 'd':
          screen.y = Math.max(0, Math.min(screen.rows - 1, (first || 1) - 1));
          break;
        case 'H':
        case 'f': {
          const row = params.length > 0 && params[0] ? params[0] : 1;
          const col = params.length > 1 && params[1] ? params[1] : 1;
          screen.y = Math.max(0, Math.min(screen.rows - 1, row - 1));
          screen.x = Math.max(0, Math.min(screen.cols - 1, col - 1));
          break;
        }
        case 'J':
          eraseInDisplay(screen, first);
          break;
        case 'K':
          eraseInLine(screen, first);
          break;
        case 'L':
          if (screen.y >= screen.top && screen.y <= screen.bottom) scrollDown(screen, screen.y, screen.bottom, amount);
          break;
        case 'M':
          if (screen.y >= screen.top && screen.y <= screen.bottom) scrollUp(screen, screen.y, screen.bottom, amount);
          break;
        case 'P': {
          const line = screen.lines[screen.y];
          if (line) {
            line.splice(screen.x, amount);
            while (line.length < screen.cols) line.push(null);
          }
          break;
        }
        case 'S':
          scrollUp(screen, screen.top, screen.bottom, amount);
          break;
        case 'T':
          scrollDown(screen, screen.top, screen.bottom, amount);
          break;
        case 'X': {
          const line = screen.lines[screen.y];
          if (line) for (let x = screen.x; x < Math.min(screen.cols, screen.x + amount); x += 1) line[x] = null;
          break;
        }
        case 'm':
          applySgr(screen, params);
          break;
        case 'n':
          break;
        case 'r':
          screen.top = params.length > 0 && params[0] ? params[0] - 1 : 0;
          screen.bottom = params.length > 1 && params[1] ? params[1] - 1 : screen.rows - 1;
          screen.top = Math.max(0, Math.min(screen.rows - 1, screen.top));
          screen.bottom = Math.max(screen.top, Math.min(screen.rows - 1, screen.bottom));
          screen.x = 0;
          screen.y = screen.top;
          break;
        case 's':
          screen.savedX = screen.x;
          screen.savedY = screen.y;
          break;
        case 'u':
          screen.x = screen.savedX;
          screen.y = screen.savedY;
          break;
        case 'h':
        case 'l':
          if (privateMode) {
            const on = final === 'h';
            for (const param of params) {
              if (param === 25) screen.cursorVisible = on;
              else if (param === 1049 || param === 47 || param === 1047) switchAlt(screen, on);
            }
          }
          break;
        default:
          break;
      }
    }

    function feed(screen, text) {
      if (!text) return;
      let i = 0;
      while (i < text.length) {
        const code = text.charCodeAt(i);
        if (code === 27) {
          i = escapeAt(screen, text, i);
          continue;
        }
        if (code === 13) {
          screen.x = 0;
          i += 1;
          continue;
        }
        if (code === 10 || code === 11 || code === 12) {
          index(screen);
          i += 1;
          continue;
        }
        if (code === 8) {
          if (screen.x > 0) screen.x -= 1;
          i += 1;
          continue;
        }
        if (code === 9) {
          screen.x = Math.min(screen.cols - 1, (Math.floor(screen.x / 8) + 1) * 8);
          i += 1;
          continue;
        }
        if (code < 32 || code === 127) {
          i += 1;
          continue;
        }
        const cp = text.codePointAt(i);
        const ch = String.fromCodePoint(cp);
        i += ch.length;
        put(screen, ch, cp);
      }
      screen.dirty = true;
    }

    const styleCache = new Map();

    function colorOf(value) {
      if (value === null || value === undefined) return null;
      if (typeof value === 'string') return value;
      if (value < 16) return palette()[value];
      if (value < 232) {
        const n = value - 16;
        const steps = [0, 95, 135, 175, 215, 255];
        const r = steps[Math.floor(n / 36) % 6];
        const g = steps[Math.floor(n / 6) % 6];
        const b = steps[n % 6];
        return '#' + hex(r) + hex(g) + hex(b);
      }
      const level = 8 + (value - 232) * 10;
      return '#' + hex(level) + hex(level) + hex(level);
    }

    function cellKey(cell) {
      if (!cell) return 'd';
      return String(cell.fg) + '/' + String(cell.bg) + '/' + cell.a;
    }

    function cellStyle(cell) {
      const key = cellKey(cell) + '@' + runtime.scheme;
      const cached = styleCache.get(key);
      if (cached !== undefined) return cached;
      const style = {};
      if (!cell) {
        styleCache.set(key, style);
        return style;
      }
      let fg = colorOf(cell.fg);
      let bg = colorOf(cell.bg);
      if (cell.a & ATTR_INVERSE) {
        const swap = fg;
        fg = bg || 'var(--dt-fg)';
        bg = swap || 'var(--dt-bg)';
      }
      if (cell.a & ATTR_BOLD) style.fontWeight = 600;
      if (cell.a & ATTR_DIM) style.opacity = 0.65;
      if (cell.a & ATTR_ITALIC) style.fontStyle = 'italic';
      if (cell.a & ATTR_UNDERLINE) style.textDecoration = 'underline';
      if (cell.a & ATTR_STRIKE) style.textDecoration = 'line-through';
      if (fg) style.color = fg;
      if (bg) style.backgroundColor = bg;
      styleCache.set(key, style);
      return style;
    }

    /** Split one row into styled runs, splitting again at the cursor cell. */
    function runsFor(screen, y) {
      const line = screen.lines[y] || [];
      const cursorHere = screen.cursorVisible && screen.y === y;
      const runs = [];
      let current = null;
      for (let x = 0; x < screen.cols; x += 1) {
        const cell = line[x];
        const isCursor = cursorHere && x === screen.x;
        const key = cellKey(cell) + (isCursor ? '+' : '');
        const text = cell ? cell.ch : ' ';
        if (!current || current.key !== key) {
          current = { key, text, cell: cell || null, cursor: isCursor };
          runs.push(current);
        } else {
          current.text += text;
        }
      }
      while (runs.length) {
        const last = runs[runs.length - 1];
        if (!last.cursor && last.key === 'd' && /^ +$/.test(last.text)) runs.pop();
        else break;
      }
      return runs;
    }

    function measurePanel(holder) {
      if (!holder) return;
      const probe = holder.parentElement ? holder.parentElement.querySelector('.dt-probe') : null;
      const target = probe || holder.querySelector('.dt-probe');
      const rect = target ? target.getBoundingClientRect() : null;
      const cellW = rect && rect.width ? rect.width / 20 : 7.8;
      const cellH = rect && rect.height ? rect.height / 2 : 17;
      const cols = Math.max(20, Math.min(MAX_COLS, Math.floor((holder.clientWidth - 20) / cellW)));
      const rows = Math.max(5, Math.min(MAX_ROWS, Math.floor((holder.clientHeight - 34) / cellH)));
      panelSize = { cols, rows };
    }

    function decodeBase64(text) {
      const binary = atob(text);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder('utf-8').decode(bytes);
    }

    function keyToData(event) {
      const key = event.key;
      if (event.ctrlKey && !event.altKey && !event.metaKey && key.length === 1) {
        if (key === ' ') return '\x00';
        const upper = key.toUpperCase();
        const code = upper.charCodeAt(0);
        if (code >= 65 && code <= 90) return String.fromCharCode(code - 64);
        if (key === '[') return '\x1b';
        if (key === '\\') return '\x1c';
        if (key === ']') return '\x1d';
        if (key === '^') return '\x1e';
        if (key === '_') return '\x1f';
        return null;
      }
      if (event.metaKey) return null;
      if (event.altKey && key.length === 1) return '\x1b' + key;
      switch (key) {
        case 'Enter':
          return '\r';
        case 'Backspace':
          return '\x7f';
        case 'Tab':
          return '\t';
        case 'Escape':
          return '\x1b';
        case 'ArrowUp':
          return '\x1b[A';
        case 'ArrowDown':
          return '\x1b[B';
        case 'ArrowRight':
          return '\x1b[C';
        case 'ArrowLeft':
          return '\x1b[D';
        case 'Home':
          return '\x1b[H';
        case 'End':
          return '\x1b[F';
        case 'PageUp':
          return '\x1b[5~';
        case 'PageDown':
          return '\x1b[6~';
        case 'Insert':
          return '\x1b[2~';
        case 'Delete':
          return '\x1b[3~';
        default:
          return null;
      }
    }

    // ----------------------------------------------------------- components

    function TerminalView({ item, select }) {
      const holderRef = React.useRef(null);
      const inputRef = React.useRef(null);
      const screenRef = React.useRef(null);
      const frameRef = React.useRef(0);
      const [, setFrame] = React.useState(0);

      const cols = item.cols || 100;
      const rows = item.rows || 28;
      if (!screenRef.current || screenRef.current.cols !== cols || screenRef.current.rows !== rows) {
        const previous = screenRef.current;
        const next = createScreen(cols, rows);
        if (previous) adoptScreen(previous, next);
        screenRef.current = next;
      }
      const screen = screenRef.current;

      const scheduleFrame = React.useCallback(() => {
        if (frameRef.current) return;
        frameRef.current = window.requestAnimationFrame(() => {
          frameRef.current = 0;
          setFrame((value) => value + 1);
        });
      }, []);

      React.useEffect(() => {
        const source = new EventSource(API + '/stream?id=' + encodeURIComponent(item.id));
        const onData = (event) => {
          feed(screenRef.current, decodeBase64(event.data));
          scheduleFrame();
        };
        const onStatus = () => scheduleFrame();
        source.addEventListener('data', onData);
        source.addEventListener('history', onData);
        source.addEventListener('status', onStatus);
        source.addEventListener('exit', onStatus);
        return () => source.close();
      }, [item.id, scheduleFrame]);

      React.useEffect(() => {
        const holder = holderRef.current;
        if (!holder) return undefined;
        if (inputRef.current) inputRef.current.focus({ preventScroll: true });
        measurePanel(holder);
        let lastSent = 0;
        const observer = new ResizeObserver(() => {
          if (!holder.clientWidth || holder.clientWidth < 80 || holder.clientHeight < 60) return;
          measurePanel(holder);
          const screenNow = screenRef.current;
          if (!item.resizable || !screenNow) return;
          if (panelSize.cols === screenNow.cols && panelSize.rows === screenNow.rows) return;
          const now = Date.now();
          if (now - lastSent < 350) return;
          lastSent = now;
          const next = createScreen(panelSize.cols, panelSize.rows);
          adoptScreen(screenNow, next);
          screenRef.current = next;
          scheduleFrame();
          api('resize', { id: item.id, cols: panelSize.cols, rows: panelSize.rows }).catch(() => undefined);
        });
        observer.observe(holder);
        return () => observer.disconnect();
      }, [item.id, item.resizable, scheduleFrame]);

      const focus = React.useCallback(() => {
        if (inputRef.current) inputRef.current.focus({ preventScroll: true });
      }, []);

      const send = React.useCallback(
        (data) => {
          writeData(item.id, data);
        },
        [item.id],
      );

      const onKeyDown = (event) => {
        const data = keyToData(event);
        if (data !== null) {
          event.preventDefault();
          send(data);
        }
      };

      const onInput = (event) => {
        const value = event.target.value;
        if (value) {
          send(value);
          event.target.value = '';
        }
      };

      const onPaste = (event) => {
        const text = event.clipboardData ? event.clipboardData.getData('text') : '';
        if (text) {
          event.preventDefault();
          send(text);
        }
      };

      const rowNodes = [];
      for (let y = 0; y < screen.rows; y += 1) {
        const runs = runsFor(screen, y);
        rowNodes.push(
          h(
            'div',
            { className: 'dt-row', key: y },
            runs.map((run, index) =>
              h(
                'span',
                { key: index, className: run.cursor ? 'dt-cursor' : undefined, style: cellStyle(run.cell) },
                run.text,
              ),
            ),
          ),
        );
      }

      return h(
        'div',
        { className: select ? 'dt-view plain' : 'dt-view', ref: holderRef, onMouseDown: select ? undefined : focus },
        h('div', { className: 'dt-screen', style: { width: screen.cols + 'ch' } }, rowNodes),
        h('textarea', {
          className: select ? 'dt-input off' : 'dt-input',
          ref: inputRef,
          spellCheck: false,
          autoCapitalize: 'off',
          autoCorrect: 'off',
          autoComplete: 'off',
          onKeyDown,
          onInput,
          onPaste,
        }),
      );
    }

    function TerminalTab({ item, active }) {
      const t = runtime.t;
      const [editing, setEditing] = React.useState(false);
      const [draft, setDraft] = React.useState(item.title);
      const inputRef = React.useRef(null);

      React.useEffect(() => {
        if (editing && inputRef.current) {
          inputRef.current.focus();
          inputRef.current.select();
        }
      }, [editing]);

      const startEditing = () => {
        setDraft(item.title);
        setEditing(true);
      };

      const commit = () => {
        setEditing(false);
        const next = draft.trim();
        if (next && next !== item.title) renameTerminal(item.id, next);
      };

      if (editing) {
        return h(
          'div',
          { className: active ? 'dt-tab on' : 'dt-tab' },
          h('span', { className: item.status === 'running' ? 'dt-dot on' : 'dt-dot' }),
          h('input', {
            className: 'dt-tab-input',
            ref: inputRef,
            value: draft,
            spellCheck: false,
            onChange: (event) => setDraft(event.target.value),
            onBlur: commit,
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commit();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                setEditing(false);
              }
            },
          }),
        );
      }

      return h(
        'div',
        {
          className: active ? 'dt-tab on' : 'dt-tab',
          onClick: () => store.patch({ activeId: item.id, settingsOpen: false }),
          onDoubleClick: startEditing,
          title:
            (item.shellLabel ? item.shellLabel + ' — ' : '') + (item.cwd ? item.cwd + ' — ' : '') + t('renameHint'),
        },
        h('span', { className: item.status === 'running' ? 'dt-dot on' : 'dt-dot' }),
        h('span', { className: 'dt-tab-name' }, item.title),
        h(
          'button',
          {
            type: 'button',
            className: 'dt-tab-x',
            title: t('rename'),
            onClick: (event) => {
              event.stopPropagation();
              startEditing();
            },
          },
          '✎',
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dt-tab-x',
            title: item.status === 'running' ? t('close') : t('remove'),
            onClick: (event) => {
              event.stopPropagation();
              if (item.status === 'running') closeTerminal(item.id);
              else removeTerminal(item.id);
            },
          },
          '✕',
        ),
      );
    }

    /**
     * "New Terminal" plus its options: which installed shell to run and which
     * directory to start in (empty = the host default, i.e. the user home
     * directory a shell opened by the OS would use). The shell choice is
     * remembered; only shells the host actually resolved are offered.
     */
    function NewTerminalButton({ state, variant }) {
      const t = runtime.t;
      const [open, setOpen] = React.useState(false);
      const [pos, setPos] = React.useState(null);
      const [cwd, setCwd] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const holderRef = React.useRef(null);

      const shells = state.shells || [];
      const chosen = chosenShell(state);
      const groups = groupShells(shells);
      const missing = state.missingShells || [];
      const device = deviceSummary(state);

      React.useEffect(() => {
        if (!open) return undefined;
        const close = (event) => {
          const target = event.target;
          const inButton = !!(holderRef.current && holderRef.current.contains(target));
          const inMenu = !!(target && typeof target.closest === 'function' && target.closest('.dt-menu'));
          if (!inButton && !inMenu) setOpen(false);
        };
        const escape = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', close);
        document.addEventListener('keydown', escape);
        return () => {
          document.removeEventListener('mousedown', close);
          document.removeEventListener('keydown', escape);
        };
      }, [open]);

      React.useEffect(() => {
        if (open) refreshShells(false);
      }, [open]);

      React.useEffect(() => {
        if (state.settingsOpen) {
          refreshSettings();
          refreshShells(false);
        }
      }, [state.settingsOpen]);

      const quick = async () => {
        setBusy(true);
        const ok = await createTerminal({ shell: chosen ? chosen.id : undefined });
        setBusy(false);
        if (ok) setOpen(false);
      };

      const confirm = async () => {
        setBusy(true);
        const ok = await createTerminal({ shell: chosen ? chosen.id : undefined, cwd });
        setBusy(false);
        // Keep the menu open on failure so the path can be corrected.
        if (ok !== false) setOpen(false);
      };

      /** Picking a shell here changes the default too: one source of truth. */
      const pick = (id) => {
        const current = state.settings || {};
        store.patch({
          settings: { ...current, defaultShell: id === 'auto' ? '' : id, effectiveShell: id === 'auto' ? current.autoShell : id },
        });
        saveSettings({ defaultShell: id });
      };

      /*
       * The tab strip scrolls horizontally and the empty state is vertically
       * centred, so the menu is anchored to the viewport instead of the button.
       *
       * Two rules keep it honest:
       *  - it must never cover its own button. The space actually available
       *    below (or above) the anchor decides where it goes, and the menu is
       *    capped to that space and scrolls instead of overlapping.
       *  - it must follow the button. Layout around it keeps moving after the
       *    first commit (the panel settles, a notice appears, the shell list
       *    arrives, the page scrolls), so the position is recomputed on scroll,
       *    on resize, when any ancestor resizes, and on a slow timer as a
       *    safety net. A frame loop would be the obvious choice, but rAF is not
       *    guaranteed to keep ticking (hidden tabs, headless rendering), and a
       *    stale menu position is exactly the bug this prevents.
       */
      const menuRef = React.useRef(null);
      const metricsRef = React.useRef({ width: 300, height: 320 });
      const posRef = React.useRef(null);
      React.useLayoutEffect(() => {
        if (!open) {
          posRef.current = null;
          return undefined;
        }
        const menu = menuRef.current;
        if (menu) {
          // Measure the natural size once per open; the tracking below only reads.
          menu.style.maxHeight = 'none';
          metricsRef.current = { width: menu.offsetWidth || 300, height: menu.offsetHeight || 320 };
        }
        const place = () => {
          const holder = holderRef.current;
          if (!holder) return;
          const anchor = holder.getBoundingClientRect();
          const margin = 8;
          const gap = 6;
          const natural = metricsRef.current.height;
          const width = metricsRef.current.width;
          const below = anchor.bottom + gap;
          const spaceBelow = window.innerHeight - below - margin;
          const spaceAbove = anchor.top - gap - margin;
          let top = below;
          let limit = spaceBelow;
          if (!(spaceBelow >= Math.min(natural, 260) || spaceBelow >= spaceAbove)) {
            limit = Math.min(natural, spaceAbove);
            top = anchor.top - gap - limit;
          }
          const next = {
            top: Math.round(Math.max(margin, Math.min(top, window.innerHeight - margin - 60))),
            left: Math.round(Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin))),
            maxHeight: Math.max(140, Math.round(limit)),
          };
          const prev = posRef.current;
          if (
            !prev ||
            Math.abs(prev.top - next.top) > 0.5 ||
            Math.abs(prev.left - next.left) > 0.5 ||
            prev.maxHeight !== next.maxHeight
          ) {
            posRef.current = next;
            setPos(next);
          }
        };
        place();
        const timer = window.setInterval(place, 150);
        window.addEventListener('scroll', place, true);
        window.addEventListener('resize', place);
        let observer = null;
        if (typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(place);
          let node = holderRef.current;
          for (let depth = 0; node && depth < 4; depth += 1) {
            observer.observe(node);
            node = node.parentElement;
          }
        }
        return () => {
          window.clearInterval(timer);
          window.removeEventListener('scroll', place, true);
          window.removeEventListener('resize', place);
          if (observer) observer.disconnect();
        };
      }, [open, shells.length]);

      const toggle = () => setOpen(!open);

      /*
       * One segmented control: a single bordered, rounded shell holds the
       * primary action and the caret, with a hairline divider between them, so
       * the two halves read as one button instead of two glued boxes.
       */
      /*
       * The menu is a sibling of the button, never a child: a `filter` on an
       * ancestor makes that ancestor the containing block for fixed-position
       * descendants, and its `overflow: hidden` then clips them away. The
       * empty-state hero brightens on hover with exactly such a filter, which
       * hid the menu until the pointer left the button. Kept apart, the
       * viewport coordinates stay honest however the button is styled.
       */
      return h(
        React.Fragment,
        null,
        h(
          'span',
          {
            className:
              'dt-newbox' + (variant === 'empty' ? ' dt-newbox-primary' : '') + (open ? ' open' : '') + (busy ? ' busy' : ''),
            ref: holderRef,
          },
          h(
            'button',
            { type: 'button', className: 'dt-new-main', disabled: busy, onClick: quick, title: t('newTerminal') },
            h('span', { className: 'dt-new-plus', 'aria-hidden': true }, '+'),
            h('span', { className: 'dt-new-text' }, t('newTerminal')),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dt-new-caret',
              disabled: busy,
              title: t('options'),
              'aria-label': t('options'),
              'aria-expanded': open ? 'true' : 'false',
              onClick: toggle,
            },
            h(
              'svg',
              { width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': true, className: 'dt-caret-icon' },
              h('path', {
                d: 'M2 3.6 5 6.6 8 3.6',
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: 1.5,
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
              }),
            ),
          ),
        ),
        open
          ? h(
              'div',
              {
                className: 'dt-menu',
                ref: menuRef,
                style: pos
                  ? { position: 'fixed', top: pos.top, left: pos.left, maxHeight: pos.maxHeight }
                  : { position: 'fixed', visibility: 'hidden' },
              },
              h(
                'div',
                { className: 'dt-menu-head' },
                h('span', { className: 'dt-menu-title' }, t('shell')),
                device ? h('span', { className: 'dt-menu-note', title: device }, device) : null,
              ),
              shells.length
                ? h(
                    'div',
                    { className: 'dt-menu-list' },
                    groups.map((group) =>
                      h(
                        'div',
                        { key: group.family, className: 'dt-menu-group' },
                        h('div', { className: 'dt-menu-group-name' }, familyName(group.family)),
                        group.items.map((item) =>
                          h(
                            'label',
                            { key: item.id, className: 'dt-menu-item', title: item.path || '' },
                            h('input', {
                              type: 'radio',
                              name: 'dt-shell',
                              checked: Boolean(chosen && chosen.id === item.id),
                              onChange: () => pick(item.id),
                            }),
                            h(
                              'span',
                              { className: 'dt-menu-body' },
                              h('span', { className: 'dt-menu-name' }, item.label),
                              item.about ? h('span', { className: 'dt-menu-sub' }, item.about) : null,
                            ),
                            item.default ? h('span', { className: 'dt-menu-tag' }, '★') : null,
                          ),
                        ),
                      ),
                    ),
                  )
                : h('div', { className: 'dt-menu-hint' }, t('noShell')),
              h('div', { className: 'dt-menu-hint' }, t('pickIsDefault')),
              missing.length
                ? h(
                    'div',
                    { className: 'dt-menu-missing' },
                    h('span', { className: 'dt-menu-title' }, t('notInstalled')),
                    h(
                      'span',
                      { className: 'dt-menu-sub' },
                      missing.map((item) => item.label || item.id).join(' · '),
                    ),
                  )
                : null,
              h(
                'button',
                {
                  type: 'button',
                  className: 'dt-menu-link',
                  onClick: () => refreshShells(true),
                },
                '⟳ ' + t('redetect'),
              ),
              h('div', { className: 'dt-menu-title' }, t('workingDir')),
              h('input', {
                className: 'dt-menu-input',
                value: cwd,
                spellCheck: false,
                placeholder: t('workingDirPlaceholder'),
                onChange: (event) => setCwd(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    confirm();
                  }
                },
              }),
              h('div', { className: 'dt-menu-hint' }, t('defaultDir') + ': ' + (state.cwd || '—')),
              h(
                'div',
                { className: 'dt-menu-actions' },
                h('button', { type: 'button', className: 'dt-menu-btn', onClick: confirm, disabled: busy }, t('create')),
                h('button', { type: 'button', className: 'dt-menu-btn ghost', onClick: () => setOpen(false) }, t('cancel')),
              ),
            )
          : null,
      );
    }

    /** The gear that opens the settings view; always reachable, even when empty. */
    function SettingsButton({ state }) {
      const t = runtime.t;
      return h(
        'button',
        {
          type: 'button',
          className: state.settingsOpen ? 'dt-gear on' : 'dt-gear',
          title: t('settings'),
          'aria-label': t('settings'),
          'aria-pressed': state.settingsOpen ? 'true' : 'false',
          onClick: () => store.patch({ settingsOpen: !state.settingsOpen }),
        },
        h(
          'svg',
          { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, 'aria-hidden': true },
          h('circle', { cx: 8, cy: 8, r: 2.4 }),
          h('path', {
            d: 'M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1',
            strokeLinecap: 'round',
          }),
        ),
      );
    }

    /** Shell, working directory and tool-injection settings for this plugin. */
    function SettingsView({ state }) {
      const t = runtime.t;
      const settings = state.settings || {};
      const shells = settings.shells || [];
      const selected = settings.defaultShell || '';
      const busy = state.settingsBusy;
      const groups = groupShells(shells);
      const missing =
        settings.missingShells && settings.missingShells.length ? settings.missingShells : state.missingShells || [];
      const device = deviceSummary(state);

      const setDefaultShell = (id) => {
        store.patch({
          settings: {
            ...settings,
            defaultShell: id === 'auto' ? '' : id,
            effectiveShell: id === 'auto' ? settings.autoShell : id,
            defaultShellInstalled: true,
          },
        });
        saveSettings({ defaultShell: id });
      };

      return h(
        'div',
        { className: 'dt-settings' },
        h(
          'div',
          { className: 'dt-set-head' },
          h('div', { className: 'dt-set-title' }, t('settingsTitle')),
          h(
            'button',
            {
              type: 'button',
              className: 'dt-set-close',
              title: t('close'),
              'aria-label': t('close'),
              onClick: () => store.patch({ settingsOpen: false }),
            },
            '✕',
          ),
        ),
        h(
          'div',
          { className: 'dt-set-card' },
          h('div', { className: 'dt-set-label' }, t('defaultShell')),
          h('div', { className: 'dt-set-hint' }, t('defaultShellHint')),
          device ? h('div', { className: 'dt-set-device' }, t('thisDevice') + ': ' + device) : null,
          shells.length ? h('div', { className: 'dt-set-hint' }, t('detectedOn')) : null,
          h(
            'label',
            { className: selected ? 'dt-set-option' : 'dt-set-option on' },
            h('input', {
              type: 'radio',
              name: 'dt-default-shell',
              checked: !selected,
              disabled: busy,
              onChange: () => setDefaultShell('auto'),
            }),
            h('span', { className: 'dt-set-option-name' }, t('autoShell')),
            settings.autoShell ? h('span', { className: 'dt-set-option-tag' }, settings.autoShell) : null,
          ),
          groups.map((group) =>
            h(
              'div',
              { key: group.family, className: 'dt-set-group' },
              h('div', { className: 'dt-set-group-name' }, familyName(group.family)),
              group.items.map((shell) =>
                h(
                  'label',
                  {
                    key: shell.id,
                    className: selected === shell.id ? 'dt-set-option on' : 'dt-set-option',
                    title: shell.path || '',
                  },
                  h('input', {
                    type: 'radio',
                    name: 'dt-default-shell',
                    checked: selected === shell.id,
                    disabled: busy,
                    onChange: () => setDefaultShell(shell.id),
                  }),
                  h(
                    'span',
                    { className: 'dt-set-option-body' },
                    h('span', { className: 'dt-set-option-name' }, shell.label),
                    shell.about ? h('span', { className: 'dt-set-option-about' }, shell.about) : null,
                  ),
                  settings.autoShell === shell.id
                    ? h('span', { className: 'dt-set-option-tag' }, t('autoShellShort'))
                    : null,
                ),
              ),
            ),
          ),
          shells.length ? null : h('div', { className: 'dt-set-hint' }, t('noShell')),
          missing.length
            ? h(
                'div',
                { className: 'dt-set-missing' },
                h('span', { className: 'dt-set-missing-name' }, t('notInstalled') + ': ' + missing.map((item) => item.label || item.id).join(' · ')),
                h('div', { className: 'dt-set-hint' }, t('notInstalledHint')),
              )
            : null,
          settings.defaultShellInstalled === false ? h('div', { className: 'dt-set-warn' }, t('shellMissing')) : null,
          h('div', { className: 'dt-set-hint' }, t('autoShellHint')),
          h(
            'button',
            { type: 'button', className: 'dt-menu-link', disabled: busy, onClick: () => refreshShells(true).then(() => refreshSettings()) },
            '⟳ ' + t('redetect'),
          ),
        ),
        h(
          'div',
          { className: 'dt-set-card' },
          h(
            'div',
            { className: 'dt-set-row' },
            h(
              'div',
              { className: 'dt-set-grow' },
              h('div', { className: 'dt-set-label' }, t('injectTools')),
              h('div', { className: 'dt-set-hint' }, t('injectToolsHint')),
            ),
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': settings.toolsEnabled ? 'true' : 'false',
              'aria-label': t('injectTools'),
              className: settings.toolsEnabled ? 'dt-switch on' : 'dt-switch',
              disabled: busy,
              onClick: () => saveSettings({ toolsEnabled: !settings.toolsEnabled }),
            }),
          ),
          h(
            'div',
            { className: settings.toolsEnabled ? 'dt-set-ok' : 'dt-set-warn' },
            settings.toolsEnabled
              ? t('toolsOn').replace('{n}', String(settings.toolsRegistered || 0))
              : t('toolsOff'),
          ),
          h('div', { className: 'dt-set-hint' }, t('toolsExisting')),
          settings.toolError ? h('div', { className: 'dt-set-warn' }, settings.toolError) : null,
        ),
        state.settingsNotice
          ? h('div', { className: state.settingsError ? 'dt-set-warn' : 'dt-set-ok' }, state.settingsNotice)
          : null,
        settings.settingsPath
          ? h(
              'div',
              { className: 'dt-set-foot' },
              t('settingsPath') + ': ' + settings.settingsPath + (settings.persistent ? '' : ' ' + t('notPersistent')),
            )
          : null,
      );
    }

    function PanelHeader({ state }) {
      const t = runtime.t;
      return h(
        'div',
        { className: 'dt-head' },
        h(
          'div',
          { className: 'dt-tabs' },
          state.items.map((item) => h(TerminalTab, { key: item.id, item, active: item.id === state.activeId })),
          state.items.length ? h(NewTerminalButton, { state }) : null,
          state.items.length
            ? h(
                'button',
                {
                  type: 'button',
                  className: state.selectMode ? 'dt-icon-btn on' : 'dt-icon-btn',
                  title: state.selectMode ? t('inputMode') : t('selectMode'),
                  onClick: () => store.patch({ selectMode: !state.selectMode }),
                },
                state.selectMode ? '⌨' : '⧉',
              )
            : null,
        ),
        state.items.length ? h('div', { className: 'dt-meta' }, activeMeta(state)) : null,
        h(SettingsButton, { state }),
      );
    }

    /** Shell and directory of the selected terminal, for the header. */
    function activeMeta(state) {
      const active = state.items.find((item) => item.id === state.activeId);
      if (!active) return '';
      return (active.shellLabel ? active.shellLabel + ' · ' : '') + (active.cwd || '');
    }

    function TerminalPanel() {
      const t = runtime.t;
      const state = useStore();
      React.useEffect(() => {
        if (runtime.syncScheme) runtime.syncScheme();
      }, []);
      const active = state.items.find((item) => item.id === state.activeId) || null;
      return h(
        'div',
        { className: 'dt-panel' },
        h('span', { className: 'dt-probe', 'aria-hidden': true }, 'MMMMMMMMMMMMMMMMMMMM\nM'),
        h(PanelHeader, { state }),
        state.notice ? h('div', { className: 'dt-notice' }, state.notice) : null,
        state.error ? h('div', { className: 'dt-notice err' }, state.error) : null,
        state.settingsOpen
          ? h(SettingsView, { state })
          : active
            ? h(TerminalView, { key: active.id, item: active, select: state.selectMode })
            : h(
                'div',
                { className: 'dt-empty' },
                h('div', { className: 'dt-empty-title' }, t('empty')),
                h('div', { className: 'dt-empty-hint' }, t('emptyHint')),
                h(NewTerminalButton, { state, variant: 'empty' }),
              ),
      );
    }

    function PanelIcon(props) {
      const t = runtime.t;
      const state = useStore();
      const size = props && props.size ? props.size : 18;
      const active = Boolean(props && props.active);
      const running = state.items.filter((item) => item.status === 'running').length;
      return h(
        'span',
        { className: 'dt-icon' },
        h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 16 16',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.4,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': true,
            style: { display: 'block', opacity: active ? 1 : 0.85 },
          },
          h('rect', { x: 1.6, y: 2.4, width: 12.8, height: 11.2, rx: 2 }),
          h('path', { d: 'M4.4 6.2l2 1.8-2 1.8' }),
          h('path', { d: 'M8.4 10.2h3.2' }),
        ),
        running
          ? h('span', { className: 'dt-badge', title: t('activeLabel') + ': ' + running }, String(running))
          : null,
      );
    }

    // ---------------------------------------------------------------- style

    const CSS = [
      '.dt-panel{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2329);font-size:13px}',
      '.dt-head{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.1));background:var(--dsw-alias-bg-layer-1,#fafafa)}',
      '.dt-tabs{display:flex;align-items:center;gap:4px;overflow-x:auto;min-width:0;flex:1 1 auto}',
      '.dt-tab{display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border-radius:7px;cursor:pointer;white-space:nowrap;color:var(--dsw-alias-label-secondary,#6b7280)}',
      '.dt-tab:hover{background:var(--dsw-alias-bg-layer-2,rgba(15,23,42,.06))}',
      '.dt-tab.on{background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2329);box-shadow:0 0 0 1px var(--dsw-alias-border-l1,rgba(15,23,42,.12))}',
      '.dt-tab-name{max-width:160px;overflow:hidden;text-overflow:ellipsis}',
      '.dt-tab-x{border:0;background:transparent;color:inherit;cursor:pointer;border-radius:4px;font-size:11px;line-height:1;padding:1px 3px;opacity:.6}',
      '.dt-tab-x:hover{opacity:1;color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.dt-new{border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.14));background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);border-radius:7px;padding:4px 8px;cursor:pointer;font:inherit;white-space:nowrap}',
      '.dt-new:hover{color:var(--dsw-alias-brand-primary,#4d6bfe);border-color:currentColor}',
      '.dt-new:disabled{opacity:.55;cursor:default}',
      /* Segmented control: one border, one radius, a hairline divider inside. */
      '.dt-newbox{position:relative;display:inline-flex;align-items:stretch;flex:0 0 auto;border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.16));border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);overflow:hidden;transition:border-color .12s ease,color .12s ease,background-color .12s ease}',
      '.dt-newbox:hover{border-color:var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.dt-newbox.open{border-color:var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-brand-primary,#4d6bfe);background:var(--dsw-alias-bg-layer-2,rgba(15,23,42,.04))}',
      '.dt-newbox.busy{opacity:.6}',
      '.dt-newbox > button{border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:5px;padding:4px 9px;line-height:1.5;white-space:nowrap}',
      '.dt-newbox > button:disabled{cursor:default}',
      '.dt-newbox > button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,rgba(15,23,42,.07))}',
      '.dt-new-caret{padding:4px 6px !important;border-left:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.16)) !important}',
      '.dt-newbox:hover .dt-new-caret{border-left-color:currentColor !important}',
      '.dt-caret-icon{display:block;transition:transform .14s ease}',
      '.dt-newbox.open .dt-caret-icon{transform:rotate(180deg)}',
      '.dt-new-plus{font-weight:600;line-height:1}',
      /* The empty state uses the same control, filled. */
      '.dt-newbox-primary{border-color:transparent;background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff;border-radius:8px;margin-top:4px}',
      // A plain colour change, no `filter`: a filter here would become the containing block
// for the fixed-position menu and its overflow would clip the menu away.
'.dt-newbox-primary:hover{border-color:transparent;color:#fff;background:var(--dsw-alias-brand-primary,#4d6bfe);background-image:linear-gradient(rgba(255,255,255,.08),rgba(255,255,255,.08))}',
      '.dt-newbox-primary.open{background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff}',
      '.dt-newbox-primary > button{padding:6px 13px;font-weight:600;color:#fff}',
      '.dt-newbox-primary > button:hover:not(:disabled){background:rgba(255,255,255,.14)}',
      '.dt-newbox-primary > .dt-new-caret{border-left:1px solid rgba(255,255,255,.4) !important;padding:6px 8px !important}',
      '.dt-newbox-primary:hover .dt-new-caret{border-left-color:rgba(255,255,255,.4) !important}',
      '.dt-menu{position:absolute;top:calc(100% + 6px);left:0;z-index:40;min-width:250px;max-width:min(360px,80vw);max-height:min(70vh,520px);overflow:auto;display:flex;flex-direction:column;gap:6px;padding:10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.14));background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 8px 28px rgba(15,23,42,.18);color:var(--dsw-alias-label-primary,#1f2329);cursor:default;font-weight:400}',
      '.dt-menu-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}',
      '.dt-menu-note{font-size:10px;color:var(--dsw-alias-label-secondary,#9ca3af);white-space:nowrap}',
      '.dt-menu-title{font-size:11px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary,#6b7280)}',
      '.dt-menu-list{display:flex;flex-direction:column;gap:2px;max-height:220px;overflow:auto}',
      '.dt-menu-item{display:flex;align-items:center;gap:7px;padding:4px 6px;border-radius:6px;cursor:pointer}',
      '.dt-menu-item:hover{background:var(--dsw-alias-bg-layer-2,rgba(15,23,42,.06))}',
      '.dt-menu-item input{margin:0;accent-color:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.dt-menu-name{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dt-menu-tag{color:var(--dsw-alias-brand-primary,#4d6bfe);font-size:11px}',
      '.dt-menu-input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.18));border-radius:6px;background:var(--dsw-alias-bg-base,#fff);color:inherit;font:inherit;padding:4px 6px;outline:none}',
      '.dt-menu-input:focus{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.dt-menu-hint{font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);word-break:break-all}',
      '.dt-menu-link{align-self:flex-start;border:0;background:transparent;color:var(--dsw-alias-brand-primary,#4d6bfe);font:inherit;font-size:11px;cursor:pointer;padding:0}',
      '.dt-menu-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:2px}',
      '.dt-menu-btn{border:0;border-radius:7px;padding:4px 12px;background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff;font:inherit;font-weight:600;cursor:pointer}',
      '.dt-menu-btn.ghost{background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);font-weight:400}',
      '.dt-menu-btn:disabled{opacity:.55;cursor:default}',
      '.dt-meta{flex:0 0 auto;max-width:32%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px}',
      '.dt-notice{margin:6px 10px 0;padding:5px 8px;border-radius:6px;background:rgba(220,38,38,.1);color:var(--dsw-alias-state-error-primary,#dc2626);font-size:12px;word-break:break-word}',
      '.dt-notice.err{background:rgba(220,38,38,.1)}',
      '.dt-view{position:relative;flex:1 1 auto;min-height:0;overflow:auto;padding:8px 10px;cursor:text;background:var(--dsw-alias-bg-base,#fff)}',
      '.dt-screen{--dt-fg:var(--dsw-alias-label-primary,#1f2329);--dt-bg:var(--dsw-alias-bg-base,#fff);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:13px;line-height:1.32;white-space:pre;tab-size:8}',
      '.dt-row{height:1.32em;white-space:pre}',
      '.dt-cursor{outline:1px solid var(--dsw-alias-brand-primary,#4d6bfe);background:rgba(77,107,254,.14)}',
      '.dt-probe{position:absolute;left:-9999px;top:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:13px;line-height:1.32;white-space:pre}',
      '.dt-input{position:absolute;inset:0;width:100%;height:100%;opacity:0;border:0;resize:none;background:transparent;color:transparent;caret-color:transparent;font:inherit;padding:0;outline:none}',
      '.dt-input.off{pointer-events:none}',
      '.dt-new.on{color:var(--dsw-alias-brand-primary,#4d6bfe);border-color:currentColor}',
      '.dt-icon-btn{border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.14));background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);border-radius:8px;padding:3px 7px;cursor:pointer;font:inherit;line-height:1.4}',
      '.dt-icon-btn:hover{color:var(--dsw-alias-brand-primary,#4d6bfe);border-color:currentColor}',
      '.dt-icon-btn.on{color:var(--dsw-alias-brand-primary,#4d6bfe);border-color:currentColor;background:var(--dsw-alias-bg-layer-2,rgba(15,23,42,.05))}',
      '.dt-gear{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);border-radius:8px;padding:4px;cursor:pointer;line-height:0}',
      '.dt-gear:hover{color:var(--dsw-alias-brand-primary,#4d6bfe);background:var(--dsw-alias-bg-layer-2,rgba(15,23,42,.07))}',
      '.dt-gear.on{color:var(--dsw-alias-brand-primary,#4d6bfe);border-color:var(--dsw-alias-border-l1,rgba(15,23,42,.14));background:var(--dsw-alias-bg-base,#fff)}',
      /* Settings view */
      '.dt-settings{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:12px;padding:14px 16px;background:var(--dsw-alias-bg-base,#fff)}',
      '.dt-set-head{display:flex;align-items:center;gap:8px}',
      '.dt-set-title{flex:1 1 auto;font-size:14px;font-weight:600}',
      '.dt-set-close{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer;border-radius:6px;padding:3px 6px;font:inherit;line-height:1}',
      '.dt-set-close:hover{color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.dt-set-card{display:flex;flex-direction:column;gap:6px;padding:12px;border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.12));border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fafafa)}',
      '.dt-set-label{font-size:12px;font-weight:600}',
      '.dt-set-hint{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,#6b7280)}',
      '.dt-set-ok{font-size:11px;line-height:1.5;color:var(--dsw-alias-state-success-primary,#16a34a)}',
      '.dt-set-warn{font-size:11px;line-height:1.5;color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.dt-set-option{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:8px;cursor:pointer;border:1px solid transparent}',
      '.dt-set-option:hover{background:var(--dsw-alias-bg-layer-2,rgba(15,23,42,.05))}',
      '.dt-set-option.on{border-color:var(--dsw-alias-brand-primary,#4d6bfe);background:var(--dsw-alias-bg-base,#fff)}',
      '.dt-set-option input{margin:0;accent-color:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.dt-set-option-name{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dt-set-option-tag{font-size:10px;color:var(--dsw-alias-label-secondary,#9ca3af)}',
      '.dt-set-row{display:flex;align-items:center;gap:12px}',
      '.dt-set-grow{flex:1 1 auto;display:flex;flex-direction:column;gap:4px}',
      '.dt-switch{position:relative;flex:0 0 auto;width:40px;height:22px;border:0;border-radius:11px;background:var(--dsw-alias-border-l1,rgba(15,23,42,.24));cursor:pointer;transition:background-color .15s ease;padding:0}',
      '.dt-switch:disabled{opacity:.6;cursor:default}',
      '.dt-switch::after{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(15,23,42,.3);transition:transform .15s ease}',
      '.dt-switch.on{background:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.dt-switch.on::after{transform:translateX(18px)}',
      '.dt-set-foot{font-size:10px;color:var(--dsw-alias-label-secondary,#9ca3af);word-break:break-all}',
      '.dt-view.plain{cursor:text;user-select:text}',
      '.dt-view.plain .dt-screen{user-select:text}',
      '.dt-empty{flex:1 1 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--dsw-alias-label-secondary,#6b7280)}',
      '.dt-empty-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2329)}',
      '.dt-empty-hint{font-size:12px}',
      '.dt-icon{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;line-height:0;white-space:nowrap;overflow:visible}',
      '.dt-badge{position:absolute;top:-3px;right:-5px;display:block;min-width:13px;height:13px;padding:0 3px;border-radius:7px;background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff;font-size:9px;font-weight:700;line-height:13px;font-variant-numeric:tabular-nums;white-space:nowrap;text-align:center;box-shadow:0 0 0 1.5px var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-base,#fff))}',
      '.dt-tab-input{width:130px;border:1px solid var(--dsw-alias-brand-primary,#4d6bfe);border-radius:5px;background:var(--dsw-alias-bg-base,#fff);color:inherit;font:inherit;padding:1px 4px;outline:none}',
      '.dt-dot{flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-secondary,#9ca3af)}',
      '.dt-dot.on{background:var(--dsw-alias-state-success-primary,#16a34a)}',
      /* Device-aware shell pickers: grouped by family, each entry with a one-line about. */
      '.dt-menu-group{display:flex;flex-direction:column;gap:2px}',
      '.dt-menu-group + .dt-menu-group{margin-top:4px}',
      '.dt-menu-group-name{font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#9ca3af);padding:0 6px}',
      '.dt-menu-item{align-items:flex-start}',
      '.dt-menu-item > input{margin-top:2px}',
      '.dt-menu-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}',
      '.dt-menu-body .dt-menu-name{flex:0 0 auto}',
      '.dt-menu-sub{font-size:10px;line-height:1.35;color:var(--dsw-alias-label-secondary,#9ca3af)}',
      '.dt-menu-missing{display:flex;flex-direction:column;gap:2px;padding-top:5px;border-top:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.1))}',
      '.dt-set-device{font-size:11px;word-break:break-all;color:var(--dsw-alias-label-secondary,#6b7280)}',
      '.dt-set-group{display:flex;flex-direction:column;gap:2px}',
      '.dt-set-group + .dt-set-group{margin-top:4px}',
      '.dt-set-group-name{font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#9ca3af);padding:0 2px}',
      '.dt-set-option{align-items:flex-start}',
      '.dt-set-option > input{margin-top:3px}',
      '.dt-set-option-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}',
      '.dt-set-option-body .dt-set-option-name{flex:0 0 auto}',
      '.dt-set-option-about{font-size:10px;line-height:1.35;color:var(--dsw-alias-label-secondary,#9ca3af)}',
      '.dt-set-missing{display:flex;flex-direction:column;gap:3px;margin-top:2px;padding:7px 9px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(15,23,42,.04))}',
      '.dt-set-missing-name{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary,#6b7280)}',
    ].join('\n');

    /** Parse a computed CSS colour into [r, g, b], for the luminance probe. */
    function parseColor(raw) {
      if (!raw) return null;
      const text = raw.trim();
      if (text[0] === '#') {
        if (text.length === 4) {
          return [parseInt(text[1] + text[1], 16), parseInt(text[2] + text[2], 16), parseInt(text[3] + text[3], 16)];
        }
        if (text.length >= 7) {
          return [parseInt(text.slice(1, 3), 16), parseInt(text.slice(3, 5), 16), parseInt(text.slice(5, 7), 16)];
        }
        return null;
      }
      const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(text);
      if (!match) return null;
      return [Number(match[1]), Number(match[2]), Number(match[3])];
    }

    /** Light or dark: the theme service is authoritative, the painted tokens are the fallback. */
    function detectScheme(ctx) {
      try {
        const theme = ctx && ctx.get ? ctx.get('theme') : null;
        const snapshot = theme && typeof theme.getTheme === 'function' ? theme.getTheme() : null;
        const scheme = snapshot && snapshot.active ? snapshot.active.colorScheme : null;
        if (scheme === 'light' || scheme === 'dark') return scheme;
      } catch (err) {
        /* fall through to the painted tokens */
      }
      try {
        const probe = document.querySelector('.dt-probe') || document.body || document.documentElement;
        const rgb = parseColor(window.getComputedStyle(probe).getPropertyValue('--dsw-alias-bg-base'));
        if (rgb) {
          const luminance = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
          return luminance > 0.55 ? 'light' : 'dark';
        }
      } catch (err) {
        /* keep the current scheme */
      }
      return runtime.scheme;
    }

    function installTheme(ctx) {
      const sync = () => {
        const next = detectScheme(ctx);
        if (next === runtime.scheme) return;
        runtime.scheme = next;
        styleCache.clear();
        store.patch({ scheme: next });
      };
      runtime.syncScheme = sync;
      sync();
      try {
        ctx.effect(() => ctx.on('theme/change', sync));
      } catch (err) {
        /* theme events unavailable: the palette simply stays as first detected */
      }
    }

    /**
     * Insert the package stylesheet once, for the whole plugin run. It must not
     * wait for a component to mount: the sidebar panel icon renders before (and
     * without) the terminal panel, and an unstyled count badge would wrap.
     */
    function installStyles(ctx) {
      const disposers = [];
      try {
        if (typeof styles !== 'undefined' && styles && typeof styles.insert === 'function') {
          disposers.push(styles.insert(CSS));
        }
      } catch (err) {
        /* fall back to a plain style element below */
      }
      if (!disposers.length) {
        try {
          const node = document.createElement('style');
          node.setAttribute('data-dsh-plugin', NS);
          node.textContent = CSS;
          document.head.appendChild(node);
          disposers.push(() => {
            if (node.parentNode) node.parentNode.removeChild(node);
          });
        } catch (err) {
          return;
        }
      }
      ctx.effect(() => () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch (err) {
            /* already removed */
          }
        }
      });
    }

    // -------------------------------------------------------------- install

    function installLocale(ctx) {
      const locale = ctx.get('locale');
      if (!locale || typeof locale.register !== 'function') return;
      runtime.locale = locale;
      /*
       * Register the complete zh/en dictionary once, up front. Registering only
       * whichever language happened to be active at mount time made lookups for
       * the new language miss until the next locale notification, so different
       * parts of the UI flipped languages at different moments.
       */
      try {
        ctx.effect(() => locale.register(NS, { en: DICTS.en, zh: DICTS.zh }));
      } catch (err) {
        /* a previous instance already owns this namespace */
      }
      if (typeof locale.bind === 'function') {
        try {
          const bound = locale.bind(NS);
          runtime.t = (key, params) => {
            try {
              const text = bound(key, params);
              return text === undefined || text === null ? key : String(text);
            } catch (err) {
              return key;
            }
          };
        } catch (err) {
          /* keep the built-in dictionary */
        }
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        runtime.ctx = ctx;
        installLocale(ctx);
        installStyles(ctx);
        installTheme(ctx);
        ctx.effect(() => {
          refresh();
          refreshShells(false);
          refreshSettings();
          const timer = window.setInterval(refresh, POLL_MS);
          return () => window.clearInterval(timer);
        });
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_KEY, locale: NS }, TerminalPanel),
        );
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_KEY,
              order: 22,
              locale: NS,
              label: () => {
                const running = store.snapshot.items.filter((item) => item.status === 'running').length;
                return running ? runtime.t('title') + ' · ' + running : runtime.t('title');
              },
            },
            PanelIcon,
          ),
        );
      },
    };
  },
});
