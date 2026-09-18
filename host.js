/**
 * terminal-dock — Host half (route carrier).
 *
 * This file only carries the named webserver route and forwards every request
 * to the implementation in `impl.js`, which is pulled in through a cache-busted
 * dynamic import. That indirection exists because a loaded ESM module stays
 * cached for the life of the process: with it, replacing `impl.js` and calling
 * POST /system-terminals/api/__reload brings the new code in live, without a
 * harness restart.
 */

const PREFIX = '/system-terminals/api';

/** Hard dependencies: the route needs the carrier, terminals need the process plane. */
export const inject = ['webServer', 'subprocess'];

export function apply(ctx) {
  const web = ctx.webServer || ctx.get('webServer');
  if (!web || typeof web.register !== 'function') {
    console.error('[terminal-dock] webServer unavailable; host half inactive');
    return;
  }

  let impl = null;
  let loading = null;

  function load(fresh) {
    if (fresh) {
      impl = null;
      loading = null;
    }
    if (impl) return Promise.resolve(impl);
    if (!loading) {
      const url = new URL('./impl.js', import.meta.url);
      url.searchParams.set('v', String(Date.now()));
      loading = import(url.href).then(
        (mod) => {
          impl = mod;
          loading = null;
          return mod;
        },
        (err) => {
          loading = null;
          throw err;
        },
      );
    }
    return loading;
  }

  function fail(res, code, message) {
    try {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: { code: 'host_loader', message } }));
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
            await load(true);
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, value: { reloaded: true } }));
          } catch (err) {
            fail(res, 500, err && err.message ? err.message : String(err));
          }
          return;
        }
        try {
          const mod = await load(false);
          if (!mod || typeof mod.handle !== 'function') {
            fail(res, 500, 'impl.js does not export handle(req, res, ctx)');
            return;
          }
          await mod.handle(req, res, ctx);
        } catch (err) {
          fail(res, 500, err && err.message ? err.message : String(err));
        }
      },
    }),
  );

  console.log('[terminal-dock] host half ready (route ' + PREFIX + ')');
}
