/**
 * terminal-dock — Host half (route carrier + agent tool registration).
 *
 * This file carries the named webserver route, registers the agent-facing
 * `terminal_*` tools, and forwards every request to the implementation in
 * `impl.js`, which is pulled in through a cache-busted dynamic import. That
 * indirection exists because a loaded ESM module stays cached for the life of
 * the process: with it, replacing `impl.js` and calling
 * POST /system-terminals/api/__reload brings the new code in live — tool
 * schemas and bodies included — without a harness restart.
 */

const PREFIX = '/system-terminals/api';

/**
 * Where this half publishes what it managed to wire up. impl.js reads the same
 * slot for the `host` block of the health route, so a registration problem is
 * visible from the panel's own API instead of only in the process log.
 */
const STATUS_KEY = Symbol.for('dsh-terminal-panel.host.v1');

/** Same slot impl.js publishes the tool registration into (for unload). */
const TOOLS_KEY = Symbol.for('dsh-terminal-panel.tools.v1');

function report(patch) {
  try {
    globalThis[STATUS_KEY] = Object.assign({}, globalThis[STATUS_KEY], patch, { at: new Date().toISOString() });
  } catch (err) {
    /* diagnostics must never break the plugin */
  }
}

/**
 * Hard dependencies: the route needs the carrier, terminals need the process
 * plane, and the agent tools need the tool registry.
 */
export const inject = ['webServer', 'subprocess', 'tools'];

export function apply(ctx) {
  const web = ctx.webServer || ctx.get('webServer');
  if (!web || typeof web.register !== 'function') {
    console.error('[terminal-dock] webServer unavailable; host half inactive');
    return;
  }

  let impl = null;
  let loading = null;
  /** Bumped on every fresh load so a stale in-flight import cannot win. */
  let generation = 0;
  /** Module instance whose tools are currently registered. */
  let registeredModule = null;

  function load(fresh) {
    if (fresh) {
      impl = null;
      loading = null;
    }
    if (impl) return Promise.resolve(impl);
    if (!loading) {
      const url = new URL('./impl.js', import.meta.url);
      url.searchParams.set('v', String(Date.now()));
      const mine = generation + 1;
      generation = mine;
      loading = import(url.href).then(
        (mod) => {
          if (generation === mine) {
            impl = mod;
            loading = null;
          }
          return mod;
        },
        (err) => {
          if (generation === mine) loading = null;
          throw err;
        },
      );
    }
    return loading;
  }

  /**
   * Hand the tool registry over to impl.js, which owns the definitions and the
   * take-over protocol. A reload re-registers the new schemas and bodies; the
   * health route reports what happened.
   */
  function attachTools(mod) {
    if (!mod || registeredModule === mod) return;
    registeredModule = mod;
    if (typeof mod.attachTools !== 'function') {
      report({ toolService: false, toolCount: 0, toolNames: [], error: 'impl.js does not export attachTools' });
      return;
    }
    try {
      const result = mod.attachTools(ctx);
      if (result && result.count) console.log('[terminal-dock] ' + result.count + ' agent tool(s) registered');
      if (result && result.failures && result.failures.length) {
        console.error('[terminal-dock] tool registration problems: ' + result.failures.join(' | '));
      }
    } catch (err) {
      console.error('[terminal-dock] cannot attach agent tools: ' + message(err));
      report({ toolCount: 0, toolNames: [], error: message(err) });
    }
  }

  function message(err) {
    return err && err.message ? err.message : String(err);
  }

  function fail(res, code, text) {
    try {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: { code: 'host_loader', message: text } }));
    } catch (err) {
      /* response already gone */
    }
  }

  ctx.effect(() =>
    web.register({
      kind: 'prefix',
      path: PREFIX,
      handler: async (req, res) => {
        const path = String(req.url || '').split('?')[0];
        const tail = path.replace(/^\/+/, '').split('/').filter(Boolean).pop() || '';
        if (tail === '__reload') {
          try {
            const mod = await load(true);
            attachTools(mod);
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, value: { reloaded: true, tools: mod && mod.attachTools ? 'attached' : 'unavailable' } }));
          } catch (err) {
            fail(res, 500, message(err));
          }
          return;
        }
        try {
          const mod = await load(false);
          attachTools(mod);
          if (!mod || typeof mod.handle !== 'function') {
            fail(res, 500, 'impl.js does not export handle(req, res, ctx)');
            return;
          }
          await mod.handle(req, res, ctx);
        } catch (err) {
          fail(res, 500, message(err));
        }
      },
    }),
  );

  ctx.effect(() => () => {
    // Unloading the plugin must leave no `terminal_*` tool behind.
    try {
      if (typeof impl === 'object' && impl && typeof impl.detachTools === 'function') impl.detachTools();
      else {
        const entry = globalThis[TOOLS_KEY];
        if (entry && typeof entry.dispose === 'function') entry.dispose();
      }
    } catch (err) {
      /* already gone */
    }
    registeredModule = null;
    report({ toolCount: 0, toolNames: [], error: 'plugin unloaded' });
  });

  // Load eagerly so the agent tools exist even if the panel is never opened.
  load(false).then(
    (mod) => attachTools(mod),
    (err) => console.error('[terminal-dock] impl.js failed to load: ' + message(err)),
  );

  console.log('[terminal-dock] host half ready (route ' + PREFIX + ')');
}
