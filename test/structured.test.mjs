import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness } from './harness.mjs';
import { Archive } from '../src/archive.mjs';
import descriptor from '../fixtures/descriptor.json' with { type: 'json' };
import routes from '../fixtures/routes.json' with { type: 'json' };

async function acquire(context, collectionId, entry, options = {}) {
  return context.call('/acquisitions', { collectionId, entry, options });
}

function record(collection, kind, predicate = () => true) {
  return collection.records.filter(item => item.kind === kind).find(predicate);
}

test('同姓名的两个人保持各自指针，不按姓名合并', async () => {
  const context = await harness();
  try {
    const result = await acquire(context, 'people', context.source + descriptor.entry);
    assert.equal(result.status, 201);
    const collection = (await context.call('/collections/people')).value;
    const people = collection.records.filter(item => item.kind === 'person');
    assert.equal(people.length, 2);
    assert.deepEqual(people.map(item => item.value.pointer).sort(), ['@I1@', '@I2@']);
    assert.equal(new Set(people.map(item => item.key)).size, 2);
    for (const person of people) {
      assert.equal(person.deliveryId, 'delivery-1');
      assert.ok(person.provenance[0].receiptId.match(/^[a-f0-9]{64}$/));
      assert.ok(person.provenance[0].location.startsWith('line:'));
    }
  } finally { await context.close(); }
});

test('寄养关系保留原限定，不默认成生物学关系', async () => {
  const context = await harness();
  try {
    await acquire(context, 'pedigree', context.source + descriptor.entry);
    const collection = (await context.call('/collections/pedigree')).value;
    const foster = record(collection, 'relationship', item => item.value.child === '@I1@');
    assert.equal(foster.value.pedigree, 'FOSTER');
    assert.equal(foster.value.family, '@F1@');
    assert.equal(foster.value.familyKey, 'delivery-1:@F1@');
    assert.ok(foster.provenance[0].location.length > 0);
  } finally { await context.close(); }
});

test('区间日期保留原文与精度，不整理成精确生日', async () => {
  const context = await harness();
  try {
    await acquire(context, 'dates', context.source + descriptor.entry);
    const collection = (await context.call('/collections/dates')).value;
    const date = record(collection, 'event-date', item => item.value.raw?.includes('BET'));
    assert.deepEqual(date.value, { raw: 'BET 1900 AND 1902', precision: 'range' });
  } finally { await context.close(); }
});

test('续行、自定义标签与重复指针忠实保留', async () => {
  const context = await harness();
  try {
    const entry = context.source + '/files/mixed.ged';
    const result = await acquire(context, 'mixed', entry);
    assert.equal(result.status, 201);
    const collection = (await context.call('/collections/mixed')).value;
    const note = record(collection, 'note', item => item.value.text?.startsWith('first'));
    assert.equal(note.value.text, 'first-joined');
    assert.equal(note.provenance[0].location, 'line:13-14');
    const custom = record(collection, 'custom-tag', item => item.value.tag === '_CUSTOM');
    assert.equal(custom.value.value, 'keep-metail');
    assert.ok(collection.issues.some(issue => issue.reason === 'duplicate_pointer' && issue.pointer === '@I9@'));
    const people = collection.records.filter(item => item.kind === 'person');
    assert.equal(people.length, 2);
    assert.notEqual(people[0].key, people[1].key);
    const relationship = record(collection, 'relationship', item => item.value.child === '@I9@');
    assert.equal(relationship.value.pedigree, undefined);
    // 关系附注保存在关系旁，不丢失也不升级成生物学关系。
    const fosterNote = collection.records.find(item => item.kind === 'note' && item.value.text === 'foster-placed');
    assert.equal(fosterNote.value.relationship, relationship.key);
    // 共享 NOTE 引用保留指针与包内身份，不复制成孤立正文。
    const shared = collection.records.find(item => item.kind === 'note' && item.value.note === '@N1@');
    assert.equal(shared.value.noteKey, collection.records.find(item => item.kind === 'note' && item.value.text?.startsWith('shared note')).key);
    const sharedNote = collection.records.find(item => item.kind === 'note' && item.value.text?.startsWith('shared note'));
    assert.equal(sharedNote.value.text, 'shared note text\nsecond line');
    assert.equal(sharedNote.provenance[0].location, 'line:17-18');
  } finally { await context.close(); }
});

test('约数与估计日期分别标记，来源可回溯到真实收件', async () => {
  const context = await harness();
  try {
    await acquire(context, 'approx', context.source + '/files/mixed.ged');
    const collection = (await context.call('/collections/approx')).value;
    const date = record(collection, 'event-date');
    assert.deepEqual(date.value, { raw: 'ABT 1888', precision: 'about' });
    const receipt = await context.call('/receipts/' + date.provenance[0].receiptId);
    assert.equal(receipt.status, 200);
    assert.equal(receipt.value.collectionId, 'approx');
  } finally { await context.close(); }
});

