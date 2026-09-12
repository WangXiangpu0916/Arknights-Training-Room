import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { GameData, Material, MaterialAmount, OperatorDefinition, ProgressionData } from '../domain/types';
import { professionFromToolboxId } from '../domain/professions';

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


// Build-time adapter. The application only reads the resulting stable GameData.
export class ToolboxResourceConverter {
  async convert(directory: string): Promise<GameData> {
    const [characters, cultivate, items, characterNames, materialNames, skillNames, moduleNames, subProfessionNames, operatorMetadata, materialMetadata, moduleMetadata, progression, metadata] = await Promise.all([
      this.json<Dict<RawCharacter>>(directory, 'character.json'),
      this.json<Dict<RawCultivate>>(directory, 'cultivate.json'),
      this.json<Dict<RawItem>>(directory, 'item.json'),
      this.json<Dict<string>>(directory, 'character-cn.json'),
      this.json<Dict<string>>(directory, 'material-cn.json'),
      this.json<Dict<string>>(directory, 'skill-cn.json'),
      this.json<Dict<string>>(directory, 'uniequip-cn.json'),
      this.json<Dict<string>>(directory, 'subprofession-cn.json'),
      this.json<Dict<OperatorMetadata>>(directory, 'operator-metadata.json'),
      this.json<Dict<MaterialMetadata>>(directory, 'material-metadata.json'),
      this.json<Dict<ModuleMetadata>>(directory, 'uniequip-metadata.json'),
      this.json<ProgressionData>(directory, 'progression.json'),
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
    if (!materials.some(item => item.itemId === progression.lmdItemId)) materials.push({ itemId: progression.lmdItemId, name: '龙门币', rarity: 1, type: 4 });
    for (const itemId of Object.keys(progression.expItems)) {
      if (materials.some(item => item.itemId === itemId)) continue;
      materials.push({ itemId, name: materialNames[itemId] ?? ({ '2001': '基础作战记录', '2002': '初级作战记录', '2003': '中级作战记录', '2004': '高级作战记录' } as Dict<string>)[itemId] ?? itemId, rarity: 1, type: 4 });
    }

    const operators: OperatorDefinition[] = [];
    for (const [operatorId, character] of Object.entries(characters)) {
      const raw = cultivate[operatorId] ?? {};
      const elite = raw.skills?.elite ?? [];
      // Locale tables may already contain announced operators without released cultivation data.
      if (!characterNames[operatorId] || !cultivate[operatorId] || character.star >= 4 && !elite.length) continue;
      const profile = operatorMetadata[operatorId] ?? {};
      const hasE1Data = Boolean(raw.evolve?.[0] && Object.keys(raw.evolve[0]).length);
      const hasE2Data = Boolean(raw.evolve?.[1] && Object.keys(raw.evolve[1]).length);
      const maxElitePhase = hasE2Data ? 2 : hasE1Data || character.star === 3 ? 1 : 0;
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
        maxElitePhase,
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

}
