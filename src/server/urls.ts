import type { Config } from './config.ts';
import type { Instance } from './supervisor/types.ts';

// Single source of truth for instance-facing URLs. Three sites used to
// inline the same `${scheme}://${name}.${baseDomain}${portSuffix}`
// formula, and one site (`deployments()`) hardcoded `https://…` without
// the port suffix — silently breaking HTTP-only setups where users access
// the orchestrator via `http://orchestrator.cvx.lan:18000`.
export function cloudUrl(instance: Pick<Instance, 'name' | 'baseDomain'>, config: Config): string {
  return `${config.EXTERNAL_SCHEME}://${instance.name}.${instance.baseDomain}${config.EXTERNAL_PORT_SUFFIX}`;
}

export function siteUrl(instance: Pick<Instance, 'name' | 'baseDomain'>, config: Config): string {
  return `${config.EXTERNAL_SCHEME}://${instance.name}-site.${instance.baseDomain}${config.EXTERNAL_PORT_SUFFIX}`;
}