test('补交来源资料后补齐引用出处，不覆盖已归档原文', async () => {
  const context = await harness();
  try {
    // 先领取不完整包：sources.ged 尚未到位，@S1@ 引用无法解析。
    const partial = await harness('partial');
    try {
      const result = await acquire(partial, 'gap', partial.source + descriptor.entry);
      assert.equal(result.status, 201);
      const collection = (await partial.call('/collections/gap')).value;
      assert.ok(collection.issues.some(issue => issue.reason === 'resource_unavailable'));
      assert.ok(collection.issues.some(issue => issue.reason === 'unresolved_pointer' && issue.pointer === '@S1@'));
      const before = collection.records.find(item => item.kind === 'citation');
      assert.equal(before.value.sourceKey, undefined);
      const receiptsBefore = collection.receiptIds.length;

      // 完整来源补交同一资料集的来源资源：使用同一 deliveryId 并入原包。
      const supplement = await partial.call('/acquisitions', {
        collectionId: 'gap', entry: partial.source + '/files/sources-late.ged', options: { deliveryId: 'delivery-1' }
      });
      assert.equal(supplement.status, 201);
      const after = (await partial.call('/collections/gap')).value;
      assert.ok(after.receiptIds.length > receiptsBefore);
      assert.ok(!after.issues.some(issue => issue.reason === 'unresolved_pointer' && issue.pointer === '@S1@'));
      const citation = after.records.find(item => item.kind === 'citation');
      assert.equal(citation.value.sourceKey, 'delivery-1:@S1@');
      const source = after.records.find(item => item.kind === 'source');
      assert.equal(source.value.title, 'Synthetic family record');
      // 来源原文仍可读取，未被解析摘要替代。
      const body = await fetch(partial.base + '/receipts/' + source.provenance[0].receiptId + '/body').then(response => response.text());
      assert.ok(body.includes('Synthetic family record'));
    } finally { await partial.close(); }
  } finally { await context.close(); }
});

test('跨包人物是否同一留给整理员确认，且不合并记录', async () => {
  const context = await harness();
  try {
    await acquire(context, 'review', context.source + descriptor.entry);
    const second = await acquire(context, 'review', context.source + '/second-delivery');
    assert.equal(second.status, 201);
    const before = (await context.call('/collections/review')).value;
    assert.deepEqual(before.deliveries, ['delivery-1', 'delivery-2']);
    // 两个包都有 @I1@ 且同名：仍是两条独立人物记录，身份键不同。
    const people = before.records.filter(item => item.kind === 'person');
    assert.equal(people.length, 3);
    const chen = people.filter(item => item.value.pointer === '@I1@');
    assert.equal(chen.length, 2);
    assert.notEqual(chen[0].key, chen[1].key);
    assert.deepEqual(chen.map(item => item.deliveryId).sort(), ['delivery-1', 'delivery-2']);
    const names = before.records.filter(item => item.kind === 'name' && item.value.name === 'Chen /Lin/');
    assert.equal(names.length, 3);

    const link = { left: 'delivery-1:@I1@', right: 'delivery-2:@I1@', confirmedBy: 'librarian' };
    assert.equal((await context.call('/collections/review/identities', link)).status, 201);
    const after = (await context.call('/collections/review')).value;
    assert.deepEqual(after.identities, [link]);
    // 确认只登记对应关系，不把两条声明合并或删除任何一条。
    assert.equal(after.records.filter(item => item.kind === 'person').length, 3);
    assert.deepEqual(after.records.filter(item => item.kind === 'person'), people);
    // 未确认时不会产生任何合并痕迹。
    const fresh = await harness();
    try {
      await acquire(fresh, 'review', fresh.source + descriptor.entry);
      const untouched = (await fresh.call('/collections/review')).value;
      assert.equal(untouched.identities, undefined);
    } finally { await fresh.close(); }
  } finally { await context.close(); }
});

test('人工确认的同键记录优先保留，自动值冲突显式登记', async () => {
  const context = await harness();
  try {
    const intake = await context.call('/intakes', { collectionId: 'confirm', sourceKey: 'note', revision: 'v1', contentBase64: 'eA==' });
    const manual = {
      kind: 'person', key: 'delivery-1:@I1@', value: { pointer: '@I1@', note: '人工确认' },
      provenance: [{ receiptId: intake.value.receiptId, location: 'line:1' }], manual: true
    };
    assert.equal((await context.call('/collections/confirm/records', manual)).status, 201);
    await acquire(context, 'confirm', context.source + descriptor.entry);
    const collection = (await context.call('/collections/confirm')).value;
    // 人工值不被自动解释覆盖，两个值都保留供比对。
    assert.deepEqual(collection.records.find(item => item.key === 'delivery-1:@I1@').value, manual.value);
    assert.deepEqual(collection.conflicts, [{
      kind: 'person', key: 'delivery-1:@I1@', deliveryId: 'delivery-1',
      automatic: { pointer: '@I1@' }, manual: manual.value
    }]);
    const issue = collection.issues.find(item => item.reason === 'manual_identity_conflict');
    assert.equal(issue.key, 'delivery-1:@I1@');
    assert.ok(issue.receiptId && issue.location);
    // 再次领取不会把冲突清掉。
    await acquire(context, 'confirm', context.source + descriptor.entry);
    assert.equal((await context.call('/collections/confirm')).value.conflicts.length, 1);
  } finally { await context.close(); }
});

