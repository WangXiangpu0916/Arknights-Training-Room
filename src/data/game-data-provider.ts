import { app } from 'electron';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GameData, Material, MaterialAmount, OperatorDefinition, ProgressionData } from '../domain/types';
import { professionFromToolboxId } from '../domain/professions';
import { LocalStore } from './local-store';

type Dict<T> = Record<string, T>;

interface RawCharacter {
  star: number;
  profession: number;
}

interface RawItem {
  type: number;
  rare: number;
  formula?: Record<string, number>;
}

interface RawCultivate {
  evolve?: Array<Record<string, number>>;
  skills?: {
    elite?: Array<{
      name: string;
      cost: Array<Record<string, number>>;
    }>;
  };
  uniequip?: Array<{
    id: string;
    cost: Array<Record<string, number>>;
  }>;
}

interface OperatorMetadata {
  name?: string;
  pinyin?: string;
  pinyinInitials?: string;
  implementationDate?: string;
  gender?: string;
  position?: string;
  obtainMethods?: string[];
  races?: string[];
  birthPlaces?: string[];
  organizations?: string[];
  teams?: string[];
  birthdayMonth?: number;
  tags?: string[];
}

interface MaterialMetadata {
  purpose?: string;
  description?: string;
}

interface ModuleMetadata {
  typeIcon: string;
  typeLabel: string;
  requirements: Record<1 | 2 | 3, MaterialAmount[]>;
}

const FILES = [
  ['data/character.json', 'character.json'],
  ['data/cultivate.json', 'cultivate.json'],
  ['data/item.json', 'item.json'],
  ['locales/cn/character.json', 'character-cn.json'],
  ['locales/cn/material.json', 'material-cn.json'],
  ['locales/cn/skill.json', 'skill-cn.json'],
  ['locales/cn/uniequip.json', 'uniequip-cn.json'],
] as const;

const RAW_ROOT = 'https://raw.githubusercontent.com/arkntools/arknights-toolbox-data/master/assets';

export class ToolboxGameDataProvider {
  constructor(private readonly store: LocalStore) {}

  async initialize(): Promise<GameData> {
    await mkdir(this.store.gameDataDir, { recursive: true });
    try {
      return await this.load();
    } catch {
      await rm(this.store.gameDataDir, { recursive: true, force: true });
      await cp(this.bundledGameDataDir(), this.store.gameDataDir, { recursive: true });
      await this.store.log('game-data-cache-recovered', '已回退到内置游戏数据');
      return this.load();
    }
  }

  async update(): Promise<GameData> {
    const nextDir = `${this.store.gameDataDir}.next`;
    const backupDir = `${this.store.gameDataDir}.backup`;
    await rm(nextDir, { recursive: true, force: true });
    await mkdir(nextDir, { recursive: true });
    let version = '';
    for (const [remote, local] of FILES) {
      const response = await fetch(`${RAW_ROOT}/${remote}`, { headers: { 'User-Agent': 'Arknights-Training-Room/1.0' } });
      if (!response.ok) throw new Error(`游戏数据下载失败：${local}（HTTP ${response.status}）`);
      const text = await response.text();
      JSON.parse(text);
      await writeFile(path.join(nextDir, local), text, 'utf8');
      version ||= response.headers.get('etag')?.replaceAll('"', '') ?? '';
    }
    const updatedAt = new Date().toISOString();
    await writeFile(
      path.join(nextDir, 'data-version.json'),
      JSON.stringify({ version: version || updatedAt, updatedAt, source: RAW_ROOT }, null, 2),
      'utf8',
    );
    const parsed = await this.loadFrom(nextDir);
    await rm(backupDir, { recursive: true, force: true });
    await rename(this.store.gameDataDir, backupDir);
    try {
      await rename(nextDir, this.store.gameDataDir);
      await rm(backupDir, { recursive: true, force: true });
    } catch (error) {
      await rename(backupDir, this.store.gameDataDir).catch(() => undefined);
      throw error;
    }
    return parsed;
  }

  async load(): Promise<GameData> {
    return this.loadFrom(this.store.gameDataDir);
  }

