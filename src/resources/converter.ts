import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { GameData, Material, MaterialAmount, ModuleDefinition, OperatorDefinition, ProgressionData, SkillDefinition, SkillLevelDetail } from '../domain/types';
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

interface SpecialOperator {
  maxElitePhase: 0 | 1 | 2;
  skillIds: string[];
  modules: Omit<ModuleDefinition, 'requirements'>[];
}


// Build-time adapter. The application only reads the resulting stable GameData.
export class ToolboxResourceConverter {
  async convert(directory: string): Promise<GameData> {
    const [characters, cultivate, items, characterNames, materialNames, skillNames, moduleNames, subProfessionNames, operatorMetadata, materialMetadata, moduleMetadata, progression, metadata, specialOperators, skillData] = await Promise.all([
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
      this.json<Dict<SpecialOperator>>(directory, 'special-operators.json'),
      this.json<{ operators: Dict<{ skills: Pick<SkillDefinition, 'skillId' | 'maxLevel' | 'requirements'>[]; skillLevelRequirements: MaterialAmount[][] }>; skills: Dict<SkillLevelDetail[]> }>(directory, 'skill-details.json'),
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
      const special = specialOperators[operatorId];
      const elite = special ? special.skillIds.map(name => ({ name, cost: [] })) : raw.skills?.elite ?? [];
      // Low-star and officially available special operators do not require a normal cultivation table.
      if (!characterNames[operatorId] || !special && (character.star >= 3 && !cultivate[operatorId] || character.star >= 4 && !elite.length)) continue;
      if (character.star >= 3 && !skillData.operators[operatorId]) throw new Error(`缺少干员技能资料 ${operatorId}`);
      const profile = operatorMetadata[operatorId] ?? {};
      const hasE1Data = Boolean(raw.evolve?.[0] && Object.keys(raw.evolve[0]).length);
      const hasE2Data = Boolean(raw.evolve?.[1] && Object.keys(raw.evolve[1]).length);
      const maxElitePhase = special?.maxElitePhase ?? (hasE2Data ? 2 : hasE1Data || character.star === 3 ? 1 : 0);
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
        ...(special ? { specialTraining: true } : {}),
        promotionRequirements: {
          1: this.amounts(raw.evolve?.[0] ?? {}),
          2: this.amounts(raw.evolve?.[1] ?? {}),
        },
        modules: special ? special.modules.map(module => ({ ...module, requirements: { 1: [], 2: [], 3: [] } })) : (raw.uniequip ?? []).map(module => ({
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
        skillLevelRequirements: skillData.operators[operatorId]?.skillLevelRequirements,
        skills: (skillData.operators[operatorId]?.skills ?? []).map((skill, index) => ({
          ...skill,
          operatorId,
          index: index + 1,
          name: skillData.skills[skill.skillId]?.[0]?.name ?? skillNames[skill.skillId] ?? `技能 ${index + 1}`,
        })),
      });
    }

    // Account snapshots merge Amiya's forms under the caster ID; resource definitions must match.
    const amiya = operators.find(op => op.operatorId === '002_amiya');
    for (const form of operators.filter(op => /_amiya\d+$/.test(op.operatorId)).sort((a, b) => a.operatorId.localeCompare(b.operatorId))) {
      if (!amiya) throw new Error('阿米娅形态缺少本体资料');
      for (const skill of form.skills) {
        if (!amiya.skills.some(existing => existing.skillId === skill.skillId)) {
          amiya.skills.push({ ...skill, operatorId: amiya.operatorId, index: amiya.skills.length + 1 });
        }
      }
      for (const module of form.modules ?? []) {
        if (!amiya.modules!.some(existing => existing.moduleId === module.moduleId)) amiya.modules!.push(module);
      }
      operators.splice(operators.indexOf(form), 1);
    }

    return {
      version: metadata.version,
      updatedAt: metadata.updatedAt,
      sourceCommit: metadata.sourceCommit,
      operators,
      materials,
      progression,
      skillDetails: Object.fromEntries([...new Set(operators.flatMap(op => op.skills.map(s => s.skillId)))].map(id => [id, skillData.skills[id]])),
    };
  }

  private amounts(value: Record<string, number>): MaterialAmount[] {
    return Object.entries(value).map(([itemId, quantity]) => ({ itemId, quantity }));
  }

  private async json<T>(directory: string, name: string): Promise<T> {
    return JSON.parse(await readFile(path.join(directory, name), 'utf8')) as T;
  }

}
