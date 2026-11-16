// 把 GEDCOM 7 语法树解释为收件库的结构化观察记录。
// 身份按捐赠包（deliveryId）内指针保存，绝不按姓名合并；
// 关系限定（PEDI）、约数/区间日期、续行、自定义标签与重复声明均忠实保留。
// 一个交付包可由多个 GEDCOM 资源组成，指针作用域为整个 deliveryId。

import { parseGedcom } from './gedcom.mjs';

const EVENT_TAGS = new Set([
  'BIRT', 'DEAT', 'CHR', 'BAPM', 'BURI', 'CREM', 'ADOP', 'MARR', 'DIV',
  'ANUL', 'ENGA', 'CENS', 'OCCU', 'RESI', 'EMIG', 'IMMI', 'NATU', 'RETI',
  'GRAD', 'CONF', 'ORDN', 'PROB', 'WILL', 'EVEN'
]);
const ENTITY_TAGS = new Set(['INDI', 'FAM', 'SOUR', 'NOTE']);
const KNOWN_INDI_CHILDREN = new Set(['NAME', 'SEX', 'BIRT', 'DEAT', 'CHR', 'BAPM', 'BURI', 'CREM', 'ADOP', 'MARR', 'DIV', 'ANUL', 'ENGA', 'CENS', 'OCCU', 'RESI', 'EMIG', 'IMMI', 'NATU', 'RETI', 'GRAD', 'CONF', 'ORDN', 'PROB', 'WILL', 'EVEN', 'FAMC', 'FAMS', 'NOTE', 'SOUR']);
const KNOWN_FAM_CHILDREN = new Set(['HUSB', 'WIFE', 'CHIL', 'MARR', 'DIV', 'ANUL', 'ENGA', 'EVEN', 'NOTE', 'SOUR']);
const KNOWN_SOUR_CHILDREN = new Set(['TITL', 'AUTH', 'PUBL', 'TEXT', 'NOTE', 'DATA']);
const KNOWN_EVENT_CHILDREN = new Set(['DATE', 'PLAC', 'SOUR', 'NOTE', 'TYPE', 'AGE', 'CAUS']);

export function classifyPrecision(rawDate) {
  const raw = rawDate.trim();
  if (/^BET\s+.+\s+AND\s+/i.test(raw)) return 'range';
  if (/^FROM\s+.+\s+TO\s+/i.test(raw)) return 'period';
  if (/^ABT/i.test(raw)) return 'approximate';
  if (/^CAL/i.test(raw)) return 'calculated';
  if (/^EST/i.test(raw)) return 'estimated';
  if (/^(BEF|AFT)/i.test(raw)) return 'boundary';
  if (raw.startsWith('(')) return 'phrase';
  return 'exact';
}

// 递归快照：把整棵子树（含自定义标签与重复声明）原样结构化保留，
// 每个节点带物理行位置，馆员可沿任一关系回到原记录。
function snapshot(node) {
  return {
    tag: node.tag,
    pointer: node.pointer,
    payload: node.payload,
    text: node.text,
    location: node.location,
    children: node.children.map(snapshot)
  };
}

function extension(node) {
  return { tag: node.tag, payload: node.payload, location: node.location, statement: snapshot(node) };
}

function findChild(node, tag) {
  return node.children.find(child => child.tag === tag);
}

function namesOf(node) {
  return node.children.filter(child => child.tag === 'NAME').map(child => ({
    raw: child.payload,
    text: child.joinedText,
    location: child.location,
    parts: child.textParts
  }));
}

function notesOf(node) {
  return node.children.filter(child => child.tag === 'NOTE').map(child => ({
    text: child.joinedText,
    pointer: child.isPointer ? child.payload : null,
    parts: child.textParts,
    location: child.location
  }));
}

function sourceRefsOf(node) {
  return node.children.filter(child => child.tag === 'SOUR').map(child => ({
    pointer: child.isPointer ? child.payload : null,
    inline: child.isPointer ? null : child.joinedText,
    location: child.location,
    statement: snapshot(child)
  }));
}

function buildEvents({ node, receiptId, deliveryId, push }) {
  const events = [];
  node.children.filter(child => EVENT_TAGS.has(child.tag)).forEach((eventNode, index) => {
    const dateNode = findChild(eventNode, 'DATE');
    const placeNode = findChild(eventNode, 'PLAC');
    const eventValue = {
      deliveryId,
      subject: node.pointer,
      type: eventNode.tag,
      date: dateNode ? { raw: dateNode.payload, precision: classifyPrecision(dateNode.payload), location: dateNode.location } : null,
      place: placeNode ? { raw: placeNode.joinedText, location: placeNode.location } : null,
      sourceRefs: sourceRefsOf(eventNode),
      notes: notesOf(eventNode),
      extensions: eventNode.children
        .filter(child => !KNOWN_EVENT_CHILDREN.has(child.tag))
        .map(extension),
      statement: snapshot(eventNode)
    };
    const eventKey = `${deliveryId}:event:${node.pointer}:${eventNode.tag}:${index + 1}:line${eventNode.lineNumber}`;
    push({
      kind: 'event',
      key: eventKey,
      value: eventValue,
      provenance: [{ receiptId, location: eventNode.location }]
    });
    events.push({ type: eventNode.tag, location: eventNode.location, date: eventValue.date });

    // 日期作为独立观察保存原文与精度，约数、区间绝不折算为精确生日。
    if (dateNode) {
      push({
        kind: 'event-date',
        key: `${deliveryId}:event-date:${node.pointer}:${eventNode.tag}:line${dateNode.lineNumber}`,
        value: {
          deliveryId,
          subject: node.pointer,
          event: eventNode.tag,
          raw: dateNode.payload,
          precision: classifyPrecision(dateNode.payload),
          location: dateNode.location
        },
        provenance: [{ receiptId, location: dateNode.location }]
      });
    }
  });
  return events;
}

