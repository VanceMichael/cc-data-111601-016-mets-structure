import { createHash } from 'node:crypto';
import { analyzeMets } from './mets.mjs';
import { acquire } from './transport.mjs';

const digestOf = bytes => createHash('sha256').update(bytes).digest('hex');
const normalizeId = value => String(value ?? '').replace(/^#/, '');
const upper = value => String(value ?? '').toUpperCase();

const CHECKSUMS = {
  'SHA-256': 'sha256',
  'SHA-1': 'sha1',
  'MD5': 'md5'
};

export function verifyChecksum(bytes, file) {
  const algorithm = CHECKSUMS[upper(file.checksumType)];
  if (!algorithm || !file.checksum) return null;
  return createHash(algorithm).update(bytes).digest('hex')
    === String(file.checksum).toLowerCase().replace(/^0x/, '');
}

function blockIndex(structMaps) {
  const index = new Map();
  const walk = (map, div) => {
    index.set(div.blockId, { blockId: div.blockId, id: div.id, label: div.label,
      labelPath: div.labelPath, order: div.order, type: div.type,
      structMap: map.index, structMapType: map.type, div });
    for (const child of div.children) walk(map, child);
  };
  for (const map of structMaps) for (const root of map.roots) walk(map, root);
  return index;
}

function buildRegions(references, blocks) {
  const regions = [];
  for (const reference of references) {
    if (reference.kind === 'fptr' && !reference.fileId && reference.hasChildren) continue;
    const block = blocks.get(reference.owner.blockId);
    const explicit = reference.fileId ?? null;
    const inherited = explicit ? null : (reference.inheritedFileId ?? null);
    regions.push({
      id: `region|${reference.owner.blockId}|${reference.path.join('.')}|${reference.kind}`,
      kind: reference.kind,
      region: reference.path.join('.'),
      blockId: reference.owner.blockId,
      divId: block?.id ?? reference.owner.divId ?? null,
      structMap: reference.owner.structMap,
      structMapType: reference.owner.structMapType,
      label: block?.label ?? null,
      labelPath: block?.labelPath ?? [],
      fileId: explicit ?? inherited,
      fileIdSource: explicit ? 'explicit' : (inherited ? 'inherited' : 'none'),
      begin: reference.begin ?? null,
      end: reference.end ?? null,
      betype: reference.betype ?? null,
      extent: reference.extent ?? null,
      shape: reference.shape ?? null,
      coords: reference.coords ?? null,
      spansFiles: reference.group ? reference.group.fileIds.size > 1 : false,
      state: 'pending',
      fileUse: null,
      href: null,
      digest: null,
      bytes: null,
      reason: null,
      status: null
    });
  }
  return regions;
}

export function evaluateRegions(input, files, fileUse, blocks, links) {
  const byId = new Map();
  for (const file of files) {
    if (file.id == null) continue;
    if (!byId.has(file.id)) byId.set(file.id, []);
    byId.get(file.id).push(file);
  }
  const regions = input.map(region => ({ ...region }));
  const issues = [];
  const issue = (region, reason) => {
    issues.push({ issueId: region.id, regionId: region.id, blockId: region.blockId,
      divId: region.divId, structMap: region.structMap, structMapType: region.structMapType,
      label: region.label, labelPath: region.labelPath, kind: region.kind,
      fileId: region.fileId, fileIdSource: region.fileIdSource, href: region.href,
      begin: region.begin, end: region.end, betype: region.betype,
      reason, status: region.status, spansFiles: region.spansFiles });
  };
  for (const region of regions) {
    if (!region.fileId) {
      Object.assign(region, { state: 'missing', reason: 'missing_file_id',
        fileUse: null, href: null, digest: null, bytes: null });
      issue(region, region.reason);
      continue;
    }
    const candidates = byId.get(region.fileId) ?? [];
    if (candidates.length === 0) {
      Object.assign(region, { state: 'missing', reason: 'unknown_file_id',
        fileUse: null, href: null, digest: null, bytes: null });
      issue(region, region.reason);
      continue;
    }
    if (candidates.length > 1) {
      Object.assign(region, { state: 'missing', reason: 'ambiguous_file_id',
        fileUse: null, href: null, digest: null, bytes: null });
      issue(region, region.reason);
      continue;
    }
    const file = candidates[0];
    region.fileUse = file.use ?? null;
    region.href = file.location ?? null;
    if (file.use !== fileUse) {
      Object.assign(region, { state: 'not_master', reason: 'non_master_file',
        digest: null, bytes: null });
      issue(region, region.reason);
      continue;
    }
    if (file.state !== 'acquired') {
      Object.assign(region, { state: 'unavailable', reason: file.reason ?? 'file_unavailable',
        status: file.status ?? null, digest: null, bytes: null });
      issue(region, region.reason);
      continue;
    }
    Object.assign(region, { state: 'available', reason: null, status: null,
      digest: file.digest, bytes: file.bytes });
  }
  return { regions, issues, affected: affectedDivs(issues, regions, blocks, links) };
}

function affectedDivs(issues, regions, blocks, links) {
  const idIndex = new Map();
  for (const block of blocks.values()) {
    if (block.id == null) continue;
    if (!idIndex.has(block.id)) idIndex.set(block.id, []);
    idIndex.get(block.id).push(block);
  }
  const affected = new Map();
  const add = (block, via, issue) => {
    if (!block) return;
    if (!affected.has(block.blockId)) {
      affected.set(block.blockId, { blockId: block.blockId, divId: block.id,
        label: block.label, order: block.order, labelPath: block.labelPath,
        structMap: block.structMap, structMapType: block.structMapType,
        kind: upper(block.structMapType) === 'LOGICAL' ? 'chapter' : 'page',
        via: [], issues: [] });
    }
    const entry = affected.get(block.blockId);
    if (!entry.via.includes(via)) entry.via.push(via);
    if (!entry.issues.some(item => item.issueId === issue.issueId)) {
      entry.issues.push({ issueId: issue.issueId, reason: issue.reason,
        fileId: issue.fileId, regionId: issue.regionId });
    }
  };
  for (const problem of issues) {
    const owner = blocks.get(problem.blockId);
    add(owner, 'direct', problem);
    const ownerIsLogical = upper(problem.structMapType) === 'LOGICAL';
    if (owner?.id == null || ownerIsLogical) continue;
    for (const link of links) {
      if (normalizeId(link.to) !== owner.id) continue;
      for (const linked of idIndex.get(normalizeId(link.from)) ?? []) {
        if (upper(linked.structMapType) !== 'LOGICAL') continue;
        add(linked, 'structLink', problem);
      }
    }
  }
  return [...affected.values()];
}

function divSummary(div) {
  return { blockId: div.blockId, id: div.id, label: div.label, order: div.order,
    type: div.type, path: div.path, labelPath: div.labelPath,
    fileIds: div.fileIds, spansFiles: div.crossFile };
}

function inOrder(entries) {
  return entries.map((entry, index) => ({ entry, index })).sort((left, right) => {
    const a = left.entry.order;
    const b = right.entry.order;
    const aNumber = a != null && /^\d+$/.test(String(a));
    const bNumber = b != null && /^\d+$/.test(String(b));
    if (aNumber && bNumber) return Number(a) - Number(b) || left.index - right.index;
    if (aNumber !== bNumber) return aNumber ? -1 : 1;
    return left.index - right.index;
  }).map(item => item.entry);
}

function mapView(map) {
  const entries = [];
  const pages = [];
  const walk = div => {
    entries.push(divSummary(div));
    if (div.ownFileIds.length > 0) {
      pages.push({ blockId: div.blockId, id: div.id, label: div.label,
        order: div.order, fileIds: div.ownFileIds, spansFiles: div.crossFile });
    }
    for (const child of inOrder(div.children)) walk(child);
  };
  for (const root of inOrder(map.roots)) walk(root);
  return { structMap: map.index, id: map.id, type: map.type, label: map.label,
    order: map.order, entries, pages, pageOrder: pages.map(page => page.blockId) };
}

function counts(files, regions, issues, affected, fileUse) {
  const master = files.filter(file => file.use === fileUse);
  return {
    files: master.length,
    acquired: master.filter(file => file.state === 'acquired').length,
    unavailable: master.filter(file => file.state === 'unavailable').length,
    described: files.filter(file => file.use !== fileUse).length,
    regions: regions.length,
    availableRegions: regions.filter(region => region.state === 'available').length,
    unavailableRegions: regions.filter(region => region.state === 'unavailable').length,
    missingRegions: regions.filter(region => region.state === 'missing').length,
    nonMasterRegions: regions.filter(region => region.state === 'not_master').length,
    issues: issues.length,
    affected: affected.length,
    chapters: affected.filter(entry => entry.kind === 'chapter').length,
    pages: affected.filter(entry => entry.kind === 'page').length,
    spansFiles: regions.filter(region => region.spansFiles).length,
    fileUse
  };
}

function fileGroups(parsed, files) {
  return parsed.groups.map(group => ({
    id: group.id,
    use: group.use,
    files: group.files.length,
    acquired: files.filter(file => file.use === group.use && file.state === 'acquired').length
  }));
}

function fingerprintOf(parsed) {
  const normalize = div => ({ id: div.id, label: div.label, order: div.order,
    type: div.type, children: div.children.map(normalize),
    pointers: div.pointers.map(pointer => ({
      kind: pointer.kind, fileId: pointer.fileId ?? null, path: pointer.path,
      children: pointer.children.map(child => ({ kind: child.kind,
        fileId: child.fileId ?? null, begin: child.begin ?? null,
        end: child.end ?? null, betype: child.betype ?? null }))
    })) });
  return digestOf(Buffer.from(JSON.stringify({
    objectId: parsed.objectId,
    maps: parsed.structMaps.map(map => ({ type: map.type, id: map.id, label: map.label,
      order: map.order, roots: map.roots.map(normalize) })),
    links: parsed.links
  })));
}

async function acquireFiles({ source, parsed, entryHref, fileUse, fetchBytes }) {
  const origin = new URL(source).origin;
  const cache = new Map();
  const artifacts = [];
  const files = [];
  for (const group of parsed.groups) {
    const selected = String(group.use ?? '') === fileUse;
    for (const file of group.files) {
      let location = null;
      try { location = file.location ? new URL(file.location, entryHref).href : null; }
      catch { location = null; }
      const record = { id: file.id, use: file.use ?? null, mime: file.mime,
        checksum: file.checksum, checksumType: file.checksumType, groupId: file.groupId,
        href: location, state: selected ? 'unavailable' : 'described',
        digest: null, bytes: null, verified: null, acquired: false,
        reason: selected ? 'not_attempted' : null, status: null };
      if (!selected) { files.push(record); continue; }
      if (!location) {
        record.reason = 'no_location';
      } else if (new URL(location).origin !== origin) {
        record.reason = 'outside_source';
      } else {
        let transfer = cache.get(location);
        if (!transfer) {
          try {
            const result = await fetchBytes(source, location);
            const verified = verifyChecksum(result.bytes, file);
            if (verified === false) {
              transfer = { state: 'unavailable', reason: 'checksum_mismatch', status: null,
                verified: false, digest: null, bytes: null };
            } else {
              const digest = digestOf(result.bytes);
              transfer = { state: 'acquired', reason: null, status: null, verified,
                digest, bytes: result.bytes.length };
              artifacts.push({ digest, bytes: result.bytes });
            }
          } catch (error) {
            transfer = { state: 'unavailable', reason: 'source_unavailable',
              status: error.message, verified: null, digest: null, bytes: null };
          }
          cache.set(location, transfer);
        }
        Object.assign(record, transfer);
        record.acquired = transfer.state === 'acquired';
      }
      files.push(record);
    }
  }
  return { files, artifacts };
}

export async function planDelivery({ source, bytes, entryPath, entryHref,
  fileUse = 'master', fetchBytes = acquire }) {
  const parsed = analyzeMets(bytes);
  if (!parsed.groups.some(group => String(group.use ?? '') === fileUse)) {
    throw new Error('file_use_not_found');
  }
  const href = entryHref ?? new URL(entryPath, source).href;
  const origin = new URL(source).origin;
  if (new URL(href).origin !== origin) throw new Error('entry_outside_source');
  const { files, artifacts } = await acquireFiles({ source, parsed, entryHref: href,
    fileUse, fetchBytes });
  const blocks = blockIndex(parsed.structMaps);
  const regions = buildRegions(parsed.references, blocks);
  const evaluated = evaluateRegions(regions, files, fileUse, blocks, parsed.links);
  const logical = parsed.structMaps
    .filter(map => upper(map.type) === 'LOGICAL').map(mapView);
  const physical = parsed.structMaps
    .filter(map => upper(map.type) === 'PHYSICAL').map(mapView);
  const entryDigest = digestOf(bytes);
  artifacts.push({ digest: entryDigest, bytes });
  return {
    artifacts,
    record: {
      objectId: parsed.objectId,
      fileUse,
      entry: { path: entryPath, href, digest: entryDigest, bytes: bytes.length },
      groups: fileGroups(parsed, files),
      files,
      structure: { structMaps: parsed.structMaps, links: parsed.links },
      logical,
      physical,
      regions: evaluated.regions,
      issues: evaluated.issues,
      affected: evaluated.affected,
      counts: counts(files, evaluated.regions, evaluated.issues,
        evaluated.affected, fileUse),
      structureFingerprint: fingerprintOf(parsed)
    }
  };
}

export function createRecord(record, { id, source, now }) {
  return { id, kind: 'mets-delivery', source, createdAt: now, updatedAt: now,
    attempts: 1, ...record };
}

export function summarize(record) {
  return { id: record.id, kind: record.kind, source: record.source,
    objectId: record.objectId, fileUse: record.fileUse, entry: record.entry,
    createdAt: record.createdAt, updatedAt: record.updatedAt, attempts: record.attempts,
    counts: record.counts, complete: record.counts.issues === 0,
    structureDrift: record.structureDrift
      ? { detectedAt: record.structureDrift.detectedAt } : null };
}

export function affectedView(record, filter = {}) {
  const wanted = filter.chapterId != null ? String(filter.chapterId) : null;
  return record.affected
    .filter(entry => filter.kind == null || entry.kind === filter.kind)
    .filter(entry => wanted == null || entry.divId === wanted
      || (entry.labelPath ?? []).includes(wanted))
    .map(entry => ({
      blockId: entry.blockId,
      divId: entry.divId,
      kind: entry.kind,
      label: entry.label,
      labelPath: entry.labelPath,
      order: entry.order,
      structMap: entry.structMap,
      structMapType: entry.structMapType,
      via: entry.via,
      issues: entry.issues,
      regions: record.regions.filter(region => region.blockId === entry.blockId).map(region => ({
        regionId: region.id,
        region: region.region,
        kind: region.kind,
        fileId: region.fileId,
        begin: region.begin,
        end: region.end,
        betype: region.betype,
        state: region.state,
        reason: region.reason
      }))
    }));
}

export function reconcile(existing, next, { now }) {
  const attempts = (existing.attempts ?? 1) + 1;
  const drift = existing.structureFingerprint !== next.structureFingerprint;
  if (!drift) {
    return { ...next, id: existing.id, kind: existing.kind, source: existing.source,
      createdAt: existing.createdAt, updatedAt: now, attempts,
      previousEntry: existing.entry, structureDrift: existing.structureDrift ?? null };
  }
  const blocks = blockIndex(existing.structure.structMaps);
  const evaluated = evaluateRegions(existing.regions, next.files,
    existing.fileUse ?? next.fileUse, blocks, existing.structure.links);
  return { ...existing, updatedAt: now, attempts, entry: next.entry,
    groups: next.groups, files: next.files, regions: evaluated.regions,
    issues: evaluated.issues, affected: evaluated.affected,
    counts: counts(next.files, evaluated.regions, evaluated.issues,
      evaluated.affected, existing.fileUse ?? next.fileUse),
    structureDrift: { previous: existing.structureFingerprint,
      current: next.structureFingerprint, detectedAt: now } };
}

export async function recheckDelivery(record, { source, fetchBytes = acquire,
  now = () => new Date().toISOString() } = {}) {
  const origin = new URL(source).origin;
  const cache = new Map();
  const artifacts = [];
  const files = [];
  for (const file of record.files) {
    const next = { ...file };
    if (next.use !== record.fileUse || next.state === 'acquired') { files.push(next); continue; }
    if (!next.href) { next.reason = 'no_location'; next.acquired = false; files.push(next); continue; }
    if (new URL(next.href).origin !== origin) {
      next.state = 'unavailable'; next.reason = 'outside_source'; next.acquired = false;
      files.push(next); continue;
    }
    let transfer = cache.get(next.href);
    if (!transfer) {
      try {
        const result = await fetchBytes(source, next.href);
        const verified = verifyChecksum(result.bytes, next);
        if (verified === false) {
          transfer = { state: 'unavailable', reason: 'checksum_mismatch', status: null,
            verified: false, digest: null, bytes: null };
        } else {
          const digest = digestOf(result.bytes);
          transfer = { state: 'acquired', reason: null, status: null, verified,
            digest, bytes: result.bytes.length };
          artifacts.push({ digest, bytes: result.bytes });
        }
      } catch (error) {
        transfer = { state: 'unavailable', reason: 'source_unavailable',
          status: error.message, verified: null, digest: null, bytes: null };
      }
      cache.set(next.href, transfer);
    }
    Object.assign(next, transfer);
    next.acquired = transfer.state === 'acquired';
    files.push(next);
  }
  const blocks = blockIndex(record.structure.structMaps);
  const evaluated = evaluateRegions(record.regions, files, record.fileUse,
    blocks, record.structure.links);
  return {
    artifacts,
    record: { ...record, updatedAt: now(), attempts: (record.attempts ?? 1) + 1,
      files, regions: evaluated.regions, issues: evaluated.issues,
      affected: evaluated.affected,
      counts: counts(files, evaluated.regions, evaluated.issues,
        evaluated.affected, record.fileUse) }
  };
}
