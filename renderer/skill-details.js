(function exposeSkillDetails(root) {
  const levelName = level => level <= 7 ? `技能 ${level} 级` : ['专精一级', '专精二级', '专精三级'][level - 8];

  function progress(operator, owned, skill) {
    const maximum = skill.maxLevel ?? (Object.values(skill.requirements).every(cost => cost.length) || operator.specialTraining ? 10 : 7);
    const normal = Math.max(1, Math.min(7, owned.skillLevel || 1));
    const mastery = normal === 7 ? owned.skills.find(s => s.skillId === skill.skillId)?.masteryLevel ?? 0 : 0;
    const current = Math.min(maximum, normal + mastery);
    const next = current < maximum ? current + 1 : null;
    const requirements = next === null ? null : next <= 7
      ? operator.skillLevelRequirements?.[next - 2] : skill.requirements[next - 7];
    return { current, next, maximum, requirements };
  }

  function position(anchor, card, width, height, viewport) {
    const margin = 12, gap = 8;
    const below = Math.max(0, viewport.height - margin - anchor.bottom - gap);
    const above = Math.max(0, anchor.top - margin - gap);
    const upward = height > below && above > below;
    const maxHeight = upward ? above : below;
    const left = Math.max(margin, Math.min(card.right - width, viewport.width - width - margin));
    return { left, top: upward ? anchor.top - gap - Math.min(height, maxHeight) : anchor.bottom + gap,
      maxHeight, placement: upward ? 'above' : 'below' };
  }

  const exported = { levelName, progress, position };
  root.SkillDetails = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})(typeof window === 'undefined' ? globalThis : window);