// 解释整个交付包。resources 为同包已领取资源：{ name, bytes, receiptId }。
// 指针在包内统一解析；独立资料集不互认指针，跨包身份留给整理员确认。
export function interpretDelivery(deliveryId, resources) {
  const records = [];
  const issues = [];
  const seenIssues = new Set();
  const pushIssue = (issue) => {
    const serialized = JSON.stringify(issue);
    if (!seenIssues.has(serialized)) {
      seenIssues.add(serialized);
      issues.push(issue);
    }
  };
  const push = (record) => records.push(record);

  // 第一阶段：解析全部资源，建立包级实体指针索引与关系合并表。
  const parsedResources = resources.map(resource => ({ ...resource, parsed: parseGedcom(resource.bytes, resource.name) }));
  for (const resource of parsedResources) resource.parsed.issues.forEach(pushIssue);

  // pointer -> [{ node, resource, occurrence }]，重复声明全部保留。
  const entities = new Map();
  const occurrenceByPointer = new Map();
  for (const resource of parsedResources) {
    for (const node of resource.parsed.nodes) {
      if (!ENTITY_TAGS.has(node.tag)) continue;
      if (!node.pointer) {
        pushIssue({ reason: 'entity_without_pointer', location: node.location, detail: `${node.tag} 记录缺少指针，无法建立包内身份` });
        continue;
      }
      if (entities.has(node.pointer)) {
        pushIssue({ reason: 'duplicate_pointer', location: node.location, detail: `指针 ${node.pointer} 重复声明，各份声明均保留不合并` });
      }
      const occurrence = (occurrenceByPointer.get(node.pointer) || 0) + 1;
      occurrenceByPointer.set(node.pointer, occurrence);
      const declarations = entities.get(node.pointer) || [];
      declarations.push({ node, resource, occurrence });
      entities.set(node.pointer, declarations);
    }
  }

  const requirePointer = (pointer, location) => {
    if (!entities.has(pointer)) {
      pushIssue({ reason: 'unresolved_pointer', location, detail: `引用 ${pointer} 在捐赠包 ${deliveryId} 内没有对应声明，不跨包推测身份` });
    }
  };

  // 全包引用校验：遍历每个指针型负载（SOUR/NOTE/FAMC/FAMS/HUSB/WIFE/CHIL 等），
  // 包括事件与子结构中的引用；出处缺失记录 issue，不静默丢弃。
  const REFERENCE_TAGS = new Set(['SOUR', 'NOTE', 'FAMC', 'FAMS', 'HUSB', 'WIFE', 'CHIL', 'ALIA', 'ANCI', 'DESI', 'SUBM']);
  const walkReferences = (node) => {
    if (REFERENCE_TAGS.has(node.tag) && node.isPointer) requirePointer(node.payload, node.location);
    for (const child of node.children) walkReferences(child);
  };
  for (const resource of parsedResources) {
    for (const node of resource.parsed.nodes) walkReferences(node);
  }

  const relationships = new Map();
  const relationshipKey = (family, child) => `${family}|${child}`;
  const ensureRelationship = (family, child, location, receiptId) => {
    const key = relationshipKey(family, child);
    let relationship = relationships.get(key);
    if (!relationship) {
      relationship = { child, family, pedigree: null, famcLocation: null, chilLocation: null, origins: [] };
      relationships.set(key, relationship);
    }
    if (!relationship.origins.some(origin => origin.location === location)) {
      relationship.origins.push({ receiptId, location });
    }
    return relationship;
  };

  // 第二阶段：逐资源、逐实体解释，出处始终回指产生该记录的具体收件与行。
  for (const resource of parsedResources) {
    const { receiptId, parsed } = resource;
    for (const node of parsed.nodes) {
      if (!ENTITY_TAGS.has(node.tag) || !node.pointer) continue;
      const declarations = entities.get(node.pointer) || [];
      const declaration = declarations.find(entry => entry.node === node);
      const suffix = declarations.length > 1 ? `:dup${declaration.occurrence}` : '';

      if (node.tag === 'INDI') {
        const familyChildLinks = node.children
          .filter(child => child.tag === 'FAMC')
          .map(child => {
            const pedigreeNode = findChild(child, 'PEDI');
            const link = { family: child.payload, pedigree: pedigreeNode ? pedigreeNode.payload : null, location: child.location };
            if (child.isPointer) {
              const relationship = ensureRelationship(child.payload, node.pointer, child.location, receiptId);
              relationship.famcLocation = child.location;
              if (pedigreeNode) relationship.pedigree = pedigreeNode.payload;
            }
            return link;
          });
        const familySpouseLinks = node.children
          .filter(child => child.tag === 'FAMS')
          .map(child => ({ family: child.payload, location: child.location }));
        const events = buildEvents({ node, receiptId, deliveryId, push });
        push({
          kind: 'person',
          key: `${deliveryId}:person:${node.pointer}${suffix}`,
          value: {
            deliveryId,
            pointer: node.pointer,
            names: namesOf(node),
            sex: findChild(node, 'SEX')?.payload ?? null,
            events,
            familyChildLinks,
            familySpouseLinks,
            notes: notesOf(node),
            sourceRefs: sourceRefsOf(node),
            extensions: node.children.filter(child => !KNOWN_INDI_CHILDREN.has(child.tag)).map(extension),
            statement: snapshot(node)
          },
          provenance: [{ receiptId, location: node.location }]
        });
      }

      if (node.tag === 'FAM') {
        const husbands = node.children.filter(child => child.tag === 'HUSB').map(child => ({ pointer: child.payload, location: child.location }));
        const wives = node.children.filter(child => child.tag === 'WIFE').map(child => ({ pointer: child.payload, location: child.location }));
        const children = node.children.filter(child => child.tag === 'CHIL').map(child => {
          if (child.isPointer) {
            const relationship = ensureRelationship(node.pointer, child.payload, child.location, receiptId);
            relationship.chilLocation = child.location;
          }
          return { pointer: child.payload, location: child.location };
        });
        const events = buildEvents({ node, receiptId, deliveryId, push });
        push({
          kind: 'family',
          key: `${deliveryId}:family:${node.pointer}${suffix}`,
          value: {
            deliveryId,
            pointer: node.pointer,
            husbands,
            wives,
            children,
            events,
            notes: notesOf(node),
            sourceRefs: sourceRefsOf(node),
            extensions: node.children.filter(child => !KNOWN_FAM_CHILDREN.has(child.tag)).map(extension),
            statement: snapshot(node)
          },
          provenance: [{ receiptId, location: node.location }]
        });
      }

      if (node.tag === 'SOUR') {
        const titleNode = findChild(node, 'TITL');
        const authorNode = findChild(node, 'AUTH');
        const publicationNode = findChild(node, 'PUBL');
        push({
          kind: 'source',
          key: `${deliveryId}:source:${node.pointer}${suffix}`,
          value: {
            deliveryId,
            pointer: node.pointer,
            title: titleNode ? titleNode.joinedText : null,
            author: authorNode ? authorNode.joinedText : null,
            publication: publicationNode ? publicationNode.joinedText : null,
            notes: notesOf(node),
            extensions: node.children.filter(child => !KNOWN_SOUR_CHILDREN.has(child.tag)).map(extension),
            statement: snapshot(node)
          },
          provenance: [{ receiptId, location: node.location }]
        });
      }

      if (node.tag === 'NOTE') {
        push({
          kind: 'note',
          key: `${deliveryId}:note:${node.pointer}${suffix}`,
          value: {
            deliveryId,
            pointer: node.pointer,
            text: node.joinedText,
            parts: node.textParts,
            statement: snapshot(node)
          },
          provenance: [{ receiptId, location: node.location }]
        });
      }
    }

    // 未知 0 级记录：明确标识为未支持扩展，不假称已解释，也不静默丢弃。
    for (const node of parsed.nodes) {
      if (!ENTITY_TAGS.has(node.tag) && node.tag !== 'HEAD' && node.tag !== 'TRLR') {
        pushIssue({ reason: 'unsupported_record', location: node.location, detail: `未支持的 0 级标签 ${node.tag}，原始声明已保留为扩展记录` });
        push({
          kind: 'extension',
          key: `${deliveryId}:extension:${node.tag}:line${node.lineNumber}`,
          value: { deliveryId, tag: node.tag, statement: snapshot(node) },
          provenance: [{ receiptId, location: node.location }]
        });
      }
    }
  }

  // 关系限定跟随原记录保存；没有 PEDI 时保持 null（未声明），不默认生物学关系。
  for (const relationship of relationships.values()) {
    push({
      kind: 'relationship',
      key: `${deliveryId}:relationship:${relationship.family}:${relationship.child}`,
      value: {
        deliveryId,
        child: relationship.child,
        family: relationship.family,
        pedigree: relationship.pedigree,
        declaredBy: { famc: relationship.famcLocation, chil: relationship.chilLocation }
      },
      provenance: relationship.origins
    });
  }

  return { records, issues };
}
