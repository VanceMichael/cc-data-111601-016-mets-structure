import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { ingestDelivery } from '../src/ingest.mjs';

const source = 'http://source.test/archive/';
const xml = ({ checksumPage1 = '', checksumPage2 = '', extra = '' } = {}) =>
  `<mets:mets xmlns:mets="http://www.loc.gov/METS/" xmlns:xlink="http://www.w3.org/1999/xlink" OBJID="folio-17">` +
  `<mets:fileSec><mets:fileGrp USE="master">` +
  `<mets:file ID="page1" MIMETYPE="text/plain"${checksumPage1}><mets:FLocat xlink:href="pages/p1.txt"/></mets:file>` +
  `<mets:file ID="page2" MIMETYPE="text/plain"${checksumPage2}><mets:FLocat xlink:href="pages/p2.txt"/></mets:file>` +
  `</mets:fileGrp><mets:fileGrp USE="thumbnail">` +
  `<mets:file ID="thumb1"><mets:FLocat xlink:href="pages/t1.txt"/></mets:file></mets:fileGrp></mets:fileSec>` +
  `<mets:structMap TYPE="LOGICAL"><mets:div ID="book" LABEL="地方志"><mets:div ID="chapter" LABEL="交通">` +
  `<mets:fptr><mets:seq><mets:area FILEID="page1" BEGIN="line1" END="line9"/>` +
  `<mets:area FILEID="page2" BEGIN="line1" END="line5"/></mets:seq></mets:fptr>` +
  `${extra}</mets:div></mets:div></mets:structMap>` +
  `<mets:structMap TYPE="PHYSICAL"><mets:div ID="physical">` +
  `<mets:div ID="p1" ORDER="1" LABEL="一"><mets:fptr FILEID="page1"/></mets:div>` +
  `<mets:div ID="p2" ORDER="2"><mets:fptr FILEID="page2"/></mets:div>` +
  `</mets:div></mets:structMap>` +
  `<mets:structLink><mets:smLink xlink:from="chapter" xlink:to="p1"/></mets:structLink></mets:mets>`;

const p1 = Buffer.from('第一至九行');
const p2 = Buffer.from('续页第一至五行');
const t1 = Buffer.from('缩略预览');

function fakeAcquire(failures = {}, metsBytes = null) {
  const calls = [];
  const acquire = async (base, path, headers = {}) => {
    calls.push({ path, headers });
    if (path.includes('foreign.example')) throw new Error('outside_source');
    if (failures[path]) throw new Error(failures[path]);
    if (metsBytes && (path === 'mets.xml' || path.endsWith('/mets.xml'))) {
      return { bytes: metsBytes, status: 200, headers: { etag: '"mets"' } };
    }
    const bytes = path.includes('p1') ? p1 : path.includes('p2') ? p2 : t1;
    return { bytes, status: 200, headers: { etag: `"${path}"` } };
  };
  return { acquire, calls };
}

async function freshStore() {
  const directory = await mkdtemp(join(tmpdir(), 'ingest-unit-'));
  const store = await new Store(directory).initialize();
  return { directory, store };
}