  private async loadFrom(directory: string): Promise<GameData> {
    const [characters, cultivate, items, characterNames, materialNames, skillNames, moduleNames, subProfessionNames, operatorMetadata, materialMetadata, moduleMetadata, progression, metadata] = await Promise.all([
      this.json<Dict<RawCharacter>>(directory, 'character.json'),
      this.json<Dict<RawCultivate>>(directory, 'cultivate.json'),
      this.json<Dict<RawItem>>(directory, 'item.json'),
      this.json<Dict<string>>(directory, 'character-cn.json'),
      this.json<Dict<string>>(directory, 'material-cn.json'),
      this.json<Dict<string>>(directory, 'skill-cn.json'),
      this.json<Dict<string>>(directory, 'uniequip-cn.json'),
      this.json<Dict<string>>(this.bundledGameDataDir(), 'subprofession-cn.json'),
      this.json<Dict<OperatorMetadata>>(this.bundledGameDataDir(), 'operator-metadata.json'),
      this.json<Dict<MaterialMetadata>>(this.bundledGameDataDir(), 'material-metadata.json'),
      this.json<Dict<ModuleMetadata>>(this.bundledGameDataDir(), 'uniequip-metadata.json'),
      this.json<ProgressionData>(this.bundledGameDataDir(), 'progression.json'),
      this.json<{ version: string; updatedAt: string; sourceCommit?: string }>(directory, 'data-version.json'),
    ]);

    const materials: Material[] = Object.entries(items).map(([itemId, item]) => ({
      itemId,
      name: materialNames[itemId] ?? `未知材料 ${itemId}`,
      rarity: item.rare,
      type: item.type,
      purpose: materialMetadata[itemId]?.purpose ?? '',
      description: materialMetadata[itemId]?.description ?? '',
      recipe: item.formula && Object.keys(item.formula).length
        ? {
            productItemId: itemId,
            outputQuantity: item.type === 1 && (item.rare === 3 || item.rare === 4) ? 2 : 1,
            ingredients: this.amounts(item.formula),
          }
        : undefined,
    }));
    materials.push({ itemId: progression.lmdItemId, name: '龙门币', rarity: 1, type: 4 });

    const operators: OperatorDefinition[] = [];
    for (const [operatorId, raw] of Object.entries(cultivate)) {
      const character = characters[operatorId];
      const elite = raw.skills?.elite ?? [];
      if (!character || !characterNames[operatorId]) continue;
      const profile = operatorMetadata[operatorId] ?? {};
      operators.push({
        operatorId,
        name: characterNames[operatorId],
        rarity: character.star,
        profession: professionFromToolboxId(character.profession),
        subProfession: subProfessionNames[operatorId] ?? '未知分支',
        searchPinyin: profile.pinyin ?? '',
        searchPinyinInitials: profile.pinyinInitials ?? '',
        implementationDate: profile.implementationDate,
        gender: profile.gender ?? '',
        position: profile.position ?? '',
        obtainMethods: profile.obtainMethods ?? [],
        races: profile.races ?? [],
        birthPlaces: profile.birthPlaces ?? [],
        organizations: profile.organizations ?? [],
        teams: profile.teams ?? [],
        birthdayMonth: profile.birthdayMonth,
        tags: profile.tags ?? [],
        promotionRequirements: {
          1: this.amounts(raw.evolve?.[0] ?? {}),
          2: this.amounts(raw.evolve?.[1] ?? {}),
        },
        modules: (raw.uniequip ?? []).map(module => ({
          moduleId: module.id,
          name: moduleNames[module.id] ?? module.id,
          typeIcon: moduleMetadata[module.id]?.typeIcon ?? '',
          typeLabel: moduleMetadata[module.id]?.typeLabel ?? '特殊模组',
          requirements: moduleMetadata[module.id]?.requirements ?? {
            1: this.amounts(module.cost[0] ?? {}),
            2: this.amounts(module.cost[1] ?? {}),
            3: this.amounts(module.cost[2] ?? {}),
          },
        })),
        skills: elite.map((skill, index) => ({
          skillId: skill.name,
          operatorId,
          index: index + 1,
          name: skillNames[skill.name] ?? `技能 ${index + 1}`,
          requirements: {
            1: this.amounts(skill.cost[0] ?? {}),
            2: this.amounts(skill.cost[1] ?? {}),
            3: this.amounts(skill.cost[2] ?? {}),
          },
        })),
      });
    }

    return {
      version: metadata.version,
      updatedAt: metadata.updatedAt,
      sourceCommit: metadata.sourceCommit,
      operators,
      materials,
      progression,
    };
  }

  private amounts(value: Record<string, number>): MaterialAmount[] {
    return Object.entries(value).map(([itemId, quantity]) => ({ itemId, quantity }));
  }

  private async json<T>(directory: string, name: string): Promise<T> {
    return JSON.parse(await readFile(path.join(directory, name), 'utf8')) as T;
  }

  private bundledGameDataDir(): string {
    return app.isPackaged
      ? path.join(process.resourcesPath, 'game-data')
      : path.join(app.getAppPath(), 'resources', 'game-data');
  }
}
