import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { GameData } from '../domain/types';
import { PRTS_PROFESSIONS } from '../domain/professions';
import { MAX_PACKAGE_BYTES, RESOURCE_SCHEMA_VERSION, ResourceManifest, ResourceSnapshot, SnapshotManifest, compareAppVersions } from './schema';

export const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`资源校验失败：${message}`);
}
const object = (v: any): boolean => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: any): boolean => typeof v === 'string' && v.length > 0 && v.length <= 512;
const id = (v: any): boolean => typeof v === 'string' && /^[A-Za-z0-9_-]+$/.test(v);
const integer = (v: any, min = 0, max = Number.MAX_SAFE_INTEGER): boolean => Number.isSafeInteger(v) && v >= min && v <= max;

export function safeResourcePath(name: string): string {
  ensure(typeof name === 'string' && name.length <= 240 && !/[\\:\u0000-\u001f]/.test(name), '文件路径无效');
  const segments = name.split('/');
  ensure(segments.every(s => s && s !== '.' && s !== '..' && !/[. ]$/.test(s) && !/[<>"|?*]/.test(s)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)), `不安全路径 ${name}`);
  ensure(name === 'data/game.json' || name === 'metadata/provenance.json' || name === 'metadata/notices.md' || /^images\/.+\.(png|svg)$/.test(name), `未允许的文件 ${name}`);
  return name;
}

export function validateManifest(value: unknown, appVersion: string, remote = true): ResourceManifest {
  const m = value as any;
  ensure(object(m), 'manifest 必须是对象');
  ensure(typeof m.resourceVersion === 'string' && /^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(m.resourceVersion), 'resourceVersion 无效');
  const date = m.resourceVersion.split('.').slice(0, 3).join('-');
  ensure(Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date
    && m.resourceVersion.split('.').every((n: string) => Number.isSafeInteger(Number(n))), 'resourceVersion 日期或序号无效');
  ensure(integer(m.schemaVersion, 1), 'schemaVersion 无效');
  if (m.schemaVersion !== RESOURCE_SCHEMA_VERSION) throw new Error(`此资源格式需要升级应用（支持 schema ${RESOURCE_SCHEMA_VERSION}，收到 ${m.schemaVersion}），继续使用当前资源。`);
  ensure(text(m.buildTime) && Number.isFinite(Date.parse(m.buildTime)), 'buildTime 无效');
  ensure(text(m.minAppVersion), 'minAppVersion 无效');
  if (compareAppVersions(appVersion, m.minAppVersion) < 0) throw new Error(`此资源需要应用 v${m.minAppVersion} 或更高版本，请升级应用；当前资源保持可用。`);
  ensure(Array.isArray(m.sources) && m.sources.length > 0, '缺少固定上游版本');
  for (const s of m.sources) ensure(object(s) && text(s.repository)
    && (s.commit !== undefined
      ? /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(s.repository) && typeof s.commit === 'string' && /^[a-f0-9]{40}$/.test(s.commit)
      : /^https:\/\/torappu\.prts\.wiki\/assets\/uniequip_type$/.test(s.repository) && /^sha256:[a-f0-9]{64}$/.test(s.dataVersion))
    && (s.dataVersion === undefined || text(s.dataVersion)), '上游 repository / 固定 commit 或内容摘要无效');
  ensure(object(m.files) && Object.keys(m.files).length > 1 && Object.keys(m.files).length <= 10000, '文件清单无效');
  const names = new Set<string>();
  for (const [name, entry] of Object.entries(m.files) as Array<[string, any]>) {
    safeResourcePath(name);
    ensure(!names.has(name.toLowerCase()), `大小写冲突 ${name}`); names.add(name.toLowerCase());
    ensure(object(entry) && integer(entry.size, 1, 20 * 1024 * 1024) && /^[a-f0-9]{64}$/.test(entry.sha256), `文件校验信息无效 ${name}`);
  }
  ensure((Object.values(m.files) as Array<{ size: number }>).reduce((n, f) => n + f.size, 0) <= 110 * 1024 * 1024, '展开资源超过大小限制');
  ensure(m.files['data/game.json'], '缺少关键 JSON data/game.json');
  ensure(object(m.fallbacks) && Array.isArray(m.fallbacks.skills) && m.fallbacks.skills.every(id)
    && new Set(m.fallbacks.skills).size === m.fallbacks.skills.length, '技能 fallback 无效');
  if (remote) ensure(object(m.package) && text(m.package.url) && integer(m.package.size, 1, MAX_PACKAGE_BYTES)
    && /^[a-f0-9]{64}$/.test(m.package.sha256), '资源包信息无效');
  return m;
}

export function validateGameData(value: unknown, manifest: SnapshotManifest, previous?: GameData): GameData {
  const d = value as any;
  ensure(object(d) && d.version === manifest.resourceVersion && d.updatedAt === manifest.buildTime, '数据版本与清单不一致');
  ensure(Array.isArray(d.operators) && d.operators.length >= 100 && Array.isArray(d.materials) && d.materials.length >= 30, '关键数据集为空或过少');
  const items = new Set<string>();
  for (const item of d.materials) {
    ensure(object(item) && id(item.itemId) && !items.has(item.itemId) && text(item.name) && integer(item.rarity, 0, 6) && integer(item.type, 0, 20), '材料结构 / ID 无效');
    for (const key of ['purpose', 'description']) ensure(item[key] === undefined || typeof item[key] === 'string', `材料 ${key} 无效`);
    items.add(item.itemId);
  }
  const costs = (values: any, label: string, required = false) => {
    ensure(Array.isArray(values) && (!required || values.length > 0), `${label} 消耗为空或无效`);
    const seen = new Set();
    for (const cost of values) {
      ensure(object(cost) && id(cost.itemId) && items.has(cost.itemId) && integer(cost.quantity, 1) && !seen.has(cost.itemId), `${label} 引用未知材料或非法数量`);
      seen.add(cost.itemId);
    }
  };
  for (const item of d.materials) if (item.recipe !== undefined) {
    ensure(object(item.recipe) && item.recipe.productItemId === item.itemId && integer(item.recipe.outputQuantity, 1), '合成公式无效');
    costs(item.recipe.ingredients, item.itemId, true);
  }
  const operators = new Set(), modules = new Set();
  for (const op of d.operators) {
    ensure(object(op) && id(op.operatorId) && !operators.has(op.operatorId) && text(op.name) && integer(op.rarity, 1, 6)
      && PRTS_PROFESSIONS.includes(op.profession) && text(op.subProfession) && integer(op.maxElitePhase, 0, 2), '干员结构 / ID / 职业无效');
    operators.add(op.operatorId);
    for (const key of ['searchPinyin', 'searchPinyinInitials', 'implementationDate', 'gender', 'position']) ensure(op[key] === undefined || typeof op[key] === 'string', `干员 ${key} 无效`);
    for (const key of ['obtainMethods', 'races', 'birthPlaces', 'organizations', 'teams', 'tags']) ensure(op[key] === undefined || Array.isArray(op[key]) && op[key].every((v: any) => typeof v === 'string'), `干员 ${key} 无效`);
    ensure(op.birthdayMonth === undefined || integer(op.birthdayMonth, 1, 12), '生日月份无效');
    ensure(object(op.promotionRequirements) && Array.isArray(op.skills) && Array.isArray(op.modules), '干员培养结构无效');
    for (const level of [1, 2]) costs(op.promotionRequirements[level], `${op.operatorId} E${level}`, op.rarity >= 4 && level <= op.maxElitePhase);
    const skills = new Set();
    for (const skill of op.skills) {
      ensure(object(skill) && id(skill.skillId) && !skills.has(skill.skillId) && skill.operatorId === op.operatorId && integer(skill.index, 1, 20)
        && text(skill.name) && object(skill.requirements), '技能 ID / 干员关联无效');
      skills.add(skill.skillId);
      for (const level of [1, 2, 3]) costs(skill.requirements[level], `${skill.skillId} M${level}`, true);
    }
    ensure(op.rarity < 4 || op.skills.length > 0, `高星干员缺少技能 ${op.operatorId}`);
    for (const mod of op.modules) {
      ensure(object(mod) && id(mod.moduleId) && !modules.has(mod.moduleId) && text(mod.name) && text(mod.typeIcon) && text(mod.typeLabel)
        && object(mod.requirements), '模组结构 / ID 无效');
      modules.add(mod.moduleId);
      for (const level of [1, 2, 3]) costs(mod.requirements[level], `${mod.moduleId} Lv${level}`, true);
    }
  }
  const p = d.progression;
  ensure(object(p) && items.has(p.lmdItemId) && object(p.expItems) && Object.keys(p.expItems).length > 0, '升级曲线 / 经验物品缺失');
  for (const [itemId, exp] of Object.entries(p.expItems)) ensure(items.has(itemId) && integer(exp, 1), '经验物品引用无效');
  for (const key of ['characterExpMap', 'characterUpgradeCostMap', 'evolveGoldCost']) {
    ensure(Array.isArray(p[key]) && p[key].length >= (key === 'evolveGoldCost' ? 6 : 3), `${key} 无效`);
    for (const row of p[key]) ensure(Array.isArray(row) && row.length >= (key === 'evolveGoldCost' ? 2 : 89) && row.every((n: any) => integer(n, -1)), `${key} 曲线无效`);
  }
  ensure(d.operators.some((o: any) => o.rarity === 6) && modules.size > 0, '六星干员 / 模组数据消失');
  if (previous) {
    const counts = (g: GameData) => [g.operators.length, g.materials.length, g.operators.filter(o => o.rarity === 6).length,
      g.operators.reduce((n, o) => n + o.skills.length, 0), g.operators.reduce((n, o) => n + (o.modules?.length ?? 0), 0),
      g.operators.filter(o => o.subProfession !== '未知分支').length];
    const old = counts(previous), next = counts(d);
    next.forEach((n, i) => ensure(n >= old[i] * 0.9, `sanity check 数据集 ${i} 较上一快照减少超过 10%`));
  }
  return d;
}

export async function listResourceFiles(directory: string, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    ensure(!entry.isSymbolicLink(), `不允许符号链接 ${name}`);
    if (entry.isDirectory()) result.push(...await listResourceFiles(directory, name));
    else { ensure(entry.isFile(), `非常规文件 ${name}`); result.push(name); }
  }
  return result.sort();
}

export async function loadSnapshot(directory: string, appVersion: string, previous?: GameData, expected?: SnapshotManifest): Promise<ResourceSnapshot> {
  const manifest = validateManifest(JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')), appVersion, false);
  if (expected) ensure(JSON.stringify(manifest) === JSON.stringify(expected), '包内与远端 manifest 不一致');
  const actual = await listResourceFiles(directory);
  ensure(actual.length === Object.keys(manifest.files).length + 1 && actual.every(n => n === 'manifest.json' || manifest.files[n]), '缺失资源或包含清单外文件');
  for (const [name, info] of Object.entries(manifest.files)) {
    const target = path.join(directory, safeResourcePath(name));
    ensure((await lstat(target)).isFile(), `非常规文件 ${name}`);
    const bytes = await readFile(target);
    ensure(bytes.length === info.size && sha256(bytes) === info.sha256, `文件损坏 ${name}`);
    if (name.endsWith('.png')) ensure(bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0, `非法 PNG ${name}`);
    if (name.endsWith('.svg')) ensure(!/<script|\bon\w+\s*=|href\s*=\s*["'](?:https?:|javascript:|data:)/i.test(bytes.toString()), `不安全 SVG ${name}`);
  }
  const data = validateGameData(JSON.parse(await readFile(path.join(directory, 'data/game.json'), 'utf8')), manifest, previous);
  const required = new Set(['images/skill/placeholder.svg']);
  for (const op of data.operators) {
    required.add(`images/avatar/${op.operatorId}.png`);
    required.add(`images/profession-hd/${op.profession}.png`);
    for (const skill of op.skills) if (!manifest.fallbacks.skills.includes(skill.skillId)) required.add(`images/skill/${skill.skillId}.png`);
    for (const mod of op.modules ?? []) required.add(`images/module/type/${mod.typeIcon.toLowerCase()}.png`);
  }
  for (const item of data.materials) required.add(`images/item/${item.itemId}.png`);
  for (const level of [0, 1, 2, 3]) {
    required.add(`images/mastery/m${level}.png`);
    required.add(`images/mastery/专精_${level}_角标.png`);
    if (level < 3) required.add(`images/elite/e${level}.png`);
    if (level > 0) required.add(`images/module/stage/${level}.png`);
  }
  for (const name of required) ensure(manifest.files[name], `缺少关键图片 ${name}`);
  const allSkills = new Set(data.operators.flatMap(o => o.skills.map(s => s.skillId)));
  for (const skill of manifest.fallbacks.skills) ensure(allSkills.has(skill), 'fallback 引用未知技能');
  ensure(manifest.fallbacks.skills.length <= allSkills.size * 0.1, '缺失技能图标超过 10%');
  return { manifest, data, directory };
}
