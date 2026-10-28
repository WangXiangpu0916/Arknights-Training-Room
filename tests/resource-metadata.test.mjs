import assert from 'node:assert/strict';
import test from 'node:test';
import { skillDescription, skillId, implementationDate, fetchImplementationDates } from '../scripts/resource-metadata.mjs';

test('描述解析保留负号、小数、大小写字段、特殊键、换行与普通尖括号', () => {
  const level = { name: 'test', duration: 4, description: '<@ba.vup>{ATK:0%}</> / {-def:0%} / {a[b]@c:0.0%} / {duration}秒\\n<替身>',
    blackboard: [{ key: 'atk', value: 1.4 }, { key: 'def', value: -0.7 }, { key: 'a[b]@c', value: 0.045 }] };
  assert.equal(skillDescription(level), '140% / 70% / 4.5% / 4秒\n<替身>');
  assert.throws(() => skillDescription({ ...level, blackboard: [] }), /缺少数值/);
  assert.equal(skillId('skcom_charge_cost[1]'), 'skcom_charge_cost_1');
});

test('实装时间不伪造无效日期，固定国服时区', () => {
  assert.equal(implementationDate('2026-10-09 12:00:00'), '2026-10-09T12:00:00+08:00');
  for (const value of ['', '未实装', '2026-02-30 12:00:00']) assert.equal(implementationDate(value), undefined);
});

test('每次资源准备读取新的实装时间，错误响应不生成不完整快照', async () => {
  const rows = Array.from({length: 100}, (_, i) => ({title: {charId: `char_${i}`, cnOnlineTime: '2026-10-09 12:00:00'}}));
  const data = await fetchImplementationDates(async () => ({ ok: true, json: async () => ({cargoquery: rows}) }));
  assert.equal(data['99'], '2026-10-09T12:00:00+08:00');
  await assert.rejects(fetchImplementationDates(async () => ({ ok: false, status: 503 })), /503/);
  await assert.rejects(fetchImplementationDates(async () => ({ok: true, json: async () => ({cargoquery: []})})), /过少/);
});
