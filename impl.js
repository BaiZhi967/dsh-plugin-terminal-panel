/**
 * terminal-dock — host implementation (reloadable).
 *
 * Loaded lazily by host.js through a cache-busted dynamic import, so this file
 * can be replaced and reloaded with POST /system-terminals/api/__reload without
 * restarting the harness.
 *
 * One terminal is one real PTY allocated through the shared `subprocess`
 * service. Output is streamed to the browser as Server-Sent Events and kept in
 * a bounded replay buffer, so a reloading page rebuilds the same screen.
 * Nothing here opens an OS window.
 *
 * This module owns three things:
 *   1. the terminal registry (survives a code reload through a global symbol
 *      slot, so reloading the file never orphans running PTYs),
 *   2. shell discovery — which shells this machine can actually run — and the
 *      default working directory (the user's home, i.e. where an OS-opened
 *      terminal lands),
 *   3. the agent-facing `terminal_*` tools themselves and the small HTTP
 *      surface the browser panel uses. host.js only carries the route and asks
 *      this file to attach its tools, so both halves of the plugin reload
 *      together.
 */

const HISTORY_LIMIT = 262144;
const KEEPALIVE_MS = 20000;
/** Running terminals allowed at once. */
const MAX_TERMINALS = 12;
/** Records kept in the panel list, exited ones included. */
const MAX_TERMINAL_RECORDS = 40;
const READ_DEFAULT_CHARS = 20000;
/** Kept below the deployment's 50 kB inline-result budget so a read stays inline. */
const READ_MAX_CHARS = 40000;
const EXEC_DEFAULT_TIMEOUT_MS = 30000;
const EXEC_MAX_TIMEOUT_MS = 600000;
const EXEC_IDLE_MS = 700;
const EXEC_MIN_WAIT_MS = 250;
const EXEC_POLL_MS = 120;
const READY_TIMEOUT_MS = 6000;
const READY_QUIET_MS = 200;
/**
 * Every mutating route requires this header. A cross-origin page cannot set a
 * custom header without a preflight CORS request, which these routes never
 * answer, so this is what keeps a local page from driving the terminals.
 */
const GUARD_HEADER = 'x-dsh-terminal';

/** Registry slot shared by every loaded instance of this module. */
const REGISTRY_KEY = Symbol.for('dsh-terminal-panel.registry.v1');
/**
 * The live agent-tool registration. It lives in a global slot because the
 * carrier (host.js) is imported once per process and can be older than this
 * file: a reloaded impl.js must be able to take the tools over from the
 * previous instance without ever double-registering a name.
 */
const TOOLS_KEY = Symbol.for('dsh-terminal-panel.tools.v1');
/** Diagnostics slot read by the health route (host.js writes it too). */
const STATUS_KEY = Symbol.for('dsh-terminal-panel.host.v1');
/** Identity of THIS module instance, to tell a reload from a second call. */
const MODULE_TOKEN = Symbol('dsh-terminal-panel.module');

const fsMod = await optionalImport('node:fs');
const osMod = await optionalImport('node:os');
const pathMod = await optionalImport('node:path');
// Only used to enumerate WSL distributions; every terminal goes through the
// host's subprocess service.
const childMod = await optionalImport('node:child_process');

async function optionalImport(name) {
  try {
    return await import(name);
  } catch (err) {
    return null;
  }
}

const isAbsolutePath = pathMod
  ? pathMod.isAbsolute
  : (value) => /^[\\/]/.test(value) || /^[a-zA-Z]:[\\/]/.test(value);
const joinPath = pathMod
  ? pathMod.join
  : (...parts) => parts.filter((part) => part !== undefined && part !== null && part !== '').join('\\');
const normalizePath = pathMod ? pathMod.normalize : (value) => value;
const dirnamePath = pathMod
  ? pathMod.dirname
  : (value) => value.replace(/[\\/][^\\/]*$/, '');
const statSyncOf = fsMod && typeof fsMod.statSync === 'function' ? fsMod.statSync : null;
const lstatSyncOf = fsMod && typeof fsMod.lstatSync === 'function' ? fsMod.lstatSync : null;

// ---------------------------------------------------------------- settings

const SETTINGS_DIR = 'terminal-panel';
const SETTINGS_FILE = 'settings.json';
/** Cached copy of the on-disk settings, one per loaded instance. */
let settingsCache = null;

/** `$DSH_HOME` (already absolute) or `~/.dsh`, matching the harness' own rule. */
function dshHomeDir() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
  const home = moduleHomeDir();
  return home ? joinPath(home, '.dsh') : null;
}

function moduleHomeDir() {
  if (osMod && typeof osMod.homedir === 'function') {
    try {
      const value = osMod.homedir();
      if (typeof value === 'string' && value.trim()) return value.trim();
    } catch (err) {
      /* fall through to the environment */
    }
  }
  return process.env.USERPROFILE || process.env.HOME || null;
}

function settingsFilePath() {
  const root = dshHomeDir();
  return root ? joinPath(root, SETTINGS_DIR, SETTINGS_FILE) : null;
}

/**
 * Plugin settings, kept in a small JSON file next to the harness home so they
 * survive restarts and are shared by every browser rather than living in one
 * localStorage. A missing or broken file falls back to the defaults.
 */
function readSettings() {
  if (settingsCache) return settingsCache;
  const settings = { defaultShell: '', toolsEnabled: true };
  const file = settingsFilePath();
  if (file && fsMod && typeof fsMod.readFileSync === 'function') {
    try {
      const parsed = JSON.parse(fsMod.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.defaultShell === 'string') settings.defaultShell = parsed.defaultShell.trim();
        if (typeof parsed.toolsEnabled === 'boolean') settings.toolsEnabled = parsed.toolsEnabled;
      }
    } catch (err) {
      /* first run, unreadable file, or bad JSON: keep the defaults */
    }
  }
  settingsCache = settings;
  return settings;
}

function writeSettings(patch) {
  const next = Object.assign({}, readSettings(), patch, {
    version: 1,
    updatedAt: new Date().toISOString(),
  });
  const file = settingsFilePath();
  settingsCache = next;
  if (!file || !fsMod || typeof fsMod.writeFileSync !== 'function') return next;
  try {
    if (typeof fsMod.mkdirSync === 'function') fsMod.mkdirSync(dirnamePath(file), { recursive: true });
    const temp = file + '.tmp';
    fsMod.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    if (typeof fsMod.renameSync === 'function') fsMod.renameSync(temp, file);
  } catch (err) {
    /* keep the value in memory even when the file cannot be written */
  }
  return next;
}

/**
 * Shell catalogue. `args` is what a fresh OS terminal would pass for that
 * shell; `windows`/`posix` are the PATH names tried, and a shell is offered
 * only when one of its candidates resolves in this host's execution world.
 *
 * `family` labels the entry in the picker, `about` is its one-line hint, and
 * `platforms` keeps a Windows-only shell off a POSIX device (and the other way
 * round) even when a same-named binary happens to exist there.
 */
const SHELL_DEFS = {
  pwsh: {
    label: 'PowerShell 7',
    family: 'powershell',
    about: 'Cross-platform PowerShell (pwsh)',
    args: ['-NoLogo'],
    platforms: ['windows', 'posix'],
    windows: ['pwsh.exe'],
    posix: ['pwsh'],
  },
  powershell: {
    label: 'Windows PowerShell',
    family: 'powershell',
    about: 'Windows PowerShell 5.1, shipped with Windows',
    args: ['-NoLogo'],
    platforms: ['windows'],
    windows: ['powershell.exe'],
    posix: [],
  },
  cmd: {
    label: 'Command Prompt',
    family: 'windows',
    about: 'Classic Windows command processor (cmd)',
    args: [],
    platforms: ['windows'],
    windows: ['cmd.exe'],
    posix: [],
  },
  gitbash: {
    label: 'Git Bash',
    family: 'bash',
    about: 'Bash from Git for Windows, with the POSIX toolchain',
    // Deliberately NOT `bash.exe` from PATH: that name is the WSL launcher on
    // any machine with WSL enabled. Only a Git for Windows install tree counts.
    args: ['-l', '-i'],
    platforms: ['windows'],
    windows: [],
    posix: [],
  },
  wsl: {
    label: 'WSL',
    family: 'wsl',
    about: 'A Linux distribution running under Windows (wsl.exe)',
    // Expanded into one entry per distribution by `wslDistributions()`.
    dynamic: true,
    args: [],
    platforms: ['windows'],
    windows: [],
    posix: [],
  },
  bash: {
    label: 'Bash',
    family: 'bash',
    about: 'Bourne Again Shell',
    args: ['-l', '-i'],
    platforms: ['posix'],
    windows: [],
    posix: ['bash'],
  },
  zsh: {
    label: 'Zsh',
    family: 'zsh',
    about: 'Z shell, the macOS default since Catalina',
    args: ['-l'],
    platforms: ['posix'],
    windows: [],
    posix: ['zsh'],
  },
  sh: {
    label: 'sh',
    kind: 'sh',
    family: 'posix',
    about: 'The POSIX shell (dash on Debian and Ubuntu)',
    args: ['-l'],
    platforms: ['posix'],
    windows: [],
    posix: ['sh'],
  },
  fish: {
    label: 'Fish',
    family: 'fish',
    about: 'Friendly interactive shell',
    args: ['-l', '-i'],
    platforms: ['posix'],
    windows: [],
    posix: ['fish'],
  },
  nu: {
    label: 'Nushell',
    family: 'nu',
    about: 'Structured-data shell (nu)',
    args: [],
    platforms: ['windows', 'posix'],
    windows: ['nu.exe'],
    posix: ['nu'],
  },
  ksh: {
    label: 'KornShell',
    family: 'ksh',
    about: 'Korn shell (ksh93 / mksh)',
    args: ['-l'],
    platforms: ['posix'],
    windows: [],
    posix: ['ksh', 'mksh', 'ksh93'],
  },
  tcsh: {
    label: 'tcsh',
    family: 'csh',
    about: 'Enhanced C shell, still shipped by macOS and the BSDs',
    args: [],
    platforms: ['posix'],
    windows: [],
    posix: ['tcsh', 'csh'],
  },
};

