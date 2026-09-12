import { GameData } from '../domain/types';

export const RESOURCE_SCHEMA_VERSION = 1;
export const RESOURCE_MANIFEST_URL = 'https://github.com/WangXiangpu0916/Arknights-Training-Room/releases/download/resources-latest/manifest.json';
export const MAX_PACKAGE_BYTES = 80 * 1024 * 1024;
export const MAX_EXPANDED_BYTES = 160 * 1024 * 1024;

export interface ResourceSource {
  repository: string;
  commit?: string;
  dataVersion?: string;
}

export interface SnapshotManifest {
  resourceVersion: string;
  schemaVersion: number;
  buildTime: string;
  minAppVersion: string;
  sources: ResourceSource[];
  // Exact content inventory; no file can silently escape integrity checks.
  files: Record<string, { size: number; sha256: string }>;
  fallbacks: { skills: string[] };
}

export interface ResourceManifest extends SnapshotManifest {
  package: { url: string; size: number; sha256: string };
}

export interface ResourceSnapshot {
  manifest: SnapshotManifest;
  data: GameData;
  directory: string;
}

export function compareResourceVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 4; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

export function compareAppVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v);
    if (!match) throw new Error(`应用版本格式无效：${v}`);
    return { core: match.slice(1, 4).map(Number), pre: match[4]?.split('.') };
  };
  const left = parse(a), right = parse(b);
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i] > right.core[i] ? 1 : -1;
  if (!left.pre || !right.pre) return left.pre ? -1 : right.pre ? 1 : 0;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i], y = right.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) > Number(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}
