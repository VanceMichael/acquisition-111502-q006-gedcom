import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGedcom } from '../src/gedcom.mjs';
import { interpretDelivery, classifyPrecision } from '../src/interpreter.mjs';

const RECEIPT = 'a'.repeat(64);

function gedcom(text) {
  return Buffer.from(text, 'utf8');
}

test('续行 CONC/CONT 被忠实拼接且保留每个物理行位置', () => {
  const bytes = gedcom('0 HEAD\n0 @N1@ NOTE\n1 CONC alpha\n2 CONT beta\n0 TRLR\n');
  const parsed = parseGedcom(bytes, 'x.ged');
  const note = parsed.nodes.find(node => node.pointer === '@N1@');
  const conc = note.children[0];
  assert.equal(conc.joinedText, 'alpha\nbeta');
  assert.equal(conc.textParts.length, 2);
  assert.equal(conc.textParts[1].location, 'x.ged:line:4');
});

test('约数、区间与边界日期保留原文并标注精度，不折算成精确生日', () => {
  assert.equal(classifyPrecision('BET 1900 AND 1902'), 'range');
  assert.equal(classifyPrecision('ABT 1850'), 'approximate');
  assert.equal(classifyPrecision('EST 1850'), 'estimated');
  assert.equal(classifyPrecision('CAL 1850'), 'calculated');
  assert.equal(classifyPrecision('BEF 1900'), 'boundary');
  assert.equal(classifyPrecision('1900'), 'exact');
  const bytes = gedcom('0 HEAD\n0 @I1@ INDI\n1 BIRT\n2 DATE ABT 1850\n0 TRLR\n');
  const { records } = interpretDelivery('d', [{ name: 'a.ged', bytes, receiptId: RECEIPT }]);
  const date = records.find(record => record.kind === 'event-date');
  assert.equal(date.value.raw, 'ABT 1850');
  assert.equal(date.value.precision, 'approximate');
});

test('寄养关系限定跟随原记录，未声明 PEDI 时不默认生物学关系', () => {
  const bytes = gedcom([
    '0 HEAD',
    '0 @I1@ INDI',
    '1 FAMC @F1@',
    '2 PEDI FOSTER',
    '0 @I2@ INDI',
    '1 FAMC @F1@',
    '0 @F1@ FAM',
    '1 CHIL @I1@',
    '1 CHIL @I2@',
    '0 TRLR\n'
  ].join('\n'));
  const { records } = interpretDelivery('d', [{ name: 'a.ged', bytes, receiptId: RECEIPT }]);
  const relationships = records.filter(record => record.kind === 'relationship');
  const foster = relationships.find(record => record.value.child === '@I1@');
  const unspecified = relationships.find(record => record.value.child === '@I2@');
  assert.equal(foster.value.pedigree, 'FOSTER');
  assert.equal(unspecified.value.pedigree, null);
});

test('同名人物按指针区分，不按姓名自动合并', () => {
  const bytes = gedcom([
    '0 HEAD',
    '0 @I1@ INDI',
    '1 NAME Chen /Lin/',
    '0 @I2@ INDI',
    '1 NAME Chen /Lin/',
    '0 TRLR\n'
  ].join('\n'));
  const { records } = interpretDelivery('d', [{ name: 'a.ged', bytes, receiptId: RECEIPT }]);
  const people = records.filter(record => record.kind === 'person');
  assert.equal(people.length, 2);
  assert.deepEqual(people.map(record => record.value.pointer).sort(), ['@I1@', '@I2@']);
  assert.equal(new Set(people.map(record => record.key)).size, 2);
});

test('自定义标签与重复声明原样保留，并对未知 0 级标签登记限制说明', () => {
  const bytes = gedcom([
    '0 HEAD',
    '0 @I1@ INDI',
    '1 NAME A /B/',
    '1 _CUSTOM kept',
    '1 NAME A /B/ Jr.',
    '0 @X1@ _THING',
    '1 DATA value',
    '0 TRLR\n'
  ].join('\n'));
  const { records, issues } = interpretDelivery('d', [{ name: 'a.ged', bytes, receiptId: RECEIPT }]);
  const person = records.find(record => record.kind === 'person');
  assert.equal(person.value.names.length, 2);
  assert.equal(person.value.extensions[0].tag, '_CUSTOM');
  assert.equal(person.value.extensions[0].payload, 'kept');
  const extension = records.find(record => record.kind === 'extension');
  assert.equal(extension.value.tag, '_THING');
  assert.equal(extension.value.statement.children[0].tag, 'DATA');
  assert.ok(issues.some(issue => issue.reason === 'unsupported_record'));
});

test('重复指针的两份声明都保留并登记 duplicate_pointer', () => {
  const bytes = gedcom([
    '0 HEAD',
    '0 @I1@ INDI',
    '1 NAME First /One/',
    '0 @I1@ INDI',
    '1 NAME Second /One/',
    '0 TRLR\n'
  ].join('\n'));
  const { records, issues } = interpretDelivery('d', [{ name: 'a.ged', bytes, receiptId: RECEIPT }]);
  const people = records.filter(record => record.kind === 'person');
  assert.equal(people.length, 2);
  assert.ok(issues.some(issue => issue.reason === 'duplicate_pointer'));
  assert.notEqual(people[0].key, people[1].key);
});

test('同包跨资源指针可解析，独立解释时缺失引用登记 issue', () => {
  const family = gedcom('0 HEAD\n0 @I1@ INDI\n1 SOUR @S1@\n0 TRLR\n');
  const source = gedcom('0 HEAD\n0 @S1@ SOUR\n1 TITL S\n0 TRLR\n');
  const together = interpretDelivery('d', [
    { name: 'family.ged', bytes: family, receiptId: RECEIPT },
    { name: 'sources.ged', bytes: source, receiptId: 'b'.repeat(64) }
  ]);
  assert.equal(together.issues.filter(issue => issue.reason === 'unresolved_pointer').length, 0);
  const alone = interpretDelivery('d', [{ name: 'family.ged', bytes: family, receiptId: RECEIPT }]);
  assert.ok(alone.issues.some(issue => issue.reason === 'unresolved_pointer'));
});

test('截断文件缺少 TRLR 时登记问题但不丢弃已解释记录', () => {
  const bytes = gedcom('0 HEAD\n0 @I1@ INDI\n1 NAME A /B/');
  const parsed = parseGedcom(bytes, 'cut.ged');
  assert.equal(parsed.unterminated, true);
  const { records, issues } = interpretDelivery('d', [{ name: 'cut.ged', bytes, receiptId: RECEIPT }]);
  assert.ok(records.some(record => record.kind === 'person'));
  assert.ok(issues.some(issue => issue.reason === 'unterminated_dataset'));
});
