import { mkdir, rename, writeFile } from 'node:fs/promises';
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

  render(): string {
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

    return toYaml({ http: { routers, services } });
  }

  async commit(): Promise<void> {
    this.inFlight = this.inFlight.then(() => this.doCommit());
    await this.inFlight;
  }

  private async doCommit(): Promise<void> {
    const content = this.render();
    await mkdir(dirname(this.cfg.outputPath), { recursive: true });
    const tmp = `${this.cfg.outputPath}.tmp.${process.pid}.${Date.now()}`;
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, this.cfg.outputPath);
  }

  private sortedRoutes(): RouteSpec[] {
    return Array.from(this.routes.values()).sort((a, b) =>
      a.instanceName.localeCompare(b.instanceName),
    );
  }
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