test('完整领取：两套 structMap 平行保存，区域与原件分离，缩略图不被领取', async () => {
  const { directory, store } = await freshStore();
  const { acquire, calls } = fakeAcquire({}, Buffer.from(xml()));
  try {
    const delivery = await ingestDelivery({ source, entry: 'mets.xml', acquire, store });
    assert.equal(delivery.status, 'complete');
    assert.deepEqual(delivery.structMaps.map(map => map.type), ['LOGICAL', 'PHYSICAL']);
    const physical = delivery.structMaps.find(map => map.type === 'PHYSICAL');
    assert.equal(physical.divs[0].children[0].order, '1');
    assert.equal(physical.divs[0].children[0].label, '一');
    assert.equal(physical.divs[0].children[1].order, '2');
    assert.equal(physical.divs[0].children[1].label, null);
    assert.deepEqual(delivery.links, [{ from: 'chapter', to: 'p1' }]);
    const chapter = delivery.structMaps[0].divs[0].children[0];
    const areas = chapter.pointers[0].items[0].items;
    assert.deepEqual(areas.map(area => area.area.begin), ['line1', 'line1']);
    assert.deepEqual(areas.map(area => area.area.end), ['line9', 'line5']);
    const logicalRegions = delivery.regions.filter(region => region.structMapType === 'LOGICAL');
    assert.equal(logicalRegions.length, 2);
    assert.deepEqual(logicalRegions[0].divPath, ['book', 'chapter']);
    for (const region of delivery.regions) {
      assert.equal(region.status, 'resolved');
      assert.match(region.digest, /^[a-f0-9]{64}$/);
      const stored = await store.object(region.digest);
      assert.equal(stored.equals(region.fileId === 'page1' ? p1 : p2), true);
    }
    assert.ok(delivery.fileGroups.some(group => group.use === 'thumbnail'));
    assert.equal(delivery.resources.some(item => item.use === 'thumbnail'), false);
    assert.equal(calls.some(call => call.path.includes('t1.txt')), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('单文件缺失：定位受影响篇章，其余资料继续，补件回到原结构位置', async () => {
  const { directory, store } = await freshStore();
  const failures = { '/archive/pages/p2.txt': 'source_status_404' };
  const { acquire, calls } = fakeAcquire(failures, Buffer.from(xml()));
  try {
    const first = await ingestDelivery({ source, entry: 'mets.xml', acquire, store });
    assert.equal(first.status, 'incomplete');
    assert.deepEqual(first.resources.map(item => [item.fileId, item.status]),
      [['page1', 'received'], ['page2', 'failed']]);
    assert.equal(first.resources[1].reason, 'source_status_404');
    const affected = first.affectedChapters;
    assert.deepEqual(affected.map(chapter => [chapter.structMapType, chapter.divId]),
      [['LOGICAL', 'chapter'], ['PHYSICAL', 'p2']]);
    assert.deepEqual(affected[0].divPath, ['book', 'chapter']);
    assert.equal(affected[0].problems[0].region.end, 'line5');
    const stuck = first.regions.find(region => region.fileId === 'page2' && region.structMapType === 'LOGICAL');
    assert.equal(stuck.status, 'unresolved');
    assert.equal(stuck.reason, 'source_status_404');
    assert.equal(calls.some(call => call.path.includes('t1.txt')), false);

    failures['/archive/pages/p2.txt'] = undefined;
    const second = await ingestDelivery({ source, entry: 'mets.xml', acquire, store });
    assert.equal(second.id, first.id);
    assert.equal(second.status, 'complete');
    assert.deepEqual(second.events.map(event => event.phase), ['initial', 'supplement']);
    const healed = second.regions.find(region => region.fileId === 'page2' && region.structMapType === 'LOGICAL');
    assert.equal(healed.status, 'resolved');
    assert.deepEqual(healed.divPath, ['book', 'chapter']);
    assert.deepEqual(healed.pointerPath, stuck.pointerPath);
    assert.equal(healed.region.begin, 'line1');
    const reopened = await new Store(directory).initialize()
      .then(store2 => store2.findDelivery(second.mets.digest, new URL('mets.xml', source).href));
    assert.equal(reopened.id, second.id);
    assert.equal(reopened.status, 'complete');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('未声明 FILEID 与缺失 FLocat 不被相似资源顶替，独立标记', async () => {
  const { directory, store } = await freshStore();
  const { acquire } = fakeAcquire();
  try {
    const mets = xml({ extra: '<mets:fptr FILEID="pageX"/>' });
    const custom = async (base, path) => {
      if (path === 'mets.xml') return { bytes: Buffer.from(mets), status: 200, headers: {} };
      return acquire(base, path);
    };
    const delivery = await ingestDelivery({ source, entry: 'mets.xml', acquire: custom, store });
    const unknown = delivery.regions.find(region => region.fileId === 'pageX');
    assert.equal(unknown.status, 'unresolved');
    assert.equal(unknown.reason, 'undeclared_file');
    assert.equal(unknown.divId, 'chapter');
    assert.equal(delivery.resources.every(item => item.fileId !== 'pageX'), true);
    assert.equal(delivery.status, 'incomplete');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('校验和不符拒收且不落盘，相符则通过', async () => {
  const { directory, store } = await freshStore();
  const good = createHash('sha256').update(p1).digest('hex');
  const mets = xml({
    checksumPage1: ` CHECKSUM="${good}" CHECKSUMTYPE="SHA-256"`,
    checksumPage2: ' CHECKSUM="00" CHECKSUMTYPE="MD5"',
  });
  const acquire = async (base, path) => {
    if (path === 'mets.xml') return { bytes: Buffer.from(mets), status: 200, headers: {} };
    if (path.includes('p1')) return { bytes: p1, status: 200, headers: {} };
    if (path.includes('p2')) return { bytes: p2, status: 200, headers: {} };
    throw new Error('unexpected');
  };
  try {
    const delivery = await ingestDelivery({ source, entry: 'mets.xml', acquire, store });
    assert.equal(delivery.resources[0].status, 'received');
    assert.equal(delivery.resources[1].status, 'failed');
    assert.equal(delivery.resources[1].reason, 'checksum_mismatch');
    const objects = await readdir(join(directory, 'objects'));
    const p2Digest = createHash('sha256').update(p2).digest('hex');
    assert.equal(objects.includes(p2Digest), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('跨来源 href 拒绝；切换 USE 时原正文用途不被领取', async () => {
  const { directory, store } = await freshStore();
  const foreignMets = xml().replace('xlink:href="pages/p2.txt"', 'xlink:href="http://foreign.example/p2.txt"');
  const fallback = fakeAcquire({}, Buffer.from(xml())).acquire;
  const acquireForeign = async (base, path) =>
    path === 'mets.xml' ? { bytes: Buffer.from(foreignMets), status: 200, headers: {} } : fallback(base, path);
  try {
    const delivery = await ingestDelivery({ source, entry: 'mets.xml', acquire: acquireForeign, store });
    assert.equal(delivery.resources.find(item => item.fileId === 'page2').reason, 'outside_source');
    assert.equal(delivery.status, 'incomplete');
  } finally { await rm(directory, { recursive: true, force: true }); }

  const store2ctx = await freshStore();
  const { acquire, calls } = fakeAcquire({}, Buffer.from(xml()));
  try {
    const thumbs = await ingestDelivery({ source, entry: 'mets.xml', use: 'thumbnail', acquire, store: store2ctx.store });
    assert.deepEqual(thumbs.resources.map(item => [item.fileId, item.status]), [['thumb1', 'received']]);
    assert.equal(calls.some(call => call.path.includes('p1.txt') || call.path.includes('p2.txt')), false);
    assert.ok(thumbs.regions.every(region => region.reason === 'outside_selected_use'));
  } finally { await rm(store2ctx.directory, { recursive: true, force: true }); }
});

test('来源未变更（304）时复用已存原件，不重复领取', async () => {
  const { directory, store } = await freshStore();
  let mode304 = false;
  const acquire = async (base, path, headers = {}) => {
    if (path === 'mets.xml') return { bytes: Buffer.from(xml()), status: 200, headers: { etag: '"m"' } };
    if (mode304 && headers['if-none-match']) throw new Error('source_status_304');
    const bytes = path.includes('p1') ? p1 : p2;
    return { bytes, status: 200, headers: { etag: `"${path}"` } };
  };
  try {
    const first = await ingestDelivery({ source, entry: 'mets.xml', acquire, store });
    mode304 = true;
    const again = await ingestDelivery({ source, entry: 'mets.xml', acquire, store });
    assert.equal(again.id, first.id);
    assert.equal(again.status, 'complete');
    assert.deepEqual(again.resources.map(item => item.digest), first.resources.map(item => item.digest));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
