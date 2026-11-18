// 将 GEDCOM 7 结构解释为可回查的记录。
// 身份以 deliveryId + pointer 为准，绝不按姓名合并；指针只在同一捐赠包内解析。
import { parseGedcom, isPointer, locationOf } from './gedcom.mjs';

const EVENTS = new Set([
  'BIRT', 'CHR', 'DEAT', 'BURI', 'CREM', 'MARR', 'DIV', 'DIVF', 'ANUL', 'CENS', 'RESI', 'EVEN',
  'BAPM', 'BARM', 'BASM', 'BLES', 'CHRA', 'CONF', 'FCOM', 'ORDN', 'NATU', 'EMIG', 'IMMI',
  'PROB', 'WILL', 'ADOP', 'GRAD', 'RETI', 'BAPL', 'ENDL', 'SLGC', 'SLGS'
]);

// 只说明日期的表达方式，不把约数或区间改写成精确日。
export function dateExpression(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { precision: 'unknown' };
  if (/^BET\s+.+\s+AND\s+.+$/i.test(text) || /^FROM\s+.+\s+TO\s+.+$/i.test(text)) return { precision: 'range' };
  if (/^(ABT|ABOUT|CIR|CIRC|CIRCA)\s+/i.test(text)) return { precision: 'about' };
  if (/^EST\s+/i.test(text)) return { precision: 'estimated' };
  if (/^CAL\s+/i.test(text)) return { precision: 'calculated' };
  if (/^BEF\s+/i.test(text)) return { precision: 'before' };
  if (/^AFT\s+/i.test(text)) return { precision: 'after' };
  if (/^(INT)\s+/i.test(text) || /^\(.*\)$/.test(text)) return { precision: 'phrase' };
  if (/^\d{3,4}$/.test(text)) return { precision: 'year' };
  if (/^[A-Za-z]{3,9}\s+\d{3,4}$/.test(text)) return { precision: 'month' };
  if (/^\d{1,2}\s+[A-Za-z]{3,9}\s+\d{3,4}(\s*\/\s*\d{1,2})?$/.test(text)) return { precision: 'day' };
  return { precision: 'unknown' };
}

function valueOf(node) {
  return node.value === '' ? null : node.value;
}

/**
 * resources: [{ href, receiptId, bytes }]，同一捐赠包内的所有已领取资料。
 * 返回 { records, issues }，每条记录都带真实 receiptId 与原始行位置。
 */