/** The POSIX binary name of a shell, used to build absolute candidates. */
const POSIX_BINARIES = {
  pwsh: 'pwsh',
  bash: 'bash',
  zsh: 'zsh',
  sh: 'sh',
  fish: 'fish',
  nu: 'nu',
  ksh: 'ksh',
  tcsh: 'tcsh',
};

/**
 * Preference order per device kind, so that `auto` means "what this device
 * would open by itself": Windows keeps the historical pwsh → powershell → cmd
 * order, macOS leads with zsh (its default since Catalina) and Linux with bash.
 */
const SHELL_ORDER = {
  windows: ['pwsh', 'powershell', 'cmd', 'gitbash', 'wsl', 'nu', 'bash'],
  macos: ['zsh', 'bash', 'fish', 'sh', 'nu', 'pwsh', 'ksh', 'tcsh'],
  linux: ['bash', 'zsh', 'fish', 'sh', 'nu', 'pwsh', 'ksh', 'tcsh'],
};

/** One state per loaded module instance; the terminal registry is shared. */
let state = null;

export async function handle(req, res, ctx) {
  const st = ensureState(ctx);
  // Self-healing: whichever carrier delivered this request, the tools exist
  // once the first call lands (a cached older host.js never ran attachTools).
  try {
    attachTools(ctx);
  } catch (err) {
    /* the HTTP surface must keep working even if registration fails */
  }
  return st.handle(req, res);
}

/**
 * Tool definitions for the host tool registry. Declared here (not in host.js)
 * so that reloading this file also refreshes the tool schemas and bodies.
 */
export function toolDefinitions(ctx) {
  return ensureState(ctx).tools();
}

/**
 * Publish this instance's tools into the host registry, honouring the
 * user-facing "inject terminal tools into the agent" setting. Idempotent per
 * module instance and per enabled state: a newer instance (or a settings
 * change) first disposes the previous set, and an unloaded plugin leaves no
 * tools behind.
 *
 * @returns a summary of what happened, for logs and the health route.
 */
export function attachTools(ctx) {
  const settings = readSettings();
  const enabled = settings.toolsEnabled !== false;
  const previous = globalTools();
  const mine = Boolean(previous && previous.token === MODULE_TOKEN);
  if (mine && previous.enabled === enabled) {
    return { registered: enabled, count: previous.count, names: previous.names, reused: true };
  }
  if (previous && typeof previous.dispose === 'function') {
    try {
      previous.dispose();
    } catch (err) {
      /* the old set is already gone */
    }
  }
  if (!enabled) {
    publishStatus({
      toolService: true,
      toolsEnabled: false,
      toolCount: 0,
      toolNames: [],
      error: null,
      settingsPath: settingsFilePath(),
    });
    return { registered: false, count: 0, disabled: true };
  }
  const tools = toolsServiceOf(ctx);
  if (!tools) {
    publishStatus({ toolService: false, toolsEnabled: true, toolCount: 0, toolNames: [], error: 'tools service unavailable' });
    return { registered: false, count: 0, error: 'tools service unavailable' };
  }
  let definitions;
  try {
    definitions = ensureState(ctx).tools();
  } catch (err) {
    publishStatus({ toolService: true, toolCount: 0, toolNames: [], error: 'toolDefinitions failed: ' + message(err) });
    throw err;
  }
  const disposers = [];
  const names = [];
  const failures = [];
  for (const definition of definitions) {
    try {
      const dispose = tools.register(definition);
      if (typeof dispose === 'function') disposers.push(dispose);
      names.push(definition.name);
    } catch (err) {
      failures.push(definition.name + ': ' + message(err));
    }
  }
  const entry = {
    token: MODULE_TOKEN,
    enabled: true,
    count: disposers.length,
    names,
    at: Date.now(),
    dispose() {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch (err) {
          /* already gone */
        }
      }
      const current = globalTools();
      if (current === entry) {
        try {
          delete globalThis[TOOLS_KEY];
        } catch (err) {
          /* frozen global */
        }
      }
    },
  };
  try {
    globalThis[TOOLS_KEY] = entry;
  } catch (err) {
    /* diagnostics only */
  }
  publishStatus({
    toolService: true,
    toolsEnabled: true,
    toolCount: disposers.length,
    toolNames: names,
    error: failures.length ? failures.join(' | ') : null,
    settingsPath: settingsFilePath(),
  });
  return { registered: true, count: disposers.length, names, failures };
}

/** Remove the current registration (plugin unload). */
export function detachTools() {
  const entry = globalTools();
  if (entry && typeof entry.dispose === 'function') {
    try {
      entry.dispose();
    } catch (err) {
      /* already gone */
    }
  }
}

function toolsServiceOf(ctx) {
  const attempts = [];
  const pick = (label, read) => {
    try {
      const value = read();
      if (value && typeof value.register === 'function') return value;
      attempts.push(label + ': ' + (value === undefined ? 'undefined' : typeof value));
    } catch (err) {
      attempts.push(label + ': ' + message(err));
    }
    return undefined;
  };
  const direct = pick('ctx.tools', () => ctx && ctx.tools);
  if (direct) return direct;
  const get = pick('ctx.get(tools)', () => ctx && typeof ctx.get === 'function' && ctx.get('tools'));
  if (get) return get;
  const loose = pick('ctx.get(tools,false)', () => ctx && typeof ctx.get === 'function' && ctx.get('tools', false));
  if (loose) return loose;
  // A plugin upgraded in place keeps its already-imported carrier for the life
  // of the process, and an older carrier never injected `tools`. Reaching the
  // service through the root context is what makes the tools appear without a
  // restart; a carrier that declares the dependency never gets here.
  const root = ctx && ctx.root;
  if (root && root !== ctx) {
    const fromRoot = pick('ctx.root.get(tools,false)', () => typeof root.get === 'function' && root.get('tools', false));
    if (fromRoot) {
      publishStatus({ toolAccess: 'ctx.root', toolAccessAttempts: attempts });
      return fromRoot;
    }
    const rootProperty = pick('ctx.root.tools', () => root.tools);
    if (rootProperty) {
      publishStatus({ toolAccess: 'ctx.root', toolAccessAttempts: attempts });
      return rootProperty;
    }
  }
  publishStatus({ toolAccess: null, toolAccessAttempts: attempts });
  return undefined;
}

function globalTools() {
  try {
    return globalThis[TOOLS_KEY] || null;
  } catch (err) {
    return null;
  }
}

function publishStatus(patch) {
  try {
    globalThis[STATUS_KEY] = Object.assign({}, globalThis[STATUS_KEY], patch, { at: new Date().toISOString() });
  } catch (err) {
    /* diagnostics must never break the plugin */
  }
}

function message(err) {
  return err && err.message ? err.message : String(err);
}

function ensureState(ctx) {
  if (!state) state = createState(ctx, sharedRegistry());
  return state;
}

function sharedRegistry() {
  let registry = globalThis[REGISTRY_KEY];
  if (!registry || !(registry.terminals instanceof Map)) {
    registry = { terminals: new Map(), seq: 0 };
    try {
      globalThis[REGISTRY_KEY] = registry;
    } catch (err) {
      /* a frozen global still leaves us a usable in-instance registry */
    }
  }
  return registry;
}

function releaseRegistry() {
  try {
    if (globalThis[REGISTRY_KEY]) delete globalThis[REGISTRY_KEY];
  } catch (err) {
    /* nothing to clear */
  }
}

