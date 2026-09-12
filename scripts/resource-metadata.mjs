// Shared with the existing metadata sync script and the pinned resource builder.
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
