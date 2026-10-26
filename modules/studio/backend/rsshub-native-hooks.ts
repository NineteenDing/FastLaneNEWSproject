import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Adapts public third-party interfaces without editing installed packages or minified chunks. */
export function installRsshubHooks(entry: string) {
  const runtime = pathToFileURL(path.resolve(path.dirname(entry), "..") + path.sep).href;
  const adapters: Record<string, string> = { "rss-parser": "parser", "@hono/node-server": "server",
    "@opentelemetry/exporter-prometheus": "metrics", "@opentelemetry/sdk-trace-base": "trace" };
  registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL?.startsWith(runtime) && Object.hasOwn(adapters, specifier)) {
        const kind = adapters[specifier]!;
        return { url: "studio-rsshub:" + kind + "?original=" + encodeURIComponent(next(specifier, context).url), shortCircuit: true };
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url.startsWith("studio-rsshub:trace?")) {
        const original = JSON.stringify(new URL(url).searchParams.get("original"));
        return { format: "module", shortCircuit: true, source: `
          import * as Library from ${original};
          export * from ${original};
          const Original = Library.default ?? Library;
          export class BasicTracerProvider extends Original.BasicTracerProvider {
            constructor(options = {}) { super({ ...options, sampler: new Original.AlwaysOffSampler(), spanProcessors: [] }); }
          }
        ` };
      }
      if (url.startsWith("studio-rsshub:metrics?")) {
        const original = JSON.stringify(new URL(url).searchParams.get("original"));
        return { format: "module", shortCircuit: true, source: `
          import * as Library from ${original};
          export * from ${original};
          const Original = (Library.default ?? Library).PrometheusExporter;
          export class PrometheusExporter extends Original {
            constructor(options = {}) { super({ ...options, preventServerStart: true }); }
          }
        ` };
      }
      if (url.startsWith("studio-rsshub:server?")) {
        const original = JSON.stringify(new URL(url).searchParams.get("original"));
        return { format: "module", shortCircuit: true, source: `
          export * from ${original};
          export function serve(options) { return { fetch: options.fetch }; }
          export function createAdaptorServer() { throw new Error('RSSHub子进程不开放监听'); }
        ` };
      }
      if (url.startsWith("studio-rsshub:parser?")) {
        const original = JSON.stringify(new URL(url).searchParams.get("original"));
        return { format: "module", shortCircuit: true, source: `
          import Original from ${original};
          export default class ControlledParser extends Original {
            constructor(options = {}) { super(options); this.studioOptions = options; }
            parseURL(url, callback) {
              const work = globalThis.fetch(url, { headers: this.studioOptions.headers }).then(async response => {
                if (response.status >= 300) throw new Error('RSSHub订阅请求失败');
                return this.parseString(await response.text());
              });
              if (callback) { work.then(feed => callback(null, feed), error => callback(error)); return; }
              return work;
            }
          }
        ` };
      }
      return next(url, context);
    },
  });
}
