import { createHash } from 'node:crypto';
import { parseMets, collectReferences } from './reader.mjs';

const CHECKSUM_ALGORITHMS = { md5: 'md5', 'sha-1': 'sha1', 'sha-256': 'sha256', 'sha-512': 'sha512' };

function checksum(bytes, type) {
  const algorithm = CHECKSUM_ALGORITHMS[String(type ?? 'sha-256').toLowerCase()];
  return algorithm ? createHash(algorithm).update(bytes).digest('hex') : null;
}

// 按选定 USE 领取一份 METS 交付：结构、页序、区域分开保存；单文件失败不拖累其余资料。
export async function ingestDelivery({ source, entry, use = 'master', acquire, store }) {
  const entryUrl = new URL(entry, source).href;
  const metsResult = await acquire(source, entry);
  const parsed = parseMets(metsResult.bytes); // 解释失败直接抛出，不登记交付
  const metsDigest = await store.saveObject(metsResult.bytes);
  const etag = metsResult.headers.etag ?? null;

  // 全交付文件索引：ID 作用域限当前 METS；文件组用途随文件保留，缩略图不会进入正文用途。
  const fileIndex = new Map();
  for (const group of parsed.fileGroups) {
    for (const file of group.files) {
      if (file.id) fileIndex.set(file.id, { file, use: group.use, groupId: group.id });
    }
  }
  const selectedGroup = parsed.fileGroups.find(group => group.use === use) ?? null;
  const selectedIds = new Set(selectedGroup?.files.map(file => file.id).filter(Boolean) ?? []);

  const previous = await store.findDelivery(metsDigest, entryUrl);
  const knownEtags = new Map();
  if (previous) for (const item of previous.resources) if (item.etag) knownEtags.set(item.fileId, item.etag);

  const resources = [];
  const resourceByFile = new Map();
  if (selectedGroup) {
    for (const file of selectedGroup.files) {
      const href = file.locations.find(location => typeof location === 'string') ?? null;
      const base = { fileId: file.id, mime: file.mime, checksum: file.checksum,
        checksumType: file.checksumType, use, href, source: null, etag: null,
        digest: null, bytes: null, status: 'pending', reason: null };
      if (!href) { base.status = 'failed'; base.reason = 'missing_location'; }
      else {
        const target = new URL(href, entryUrl);
        if (target.origin !== new URL(source).origin) {
          base.status = 'failed'; base.reason = 'outside_source';
        } else {
          base.source = target.href;
          try {
            const headers = {};
            if (knownEtags.has(file.id)) headers['if-none-match'] = knownEtags.get(file.id);
            const result = await acquire(source, `${target.pathname}${target.search}`, headers);
            if (file.checksum) {
              const actual = checksum(result.bytes, file.checksumType);
              if (actual !== null && actual.toLowerCase() !== file.checksum.toLowerCase()) {
                throw new Error('checksum_mismatch');
              }
            }
            base.digest = await store.saveObject(result.bytes);
            base.etag = result.headers.etag ?? knownEtags.get(file.id) ?? null;
            base.bytes = result.bytes.length;
            base.status = 'received';
          } catch (error) {
            if (error.message === 'source_status_304' && previous) {
              const earlier = previous.resources.find(item => item.fileId === file.id);
              if (earlier?.digest) {
                Object.assign(base, { digest: earlier.digest, etag: earlier.etag ?? base.etag,
                  bytes: earlier.bytes, status: 'received', reason: null,
                  source: earlier.source ?? base.source });
              } else {
                base.status = 'failed';
                base.reason = 'source_status_304';
              }
            } else {
              base.status = 'failed';
              base.reason = error.message.startsWith('source_status_') ||
                error.message === 'checksum_mismatch' || error.message === 'outside_source'
                ? error.message : 'acquire_failed';
            }
          }
        }
      }
      resources.push(base);
      if (file.id) resourceByFile.set(file.id, base);
    }
  }

  // 区域/指针逐条解析：区域声明与已存原件分开；任何问题都带上篇章定位，绝不拿相似资源顶替。
  const references = collectReferences(parsed);
  const regions = references.map(reference => {
    const indexed = fileIndex.get(reference.fileId);
    const region = { structMapType: reference.structMapType, structMapId: reference.structMapId,
      divId: reference.divId, divPath: reference.divPath, pointerPath: reference.pointerPath,
      fileId: reference.fileId, use: indexed?.use ?? null, region: reference.region,
      status: 'resolved', reason: null, digest: null };
    if (!indexed) region.status = 'unresolved', region.reason = 'undeclared_file';
    else if (indexed.use !== use) region.status = 'unresolved', region.reason = 'outside_selected_use';
    else if (!selectedIds.has(reference.fileId)) region.status = 'unresolved', region.reason = 'file_unavailable';
    else {
      const acquired = resourceByFile.get(reference.fileId);
      if (!acquired || acquired.status !== 'received') {
        region.status = 'unresolved';
        region.reason = acquired?.reason ?? 'file_unavailable';
      } else region.digest = acquired.digest;
    }
    return region;
  });

  // 受影响篇章：保留 structMap 身份与从根到节点的路径，补件时据此回到原结构位置。
  const affectedMap = new Map();
  for (const region of regions) {
    if (region.status !== 'unresolved') continue;
    const key = `${region.structMapType}\u0000${region.divId}`;
    if (!affectedMap.has(key)) affectedMap.set(key, { structMapType: region.structMapType,
      structMapId: region.structMapId, divId: region.divId, divPath: region.divPath, problems: [] });
    affectedMap.get(key).problems.push({ fileId: region.fileId, reason: region.reason, region: region.region });
  }
  const affectedChapters = [...affectedMap.values()];
  const unresolved = regions.filter(region => region.status === 'unresolved').length;

  const event = { at: new Date().toISOString(),
    phase: previous ? 'supplement' : 'initial',
    acquired: resources.filter(item => item.status === 'received').map(item => item.fileId),
    failed: resources.filter(item => item.status === 'failed')
      .map(item => ({ fileId: item.fileId, reason: item.reason })),
    unresolvedPointers: unresolved };
  const delivery = {
    id: previous?.id ?? `del_${metsDigest.slice(0, 32)}`,
    source: entryUrl,
    objectId: parsed.objectId,
    use,
    mets: { digest: metsDigest, etag, bytes: metsResult.bytes.length },
    fileGroups: parsed.fileGroups,
    structMaps: parsed.structMaps,
    links: parsed.links,
    resources,
    regions,
    affectedChapters,
    status: unresolved === 0 ? 'complete' : 'incomplete',
    events: [...(previous?.events ?? []), event],
  };
  await store.saveDelivery(delivery);
  return delivery;
}