export function interpretDelivery({ deliveryId, resources }) {
  const records = [];
  const issues = [];
  const parsed = [];
  const definitions = new Map();
  const definitionCounts = new Map();

  const issue = (reason, node, receiptId, extra = {}) => {
    issues.push({ reason, location: locationOf(node), receiptId, deliveryId, ...extra });
  };
  const emit = (kind, key, value, node, receiptId) => {
    records.push({ kind, key, value, deliveryId, provenance: [{ receiptId, location: locationOf(node) }] });
  };

  for (const resource of resources) {
    const text = Buffer.isBuffer(resource.bytes) ? resource.bytes.toString('utf8') : String(resource.bytes);
    const { roots, issues: parseIssues } = parseGedcom(text);
    parsed.push({ ...resource, roots });
    for (const found of parseIssues) issues.push({ ...found, receiptId: resource.receiptId, deliveryId, resource: resource.href });
    for (const root of roots) {
      if (!root.xref) continue;
      if (definitions.has(root.xref)) {
        // 重复声明两份都保留，但明确标出歧义，让整理员决定。
        issue('duplicate_pointer', root, resource.receiptId, { resource: resource.href, pointer: root.xref });
      } else {
        definitions.set(root.xref, { node: root, resource });
      }
      const count = (definitionCounts.get(root.xref) || 0) + 1;
      definitionCounts.set(root.xref, count);
      root.definitionIndex = count;
    }
  }

  const keyFor = (node, xref) => `${deliveryId}:${xref}${node.definitionIndex > 1 ? '#' + node.definitionIndex : ''}`;

  const checkPointer = (node, receiptId, resource, expectedTag) => {
    const pointer = node.value.trim();
    if (!isPointer(pointer)) {
      issue('invalid_pointer', node, receiptId, { resource });
      return null;
    }
    const definition = definitions.get(pointer);
    if (!definition) issue('unresolved_pointer', node, receiptId, { resource, pointer });
    else if (expectedTag && definition.node.tag !== expectedTag) {
      issue('pointer_type_mismatch', node, receiptId, { resource, pointer, expected: expectedTag, actual: definition.node.tag });
    }
    return pointer;
  };

  // 指向共享 NOTE 记录的引用保留指针，并尽可能给出包内注释身份；
  // 指向不存在或类型不符的注释只保留原文与问题，不伪造注释内容。
  const noteValue = (node, about, receiptId, resource) => {
    const pointer = isPointer(node.value) ? node.value.trim() : null;
    if (!pointer) return { text: node.value, about };
    if (receiptId) checkPointer(node, receiptId, resource, 'NOTE');
    const value = { about, note: pointer };
    const definition = definitions.get(pointer);
    if (definition && definition.node.tag === 'NOTE') value.noteKey = keyFor(definition.node, pointer);
    return value;
  };

  // 保留未专门解释的标签、扩展和续行，让馆员仍能沿原结构回查。
  // 标准标签以 tag 原样保留，不假称已解释；以 _ 开头的扩展标为 custom-tag。
  const preserve = (node, parentKey, receiptId, resource) => {
    for (const child of node.children) {
      if (child.tag === 'CONT' || child.tag === 'CONC') continue;
      const key = `${parentKey}:${child.tag}:${child.line}`;
      if (child.tag === 'NOTE') {
        emit('note', key, noteValue(child, parentKey, receiptId, resource), child, receiptId);
        preserve(child, key, receiptId, resource);
        continue;
      }
      const value = { tag: child.tag, value: valueOf(child) };
      if (child.continuations.length) value.continuations = child.continuations.map(item => ({ tag: item.tag, value: item.value, line: item.line }));
      if (isPointer(child.value)) value.pointer = child.value.trim();
      emit(child.tag.startsWith('_') ? 'custom-tag' : 'tag', key, value, child, receiptId);
      preserve(child, key, receiptId, resource);
    }
  };

  const cite = (node, targetKey, subjectPointer, receiptId, resource) => {
    const pointer = checkPointer(node, receiptId, resource, 'SOUR');
    if (!pointer) return;
    const definition = definitions.get(pointer);
    const value = { source: pointer, target: targetKey, subject: subjectPointer };
    // 补交来源记录后，引用应能指向同一包内已解释的来源身份；缺失时只留问题。
    if (definition && definition.node.tag === 'SOUR') value.sourceKey = keyFor(definition.node, pointer);
    emit('citation', `${targetKey}:SOUR:${node.line}`, value, node, receiptId);
    for (const child of node.children) {
      if (['PAGE', 'QUAY', 'DATA'].includes(child.tag)) {
        emit('tag', `${targetKey}:SOUR:${node.line}:${child.tag}:${child.line}`, { tag: child.tag, value: valueOf(child) }, child, receiptId);
        preserve(child, `${targetKey}:SOUR:${node.line}:${child.tag}:${child.line}`, receiptId, resource);
      } else preserve({ children: [child] }, `${targetKey}:SOUR:${node.line}`, receiptId, resource);
    }
  };

  const emitEvent = (event, subjectKey, subjectPointer, receiptId, resource) => {
    const eventKey = `${subjectKey}:${event.tag}:${event.line}`;
    const type = event.children.find(child => child.tag === 'TYPE');
    const value = { pointer: subjectPointer, tag: event.tag };
    if (type && type.value) value.type = type.value;
    emit('event', eventKey, value, event, receiptId);

    for (const child of event.children) {
      if (child.tag === 'DATE') {
        const expression = dateExpression(child.value);
        emit('event-date', `${eventKey}:DATE:${child.line}`, { raw: child.value, ...expression }, child, receiptId);
        if (!child.value.trim()) issue('empty_date', child, receiptId, { resource });
      } else if (child.tag === 'SOUR') {
        cite(child, eventKey, subjectPointer, receiptId, resource);
      } else if (child.tag === 'NOTE') {
        emit('note', `${eventKey}:NOTE:${child.line}`, noteValue(child, eventKey, receiptId, resource), child, receiptId);
        preserve(child, `${eventKey}:NOTE:${child.line}`, receiptId, resource);
      } else if (child.tag === 'TYPE') {
        continue;
      } else if (['PLAC', 'ADDR', 'AGNC', 'CAUS', 'AGE'].includes(child.tag)) {
        const value = { tag: child.tag, value: valueOf(child) };
        if (isPointer(child.value)) value.pointer = child.value.trim();
        emit('tag', `${eventKey}:${child.tag}:${child.line}`, value, child, receiptId);
        preserve(child, `${eventKey}:${child.tag}:${child.line}`, receiptId, resource);
      } else {
        preserve({ children: [child] }, eventKey, receiptId, resource);
      }
    }
  };

  for (const [resourceIndex, resource] of parsed.entries()) {
    const { roots, receiptId, href } = resource;
    for (const root of roots) {
      if (root.tag === 'HEAD' || root.tag === 'TRLR') continue;
      // 无指针记录在包内可能重名：加入资源序号，避免不同文件的行号撞键。
      const subjectKey = root.xref ? keyFor(root, root.xref) : `${deliveryId}:${root.tag}:${resourceIndex}:${root.line}`;

      if (root.tag === 'INDI') {
        if (!root.xref) { issue('missing_pointer', root, receiptId, { resource: href }); continue; }
        const pointer = root.xref;
        emit('person', subjectKey, { pointer }, root, receiptId);

        for (const name of root.children.filter(child => child.tag === 'NAME')) {
          const type = name.children.find(child => child.tag === 'TYPE');
          const value = { pointer, name: name.value };
          if (type && type.value) value.type = type.value;
          emit('name', `${subjectKey}:NAME:${name.line}`, value, name, receiptId);
          preserve({ children: name.children.filter(child => child.tag !== 'TYPE') }, `${subjectKey}:NAME:${name.line}`, receiptId, href);
        }

        for (const child of root.children) {
          if (child.tag === 'NAME') continue;
          if (child.tag === 'FAMC') {
            const family = checkPointer(child, receiptId, href, 'FAM');
            if (!family) continue;
            const pedigree = child.children.find(grandchild => grandchild.tag === 'PEDI');
            const value = { child: pointer, family };
            // 未声明 PEDI 时不补写生物学关系；只保存来源明确给出的限定。
            if (pedigree && pedigree.value) value.pedigree = pedigree.value;
            const familyDefinition = definitions.get(family);
            if (familyDefinition && familyDefinition.node.tag === 'FAM') value.familyKey = keyFor(familyDefinition.node, family);
            emit('relationship', `${subjectKey}:FAMC:${child.line}`, value, child, receiptId);
            for (const grandchild of child.children) {
              if (grandchild.tag === 'PEDI') continue;
              if (grandchild.tag === 'NOTE') {
                // 关系附注与关系本身一起保留，并指向该关系记录。
                const note = noteValue(grandchild, pointer, receiptId, href);
                note.relationship = `${subjectKey}:FAMC:${child.line}`;
                emit('note', `${subjectKey}:FAMC:${child.line}:NOTE:${grandchild.line}`, note, grandchild, receiptId);
                preserve(grandchild, `${subjectKey}:FAMC:${child.line}:NOTE:${grandchild.line}`, receiptId, href);
                continue;
              }
              preserve({ children: [grandchild] }, `${subjectKey}:FAMC:${child.line}`, receiptId, href);
            }
            continue;
          }
          if (child.tag === 'FAMS') {
            const family = checkPointer(child, receiptId, href, 'FAM');
            if (!family) continue;
            emit('tag', `${subjectKey}:FAMS:${child.line}`, { tag: child.tag, pointer: family }, child, receiptId);
            continue;
          }
          if (child.tag === 'NOTE') {
            emit('note', `${subjectKey}:NOTE:${child.line}`, noteValue(child, pointer, receiptId, href), child, receiptId);
            preserve(child, `${subjectKey}:NOTE:${child.line}`, receiptId, href);
            continue;
          }
          if (child.tag === 'SOUR') { cite(child, subjectKey, pointer, receiptId, href); continue; }
          if (EVENTS.has(child.tag)) { emitEvent(child, subjectKey, pointer, receiptId, href); continue; }
          preserve({ children: [child] }, subjectKey, receiptId, href);
        }
        continue;
      }

      if (root.tag === 'FAM') {
        if (!root.xref) { issue('missing_pointer', root, receiptId, { resource: href }); continue; }
        const pointer = root.xref;
        emit('family', subjectKey, { pointer }, root, receiptId);

        for (const child of root.children) {
          if (child.tag === 'CHIL') {
            const childPointer = checkPointer(child, receiptId, href, 'INDI');
            if (!childPointer) continue;
            // 个人侧 FAMC 已表达同一关系时不再重复；关系限定跟原记录走。
            const covered = parsed.some(({ roots: all }) => all.some(other => other.tag === 'INDI' && other.xref === childPointer
              && other.children.some(link => link.tag === 'FAMC' && link.value.trim() === pointer)));
            if (!covered) {
              const value = { child: childPointer, family: pointer };
              const childDefinition = definitions.get(childPointer);
              if (childDefinition && childDefinition.node.tag === 'INDI') value.childKey = keyFor(childDefinition.node, childPointer);
              value.familyKey = subjectKey;
              emit('relationship', `${subjectKey}:CHIL:${child.line}`, value, child, receiptId);
            }
            continue;
          }
          if (child.tag === 'HUSB' || child.tag === 'WIFE') {
            const person = checkPointer(child, receiptId, href, 'INDI');
            if (!person) continue;
            emit('tag', `${subjectKey}:${child.tag}:${child.line}`, { tag: child.tag, pointer: person }, child, receiptId);
            continue;
          }
          if (child.tag === 'NOTE') {
            emit('note', `${subjectKey}:NOTE:${child.line}`, noteValue(child, pointer, receiptId, href), child, receiptId);
            preserve(child, `${subjectKey}:NOTE:${child.line}`, receiptId, href);
            continue;
          }
          if (child.tag === 'SOUR') { cite(child, subjectKey, pointer, receiptId, href); continue; }
          if (EVENTS.has(child.tag)) { emitEvent(child, subjectKey, pointer, receiptId, href); continue; }
          preserve({ children: [child] }, subjectKey, receiptId, href);
        }
        continue;
      }

      if (root.tag === 'SOUR') {
        if (!root.xref) { issue('missing_pointer', root, receiptId, { resource: href }); continue; }
        const title = root.children.find(child => child.tag === 'TITL');
        const value = { pointer: root.xref };
        if (title && title.value) value.title = title.value;
        emit('source', subjectKey, value, root, receiptId);
        preserve({ children: root.children.filter(child => child.tag !== 'TITL') }, subjectKey, receiptId, href);
        continue;
      }

      if (root.tag === 'NOTE') {
        emit('note', subjectKey, { text: root.value }, root, receiptId);
        preserve(root, subjectKey, receiptId, href);
        continue;
      }

      if (root.tag.startsWith('_')) {
        emit('custom-record', subjectKey, { tag: root.tag, value: valueOf(root) }, root, receiptId);
        preserve(root, subjectKey, receiptId, href);
        continue;
      }

      issue('unsupported_record', root, receiptId, { resource: href, tag: root.tag });
      preserve({ children: [root] }, `${deliveryId}:record:${resourceIndex}:${root.line}`, receiptId, href);
    }
  }

  return { records, issues };
}
