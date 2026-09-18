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
 */

const HISTORY_LIMIT = 262144;
const KEEPALIVE_MS = 20000;
const MAX_TERMINALS = 12;

/** One state per loaded module instance: reloading the file starts a fresh one. */
let state = null;

export async function handle(req, res, ctx) {
  if (!state) state = createState(ctx);
  return state.handle(req, res);
}

function createState(ctx) {
  /** id -> terminal record. */
  const terminals = new Map();
  const resolvedTools = new Map();
  let seq = 0;
  let cachedRoot;
  let cachedShell;

  const subprocess = () => {
    const svc = ctx.subprocess || ctx.get('subprocess');
    return svc && typeof svc.spawn === 'function' ? svc : undefined;
  };

  async function toolPath(name) {
    if (resolvedTools.has(name)) return resolvedTools.get(name);
    let path = name;
    const svc = subprocess();
    try {
      if (svc && typeof svc.resolveExecutable === 'function') {
        const resolved = await svc.resolveExecutable(name);
        if (typeof resolved === 'string' && resolved.trim()) path = resolved.trim();
      }
    } catch (err) {
      /* keep the bare name */
    }
    resolvedTools.set(name, path);
    return path;
  }

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
      const registry = ctx.get('workspaceRegistry');
      const list = registry && typeof registry.list === 'function' ? registry.list() : undefined;
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

  function workRoot() {
    if (!cachedRoot) cachedRoot = workspacePath() || '.';
    return cachedRoot;
  }

  async function resolveCwd(explicit) {
    if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
    const known = workspacePath();
    if (known) return known;
    try {
      const fsSvc = ctx.get('fs');
      if (fsSvc && typeof fsSvc.resolve === 'function' && typeof fsSvc.processPath === 'function') {
        const target = await fsSvc.resolve('.');
        const path = target ? fsSvc.processPath(target) : undefined;
        if (typeof path === 'string' && path.trim()) return path.trim();
      }
    } catch (err) {
      /* fall through */
    }
    return undefined;
  }

  /** Whether an executable can be resolved in this host's execution world. */
  async function canResolve(name) {
    const svc = subprocess();
    if (!svc || typeof svc.resolveExecutable !== 'function') return false;
    try {
      const resolved = await svc.resolveExecutable(name);
      return typeof resolved === 'string' && resolved.trim().length > 0;
    } catch (err) {
      return false;
    }
  }

  async function shellSpec() {
    if (cachedShell) return cachedShell;
    let platform = typeof process !== 'undefined' && process.platform === 'win32' ? 'windows' : 'posix';
    let fallback;
    const svc = subprocess();
    try {
      if (svc && typeof svc.terminalEnvironment === 'function') {
        const env = await svc.terminalEnvironment();
        if (env && env.platform) platform = env.platform;
        if (env && typeof env.defaultShell === 'string' && env.defaultShell.trim()) fallback = env.defaultShell.trim();
      }
    } catch (err) {
      /* fall back below */
    }
    let shell;
    if (platform === 'windows') {
      for (const candidate of ['pwsh.exe', 'powershell.exe']) {
        if (await canResolve(candidate)) {
          shell = candidate;
          break;
        }
      }
    }
    if (!shell) shell = fallback || (platform === 'windows' ? 'cmd.exe' : '/bin/bash');
    const argv = [await toolPath(shell)];
    const base = shell.replace(/\\/g, '/').split('/').pop().toLowerCase();
    if (base.startsWith('powershell') || base === 'pwsh' || base === 'pwsh.exe') argv.push('-NoLogo');
    else if (platform === 'posix') argv.push('-l');
    cachedShell = { platform, shell, argv };
    return cachedShell;
  }

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
    while (record.historyBytes > HISTORY_LIMIT && record.history.length > 1) {
      record.historyBytes -= record.history.shift().length;
    }
    const payload = base64(text);
    for (const listener of Array.from(record.listeners)) {
      if (!sendEvent(listener, 'data', payload)) record.listeners.delete(listener);
    }
  }

  function publicItem(record) {
    return {
      id: record.id,
      title: record.title,
      cwd: record.cwd,
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
    return { items: Array.from(terminals.values()).map(publicItem), cwd: workspacePath() || null };
  }

  async function createTerminal(args) {
    const svc = subprocess();
    if (!svc || typeof svc.spawnTerminal !== 'function') {
      throw new Error('this deployment has no terminal backend (subprocess.spawnTerminal unavailable)');
    }
    if (terminals.size >= MAX_TERMINALS) throw new Error('too many terminals open; close one first');
    const spec = await shellSpec();
    const cwd = (await resolveCwd(args && args.cwd)) || workRoot();
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
    const record = {
      id: 'term-' + n + '-' + Date.now().toString(36),
      title: 'Terminal ' + n,
      cwd,
      cols,
      rows,
      pid: handle && handle.pid ? handle.pid : null,
      status: 'running',
      exitCode: undefined,
      createdAt: Date.now(),
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
    );
    return { item: publicItem(record), shell: spec.shell, platform: spec.platform, resizable: record.resizable };
  }

  async function writeTerminal(args) {
    const record = requireRecord(args && args.id);
    const data = typeof (args && args.data) === 'string' ? args.data : '';
    if (!data) return {};
    if (record.status !== 'running' || !record.handle) throw new Error('terminal has exited');
    await record.handle.write(data);
    return {};
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
    return { item: publicItem(record) };
  }

  function removeTerminal(args) {
    const record = requireRecord(args && args.id);
    if (record.status === 'running') throw new Error('close the terminal before removing it');
    detach(record);
    terminals.delete(record.id);
    return {};
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
    const record = terminals.get(id);
    if (!record) throw new Error('unknown terminal');
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

  function clampInt(value, min, max, fallback) {
    const number = typeof value === 'number' ? value : Number.parseInt(value, 10);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, Math.round(number)));
  }

  function readBody(req) {
    return new Promise((resolve) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
        size += buffer.length;
        if (size > 1048576) {
          resolve(undefined);
          return;
        }
        chunks.push(buffer);
      });
      req.on('end', () => {
        // Decode once: a multi-byte character must not be split per TCP chunk.
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text.trim()) {
          resolve({});
          return;
        }
        try {
          const parsed = JSON.parse(text);
          resolve(parsed && typeof parsed === 'object' ? parsed : {});
        } catch (err) {
          resolve(undefined);
        }
      });
      req.on('error', () => resolve(undefined));
    });
  }

  function send(res, status, payload) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(payload));
  }

  const routes = {
    health: async () => {
      const spec = await shellSpec();
      return {
        version: 5,
        platform: spec.platform,
        shell: spec.shell,
        cwd: workRoot(),
        pty: typeof (subprocess() || {}).spawnTerminal === 'function',
        terminals: terminals.size,
      };
    },
    list: () => listTerminals(),
    create: (args) => createTerminal(args),
    write: (args) => writeTerminal(args),
    resize: (args) => resizeTerminal(args),
    close: (args) => closeTerminal(args),
    rename: (args) => renameTerminal(args),
    remove: (args) => removeTerminal(args),
  };

  async function handle(req, res) {
    const url = String(req.url || '');
    const path = url.split('?')[0];
    const key = path.replace(/^\/+/, '').split('/').filter(Boolean).pop() || 'list';
    if (key === 'stream') {
      const query = url.indexOf('?') === -1 ? '' : url.slice(url.indexOf('?') + 1);
      const match = /(?:^|&)id=([^&]*)/.exec(query);
      const id = match ? decodeURIComponent(match[1]) : '';
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
      args = await readBody(req);
      if (args === undefined) {
        send(res, 400, { ok: false, error: { code: 'bad_body', message: 'request body must be JSON' } });
        return;
      }
    }
    try {
      send(res, 200, { ok: true, value: await routes[key](args) });
    } catch (err) {
      send(res, 200, {
        ok: false,
        error: { code: 'failed', message: err && err.message ? err.message : String(err) },
      });
    }
  }

  ctx.effect(() => () => {
    for (const record of Array.from(terminals.values())) {
      detach(record);
      try {
        if (record.handle && record.status === 'running') record.handle.terminate();
      } catch (err) {
        /* already gone */
      }
    }
    terminals.clear();
  });

  return { handle, terminals };
}
