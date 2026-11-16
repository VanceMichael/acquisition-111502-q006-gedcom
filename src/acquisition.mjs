// 结构化自动接入：从授权来源领取交付索引及其全部根资源，
// 每个自动取得的依赖都登记真实原文收件，再在收件之上做 GEDCOM 解释。
// 缺件、截断与解释限制写入 issues，绝不以静默丢弃或人造记录代替。

import { retrieve } from './transport.mjs';
import { interpretDelivery } from './interpreter.mjs';
import { summarize } from './summary.mjs';

function asIssue(reason, location, detail) {
  return { reason, location, detail };
}

export async function acquire({ entry, allowedOrigin, archive, collectionId }) {
  const receiptIds = [];
  const issues = [];
  const gedcomResources = [];

  // 1. 入口交付索引本身也是来源原文，先登记收件。
  const index = await retrieve(entry, allowedOrigin);
  const indexReceipt = await archive.receive({
    collectionId,
    sourceKey: entry,
    revision: index.revision,
    mediaType: index.mediaType,
    bytes: index.bytes,
    summary: summarize(index.bytes, index.mediaType)
  });
  receiptIds.push(indexReceipt.receiptId);

  let delivery;
  try {
    delivery = JSON.parse(index.bytes.toString('utf8'));
  } catch {
    issues.push(asIssue('invalid_delivery_index', entry, '入口不是合法 JSON，无法声明 roots/resources；原文收件已保留'));
    await archive.addInterpretation(collectionId, { records: [], issues });
    return { collectionId, receiptIds, records: 0, issues: issues.length };
  }

  const deliveryId = typeof delivery.deliveryId === 'string' && delivery.deliveryId
    ? delivery.deliveryId
    : indexReceipt.receiptId.slice(0, 12);
  const roots = Array.isArray(delivery.roots) ? delivery.roots : [];
  const resources = Array.isArray(delivery.resources) ? delivery.resources : [];
  if (!roots.length) {
    issues.push(asIssue('missing_roots', entry, '交付索引未声明任何 roots；缺失资料不等于来源明确删除'));
  }

  // 指针作用域为 deliveryId：同包资源统一领取，独立资料集不互认指针。
  const hrefs = [];
  for (const root of roots) {
    if (root && typeof root.href === 'string' && !hrefs.includes(root.href)) hrefs.push(root.href);
  }
  for (const resource of resources) {
    if (resource && typeof resource.href === 'string' && !hrefs.includes(resource.href)) hrefs.push(resource.href);
  }

  const origin = new URL(entry).origin;
  for (const href of hrefs) {
    let url;
    try {
      url = new URL(href, entry);
    } catch {
      issues.push(asIssue('invalid_resource_href', `${entry}#${href}`, '资源地址无法解析，未发送请求'));
      continue;
    }
    if (url.origin !== origin) {
      issues.push(asIssue('resource_origin_forbidden', url.toString(), '资源地址超出冻结的授权来源，未领取'));
      continue;
    }

    let fetched;
    try {
      fetched = await retrieve(url.toString(), allowedOrigin);
    } catch (error) {
      // 缺件/截断/超时：保留问题与已领取依据，不把不完整来源变成内部崩溃。
      issues.push(asIssue('resource_unavailable', url.toString(), `领取失败: ${error.message}；已领取的原文收件仍保留`));
      continue;
    }
    const name = resourceNameOf(resources, href, url);
    const receipt = await archive.receive({
      collectionId,
      sourceKey: url.toString(),
      revision: fetched.revision,
      mediaType: fetched.mediaType,
      bytes: fetched.bytes,
      summary: summarize(fetched.bytes, fetched.mediaType)
    });
    receiptIds.push(receipt.receiptId);

    if (!looksLikeGedcom(fetched.bytes)) {
      issues.push(asIssue('unsupported_media', `${name}:line:1`, `资源 ${name} 不是 GEDCOM 文本，未做结构化解释，原文已收件`));
      continue;
    }
    gedcomResources.push({ name, bytes: fetched.bytes, receiptId: receipt.receiptId });
  }

  // 2. 全部同包资源到齐后统一解释，指针在 deliveryId 作用域内跨资源解析。
  let records = [];
  if (gedcomResources.length) {
    try {
      const interpreted = interpretDelivery(deliveryId, gedcomResources);
      records = interpreted.records;
      issues.push(...interpreted.issues);
    } catch (error) {
      issues.push(asIssue('interpretation_failed', `${deliveryId}:line:1`, `解释中断: ${error.message}；原文收件与位置仍可回查`));
    }
  }

  await archive.addInterpretation(collectionId, { records, issues });
  return { collectionId, receiptIds, records: records.length, issues: issues.length };
}

function resourceNameOf(resources, href, url) {
  const declared = resources.find(resource => resource.href === href);
  if (declared && typeof declared.name === 'string' && declared.name) return declared.name;
  const segments = url.pathname.split('/').filter(Boolean);
  return segments[segments.length - 1] || href;
}

function looksLikeGedcom(bytes) {
  const head = bytes.toString('utf8').slice(0, 400);
  return /(^|\n)0\s+HEAD(\s|$)/.test(head) || /(^|\n)0\s+@/.test(head);
}
