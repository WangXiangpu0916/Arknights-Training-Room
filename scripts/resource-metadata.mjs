// Shared with the existing metadata sync script and the pinned resource builder.
export const skillId = id => id.replace(/\[(\d+)\]/g, '_$1');

export function skillDescription(level) {
  const values = new Map([['duration', level.duration], ...level.blackboard.map(entry => [entry.key.toLowerCase(), entry.valueStr ?? entry.value])]);
  return level.description.replace(/\{(-?)([^{}:]+)(?::(0(?:\.0+)?%?))?\}/g, (token, sign, key, format) => {
    const value = values.get(key.toLowerCase());
    if (value === undefined) throw new Error(`技能 ${level.name} 缺少数值 ${token}`);
    if (typeof value === 'string') return value;
    const number = value * (sign ? -1 : 1) * (format?.endsWith('%') ? 100 : 1);
    const digits = format?.match(/\.(0+)/)?.[1].length ?? 0;
    return (format ? number.toFixed(digits) : String(Number(number.toFixed(8)))) + (format?.endsWith('%') ? '%' : '');
  }).replace(/<[@$][^>]*>|<\/>/g, '').replace(/\\n/g, '\n');
}

export function skillMetadata(characters, table) {
  const operators = {}, skills = {};
  const costs = rows => (rows ?? []).map(item => ({ itemId: item.id, quantity: item.count }));
  for (const [key, char] of Object.entries(characters)) {
    if (!key.startsWith('char_') || char.isNotObtainable) continue;
    operators[key.slice(5)] = {
      skillLevelRequirements: char.allSkillLvlup.map(level => costs(level.lvlUpCost)),
      skills: char.skills.map(skill => {
        const id = skillId(skill.skillId), raw = table[skill.skillId];
        if (!raw) throw new Error(`缺少技能数据 ${skill.skillId}`);
        const maxLevel = Math.min(raw.levels.length, 7 + skill.levelUpCostCond.length);
        skills[id] = raw.levels.map(level => ({
          name: level.name, description: skillDescription(level),
          skillType: level.skillType, spType: level.spData.spType,
          spCost: level.spData.spCost, initialSp: level.spData.initSp,
          maxCharges: level.spData.maxChargeTime, duration: level.duration,
        }));
        return { skillId: id, maxLevel, requirements: Object.fromEntries([1, 2, 3].map(n => [n, costs(skill.levelUpCostCond[n - 1]?.levelUpCost)])) };
      }),
    };
  }
  return { operators, skills };
}

export function implementationDate(value) {
  const date = String(value ?? '').trim().replace(' ', 'T');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(date)) return undefined;
  const full = date.length === 16 ? `${date}:00` : date;
  const timestamp = Date.parse(`${full}Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().startsWith(full) ? `${full}+08:00` : undefined;
}

export async function fetchImplementationDates(request = fetch) {
  const dates = {};
  for (let offset = 0; ; offset += 500) {
    const url = new URL('https://prts.wiki/api.php');
    url.search = new URLSearchParams({ action: 'cargoquery', format: 'json', tables: 'chara=c,char_obtain=o',
      fields: 'c.charId,o.cnOnlineTime', join_on: 'c._pageName=o._pageName', order_by: 'c.charId', limit: '500', offset: String(offset) });
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { response = await request(url, { headers: { 'User-Agent': 'Arknights-Training-Room/1.0' }, signal: AbortSignal.timeout(30_000) }); break; }
      catch (error) { if (attempt === 2) throw error; }
    }
    if (!response.ok) throw new Error(`PRTS 实装时间请求失败：HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.error || !Array.isArray(payload.cargoquery)) throw new Error('PRTS 实装时间数据无效');
    for (const { title } of payload.cargoquery) {
      const date = implementationDate(title.cnOnlineTime);
      if (date && /^char_[\w]+$/.test(title.charId)) dates[title.charId.slice(5)] = date;
    }
    if (payload.cargoquery.length < 500) break;
  }
  if (Object.keys(dates).length < 100) throw new Error('PRTS 实装时间数据过少');
  return dates;
}

export function specialOperators(characters, moduleData) {
  return Object.fromEntries(Object.entries(characters)
    .filter(([id, char]) => id.startsWith('char_') && !char.isNotObtainable && char.spTargetType && char.spTargetType !== 'NONE'
      && char.phases.every(phase => !phase.evolveCost?.length)
      && char.skills.every(skill => skill.levelUpCostCond.every(level => !level.levelUpCost?.length)))
    .map(([id, char]) => [id.replace(/^char_/, ''), {
      maxElitePhase: char.phases.length - 1,
      skillIds: char.skills.map(skill => skillId(skill.skillId)),
      modules: Object.values(moduleData.equipDict).filter(module => module.charId === id && module.type === 'ADVANCED')
        .map(module => ({ moduleId: module.uniEquipId, name: module.uniEquipName, typeIcon: module.typeIcon, typeLabel: moduleTypeLabel(module.typeIcon) })),
    }]));
}

export function officialMetadata(moduleData, constants, officialItems, moduleNames) {
  const moduleMetadata = Object.fromEntries(Object.values(moduleData.equipDict ?? {})
    .filter(module => module.type === 'ADVANCED' && moduleNames[module.uniEquipId])
    .map(module => [module.uniEquipId, {
      typeIcon: module.typeIcon,
      typeLabel: moduleTypeLabel(module.typeIcon),
      requirements: Object.fromEntries([1, 2, 3].map(level => [level,
        (module.itemCost?.[level] ?? []).map(item => ({ itemId: item.id, quantity: item.count })),
      ])),
    }]));
  const progression = {
    characterExpMap: constants.characterExpMap,
    characterUpgradeCostMap: constants.characterUpgradeCostMap,
    evolveGoldCost: constants.evolveGoldCost,
    expItems: Object.fromEntries(Object.entries(officialItems.expItems ?? {}).map(([id, item]) => [id, item.gainExp])),
    lmdItemId: '4001',
  };
  return { moduleMetadata, progression };
}

export function moduleTypeLabel(typeIcon) {
  const suffix = String(typeIcon ?? '').split('-').at(-1)?.toLowerCase();
  return ({ x: 'X 型模组', y: 'Y 型模组', d: 'Δ 型模组', a: 'α 型模组', b: 'β 型模组' })[suffix] ?? '特殊模组';
}
