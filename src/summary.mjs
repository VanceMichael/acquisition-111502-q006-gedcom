export function summarize(bytes, mediaType) {
  if (mediaType.includes('application/json')) {
    try {
      const value = JSON.parse(bytes);
      if (value.deliveryId && Array.isArray(value.roots)) return { format: 'delivery-index', deliveryId: value.deliveryId, roots: value.roots.length };
    } catch {}
  }
  return { format: 'gedcom', recordHeaders: bytes.toString('utf8').split(/\r?\n/).filter(line => /^0 /.test(line)).length, byteLength: bytes.length };
}
