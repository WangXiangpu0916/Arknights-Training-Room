(function exposeInventoryCatalog(root) {
  const excludedItemIds = new Set(['mod_unlock_token', 'mod_update_token_1', 'mod_update_token_2', '4001']);
  const pinnedMaterialIds = ['30103', '30093', '30083', '30073'];
  const pinnedMaterialOrder = new Map(pinnedMaterialIds.map((id, index) => [id, index]));
  const skillSummaryIds = ['3303', '3302', '3301'];
  const skillSummaryOrder = new Map(skillSummaryIds.map((id, index) => [id, index]));
  const chipTierOrder = { 3: 0, 2: 1, 1: 2 };
  const chipProfessionOrder = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 7 };

  function isChipItem(itemId) {
    return itemId === '32001' || /^32[1-8][1-3]$/.test(itemId);
  }

  function isSkillSummaryItem(itemId) {
    return skillSummaryOrder.has(itemId);
  }

  function classifyItem(item) {
    if (excludedItemIds.has(item.itemId)) return null;
    if (isSkillSummaryItem(item.itemId)) return 'skills';
    if (isChipItem(item.itemId)) return 'chips';
    return 'materials';
  }

  function sortMaterials(items) {
    return [...items].sort((a, b) => {
      const aPin = pinnedMaterialOrder.get(a.itemId);
      const bPin = pinnedMaterialOrder.get(b.itemId);
      if (aPin !== undefined || bPin !== undefined) {
        if (aPin === undefined) return 1;
        if (bPin === undefined) return -1;
        return aPin - bPin;
      }
      return b.rarity - a.rarity || a.name.localeCompare(b.name, 'zh-CN');
    });
  }

  function chipSortKey(itemId) {
    if (itemId === '32001') return [3, 0];
    const match = itemId.match(/^32(\d)(\d)$/);
    if (!match) return [9, 9];
    const profession = Number(match[1]);
    const tier = Number(match[2]);
    return [chipTierOrder[tier] ?? 9, chipProfessionOrder[profession] ?? 9];
  }

  function sortChips(items) {
    return [...items].sort((a, b) => {
      const [aTier, aProfession] = chipSortKey(a.itemId);
      const [bTier, bProfession] = chipSortKey(b.itemId);
      return aTier - bTier || aProfession - bProfession;
    });
  }

  function sortSkills(items) {
    return [...items].sort((a, b) => skillSummaryOrder.get(a.itemId) - skillSummaryOrder.get(b.itemId));
  }

  function buildSections(materials, query = '') {
    const buckets = { materials: [], chips: [], skills: [] };
    for (const item of materials) {
      const category = classifyItem(item);
      if (!category) continue;
      if (query && !item.name.includes(query)) continue;
      buckets[category].push(item);
    }
    return {
      materials: sortMaterials(buckets.materials),
      chips: sortChips(buckets.chips),
      skills: sortSkills(buckets.skills),
    };
  }

  const exported = {
    excludedItemIds,
    pinnedMaterialIds,
    skillSummaryIds,
    buildSections,
    classifyItem,
    sortMaterials,
    sortChips,
    sortSkills,
  };
  root.InventoryCatalog = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})(typeof window === 'undefined' ? globalThis : window);
