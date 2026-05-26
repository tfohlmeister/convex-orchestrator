import type { PortRepo } from './db/repos.ts';

export const PORT_RANGE_START = 13_210;
export const PORT_RANGE_END = 13_999;

export class PortAllocator {
  constructor(private readonly repo: PortRepo) {}

  allocatePair(instanceName: string): { cloud: number; site: number } {
    const reserved = this.repo.allReserved();
    let cloud = -1;
    let site = -1;
    for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
      if (reserved.has(port)) continue;
      if (cloud === -1) {
        cloud = port;
        reserved.add(port);
        continue;
      }
      site = port;
      break;
    }
    if (cloud === -1 || site === -1) {
      throw new Error('no free ports available in range');
    }
    this.repo.reserve(cloud, instanceName, 'cloud');
    this.repo.reserve(site, instanceName, 'site');
    return { cloud, site };
  }

  release(instanceName: string): void {
    this.repo.releaseForInstance(instanceName);
  }
}