function createState(ctx, registry) {
  /** id -> terminal record (shared across code reloads). */
  const terminals = registry.terminals;
  const resolvedTools = new Map();
  let seq = registry.seq;
  let cachedShells;

  const subprocess = () => {
    let svc;
    // `ctx.subprocess` is a property access that throws when the service was
    // never injected; `ctx.get` is the documented non-strict lookup.
    try {
      svc = ctx.subprocess;
    } catch (err) {
      svc = undefined;
    }
    if (!svc && typeof ctx.get === 'function') {
      try {
        svc = ctx.get('subprocess', false);
      } catch (err) {
        svc = undefined;
      }
    }
    return svc && typeof svc.spawn === 'function' ? svc : undefined;
  };

  // ------------------------------------------------------------ environment

  function homeDirectory() {
    const candidates = [];
    if (osMod && typeof osMod.homedir === 'function') {
      try {
        candidates.push(osMod.homedir());
      } catch (err) {
        /* fall through to the environment */
      }
    }
    if (process.env.USERPROFILE) candidates.push(process.env.USERPROFILE);
    if (process.env.HOMEDRIVE && process.env.HOMEPATH) candidates.push(process.env.HOMEDRIVE + process.env.HOMEPATH);
    if (process.env.HOME) candidates.push(process.env.HOME);
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
    return undefined;
  }

  function directoryExists(target) {
    if (!statSyncOf) return true;
    try {
      return statSyncOf(target).isDirectory();
    } catch (err) {
      return false;
    }
  }

  /**
   * A Windows App Execution Alias (the `pwsh.exe` stub a Store/MSIX install
   * drops into %LOCALAPPDATA%\Microsoft\WindowsApps) is a reparse point:
   * stat() follows it into the MSIX package and can fail with EACCES even
   * though CreateProcess launches the alias happily. The provider verifies
   * candidates with stat(), so without this the machine looks as if PowerShell 7
   * were not installed at all. lstat() sees the link itself.
   */
  function localFile(file) {
    if (process.platform !== 'win32' || !lstatSyncOf) return false;
    try {
      const stat = lstatSyncOf(file);
      return stat.isFile() || stat.isSymbolicLink();
    } catch (err) {
      return false;
    }
  }

  /**
   * The same lookup the provider does, minus the stat() that cannot see an
   * alias: an absolute path is probed as-is, a bare name walks PATH with
   * PATHEXT. Only Windows needs it, and there it only ever widens the result.
   */
  function localCandidate(name) {
    if (process.platform !== 'win32' || !name) return '';
    if (localFile(name)) return name;
    if (name.includes('/') || name.includes('\\')) return '';
    const extensions = name.includes('.')
      ? ['']
      : String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
    for (const directory of String(process.env.PATH || '').split(';')) {
      const trimmed = directory.trim();
      if (!trimmed) continue;
      for (const extension of extensions) {
        const file = joinPath(trimmed, name + extension);
        if (localFile(file)) return file;
      }
    }
    return '';
  }

  async function toolPath(name) {
    if (resolvedTools.has(name)) return resolvedTools.get(name);
    let path = name;
    const svc = subprocess();
    let resolved = '';
    try {
      if (svc && typeof svc.resolveExecutable === 'function') {
        const value = await svc.resolveExecutable(name);
        if (typeof value === 'string' && value.trim()) resolved = value.trim();
      }
    } catch (err) {
      /* the alias-tolerant probe below still gets a chance */
    }
    if (!resolved) resolved = localCandidate(name);
    if (resolved) path = resolved;
    resolvedTools.set(name, path);
    return path;
  }

  /** Resolve one candidate in the host's execution world (absolute paths are verified). */
  async function canResolve(name) {
    const svc = subprocess();
    if (svc && typeof svc.resolveExecutable === 'function') {
      try {
        const resolved = await svc.resolveExecutable(name);
        if (typeof resolved === 'string' && resolved.trim().length > 0) return true;
      } catch (err) {
        /* fall through to the alias-tolerant probe */
      }
    }
    return Boolean(localCandidate(name));
  }

  async function resolveExecutablePath(name) {
    const svc = subprocess();
    let resolved = '';
    try {
      if (svc && typeof svc.resolveExecutable === 'function') {
        const value = await svc.resolveExecutable(name);
        if (typeof value === 'string' && value.trim()) resolved = value.trim();
      }
    } catch (err) {
      /* the alias-tolerant probe below still gets a chance */
    }
    if (!resolved) resolved = localCandidate(name);
    return resolved || undefined;
  }

  async function platformName() {
    let platform = typeof process !== 'undefined' && process.platform === 'win32' ? 'windows' : 'posix';
    const svc = subprocess();
    try {
      if (svc && typeof svc.terminalEnvironment === 'function') {
        const env = await svc.terminalEnvironment();
        const named = env ? normalizePlatform(env.platform) : '';
        if (named) platform = named;
      }
    } catch (err) {
      /* keep the process-platform guess */
    }
    return platform;
  }

  /**
   * The provider names one of two platforms, 'windows' or 'posix'. A provider
   * that hands back a Node-style process.platform ('win32', 'darwin', 'linux')
   * is mapped rather than trusted verbatim: every shell declares the platform it
   * runs on, so a value outside that vocabulary fails every one of those checks
   * and the device looks as if it had no shells at all.
   */
  function normalizePlatform(value) {
    const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!name) return '';
    if (name === 'windows' || name === 'win32' || name === 'win') return 'windows';
    return 'posix';
  }

  /**
   * Git for Windows is normally NOT on PATH (`bash.exe` lives in the install
   * tree, only `git.exe` is linked into `cmd`). Probe the install roots and the
   * `git.exe` location, so Git Bash is offered exactly when it is installed.
   */
  async function gitBashCandidates() {
    const roots = [];
    const push = (value) => {
      if (typeof value === 'string' && value.trim()) roots.push(value.trim());
    };
    const home = homeDirectory();
    for (const base of [process.env.ProgramFiles, process.env.ProgramW6432, process.env['ProgramFiles(x86)']]) {
      if (base) push(joinPath(base, 'Git'));
    }
    if (process.env.LOCALAPPDATA) {
      push(joinPath(process.env.LOCALAPPDATA, 'Programs', 'Git'));
      push(joinPath(process.env.LOCALAPPDATA, 'Git'));
    }
    if (process.env.ProgramData) push(joinPath(process.env.ProgramData, 'scoop', 'apps', 'git', 'current'));
    if (home) push(joinPath(home, 'scoop', 'apps', 'git', 'current'));
    const candidates = [];
    for (const root of roots) {
      candidates.push(joinPath(root, 'bin', 'bash.exe'));
    }
    const git = await resolveExecutablePath('git.exe');
    if (git) {
      const leaf = git.replace(/\\/g, '/').toLowerCase();
      if (leaf.endsWith('/cmd/git.exe') || leaf.endsWith('/bin/git.exe') || leaf.endsWith('/mingw64/bin/git.exe')) {
        let root = dirnamePath(git);
        if (/[\\/](cmd|bin)$/i.test(root)) root = dirnamePath(root);
        if (/[\\/]mingw64$/i.test(root)) root = dirnamePath(root);
        candidates.push(joinPath(root, 'bin', 'bash.exe'));
        candidates.push(joinPath(root, 'usr', 'bin', 'bash.exe'));
      }
    }
    return candidates;
  }

  /** Absolute locations a shell is normally installed to on this platform. */
  function staticCandidates(id, osKind) {
    const out = [];
    const push = (value) => {
      if (typeof value === 'string' && value.trim()) out.push(value.trim());
    };
    if (osKind === 'windows') {
      const programFiles = [process.env.ProgramFiles, process.env.ProgramW6432];
      if (id === 'pwsh') {
        for (const base of programFiles) if (base) push(joinPath(base, 'PowerShell', '7', 'pwsh.exe'));
        if (process.env.LOCALAPPDATA) push(joinPath(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe'));
      } else if (id === 'powershell') {
        if (process.env.SystemRoot) {
          push(joinPath(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
        }
      } else if (id === 'cmd') {
        if (process.env.COMSPEC) push(process.env.COMSPEC);
        if (process.env.SystemRoot) push(joinPath(process.env.SystemRoot, 'System32', 'cmd.exe'));
      } else if (id === 'nu') {
        for (const base of programFiles) if (base) push(joinPath(base, 'nu', 'bin', 'nu.exe'));
        if (process.env.LOCALAPPDATA) push(joinPath(process.env.LOCALAPPDATA, 'Programs', 'nu', 'bin', 'nu.exe'));
      }
      return out;
    }
    // Package managers install outside the login PATH: Homebrew (both prefixes),
    // MacPorts, Nix, and the usual /usr/local on Linux.
    const dirs =
      osKind === 'macos'
        ? ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', '/usr/bin', '/bin']
        : ['/usr/local/bin', '/usr/bin', '/bin', '/snap/bin', '/run/current-system/sw/bin'];
    const binary = POSIX_BINARIES[id];
    if (binary) for (const dir of dirs) push(joinPath(dir, binary));
    return out;
  }

  function readTextFile(file) {
    if (!fsMod || typeof fsMod.readFileSync !== 'function') return null;
    try {
      return String(fsMod.readFileSync(file, 'utf8'));
    } catch (err) {
      return null;
    }
  }

  /** `/etc/shells` is the authoritative list of login shells on a POSIX host. */
  function etcShells() {
    const text = readTextFile('/etc/shells');
    if (!text) return [];
    const out = [];
    for (const line of text.split(/\r?\n/)) {
      const value = line.replace(/#.*$/, '').trim();
      if (value.startsWith('/')) out.push(value);
    }
    return out;
  }

  /** Which family of device this host is: windows, macos or linux. */
  function systemKind(platform) {
    if (platform === 'windows') return 'windows';
    const name = typeof process !== 'undefined' && process.platform ? process.platform : '';
    if (name === 'darwin') return 'macos';
    if (name === 'win32') return 'windows';
    return 'linux';
  }

  /** `C:\Windows\System32\bash.exe` is the WSL launcher, never Git Bash. */
  function isWslBash(resolvedPath) {
    return (
      /[\\/]system32[\\/]bash\.exe$/i.test(resolvedPath) ||
      /[\\/]windowsapps[\\/]/i.test(resolvedPath) ||
      /[\\/]wsl\.exe$/i.test(resolvedPath)
    );
  }

  /** wsl.exe prints UTF-16LE; reading that as latin1 leaves a NUL every other byte. */
  function decodeWslOutput(buffer) {
    if (!buffer) return '';
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer), 'utf8');
    let zeros = 0;
    for (let index = 1; index < bytes.length; index += 2) if (bytes[index] === 0) zeros += 1;
    if (bytes.length > 2 && zeros > bytes.length / 4) return bytes.toString('utf16le');
    return bytes.toString('utf8');
  }

  /** Both `--list --quiet` (names only) and `--list` (columns) parse to names. */
  function parseWslList(text) {
    const names = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.replace(/\u0000/g, '').replace(/\uFEFF/g, '').trim();
      if (!line) continue;
      if (/^name\s+state/i.test(line)) continue;
      if (/no installed distributions/i.test(line)) continue;
      if (/^wsl\b.*(usage|help)/i.test(line)) continue;
      const name = (line.split(/\s{2,}/)[0] || line).replace(/^\*\s*/, '').trim();
      if (!name || names.includes(name)) continue;
      names.push(name);
    }
    return names;
  }

  function runWsl(path, args) {
    return new Promise((resolve) => {
      let settled = false;
      let child;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        child = childMod.execFile(
          path,
          args,
          { encoding: 'buffer', windowsHide: true, timeout: 4000, maxBuffer: 1 << 20 },
          (err, stdout) => done(err ? null : decodeWslOutput(stdout)),
        );
      } catch (err) {
        done(null);
      }
      // A machine with WSL installed but no distribution can hang here.
      setTimeout(() => {
        try {
          if (child && typeof child.kill === 'function') child.kill();
        } catch (err) {
          /* already gone */
        }
        done(null);
      }, 5000);
    });
  }

  /** One picker entry per WSL distribution; empty when WSL is not installed. */
  async function wslDistributions() {
    if (!childMod || typeof childMod.execFile !== 'function') return [];
    if (!(await canResolve('wsl.exe'))) return [];
    const path = (await resolveExecutablePath('wsl.exe')) || 'wsl.exe';
    let text = await runWsl(path, ['--list', '--quiet']);
    let names = text ? parseWslList(text) : [];
    if (!names.length) {
      text = await runWsl(path, ['--list']);
      names = text ? parseWslList(text) : [];
    }
    return names.map((name) => ({ name, path }));
  }

  /**
   * Which shell this device would open on its own. On POSIX that is the login
   * shell recorded in `$SHELL`, so it is moved to the front of the list (and
   * therefore becomes what `auto` picks); Windows keeps its fixed order.
   */
  function orderByDeviceDefault(available, platform) {
    if (platform === 'windows' || available.length < 2) return;
    const login = typeof process.env.SHELL === 'string' ? process.env.SHELL.trim() : '';
    if (!login) return;
    const leaf = login.split('/').pop().toLowerCase();
    const index = available.findIndex(
      (entry) => entry.path === login || entry.id === leaf || entry.id === login,
    );
    if (index > 0) available.unshift(available.splice(index, 1)[0]);
  }

  /** Human-readable device description, reported next to the shell list. */
  function deviceInfo(platform, osKind, available) {
    const safe = (fn) => {
      try {
        return fn();
      } catch (err) {
        return '';
      }
    };
    const arch = osMod && osMod.arch ? safe(() => osMod.arch()) : '';
    const release = osMod && osMod.release ? safe(() => osMod.release()) : '';
    const hostname = osMod && osMod.hostname ? safe(() => osMod.hostname()) : '';
    let name;
    if (osKind === 'macos') {
      name = 'macOS' + (release ? ' (Darwin ' + release + ')' : '');
    } else if (osKind === 'windows') {
      const build = release ? release.split('.').pop() : '';
      name = 'Windows' + (build ? ' (build ' + build + ')' : '');
    } else {
      const text = readTextFile('/etc/os-release');
      const match = text ? /^PRETTY_NAME="?([^"\n]+)"?/m.exec(text) : null;
      name = match && match[1].trim() ? match[1].trim() : 'Linux' + (release ? ' ' + release : '');
    }
    return {
      name,
      platform,
      os: osKind,
      arch,
      release,
      hostname,
      home: homeDirectory() || '',
      loginShell: typeof process.env.SHELL === 'string' ? process.env.SHELL : '',
      wsl: osKind === 'linux' && /microsoft/i.test(readTextFile('/proc/version') || ''),
      shells: available.length,
    };
  }

  /** Every shell this machine can run, in the order this device prefers them. */
  async function detectShells(force) {
    if (cachedShells && !force) return cachedShells;
    const platform = await platformName();
    const osKind = systemKind(platform);
    const order = SHELL_ORDER[osKind] || SHELL_ORDER.linux;
    const loginShells = platform === 'windows' ? [] : etcShells();
    const available = [];
    const missing = [];
    for (const id of order) {
      const def = SHELL_DEFS[id];
      if (!def || (def.platforms && !def.platforms.includes(platform))) continue;
      if (def.dynamic) {
        const distros = osKind === 'windows' ? await wslDistributions() : [];
        for (const distro of distros) {
          available.push({
            id: 'wsl:' + distro.name,
            label: 'WSL · ' + distro.name,
            family: def.family,
            about: distro.name + ' under Windows Subsystem for Linux',
            path: distro.path,
            args: ['-d', distro.name],
            source: 'wsl',
            distribution: distro.name,
          });
        }
        if (!distros.length) missing.push({ id, label: def.label, about: def.about, family: def.family });
        continue;
      }
      const candidates = (platform === 'windows' ? def.windows : def.posix).slice();
      candidates.push(...staticCandidates(id, osKind));
      for (const file of loginShells) {
        const leaf = file.split('/').pop().toLowerCase();
        const known = leaf === id.toLowerCase() || candidates.some((name) => name.split(/[\\/]/).pop().toLowerCase() === leaf);
        if (known && !candidates.includes(file)) candidates.push(file);
      }
      if (id === 'gitbash' && platform === 'windows') candidates.push(...(await gitBashCandidates()));
      let hit = null;
      for (const candidate of candidates) {
        if (!(await canResolve(candidate))) continue;
        const resolved = await toolPath(candidate);
        if (id === 'gitbash' && isWslBash(resolved)) continue;
        if (available.some((entry) => entry.path === resolved)) continue;
        hit = { resolved, fromLoginShells: loginShells.includes(candidate) };
        break;
      }
      if (!hit) {
        missing.push({ id, label: def.label, about: def.about || '', family: def.family || '' });
        continue;
      }
      available.push({
        id,
        label: def.label,
        family: def.family || '',
        about: def.about || '',
        path: hit.resolved,
        args: def.args.slice(),
        source: id === 'gitbash' && platform === 'windows' ? 'git' : hit.fromLoginShells ? 'login-shell' : 'path',
      });
    }
    orderByDeviceDefault(available, platform);
    const detected = {
      platform,
      osKind,
      device: deviceInfo(platform, osKind, available),
      home: homeDirectory() || null,
      available,
      missing,
    };
    // Cache only a successful probe: a machine where nothing resolved yet must
    // be re-probed on the next call instead of reporting "none" forever.
    if (available.length) cachedShells = detected;
    return detected;
  }

  async function shellSpec(requested) {
    const detected = await detectShells();
    const settings = readSettings();
    const explicit = typeof requested === 'string' ? requested.trim().toLowerCase() : '';
    // An explicit request wins; otherwise the configured default applies, and
    // it silently falls back to the first installed shell when it is gone.
    const wanted =
      explicit && explicit !== 'default' && explicit !== 'auto' ? explicit : configuredShell(detected, settings);
    if (wanted && wanted !== 'default' && wanted !== 'auto') {
      const match = detected.available.find((entry) => entry.id === wanted || entry.label.toLowerCase() === wanted);
      if (!match) {
        if (!explicit) {
          // The configured shell disappeared: fall back to auto instead of failing.
          const first = detected.available[0];
          if (first) return { ...first, argv: [first.path, ...first.args], platform: detected.platform };
        }
        const installed = detected.available.map((entry) => entry.id).join(', ') || 'none';
        const known = SHELL_DEFS[wanted] ? 'that shell is not installed on this machine' : 'unknown shell ' + JSON.stringify(requested);
        throw new Error(known + ' (available: ' + installed + ')');
      }
      return { ...match, argv: [match.path, ...match.args], platform: detected.platform };
    }
    const first = detected.available[0];
    if (first) return { ...first, argv: [first.path, ...first.args], platform: detected.platform };
    // Nothing detected: fall back to the provider's own default shell.
    let fallback;
    const svc = subprocess();
    try {
      if (svc && typeof svc.terminalEnvironment === 'function') {
        const env = await svc.terminalEnvironment();
        if (env && typeof env.defaultShell === 'string' && env.defaultShell.trim()) fallback = env.defaultShell.trim();
      }
    } catch (err) {
      /* fall below */
    }
    const shell = fallback || (detected.platform === 'windows' ? 'cmd.exe' : '/bin/bash');
    const path = await toolPath(shell);
    const base = shell.replace(/\\/g, '/').split('/').pop().toLowerCase();
    const args = base.startsWith('powershell') || base.startsWith('pwsh') ? ['-NoLogo'] : base.startsWith('cmd') ? [] : ['-l'];
    return { id: shell, label: shell, path, args, argv: [path, ...args], platform: detected.platform };
  }

  // -------------------------------------------------------------- workspace

  function pathOf(entry) {
    if (typeof entry === 'string') return entry.trim() || undefined;
    if (!entry || typeof entry !== 'object') return undefined;
    for (const key of ['path', 'root', 'directory', 'cwd', 'folder', 'dir', 'workspacePath']) {
      const value = entry[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
  }

  function workspacePath() {
    try {
      const registrySvc = ctx.get('workspaceRegistry');
      const list = registrySvc && typeof registrySvc.list === 'function' ? registrySvc.list() : undefined;
      if (Array.isArray(list)) {
        for (let i = list.length - 1; i >= 0; i -= 1) {
          const found = pathOf(list[i]);
          if (found) return found;
        }
      }
    } catch (err) {
      /* registry absent or not ready */
    }
    return undefined;
  }

  /**
   * Where a new terminal starts: the same place an OS-opened terminal lands —
   * the user's home directory. The session workspace is only the fallback.
   */
  async function defaultCwd() {
    const home = homeDirectory();
    if (home && directoryExists(home)) return home;
    const known = workspacePath();
    if (known && directoryExists(known)) return known;
    if (known) return known;
    if (home) return home;
    return typeof process !== 'undefined' && process.cwd ? process.cwd() : '.';
  }

  function expandHome(value) {
    if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
      const home = homeDirectory();
      if (home) return value.length === 1 ? home : joinPath(home, value.slice(2));
    }
    return value;
  }

  async function resolveCwd(explicit) {
    const text = typeof explicit === 'string' ? explicit.trim() : '';
    if (text) {
      const expanded = expandHome(text);
      const base = isAbsolutePath(expanded) ? expanded : joinPath(await defaultCwd(), expanded);
      const target = normalizePath(base);
      if (!directoryExists(target)) throw new Error('working directory does not exist: ' + target);
      return target;
    }
    return defaultCwd();
  }

  // -------------------------------------------------------------- terminals

  const base64 = (text) => Buffer.from(text, 'utf8').toString('base64');

  function sendEvent(res, event, payload) {
    try {
      if (event) res.write('event: ' + event + '\n');
      res.write('data: ' + payload + '\n\n');
      return true;
    } catch (err) {
      return false;
    }
  }

  function push(record, text) {
    if (!text) return;
    record.history.push(text);
    record.historyBytes += text.length;
    record.total = (record.total || 0) + text.length;
    record.lastOutputAt = Date.now();
    // Terminal-mode escapes alone are not a ready shell: a real shell has
    // painted something. Once that happened the check is skipped forever.
    if (!record.ready && hasVisibleText(text)) {
      record.ready = true;
      record.readyAt = record.lastOutputAt;
    }
    while (record.historyBytes > HISTORY_LIMIT && record.history.length > 1) {
      record.historyBytes -= record.history.shift().length;
    }
    const payload = base64(text);
    for (const listener of Array.from(record.listeners)) {
      if (!sendEvent(listener, 'data', payload)) record.listeners.delete(listener);
    }
    // push() may drop the last listener itself; the keepalive must not outlive it.
    if (!record.listeners.size && record.keepalive) {
      clearInterval(record.keepalive);
      record.keepalive = null;
    }
  }

  function publicItem(record) {
    return {
      id: record.id,
      title: record.title,
      cwd: record.cwd,
      shell: record.shell,
      shellLabel: record.shellLabel,
      pid: record.pid || null,
      cols: record.cols,
      rows: record.rows,
      status: record.status,
      exitCode: record.exitCode === undefined ? null : record.exitCode,
      resizable: Boolean(record.resizable),
      createdAt: record.createdAt,
    };
  }

  async function listTerminals() {
    const detected = await detectShells();
    return {
      items: Array.from(terminals.values()).map(publicItem),
      cwd: await defaultCwd(),
      home: homeDirectory() || null,
      defaultShell: detected.available.length ? detected.available[0].id : null,
    };
  }

  async function createTerminal(args) {
    const svc = subprocess();
    if (!svc || typeof svc.spawnTerminal !== 'function') {
      throw new Error('this deployment has no terminal backend (subprocess.spawnTerminal unavailable)');
    }
    const running = Array.from(terminals.values()).filter((record) => record.status === 'running').length;
    if (running >= MAX_TERMINALS) {
      throw new Error('too many terminals are running (' + MAX_TERMINALS + '); close one first');
    }
    evictOldestExited();
    const spec = await shellSpec(args && args.shell);
    const cwd = await resolveCwd(args && args.cwd);
    const cols = clampInt(args && args.cols, 20, 400, 100);
    const rows = clampInt(args && args.rows, 5, 120, 28);
    const handle = await svc.spawnTerminal({
      argv: spec.argv,
      cwd,
      env: {
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        LANG: 'en_US.UTF-8',
      },
      rows,
      cols,
      terminalType: 'xterm-256color',
      shellActivity: true,
      graceMs: 3000,
    });
    const n = seq + 1;
    seq = n;
    registry.seq = n;
    const requestedTitle = typeof (args && args.title) === 'string' ? args.title.replace(/\s+/g, ' ').trim() : '';
    const record = {
      id: 'term-' + n + '-' + Date.now().toString(36),
      title: (requestedTitle || 'Terminal ' + n).slice(0, 60),
      cwd,
      shell: spec.id,
      shellLabel: spec.label,
      cols,
      rows,
      pid: handle && handle.pid ? handle.pid : null,
      status: 'running',
      exitCode: undefined,
      createdAt: Date.now(),
      lastOutputAt: Date.now(),
      total: 0,
      ready: false,
      resizable: Boolean(handle && typeof handle.resize === 'function'),
      handle,
      history: [],
      historyBytes: 0,
      listeners: new Set(),
      keepalive: null,
    };
    terminals.set(record.id, record);

    const output = handle && handle.output;
    if (output && typeof output.on === 'function') {
      if (typeof output.setEncoding === 'function') output.setEncoding('utf8');
      output.on('data', (chunk) => push(record, typeof chunk === 'string' ? chunk : String(chunk)));
      output.on('error', () => undefined);
    }
    Promise.resolve(handle.done).then(
      (outcome) => {
        record.status = 'exited';
        record.exitCode = outcome && typeof outcome.exitCode === 'number' ? outcome.exitCode : null;
        for (const listener of Array.from(record.listeners)) sendEvent(listener, 'exit', String(record.exitCode));
      },
      () => {
        record.status = 'exited';
        record.exitCode = null;
        for (const listener of Array.from(record.listeners)) sendEvent(listener, 'exit', 'null');
      },
    );    return {
      item: publicItem(record),
      shell: spec.id,
      shellLabel: spec.label,
      shellPath: spec.path,
      platform: spec.platform,
      resizable: record.resizable,
    };
  }

  /**
   * Exited terminals stay in the list so their last output is still readable.
   * When too many pile up, the oldest of them make room for a new terminal.
   */
  function evictOldestExited() {
    if (terminals.size < MAX_TERMINAL_RECORDS) return;
    const exited = Array.from(terminals.values())
      .filter((record) => record.status !== 'running')
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const record of exited) {
      if (terminals.size < MAX_TERMINAL_RECORDS) return;
      detach(record);
      terminals.delete(record.id);
    }
  }

  async function writeTerminal(args) {
    const record = requireRecord(args && args.id);
    const data = typeof (args && args.data) === 'string' ? args.data : '';
    if (!data) return { id: record.id, written: 0 };
    if (record.status !== 'running' || !record.handle) throw new Error('terminal ' + record.id + ' has exited');
    await waitForReady(record, READY_TIMEOUT_MS);
    if (record.status !== 'running' || !record.handle) throw new Error('terminal ' + record.id + ' has exited');
    await record.handle.write(data);
    return { id: record.id, written: data.length };
  }

  async function resizeTerminal(args) {
    const record = requireRecord(args && args.id);
    const cols = clampInt(args && args.cols, 20, 400, record.cols);
    const rows = clampInt(args && args.rows, 5, 120, record.rows);
    if (record.status === 'running' && record.handle && typeof record.handle.resize === 'function') {
      await record.handle.resize(cols, rows);
      record.cols = cols;
      record.rows = rows;
    }
    return { item: publicItem(record), resized: record.cols === cols && record.rows === rows };
  }

  async function closeTerminal(args) {
    const record = requireRecord(args && args.id);
    if (record.status === 'running' && record.handle) {
      try {
        await record.handle.terminate();
      } catch (err) {
        /* already gone */
      }
    }
    record.status = 'exited';
    if (record.exitCode === undefined) record.exitCode = null;
    if (args && args.remove === true) {
      detach(record);
      terminals.delete(record.id);
      return { item: publicItem(record), removed: true };
    }
    return { item: publicItem(record), removed: false };
  }

  function removeTerminal(args) {
    const record = requireRecord(args && args.id);
    if (record.status === 'running') throw new Error('close the terminal before removing it');
    detach(record);
    terminals.delete(record.id);
    return { removed: record.id };
  }

  function renameTerminal(args) {
    const record = requireRecord(args && args.id);
    const raw = typeof (args && args.title) === 'string' ? args.title : '';
    const title = raw.replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!title) throw new Error('a terminal name cannot be empty');
    record.title = title;
    return { item: publicItem(record) };
  }

  function requireRecord(id) {
    const key = typeof id === 'string' ? id.trim() : '';
    const record = key ? terminals.get(key) : undefined;
    if (!record) {
      const known = Array.from(terminals.keys());
      throw new Error(
        'unknown terminal ' + JSON.stringify(key || '') + (known.length ? ' (open: ' + known.join(', ') + ')' : ' (no terminals are open)'),
      );
    }
    return record;
  }

  function detach(record) {
    if (record.keepalive) {
      clearInterval(record.keepalive);
      record.keepalive = null;
    }
    for (const listener of Array.from(record.listeners)) {
      try {
        listener.end();
      } catch (err) {
        /* already closed */
      }
      record.listeners.delete(listener);
    }
  }

  function streamTerminal(req, res, record) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    res.write(': terminal ' + record.id + '\n\n');
    record.listeners.add(res);
    if (record.history.length) sendEvent(res, 'history', base64(record.history.join('')));
    sendEvent(res, 'status', record.status);
    if (record.status !== 'running') sendEvent(res, 'exit', String(record.exitCode));
    if (!record.keepalive) {
      record.keepalive = setInterval(() => {
        if (!record.listeners.size) return;
        for (const listener of Array.from(record.listeners)) {
          try {
            listener.write(': keepalive\n\n');
          } catch (err) {
            record.listeners.delete(listener);
          }
        }
      }, KEEPALIVE_MS);
    }
    const drop = () => {
      record.listeners.delete(res);
      if (!record.listeners.size && record.keepalive) {
        clearInterval(record.keepalive);
        record.keepalive = null;
      }
    };
    req.on('close', drop);
    req.on('error', drop);
    res.on('error', drop);
  }

  // ------------------------------------------------------------------ reads

  /**
   * Terminal output as plain text: escapes removed, carriage-return redraws
   * collapsed, bounded to the tail. Offsets are non-consuming, so the panel,
   * the model and a second reader never steal each other's input.
   */
  function readTerminal(args) {
    const record = requireRecord(args && args.id);
    if (typeof record.total !== 'number') record.total = record.historyBytes || 0;
    const buffered = record.history.join('');
    const bufferStart = record.total - buffered.length;
    const rawOffset = args ? args.offset : undefined;
    const parsedOffset = typeof rawOffset === 'number' ? rawOffset : Number.parseInt(rawOffset, 10);
    const requested = Number.isFinite(parsedOffset) ? Math.max(0, Math.floor(parsedOffset)) : bufferStart;
    const start = Math.min(Math.max(requested, 0), record.total);
    const from = Math.max(start, bufferStart);
    const dropped = from > start;
    const maxChars = clampInt(args && args.maxChars, 200, READ_MAX_CHARS, READ_DEFAULT_CHARS);
    let raw = buffered.slice(from - bufferStart);
    let tailCut = false;
    if (raw.length > maxChars) {
      let cut = raw.length - maxChars;
      // Never start the window on a low surrogate: that halves a character.
      if (cut > 0 && /[\uDC00-\uDFFF]/.test(raw[cut])) cut += 1;
      raw = raw.slice(cut);
      tailCut = true;
    }
    // The offset the returned window really starts at: the requested offset
    // unless older output was evicted or the window was trimmed.
    const shownOffset = record.total - raw.length;
    let text = stripAnsi(raw);
    const rawLines = args ? args.lines : undefined;
    // `lines: 0` (or a missing/blank value) means "no line limit".
    const lines =
      rawLines === undefined || rawLines === null || rawLines === ''
        ? 0
        : clampInt(rawLines, 0, 5000, 0);
    if (lines > 0) {
      const split = text.split('\n');
      if (split.length > lines) {
        text = split.slice(split.length - lines).join('\n');
        tailCut = true;
      }
    }
    return {
      id: record.id,
      title: record.title,
      status: record.status,
      exitCode: record.exitCode === undefined ? null : record.exitCode,
      text,
      offset: shownOffset,
      nextOffset: record.total,
      total: record.total,
      dropped,
      tailCut,
    };
  }

  /** Remove complete escape sequences; a trailing incomplete one is dropped. */
  function stripEscapes(text) {
    const out = text
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
      .replace(/\u001b[P^_][^\u001b]*\u001b\\/g, '')
      .replace(/\u001b\[[0-9;:?<>=]*[ -/]*[@-~]/g, '')
      .replace(/\u001b[@-Z\\-_]/g, '')
      .replace(/\u001b[()][0-9A-Za-z]/g, '');
    const tail = out.lastIndexOf('\u001b');
    if (tail === -1) return out;
    const complete = /^\u001b(?:\[[0-9;:?<>=]*[ -/]*[@-~]|[@-Z\\-_]|\][^\u0007]*\u0007|[()][0-9A-Za-z])/.test(
      out.slice(tail),
    );
    return complete ? out : out.slice(0, tail);
  }

  function stripAnsi(text) {
    if (!text) return '';
    let out = stripEscapes(text);
    // Normal line endings first: a `\r` that terminates a `\r\n` is a newline,
    // not a redraw. Only a lone `\r` rewrites the line it sits on.
    out = out.replace(/\r\n/g, '\n');
    if (out.indexOf('\r') !== -1) {
      out = out
        .split('\n')
        .map((line) => (line.indexOf('\r') === -1 ? line : line.slice(line.lastIndexOf('\r') + 1)))
        .join('\n');
    }
    return out.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  }

  /**
   * Send one command line and (optionally) wait for it to settle. There is no
   * shell-integration handshake to lean on, so settling is a heuristic: the
   * command is done when the PTY reports idle AND no output arrived for
   * `idleMs`. It always gives up at `timeoutMs` and reports `timedOut`.
   */
  async function execTerminal(args, signal) {
    const record = requireRecord(args && args.id);
    if (record.status !== 'running' || !record.handle) throw new Error('terminal ' + record.id + ' has exited');
    const command = typeof (args && args.command) === 'string' ? args.command : '';
    if (!command.trim()) throw new Error('command cannot be empty');
    const submit = /[\r\n]$/.test(command) ? command : command + '\r';
    await waitForReady(record, READY_TIMEOUT_MS);
    if (record.status !== 'running' || !record.handle) throw new Error('terminal ' + record.id + ' has exited');
    const offset = record.total;
    await record.handle.write(submit);
    const wait = !(args && args.wait === false);
    let timedOut = false;
    let aborted = false;
    let settled = wait ? 'quiet' : 'not-waited';
    if (wait) {
      const timeoutMs = clampInt(args && args.timeoutMs, 250, EXEC_MAX_TIMEOUT_MS, EXEC_DEFAULT_TIMEOUT_MS);
      const idleMs = clampInt(args && args.idleMs, 120, 10000, EXEC_IDLE_MS);
      const outcome = await waitForIdle(record, signal, timeoutMs, idleMs);
      timedOut = outcome.timedOut;
      aborted = outcome.aborted;
      settled = outcome.settled;
    }
    const read = readTerminal({ id: record.id, offset, maxChars: args && args.maxChars, lines: args && args.lines });
    return { ...read, command, timedOut, aborted, settled, exited: record.status !== 'running' };
  }

  /**
   * A ConPTY emits terminal-mode escapes long before the shell is listening:
   * writing then loses the bytes. Wait until the shell has painted something
   * visible and the stream has been quiet for a moment — PowerShell and Git
   * Bash both take about a second to source their profiles.
   */
  async function waitForReady(record, timeoutMs) {
    if (record.ready) return;
    const deadline = Date.now() + timeoutMs;
    let last = record.total || 0;
    let quietSince = 0;
    while (Date.now() < deadline) {
      if (record.status !== 'running') return;
      if (record.ready) {
        const total = record.total || 0;
        if (total !== last) {
          last = total;
          quietSince = 0;
        } else {
          if (!quietSince) quietSince = Date.now();
          if (Date.now() - quietSince >= READY_QUIET_MS) return;
        }
      }
      await sleep(60);
    }
  }

  function hasVisibleText(text) {
    return /[^\s]/.test(stripEscapes(text));
  }

  async function waitForIdle(record, signal, timeoutMs, idleMs) {
    const started = Date.now();
    let lastChange = started;
    let lastTotal = record.total || 0;
    let sawBusy = false;
    for (;;) {
      if (signal && signal.aborted) return { timedOut: false, aborted: true, settled: 'aborted' };
      if (record.status !== 'running') return { timedOut: false, aborted: false, settled: 'exited' };
      if ((record.total || 0) !== lastTotal) {
        lastTotal = record.total || 0;
        lastChange = Date.now();
      }
      if (record.lastOutputAt && record.lastOutputAt > lastChange) lastChange = record.lastOutputAt;
      let activity;
      try {
        activity =
          record.handle && typeof record.handle.inspectActivity === 'function'
            ? await record.handle.inspectActivity()
            : undefined;
      } catch (err) {
        activity = undefined;
      }
      const busy = Boolean(activity && activity.state === 'busy');
      if (busy) sawBusy = true;
      const quiet = Date.now() - lastChange >= idleMs;
      const warm = Date.now() - started >= EXEC_MIN_WAIT_MS;
      if (quiet && warm && !busy) {
        return { timedOut: false, aborted: false, settled: sawBusy ? 'idle' : 'quiet' };
      }
      if (Date.now() - started >= timeoutMs) return { timedOut: true, aborted: false, settled: 'timeout' };
      await sleep(EXEC_POLL_MS);
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ------------------------------------------------------------------ tools

  /** The configured default shell, but only while it is actually installed. */
  function configuredShell(detected, settings) {
    const wanted = settings && typeof settings.defaultShell === 'string' ? settings.defaultShell.trim() : '';
    if (!wanted) return '';
    return detected.available.some((entry) => entry.id === wanted) ? wanted : '';
  }

  async function shellReport(force) {
    const detected = await detectShells(force);
    const dir = await defaultCwd();
    const settings = readSettings();
    const configured = configuredShell(detected, settings);
    return {
      platform: detected.platform,
      osKind: detected.osKind || detected.platform,
      device: detected.device || null,
      home: detected.home || '',
      defaultCwd: dir,
      defaultShell: configured || (detected.available.length ? detected.available[0].id : ''),
      configuredShell: settings.defaultShell || '',
      shells: detected.available.map((entry, index) => ({
        id: entry.id,
        label: entry.label,
        family: entry.family || '',
        about: entry.about || '',
        source: entry.source || '',
        path: entry.path,
        args: Array.isArray(entry.args) ? entry.args.slice() : [],
        default: (configured || detected.available[0].id) === entry.id,
        auto: index === 0,
      })),
      // Kept as ids for backwards compatibility; missingShells carries the labels.
      missing: detected.missing.map((entry) => entry.id),
      missingShells: detected.missing.map((entry) => ({
        id: entry.id,
        label: entry.label,
        family: entry.family || '',
        about: entry.about || '',
      })),
      sessions: terminals.size,
    };
  }

  /** Everything the settings UI and the API report about the current state. */
  async function settingsReport() {
    const detected = await detectShells();
    const settings = readSettings();
    const configured = configuredShell(detected, settings);
    const status = hostStatus() || {};
    const file = settingsFilePath();
    return {
      defaultShell: configured,
      requestedShell: settings.defaultShell || '',
      defaultShellInstalled: !settings.defaultShell || Boolean(configured),
      effectiveShell: configured || (detected.available.length ? detected.available[0].id : ''),
      autoShell: detected.available.length ? detected.available[0].id : '',
      toolsEnabled: settings.toolsEnabled !== false,
      toolsRegistered: typeof status.toolCount === 'number' ? status.toolCount : 0,
      toolNames: Array.isArray(status.toolNames) ? status.toolNames : [],
      toolError: typeof status.error === 'string' ? status.error : null,
      osKind: detected.osKind || detected.platform,
      device: detected.device || null,
      shells: detected.available.map((entry) => ({
        id: entry.id,
        label: entry.label,
        family: entry.family || '',
        about: entry.about || '',
        source: entry.source || '',
        path: entry.path,
        installed: true,
      })),
      missing: detected.missing.map((entry) => entry.id),
      missingShells: detected.missing.map((entry) => ({
        id: entry.id,
        label: entry.label,
        family: entry.family || '',
        about: entry.about || '',
      })),
      defaultCwd: await defaultCwd(),
      settingsPath: file,
      persistent: Boolean(file && fsMod && typeof fsMod.writeFileSync === 'function'),
    };
  }

  /** Apply a settings patch posted from the panel, then re-register tools. */
  async function applySettings(args) {
    const patch = {};
    if (args && typeof args.defaultShell === 'string') {
      const wanted = args.defaultShell.trim();
      if (wanted && wanted !== 'auto') {
        const detected = await detectShells(true);
        if (!detected.available.some((entry) => entry.id === wanted)) {
          throw new Error('that shell is not installed on this machine: ' + JSON.stringify(wanted));
        }
        patch.defaultShell = wanted;
      } else {
        patch.defaultShell = '';
      }
    }
    if (args && typeof args.toolsEnabled === 'boolean') patch.toolsEnabled = args.toolsEnabled;
    if (Object.keys(patch).length) writeSettings(patch);
    // Turning the tools off must take effect for the next model step, and
    // turning them back on must restore them without a reload.
    attachTools(ctx);
    return settingsReport();
  }

  /**
   * The model-facing projection of a terminal. Every declared output-schema
   * field must be present with its declared type, so an unknown pid is simply
   * omitted instead of being reported as null.
   */
  function toolItem(record) {
    const item = {
      id: record.id,
      title: record.title,
      shell: record.shell,
      shellLabel: record.shellLabel,
      cwd: record.cwd,
      status: record.status,
      cols: record.cols,
      rows: record.rows,
    };
    if (typeof record.pid === 'number' && record.pid > 0) item.pid = record.pid;
    return item;
  }

  function buildTools() {
    const textOutput = (schema, render) => ({
      schema,
      render: (args, value) => [{ type: 'text', text: render(args, value) }],
    });

    const terminalFields = {
      id: { type: 'string', description: 'Terminal id (as returned by terminal_create or terminal_list).' },
      title: { type: 'string', description: 'Display name shown on the panel tab.' },
      shell: { type: 'string', description: 'Shell id as listed by terminal_shells (for example pwsh, powershell, cmd, gitbash, bash, zsh, fish, wsl:<distro>).' },
      shellLabel: { type: 'string', description: 'Human-readable shell name.' },
      cwd: { type: 'string', description: 'Working directory of the terminal.' },
      status: { type: 'string', description: 'running or exited.' },
      cols: { type: 'integer', description: 'Terminal width in columns.' },
      rows: { type: 'integer', description: 'Terminal height in rows.' },
      pid: { type: 'integer', description: 'Operating-system process id of the shell.' },
    };

    return [
      {
        name: 'terminal_shells',
        description:
          'List the terminal shells that are really installed on THIS device, the shell a new terminal uses by default, and the default working directory (the user home directory, like an OS-opened terminal). '
          + 'The list is device-specific: Windows offers PowerShell 7 (pwsh), Windows PowerShell, Command Prompt (cmd), Git Bash and one entry per WSL distribution; macOS and Linux offer the shells found on PATH and in /etc/shells (zsh, bash, fish, sh, Nushell, PowerShell 7, ksh, tcsh). '
          + 'Each entry carries the shell id to pass to terminal_create. Call this before terminal_create whenever the user asks for a specific shell, asks what this machine can run, or asks whether one is installed.',
        parameters: { type: 'object', properties: {} },
        output: textOutput(
          {
            type: 'object',
            properties: {
              platform: { type: 'string', description: 'windows or posix.' },
              osKind: { type: 'string', description: 'windows, macos or linux.' },
              device: { type: 'object', description: 'Device this session runs on: name, arch, release, hostname, home, loginShell.' },
              home: { type: 'string', description: 'User home directory.' },
              defaultCwd: { type: 'string', description: 'Directory a new terminal starts in.' },
              defaultShell: { type: 'string', description: 'Shell id used when terminal_create omits shell.' },
              shells: { type: 'array', items: { type: 'object' }, description: 'Installed shells: id, label, family, about, path, default, auto.' },
              missing: { type: 'array', items: { type: 'string' }, description: 'Known shells that are NOT installed, as ids.' },
              missingShells: { type: 'array', items: { type: 'object' }, description: 'Known shells that are NOT installed, as {id, label, about}.' },
            },
          },
          (args, value) => {
            const model = value || {};
            const shells = Array.isArray(model.shells) ? model.shells : [];
            const device = model.device || {};
            const lines = shells.map(
              (shell) => '  - ' + shell.id + ' (' + shell.label + ')' + (shell.default ? ' [default]' : '') + ' → ' + shell.path
                + (shell.about ? ' — ' + shell.about : ''),
            );
            const missing = Array.isArray(model.missingShells) && model.missingShells.length
              ? model.missingShells.map((entry) => (entry && entry.label ? entry.label : String(entry))).join(', ')
              : (Array.isArray(model.missing) ? model.missing : []).join(', ');
            return [
              'Device: ' + (device.name || '?') + (device.arch ? ' ' + device.arch : '') + ' | platform: ' + (model.platform || '?') + (model.osKind ? ' (' + model.osKind + ')' : '')
                + (device.hostname ? ' | host: ' + device.hostname : ''),
              'Default shell: ' + (model.defaultShell || '?') + ' | default working directory: ' + (model.defaultCwd || '?'),
              'Installed shells:',
              ...(lines.length ? lines : ['  (none detected)']),
              'Not installed: ' + (missing || 'none'),
            ].join('\n');
          },
        ),
        isConcurrencySafe: () => true,
        execute: async (args) => shellReport(false),
      },
      {
        name: 'terminal_list',
        description:
          'List every terminal currently open in the Terminal panel of this DeepSeek Harness session, with its id, shell, working directory and status. '
          + 'Terminals created by the user in the panel and terminals created by terminal_create appear in the same list.',
        parameters: { type: 'object', properties: {} },
        output: textOutput(
          {
            type: 'object',
            properties: {
              terminals: {
                type: 'array',
                items: { type: 'object', properties: terminalFields },
                description: 'One entry per open terminal.',
              },
              defaultShell: { type: 'string', description: 'Shell id used when terminal_create omits shell.' },
              defaultCwd: { type: 'string', description: 'Directory a new terminal starts in.' },
            },
          },
          (args, value) => {
            const terminals = Array.isArray(value && value.terminals) ? value.terminals : [];
            return terminals.length
              ? terminals.map((item) => '- ' + describeItem(item)).join('\n')
              : 'No terminals are open. Create one with terminal_create.';
          },
        ),
        isConcurrencySafe: () => true,
        execute: async () => {
          const detected = await detectShells();
          return {
            terminals: Array.from(terminals.values()).map(toolItem),
            defaultShell: detected.available.length ? detected.available[0].id : '',
            defaultCwd: await defaultCwd(),
          };
        },
      },
      {
        name: 'terminal_create',
        description:
          'Open a new terminal in the Terminal panel of this session and return its id. The new terminal behaves like one opened by the user: it starts in the user home directory unless cwd is given, '
          + 'and it is a real interactive PTY, not a one-shot command runner. Use terminal_shells first to see which shells exist, terminal_exec to run commands in it, and terminal_read to see its output.',
        parameters: {
          type: 'object',
          properties: {
            shell: { type: 'string', description: 'Shell id from terminal_shells, e.g. pwsh, powershell, cmd, gitbash, bash, zsh, fish or wsl:<distro>. Omit for the default shell of this device.' },
            cwd: { type: 'string', description: 'Working directory. Absolute path, or relative to the default directory; "~" means the user home directory. Omit for the default.' },
            title: { type: 'string', description: 'Display name for the panel tab (defaults to "Terminal N").' },
            cols: { type: 'integer', description: 'Initial width in columns (20-400, default 100).' },
            rows: { type: 'integer', description: 'Initial height in rows (5-120, default 28).' },
          },
        },
        output: textOutput(
          { type: 'object', properties: terminalFields },
          (args, value) => 'Created ' + describeItem(value || {}),
        ),
        execute: async (args) => {
          const created = await createTerminal(args);
          return toolItem(created.item);
        },
      },
      {
        name: 'terminal_read',
        description:
          'Read the recent output of one terminal as plain text (ANSI escape sequences and carriage-return redraws removed). '
          + 'Reading is non-consuming and offset-based: pass the returned nextOffset as offset next time to get only what is new. '
          + 'Use it to check what a command printed, or to see the current state of a terminal the user is driving.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Terminal id.' },
            offset: { type: 'integer', description: 'Start reading at this output offset (from a previous nextOffset). Omit to read the retained buffer from its start.' },
            maxChars: { type: 'integer', description: 'Maximum characters to return (200-40000, default 20000); the tail is kept.' },
            lines: { type: 'integer', description: 'Return only the last N lines of the selected range.' },
          },
          required: ['id'],
        },
        output: textOutput(
          {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Terminal id.' },
              title: { type: 'string', description: 'Terminal display name.' },
              status: { type: 'string', description: 'running or exited.' },
              text: { type: 'string', description: 'Plain-text output.' },
              offset: { type: 'integer', description: 'Offset the returned window starts at (the requested offset unless older output was evicted or the window was trimmed).' },
              nextOffset: { type: 'integer', description: 'Offset to pass next time to read only new output.' },
              total: { type: 'integer', description: 'Total output offset produced so far.' },
              dropped: { type: 'boolean', description: 'True when the requested offset was already evicted from the buffer.' },
              tailCut: { type: 'boolean', description: 'True when older text was dropped because of maxChars or lines.' },
            },
          },
          (args, value) => {
            const model = value || {};
            return (
              '[' + (model.id || '?') + ' ' + (model.status || '?') + ' | offset ' + (model.offset || 0) + '→' + (model.nextOffset || 0) + ' of ' + (model.total || 0) + ']' +
              (model.dropped ? ' (older output already evicted)' : '') +
              '\n' +
              (model.text ? model.text : '(no output)')
            );
          },
        ),
        isConcurrencySafe: () => true,
        execute: async (args) => readTerminal(args),
      },
      {
        name: 'terminal_write',
        description:
          'Send raw keystrokes to a terminal without waiting: text is written exactly as given, and a trailing carriage return is NOT added. '
          + 'Use it to type into an interactive program, answer a prompt, send a control character (\\u0003 = Ctrl+C, \\u0004 = Ctrl+D) or an escape sequence (\\u001b[A = arrow up). '
          + 'To run a command line and get its output, use terminal_exec instead.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Terminal id.' },
            data: { type: 'string', description: 'Exact bytes to send (control characters allowed).' },
          },
          required: ['id', 'data'],
        },
        output: textOutput(
          {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Terminal id.' },
              written: { type: 'integer', description: 'Number of characters written.' },
            },
          },
          (args, value) => 'Wrote ' + ((value && value.written) || 0) + ' characters to ' + ((value && value.id) || '?') + '.',
        ),
        execute: async (args) => writeTerminal(args),
      },
      {
        name: 'terminal_exec',
        description:
          'Run one command line in an existing terminal and return its output. The command is typed into the live PTY followed by Enter, so the shell keeps its state (cwd, environment, history) between calls. '
          + 'By default it waits for the command to settle and returns the output produced since the call started; pass wait=false to return immediately without waiting. '
          + 'Settling is a heuristic, reported in `settled`: "idle" means the shell had a child process that finished and went quiet, "quiet" means it only went quiet (a long command that prints nothing new may still be running), "exited" means the shell ended. '
          + 'It never kills the command: on timeout it returns timedOut and the output so far, and you can keep reading with terminal_read(offset=nextOffset) or wait again with a bigger timeoutMs/idleMs. '
          + 'Use terminal_create first to obtain a terminal id.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Terminal id.' },
            command: { type: 'string', description: 'Command line to type. A trailing newline is appended unless the command already ends with one.' },
            wait: { type: 'boolean', description: 'Wait for the command to settle before returning (default true).' },
            timeoutMs: { type: 'integer', description: 'Maximum wait in milliseconds (250-600000, default 30000).' },
            idleMs: { type: 'integer', description: 'How long the output must stay quiet to count as finished (120-10000, default 700). Raise it for commands that pause before printing.' },
            maxChars: { type: 'integer', description: 'Maximum characters of output to return (default 20000).' },
            lines: { type: 'integer', description: 'Return only the last N lines of the output.' },
          },
          required: ['id', 'command'],
        },
        output: textOutput(
          {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Terminal id.' },
              command: { type: 'string', description: 'The command that was sent.' },
              status: { type: 'string', description: 'running or exited.' },
              text: { type: 'string', description: 'Plain-text output produced by the command.' },
              nextOffset: { type: 'integer', description: 'Offset to pass to terminal_read to continue reading.' },
              timedOut: { type: 'boolean', description: 'True when the wait timed out; the command may still be running.' },
              settled: { type: 'string', description: 'Why the wait ended: idle, quiet, exited, timeout, aborted or not-waited.' },
              exited: { type: 'boolean', description: 'True when the shell exited while the command ran.' },
            },
          },
          (args, value) => {
            const model = value || {};
            const head = model.timedOut
              ? '[still running after timeout — output so far]'
              : '[finished (' + (model.settled || 'quiet') + ')' + (model.exited ? ', shell exited' : '') + ']';
            return (
              head +
              ' ' + (model.id || '?') + ' $ ' + (model.command || '') +
              '\n' +
              (model.text ? model.text : '(no output)')
            );
          },
        ),
        timeoutMs: EXEC_MAX_TIMEOUT_MS + 30000,
        execute: async (args, exec) => execTerminal(args, exec && exec.signal),
      },
      {
        name: 'terminal_resize',
        description: 'Resize one terminal (columns and rows). Useful after creating a terminal programmatically so full-screen programs wrap correctly.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Terminal id.' },
            cols: { type: 'integer', description: 'Width in columns (20-400).' },
            rows: { type: 'integer', description: 'Height in rows (5-120).' },
          },
          required: ['id'],
        },
        output: textOutput(
          { type: 'object', properties: { id: { type: 'string', description: 'Terminal id.' }, cols: { type: 'integer', description: 'Width in columns.' }, rows: { type: 'integer', description: 'Height in rows.' } } },
          (args, value) => 'Resized ' + ((value && value.id) || '?') + ' to ' + ((value && value.cols) || '?') + 'x' + ((value && value.rows) || '?') + '.',
        ),
        execute: async (args) => {
          const result = await resizeTerminal(args);
          return { id: result.item.id, cols: result.item.cols, rows: result.item.rows };
        },
      },
      {
        name: 'terminal_rename',
        description: 'Rename one terminal tab in the panel, so the user and the model can tell terminals apart.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Terminal id.' },
            title: { type: 'string', description: 'New display name (1-60 characters).' },
          },
          required: ['id', 'title'],
        },
        output: textOutput(
          { type: 'object', properties: { id: { type: 'string', description: 'Terminal id.' }, title: { type: 'string', description: 'New display name.' } } },
          (args, value) => 'Renamed ' + ((value && value.id) || '?') + ' to ' + JSON.stringify((value && value.title) || '') + '.',
        ),
        execute: async (args) => {
          const result = renameTerminal(args);
          return { id: result.item.id, title: result.item.title };
        },
      },
      {
        name: 'terminal_close',
        description:
          'Close one terminal. The shell process is terminated; pass remove=true to also drop it from the panel list (an exited terminal stays in the list otherwise, so the user can still read its output).',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Terminal id.' },
            remove: { type: 'boolean', description: 'Also remove it from the panel list (default false).' },
          },
          required: ['id'],
        },
        output: textOutput(
          {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Terminal id.' },
              status: { type: 'string', description: 'exited after closing.' },
              removed: { type: 'boolean', description: 'True when the terminal was also removed from the list.' },
            },
          },
          (args, value) => 'Closed ' + ((value && value.id) || '?') + (value && value.removed ? ' and removed it from the panel.' : '.'),
        ),
        execute: async (args) => {
          const closed = await closeTerminal(args);
          return { id: closed.item.id, status: 'exited', removed: closed.removed === true };
        },
      },
    ];
  }

  function describeItem(item) {
    return (
      item.id +
      ' [' +
      (item.shellLabel || item.shell || 'shell') +
      '] ' +
      item.title +
      ' — ' +
      item.cwd +
      ' (' +
      item.status +
      ')'
    );
  }

  function clampInt(value, min, max, fallback) {
    const number = typeof value === 'number' ? value : Number.parseInt(value, 10);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, Math.round(number)));
  }

  // ----------------------------------------------------------------- routes

  function readBody(req) {
    return new Promise((resolve) => {
      let size = 0;
      let settled = false;
      const chunks = [];
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      req.on('data', (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
        size += buffer.length;
        if (size > 1048576) {
          if (typeof req.resume === 'function') req.resume();
          finish(undefined);
          return;
        }
        chunks.push(buffer);
      });
      req.on('end', () => {
        // Decode once: a multi-byte character must not be split per TCP chunk.
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text.trim()) {
          finish({});
          return;
        }
        try {
          const parsed = JSON.parse(text);
          finish(parsed && typeof parsed === 'object' ? parsed : {});
        } catch (err) {
          finish(undefined);
        }
      });
      req.on('error', () => finish(undefined));
      // An aborted upload must settle too, or the handler never answers.
      req.on('close', () => finish(undefined));
    });
  }

  function send(res, status, payload) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(payload));
  }

  /** What host.js managed to wire up (tool registrations), for diagnostics. */
  function hostStatus() {
    try {
      return globalThis[Symbol.for('dsh-terminal-panel.host.v1')] || null;
    } catch (err) {
      return null;
    }
  }

  const routes = {
    health: async () => {
      const detected = await detectShells();
      return {
        version: 7,
        platform: detected.platform,
        shell: detected.available.length ? detected.available[0].id : null,
        shells: detected.available.map((entry) => entry.id),
        cwd: await defaultCwd(),
        home: homeDirectory() || null,
        pty: typeof (subprocess() || {}).spawnTerminal === 'function',
        terminals: terminals.size,
        host: hostStatus(),
      };
    },
    list: () => listTerminals(),
    shells: (args) => shellReport(Boolean(args && args.refresh)),
    settings: (args, req) =>
      req && req.method === 'POST' ? applySettings(args) : settingsReport(),
    create: (args) => createTerminal(args),
    write: (args) => writeTerminal(args),
    read: (args) => readTerminal(args),
    exec: (args) => execTerminal(args, undefined),
    resize: (args) => resizeTerminal(args),
    close: (args) => closeTerminal(args),
    rename: (args) => renameTerminal(args),
    remove: (args) => removeTerminal(args),
    tools: () =>
      buildTools().map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
  };

  async function handle(req, res) {
    const url = String(req.url || '');
    const path = url.split('?')[0];
    const key = path.replace(/^\/+/, '').split('/').filter(Boolean).pop() || 'list';
    if (key === 'stream') {
      const query = url.indexOf('?') === -1 ? '' : url.slice(url.indexOf('?') + 1);
      const match = /(?:^|&)id=([^&]*)/.exec(query);
      let id = '';
      try {
        id = match ? decodeURIComponent(match[1]) : '';
      } catch (err) {
        id = match ? match[1] : '';
      }
      const record = terminals.get(id);
      if (!record) {
        send(res, 404, { ok: false, error: { code: 'not_found', message: 'unknown terminal' } });
        return;
      }
      streamTerminal(req, res, record);
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(routes, key)) {
      send(res, 404, { ok: false, error: { code: 'not_found', message: 'unknown method ' + JSON.stringify(key) } });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'POST') {
      send(res, 405, { ok: false, error: { code: 'method_not_allowed', message: 'use GET or POST' } });
      return;
    }
    let args = {};
    if (req.method === 'POST') {
      // Cross-origin pages cannot set a custom header without a preflight this
      // route never grants, so this is what makes command execution safe.
      const guard = req.headers ? req.headers[GUARD_HEADER] : undefined;
      if (guard !== '1') {
        send(res, 403, {
          ok: false,
          error: { code: 'forbidden', message: 'missing ' + GUARD_HEADER + ': 1 header' },
        });
        return;
      }
      args = await readBody(req);
      if (args === undefined) {
        send(res, 400, { ok: false, error: { code: 'bad_body', message: 'request body must be JSON' } });
        return;
      }
    }
    try {
      send(res, 200, { ok: true, value: await routes[key](args, req) });
    } catch (err) {
      send(res, 200, {
        ok: false,
        error: { code: 'failed', message: err && err.message ? err.message : String(err) },
      });
    }
  }

  function dispose() {
    for (const record of Array.from(terminals.values())) {
      detach(record);
      try {
        if (record.handle && record.status === 'running') record.handle.terminate();
      } catch (err) {
        /* already gone */
      }
    }
    terminals.clear();
    registry.seq = 0;
    releaseRegistry();
  }
  /*
   * The teardown is bound to the shared registry, not to this module instance:
   * a reload loads a new instance over the same registry, and registering one
   * disposer per reload would pile up closures on the plugin fiber.
   */
  if (!registry.disposeBound) {
    registry.disposeBound = true;
    ctx.effect(() => () => dispose());
  }

  return {
    handle,
    terminals,
    tools: buildTools,
    shellReport,
    createTerminal,
    listTerminals,
    readTerminal,
    execTerminal,
    dispose,
  };
}
