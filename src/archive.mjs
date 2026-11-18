import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function identifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(value)) {
    throw Object.assign(new Error('invalid_identifier'), { status: 400 });
  }
  return value;
}

export class Archive {
  constructor(directory) {
    this.directory = directory;
    this.pending = Promise.resolve();
  }

  async initialize() {
    for (const name of ['blobs', 'receipts', 'collections']) {
      await mkdir(join(this.directory, name), { recursive: true });
    }
  }

  async serialized(operation) {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }

  async saveJson(path, value) {
    const temporary = path + '.pending';
    await writeFile(temporary, JSON.stringify(value, null, 2));
    await rename(temporary, path);
  }

  async collection(collectionId) {
    identifier(collectionId);
    try {
      return JSON.parse(await readFile(join(this.directory, 'collections', collectionId + '.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { collectionId, receiptIds: [], records: [], issues: [] };
    }
  }

  async receive({ collectionId, sourceKey, revision, mediaType, bytes, summary, deliveryId }) {
    identifier(collectionId);
    if (typeof sourceKey !== 'string' || !sourceKey || typeof revision !== 'string' || !revision) {
      throw Object.assign(new Error('missing_source_identity'), { status: 400 });
    }
    const sha256 = digest(bytes);
    const receiptId = digest(Buffer.from(JSON.stringify([collectionId, sourceKey, revision])));
    return this.serialized(async () => {
      const path = join(this.directory, 'receipts', receiptId + '.json');
      try {
        const existing = JSON.parse(await readFile(path, 'utf8'));
        if (existing.sha256 !== sha256) throw Object.assign(new Error('revision_content_conflict'), { status: 409 });
        const collection = await this.collection(collectionId);
        if (!collection.receiptIds.includes(receiptId)) {
          collection.receiptIds.push(receiptId);
          await this.saveJson(join(this.directory, 'collections', collectionId + '.json'), collection);
        }
        return existing;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await writeFile(join(this.directory, 'blobs', sha256), bytes, { flag: 'wx' }).catch(error => {
        if (error.code !== 'EEXIST') throw error;
      });
      const receipt = { receiptId, collectionId, sourceKey, revision, mediaType, sha256, byteLength: bytes.length, summary };
      if (deliveryId) receipt.deliveryId = deliveryId;
      await this.saveJson(path, receipt);
      const collection = await this.collection(collectionId);
      collection.receiptIds.push(receiptId);
      await this.saveJson(join(this.directory, 'collections', collectionId + '.json'), collection);
      return receipt;
    });
  }

  async receipt(receiptId) {
    if (!/^[a-f0-9]{64}$/.test(receiptId)) throw Object.assign(new Error('invalid_receipt'), { status: 400 });
    try {
      return JSON.parse(await readFile(join(this.directory, 'receipts', receiptId + '.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') throw Object.assign(new Error('receipt_not_found'), { status: 404 });
      throw error;
    }
  }

  async body(receiptId) {
    const receipt = await this.receipt(receiptId);
    return readFile(join(this.directory, 'blobs', receipt.sha256));
  }

  // 同一捐赠包已领取的全部收件，用于补交资料时重新解释整包。
  async receiptsForDelivery(collectionId, deliveryId) {
    identifier(collectionId);
    const collection = await this.collection(collectionId);
    const receipts = [];
    for (const receiptId of collection.receiptIds || []) {
      const receipt = await this.receipt(receiptId);
      if (receipt.deliveryId === deliveryId) receipts.push(receipt);
    }
    return receipts;
  }

  async addRecord(collectionId, record) {
    identifier(collectionId);
    if (!record || typeof record.kind !== 'string' || typeof record.key !== 'string' || !record.value || typeof record.value !== 'object') {
      throw Object.assign(new Error('invalid_record'), { status: 400 });
    }
    if (!Array.isArray(record.provenance) || record.provenance.length === 0) {
      throw Object.assign(new Error('missing_provenance'), { status: 400 });
    }
    for (const origin of record.provenance) {
      const receipt = await this.receipt(origin.receiptId);
      if (receipt.collectionId !== collectionId || typeof origin.location !== 'string' || !origin.location) {
        throw Object.assign(new Error('provenance_scope'), { status: 400 });
      }
    }
    return this.serialized(async () => {
      const collection = await this.collection(collectionId);
      const match = collection.records.find(existing => existing.kind === record.kind && existing.key === record.key);
      if (match && JSON.stringify(match) !== JSON.stringify(record)) {
        throw Object.assign(new Error('record_identity_conflict'), { status: 409 });
      }
      if (!match) collection.records.push(record);
      await this.saveJson(join(this.directory, 'collections', collectionId + '.json'), collection);
      return record;
    });
  }

  /**
   * 登记一次自动解释的结果。自动记录按 deliveryId + key 归并：再次领取只新增
   * 版本依据，不覆盖原有记录；人工确认过的记录（manual=true）保持原样。
   */
  async addInterpretation(collectionId, { deliveryId, records, issues, receiptIds }) {
    identifier(collectionId);
    if (typeof deliveryId !== 'string' || !deliveryId) throw Object.assign(new Error('missing_delivery_id'), { status: 400 });
    for (const origin of records.flatMap(record => record.provenance)) {
      const receipt = await this.receipt(origin.receiptId);
      if (receipt.collectionId !== collectionId) throw Object.assign(new Error('provenance_scope'), { status: 400 });
    }
    return this.serialized(async () => {
      const collection = await this.collection(collectionId);
      collection.receiptIds ||= [];
      for (const receiptId of receiptIds) if (!collection.receiptIds.includes(receiptId)) collection.receiptIds.push(receiptId);
      collection.deliveries ||= [];
      if (!collection.deliveries.includes(deliveryId)) collection.deliveries.push(deliveryId);
      collection.records ||= [];
      for (const record of records) {
        const manual = collection.records.find(existing => existing.kind === record.kind && existing.key === record.key && existing.manual);
        if (manual) {
          // 自动解释与人工确认共用同一身份时不覆盖人工值，登记冲突交馆员处理。
          if (JSON.stringify(manual.value) !== JSON.stringify(record.value)) {
            collection.conflicts ||= [];
            const conflict = { kind: record.kind, key: record.key, deliveryId, automatic: record.value, manual: manual.value };
            if (!collection.conflicts.some(existing => JSON.stringify(existing) === JSON.stringify(conflict))) collection.conflicts.push(conflict);
            collection.issues ||= [];
            if (!collection.issues.some(issue => issue.reason === 'manual_identity_conflict' && issue.key === record.key)) {
              collection.issues.push({ reason: 'manual_identity_conflict', location: record.provenance[0].location, key: record.key, receiptId: record.provenance[0].receiptId, deliveryId });
            }
          }
          continue;
        }
        const match = collection.records.find(existing => existing.kind === record.kind && existing.key === record.key);
        if (match) {
          // 同一身份在新版本里的内容变化必须留下，不能静默替换旧解释。
          if (JSON.stringify(match.value) !== JSON.stringify(record.value)) {
            match.revisions ||= [{ value: match.value, provenance: match.provenance }];
            match.revisions.push({ value: record.value, provenance: record.provenance });
            match.value = record.value;
            match.provenance = record.provenance;
          }
          delete match.current;
          if (match.issues) {
            match.issues = match.issues.filter(issue => issue.reason !== 'not_in_current_source');
            if (match.issues.length === 0) delete match.issues;
          }
        } else if (!collection.records.some(existing => existing.kind === record.kind && existing.key === record.key)) {
          collection.records.push(record);
        }
      }
      collection.issues ||= [];
      // 自动解释的问题随本次解释刷新；人工确认冲突以及人工/其他捐赠包的问题保持不动。
      collection.issues = collection.issues.filter(issue => issue.deliveryId !== deliveryId || issue.reason === 'manual_identity_conflict');
      const seen = new Set(collection.issues.map(issue => JSON.stringify(issue)));
      for (const issue of issues) {
        const text = JSON.stringify(issue);
        if (!seen.has(text)) { seen.add(text); collection.issues.push(issue); }
      }
      // 本次解释未再出现的记录不删除，而是标为不再由当前来源版本支持，供馆员复核。
      const produced = new Set(records.map(record => record.kind + '\u0000' + record.key));
      for (const existing of collection.records) {
        if (existing.deliveryId !== deliveryId || existing.manual) continue;
        if (produced.has(existing.kind + '\u0000' + existing.key)) {
          delete existing.current;
        } else {
          existing.current = false;
          existing.issues ||= [];
          if (!existing.issues.some(issue => issue.reason === 'not_in_current_source')) {
            existing.issues.push({ reason: 'not_in_current_source', deliveryId });
          }
        }
      }
      await this.saveJson(join(this.directory, 'collections', collectionId + '.json'), collection);
      return collection;
    });
  }

  /**
   * 人工确认跨包人物是否同一。只登记人工给出的对应关系，不据此合并原始记录。
   */
  async addIdentity(collectionId, link) {
    identifier(collectionId);
    if (!link || typeof link.left !== 'string' || typeof link.right !== 'string' || !link.left || !link.right) {
      throw Object.assign(new Error('invalid_identity'), { status: 400 });
    }
    if (link.left === link.right) throw Object.assign(new Error('invalid_identity'), { status: 400 });
    return this.serialized(async () => {
      const collection = await this.collection(collectionId);
      const persons = new Set((collection.records || []).filter(record => record.kind === 'person').map(record => record.key));
      if (!persons.has(link.left) || !persons.has(link.right)) throw Object.assign(new Error('unknown_person'), { status: 400 });
      collection.identities ||= [];
      // 同一对人物不分左右只登记一次。
      const exists = collection.identities.some(existing =>
        (existing.left === link.left && existing.right === link.right) || (existing.left === link.right && existing.right === link.left));
      if (!exists) {
        collection.identities.push({ left: link.left, right: link.right, confirmedBy: link.confirmedBy || 'librarian' });
      }
      await this.saveJson(join(this.directory, 'collections', collectionId + '.json'), collection);
      return collection;
    });
  }

  async list() {
    return (await readdir(join(this.directory, 'collections'))).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5));
  }
}