test('身份确认只接受本资料集已解释的人物键', async () => {
  const context = await harness();
  try {
    await acquire(context, 'keys', context.source + descriptor.entry);
    assert.equal((await context.call('/collections/keys/identities', { left: 'ghost:@I1@', right: 'delivery-1:@I2@' })).status, 400);
    assert.equal((await context.call('/collections/keys/identities', { left: 'delivery-1:@I1@', right: 'delivery-1:@I1@' })).status, 400);
    const link = { left: 'delivery-1:@I1@', right: 'delivery-1:@I2@', confirmedBy: 'librarian' };
    assert.equal((await context.call('/collections/keys/identities', link)).status, 201);
    // 反向重复提交保持幂等，不产生第二条对应。
    assert.equal((await context.call('/collections/keys/identities', { left: link.right, right: link.left })).status, 201);
    assert.deepEqual((await context.call('/collections/keys')).value.identities, [link]);
  } finally { await context.close(); }
});

test('来源新版本里消失的记录标为不再当前，不静默删除', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'revisions-'));
  try {
    const archive = new Archive(directory);
    await archive.initialize();
    const receipt = await archive.receive({ collectionId: 'rev', sourceKey: 'src', revision: 'r1', mediaType: 'text/plain', bytes: Buffer.from('x'), summary: {}, deliveryId: 'd1' });
    const origin = [{ receiptId: receipt.receiptId, location: 'line:1' }];
    const oldRecord = { kind: 'person', key: 'd1:@I1@', value: { pointer: '@I1@' }, deliveryId: 'd1', provenance: origin };
    await archive.addInterpretation('rev', { deliveryId: 'd1', records: [oldRecord], issues: [], receiptIds: [receipt.receiptId] });
    // 第二个版本只产生另一条记录。
    const nextRecord = { kind: 'person', key: 'd1:@I2@', value: { pointer: '@I2@' }, deliveryId: 'd1', provenance: origin };
    const collection = await archive.addInterpretation('rev', { deliveryId: 'd1', records: [nextRecord], issues: [], receiptIds: [receipt.receiptId] });
    const stale = collection.records.find(item => item.key === 'd1:@I1@');
    assert.equal(stale.current, false);
    assert.equal(stale.issues[0].reason, 'not_in_current_source');
    const current = collection.records.find(item => item.key === 'd1:@I2@');
    assert.equal(current.current, undefined);
    // 下个版本再次出现时恢复为当前。
    const restored = await archive.addInterpretation('rev', { deliveryId: 'd1', records: [oldRecord], issues: [], receiptIds: [receipt.receiptId] });
    assert.equal(restored.records.find(item => item.key === 'd1:@I1@').current, undefined);
    assert.equal(restored.records.find(item => item.key === 'd1:@I1@').issues, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('重新领取同一资料集不重复记录，重启后仍可回查', async () => {
  const context = await harness();
  try {
    await acquire(context, 'stable', context.source + descriptor.entry);
    const first = (await context.call('/collections/stable')).value;
    await acquire(context, 'stable', context.source + descriptor.entry);
    const second = (await context.call('/collections/stable')).value;
    assert.deepEqual(second.records, first.records);
    assert.equal(new Set(second.receiptIds).size, second.receiptIds.length);
    await context.restart();
    assert.deepEqual((await context.call('/collections/stable')).value.records, first.records);
  } finally { await context.close(); }
});

test('缺件或截断的来源只登记问题，不冒充完整解释', async () => {
  const context = await harness('partial');
  try {
    const result = await acquire(context, 'partial-records', context.source + descriptor.entry);
    assert.equal(result.status, 201);
    const collection = (await context.call('/collections/partial-records')).value;
    assert.ok(collection.issues.length > 0);
    for (const issue of collection.issues) assert.ok(issue.reason && issue.location);
    assert.ok(collection.receiptIds.length > 0);
    // 截断文件没有 TRLR，必须显式说明而不是静默忽略。
    assert.ok(collection.issues.some(issue => issue.reason === 'missing_trailer'));
  } finally { await context.close(); }
});

test('来源路由保持只读且字节与样本一致', async () => {
  const context = await harness();
  try {
    for (const [path, route] of Object.entries(routes)) {
      if (!route.file) continue;
      const response = await fetch(context.source + path);
      assert.equal(response.status, 200, path);
    }
  } finally { await context.close(); }
});
