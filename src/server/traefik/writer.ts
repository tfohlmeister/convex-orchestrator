import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RouteSpec } from '../supervisor/types.ts';

export interface TraefikWriterConfig {
  outputPath: string;
  certResolver: string;
  serviceLoopback: string;
  // Traefik entrypoint name (`websecure` for HTTPS, `web` for HTTP). When
  // `web`, the rendered router omits the `tls` block.
  entryPoint: string;
  middlewares?: string[];
}

export class TraefikWriter {
  private routes = new Map<string, RouteSpec>();
  private inFlight: Promise<void> = Promise.resolve();

  constructor(private readonly cfg: TraefikWriterConfig) {}

  set(spec: RouteSpec): void {
    this.routes.set(spec.instanceName, spec);
  }

  remove(instanceName: string): void {
    this.routes.delete(instanceName);
  }

  replaceAll(specs: RouteSpec[]): void {
    this.routes.clear();
    for (const spec of specs) this.routes.set(spec.instanceName, spec);
  }

  render(): string | null {
    const routers: Record<string, unknown> = {};
    const services: Record<string, unknown> = {};
    const middlewares = this.cfg.middlewares ?? [];

    const isHttps = this.cfg.entryPoint !== 'web';
    const tlsBlock = isHttps
      ? { tls: this.cfg.certResolver ? { certResolver: this.cfg.certResolver } : {} }
      : {};

    for (const spec of this.sortedRoutes()) {
      const cloudRouter = `${spec.instanceName}-cloud`;
      const siteRouter = `${spec.instanceName}-site`;
      routers[cloudRouter] = {
        rule: `Host(\`${spec.cloudHost}\`)`,
        entryPoints: [this.cfg.entryPoint],
        service: cloudRouter,
        ...tlsBlock,
        ...(middlewares.length > 0 ? { middlewares } : {}),
      };
      routers[siteRouter] = {
        rule: `Host(\`${spec.siteHost}\`)`,
        entryPoints: [this.cfg.entryPoint],
        service: siteRouter,
        ...tlsBlock,
        ...(middlewares.length > 0 ? { middlewares } : {}),
      };
      services[cloudRouter] = {
        loadBalancer: {
          servers: [{ url: `http://${this.cfg.serviceLoopback}:${spec.cloudPort}` }],
          passHostHeader: true,
        },
      };
      services[siteRouter] = {
        loadBalancer: {
          servers: [{ url: `http://${this.cfg.serviceLoopback}:${spec.sitePort}` }],
          passHostHeader: true,
        },
      };
    }

    // Empty routers/services blocks make Traefik's file provider log a
    // "cannot be a standalone element" watcher error on every reload.
    // Signal "no per-instance file" by returning null; commit() unlinks
    // the output file instead of writing a placeholder.
    if (Object.keys(routers).length === 0) return null;
    return renderTraefikYaml(routers, services);
  }

  async commit(): Promise<void> {
    this.inFlight = this.inFlight.then(() => this.doCommit());
    await this.inFlight;
  }

  private async doCommit(): Promise<void> {
    const content = this.render();
    if (content === null) {
      try {
        await unlink(this.cfg.outputPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      return;
    }
    await writeAtomicYaml(this.cfg.outputPath, content);
  }

  private sortedRoutes(): RouteSpec[] {
    return Array.from(this.routes.values()).sort((a, b) =>
      a.instanceName.localeCompare(b.instanceName),
    );
  }
}

// Atomic-rename file writer shared between the per-instance TraefikWriter
// commits and the boot-time self-routes write in index.ts. Lives here so
// the latter doesn't have to reimplement temp-file + rename + mkdir
// (which it used to, with the same gotchas).
export async function writeAtomicYaml(outputPath: string, content: string): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  const tmp = `${outputPath}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, outputPath);
}

// Build YAML from a `{ http: { routers, services } }` shape. Exported so
// callers that produce static routers + services (e.g. the orchestrator
// self-routes for orchestrator.* + dashboard.*) reuse the same serializer
// instead of string-templating their own.
export function renderTraefikYaml(
  routers: Record<string, unknown>,
  services: Record<string, unknown>,
): string {
  return toYaml({ http: { routers, services } });
}

// Per-router options the self-routes builder threads in.
export interface BuildRouterOpts {
  rule: string;
  entryPoint: string;
  service: string;
  certResolver: string;
}

// Shape-match the per-instance router so both callers produce identical
// YAML (one place to touch when the router schema needs to change).
export function buildRouter({
  rule,
  entryPoint,
  service,
  certResolver,
}: BuildRouterOpts): Record<string, unknown> {
  const isHttps = entryPoint !== 'web';
  return {
    rule,
    entryPoints: [entryPoint],
    service,
    ...(isHttps ? { tls: certResolver ? { certResolver } : {} } : {}),
  };
}

function toYaml(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return yamlScalar(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return value
      .map((v) => {
        if (isPlainObject(v) || Array.isArray(v)) {
          return `${pad}- ${toYaml(v, indent + 1).replace(/^\s+/, '')}`;
        }
        return `${pad}- ${toYaml(v, indent + 1)}`;
      })
      .join('\n');
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    return entries
      .map(([k, v]) => {
        if (isPlainObject(v) && Object.keys(v).length > 0) {
          return `${pad}${k}:\n${toYaml(v, indent + 1)}`;
        }
        if (Array.isArray(v) && v.length > 0) {
          return `${pad}${k}:\n${toYaml(v, indent + 1)}`;
        }
        return `${pad}${k}: ${toYaml(v, indent + 1)}`;
      })
      .join('\n');
  }
  return JSON.stringify(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function yamlScalar(s: string): string {
  if (/^[\w./@:-]+$/.test(s) && !/^(true|false|null|~|\d)/.test(s)) {
    return s;
  }
  return `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}
