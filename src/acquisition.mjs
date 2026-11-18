// 领取来源入口并解释捐赠包。每个资源都先成为真实收件，再参与解释；
// 补交资料后重新解释整个包，使之前无法解析的指针能补齐出处。
import { retrieve } from './transport.mjs';
import { digest } from './archive.mjs';
import { summarize } from './summary.mjs';
import { interpretDelivery } from './interpret.mjs';

function looksLikeDelivery(document) {
  return document && typeof document === 'object' && Array.isArray(document.roots) && typeof document.deliveryId === 'string';
}

function resourceHrefs(document) {
  const entries = [...(Array.isArray(document.roots) ? document.roots : []), ...(Array.isArray(document.resources) ? document.resources : [])];
  const hrefs = [];
  for (const entry of entries) {
    const href = typeof entry === 'string' ? entry : entry?.href;
    if (typeof href !== 'string' || !href) continue;
    if (!hrefs.includes(href)) hrefs.push(href);
  }
  return hrefs;
}

function resolveHref(base, href) {
  try {
    const url = new URL(href, base);
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function parseDeliveryIndex(bytes) {
  try {
    const document = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes));
    return looksLikeDelivery(document) ? document : null;
  } catch {
    return null;
  }
}

/**
 * 从本资料集已登记的收件重建一个捐赠包：识别清单收件、实际到位的资源以及缺件。
 * 补交资料后调用同一逻辑，因此原始收件始终是唯一依据。
 */
export async function assemblePackage({ archive, collectionId, deliveryId }) {
  const receipts = await archive.receiptsForDelivery(collectionId, deliveryId);
  const resources = [];
  const issues = [];
  let index = null;

  // 同一地址可能有多个历史修订；当前解释只使用每地址最新领取的原文，
  // 旧修订仍作为收件保留，可另行回查。
  const latest = new Map();
  for (const receipt of receipts) latest.set(receipt.sourceKey, receipt);

  for (const receipt of latest.values()) {
    const bytes = await archive.body(receipt.receiptId);
    const document = parseDeliveryIndex(bytes);
    if (document && (!index || document.deliveryId === deliveryId)) index = { receipt, document, bytes };
    else resources.push({ href: receipt.sourceKey, receiptId: receipt.receiptId, bytes });
  }

  if (index) {
    const expected = resourceHrefs(index.document);
    const present = new Map(resources.map(resource => [resolveHref(index.receipt.sourceKey, resource.href), resource]).filter(([key]) => key));
    for (const href of expected) {
      const absolute = resolveHref(index.receipt.sourceKey, href);
      if (!absolute || !present.has(absolute)) {
        issues.push({ reason: absolute ? 'resource_unavailable' : 'invalid_resource_href', location: `resource:${href}`,
          receiptId: index.receipt.receiptId, deliveryId });
      }
    }
  }

  const interpreted = interpretDelivery({ deliveryId, resources });
  return {
    deliveryId,
    indexReceiptId: index?.receipt.receiptId,
    receiptIds: receipts.map(receipt => receipt.receiptId),
    records: interpreted.records,
    issues: [...issues, ...interpreted.issues]
  };
}

/**
 * 领取入口；若入口是捐赠包清单，包内资源逐个领取为独立收件。
 * options.deliveryId 用于把补交资料并入已登记的同一捐赠包。
 */
export async function acquire({ archive, collectionId, entry, options = {}, allowedOrigin }) {
  const index = await retrieve(entry, allowedOrigin);
  const indexDocument = parseDeliveryIndex(index.bytes);
  if (options.deliveryId && indexDocument && indexDocument.deliveryId !== options.deliveryId) {
    throw Object.assign(new Error('delivery_identity_conflict'), { status: 409 });
  }
  const deliveryId = typeof options.deliveryId === 'string' && options.deliveryId
    ? options.deliveryId
    : indexDocument?.deliveryId || 'entry-' + digest(entry).slice(0, 16);

  await archive.receive({
    collectionId, sourceKey: entry, revision: index.revision, mediaType: index.mediaType, bytes: index.bytes,
    summary: summarize(index.bytes, index.mediaType),
    deliveryId
  });

  const issues = [];
  if (indexDocument) {
    for (const href of resourceHrefs(indexDocument)) {
      const absolute = resolveHref(entry, href);
      if (!absolute || new URL(absolute).origin !== allowedOrigin) {
        issues.push({ reason: 'resource_not_allowed', location: `resource:${href}`, deliveryId });
        continue;
      }
      try {
        const result = await retrieve(absolute, allowedOrigin);
        await archive.receive({
          collectionId, sourceKey: absolute, revision: result.revision, mediaType: result.mediaType, bytes: result.bytes,
          summary: summarize(result.bytes, result.mediaType), deliveryId
        });
      } catch (error) {
        // 缺件只登记问题，不能把整个包当作完整解释。
        issues.push({
          reason: error.message === 'source_response_404' ? 'resource_unavailable' : 'resource_retrieval_failed',
          location: `resource:${href}`, deliveryId, detail: error.message
        });
      }
    }
  } else {
    // 单文件入口本身就是资源，原文收件已在上面登记，无需再领一次。
  }

  const assembled = await assemblePackage({ archive, collectionId, deliveryId });
  const combined = [...issues, ...assembled.issues];
  const unique = new Map();
  for (const issue of combined) {
    const key = issue.reason + '\u0000' + issue.location;
    const previous = unique.get(key);
    // 同一缺件既有领取失败也有清单核对时，保留带真实收件依据的那条。
    if (!previous || (!previous.receiptId && issue.receiptId)) unique.set(key, issue);
  }
  return { ...assembled, issues: [...unique.values()] };
}
