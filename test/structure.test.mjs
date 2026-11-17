import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspect } from '../src/reader.mjs';
import { analyzeMets } from '../src/mets.mjs';
import { planDelivery, evaluateRegions } from '../src/intake.mjs';
import { parseXml, descendants } from '../src/xml.mjs';

const primary = await readFile(new URL('../fixtures/primary.bin', import.meta.url));
const plan = (bytes, fetchBytes) => planDelivery({ source: 'http://source.test', bytes,
  entryPath: '/primary', entryHref: 'http://source.test/primary', fetchBytes });
const offline = async (source, href) => ({ bytes: Buffer.from(href) });

const synthetic = overrides => Buffer.from(`
<mets:mets xmlns:mets="http://www.loc.gov/METS/" xmlns:xlink="http://www.w3.org/1999/xlink">
  <mets:fileSec>
    <mets:fileGrp USE="master">
      <mets:file ID="f1"><mets:FLocat xlink:href="a.txt"/></mets:file>
    </mets:fileGrp>
    <mets:fileGrp USE="thumbnail">
      <mets:file ID="t1"><mets:FLocat xlink:href="t.txt"/></mets:file>
    </mets:fileGrp>
  </mets:fileSec>
  <mets:structMap TYPE="LOGICAL">
    <mets:div ID="book" LABEL="志">
      <mets:div ID="c1" LABEL="章一"><mets:fptr><mets:seq>
        <mets:area FILEID="f1" BEGIN="1" END="2" BETYPE="BYTE"/>
        <mets:area FILEID="t1" BEGIN="1" END="1" BETYPE="BYTE"/>
      </mets:seq></mets:fptr></mets:div>
      <mets:div ID="c2" LABEL="章二"><mets:fptr FILEID="gone"/></mets:div>
      <mets:div ID="c3" LABEL="章三"><mets:fptr FILEID="t1"/></mets:div>
    </mets:div>
  </mets:structMap>
  <mets:structMap TYPE="PHYSICAL">
    <mets:div ID="pg" ORDER="7" LABEL="封面"><mets:fptr FILEID="f1"/></mets:div>
  </mets:structMap>
  <mets:structLink><mets:smLink xlink:from="c1" xlink:to="pg"/></mets:structLink>
</mets:mets>${overrides ?? ''}`);

test('两套 structMap 分别保存，不合并成一棵树', () => {
  const parsed = analyzeMets(primary);
  assert.equal(parsed.structMaps.length, 2);
  assert.deepEqual(parsed.structMaps.map(map => map.type), ['LOGICAL', 'PHYSICAL']);
  assert.deepEqual(parsed.structMaps[0].roots.map(div => div.id), ['book']);
  assert.deepEqual(parsed.structMaps[1].roots.map(div => div.id), ['physical']);
  assert.equal(descendants(parseXml(primary), 'structMap').length, 2);
});

test('ORDER 与 LABEL 分开保留，物理页序按 ORDER 而非标签', async () => {
  const { record } = await plan(primary, offline);
  const physical = record.physical[0];
  assert.deepEqual(physical.pages.map(page => page.blockId),
    ['1|0.0', '1|0.1']);
  assert.deepEqual(physical.pages.map(page => page.order), ['1', '2']);
  assert.equal(physical.pages[0].label, '一');
  assert.equal(physical.pages[1].label, null);
  const logical = record.logical[0];
  assert.deepEqual(logical.entries.map(entry => entry.label), ['地方志', '交通']);
  assert.deepEqual(logical.entries.map(entry => entry.order), [null, null]);
});

test('文件组用途区分：缩略图只保留描述，不当正文原件领取', async () => {
  assert.equal(inspect(primary).groups.length, 2);
  const requested = [];
  const fetchBytes = async (source, href) => {
    requested.push(href);
    return { bytes: Buffer.from('x') };
  };
  const { record } = await plan(primary, fetchBytes);
  assert.deepEqual(requested, ['http://source.test/pages/p1.txt',
    'http://source.test/pages/p2.txt']);
  const thumbnail = record.files.find(file => file.id === 'thumb1');
  assert.equal(thumbnail.use, 'thumbnail');
  assert.equal(thumbnail.state, 'described');
  assert.equal(thumbnail.digest, null);
  assert.equal(thumbnail.href, 'http://source.test/pages/t1.txt');
  assert.equal(record.counts.described, 1);
});

test('逻辑目录与物理页序及资源区域分别保存', async () => {
  const { record } = await plan(primary, offline);
  assert.equal(record.regions.length, 4);
  assert.deepEqual(record.regions.map(region => region.structMapType),
    ['LOGICAL', 'LOGICAL', 'PHYSICAL', 'PHYSICAL']);
  assert.deepEqual(record.regions.filter(region => region.kind === 'area')
    .map(region => [region.divId, region.fileId, region.begin, region.end]),
  [['chapter', 'page1', 'line1', 'line9'], ['chapter', 'page2', 'line1', 'line5']]);
  assert.ok(record.regions.every(region => region.state === 'available'));
  assert.equal(record.counts.acquired, 2);
});

test('跨文件区域被标记为跨越多个文件', async () => {
  const { record } = await plan(primary, offline);
  const areas = record.regions.filter(region => region.kind === 'area');
  assert.ok(areas.every(region => region.spansFiles === true));
  assert.ok(record.regions.filter(region => region.kind === 'fptr')
    .every(region => region.spansFiles === false));
});

test('同一页可同时属于正文与附录两个逻辑入口', async () => {
  const xml = Buffer.from(`<mets:mets xmlns:mets="http://www.loc.gov/METS/" xmlns:xlink="http://www.w3.org/1999/xlink">
    <mets:fileSec><mets:fileGrp USE="master">
      <mets:file ID="p1"><mets:FLocat xlink:href="p1.txt"/></mets:file>
    </mets:fileGrp></mets:fileSec>
    <mets:structMap TYPE="LOGICAL">
      <mets:div ID="body" LABEL="正文">
        <mets:div ID="c1" LABEL="章一"><mets:fptr FILEID="p1"/></mets:div></mets:div>
      <mets:div ID="appendix" LABEL="附录">
        <mets:div ID="a1" LABEL="附表"><mets:fptr FILEID="p1"/></mets:div></mets:div>
    </mets:structMap>
    <mets:structMap TYPE="PHYSICAL">
      <mets:div ID="pg1" ORDER="1"><mets:fptr FILEID="p1"/></mets:div>
    </mets:structMap></mets:mets>`);
  const { record } = await plan(xml, offline);
  const paths = record.regions.map(region => [region.divId,
    region.labelPath.join('/'), region.fileId]);
  assert.deepEqual(paths, [['c1', '正文/章一', 'p1'], ['a1', '附录/附表', 'p1'],
    ['pg1', '', 'p1']]);
  assert.equal(record.logical[0].pages.length, 2);
  assert.equal(record.physical[0].pages.length, 1);
  assert.ok(record.regions.every(region => region.state === 'available'));
});

test('缺失指向与文件组误用被定位到篇章且不影响其它资料', async () => {
  const { record } = await plan(synthetic(), offline);
  const byId = Object.fromEntries(record.affected.map(entry => [entry.divId, entry]));
  assert.ok(byId.c1, '包含缩略图区域的篇章仍被记录');
  assert.equal(byId.c2.kind, 'chapter');
  assert.ok(byId.c2.issues.some(issue => issue.reason === 'unknown_file_id'));
  assert.ok(byId.c3.issues.some(issue => issue.reason === 'non_master_file'));
  assert.equal(record.regions.find(region => region.divId === 'c2').state, 'missing');
  assert.equal(record.regions.find(region => region.divId === 'c3').state, 'not_master');
  assert.equal(record.regions.find(region => region.divId === 'c1'
    && region.fileId === 'f1').state, 'available');
  assert.equal(record.counts.files, 1);
  assert.equal(record.counts.acquired, 1);
  assert.equal(record.counts.issues, 3);
});

test('结构链接把物理页故障映射回逻辑篇章', async () => {
  const parsed = analyzeMets(synthetic());
  const blocks = new Map();
  const walk = (map, div) => {
    blocks.set(div.blockId, { blockId: div.blockId, id: div.id, label: div.label,
      labelPath: div.labelPath, order: div.order, type: div.type,
      structMap: map.index, structMapType: map.type, div });
    for (const child of div.children) walk(map, child);
  };
  for (const map of parsed.structMaps) for (const root of map.roots) walk(map, root);
  const regions = [{ id: 'r', kind: 'area', blockId: '1|0', divId: 'pg',
    structMap: 1, structMapType: 'PHYSICAL', label: '封面', labelPath: ['封面'],
    fileId: 'gone', fileIdSource: 'explicit', begin: null, end: null, betype: null,
    href: null, state: 'pending' }];
  const files = [{ id: 'f1', use: 'master', state: 'acquired', digest: 'd', bytes: 1 }];
  const result = evaluateRegions(regions, files, 'master', blocks, parsed.links);
  assert.equal(result.regions[0].state, 'missing');
  const c1 = result.affected.find(entry => entry.divId === 'c1');
  assert.ok(c1, '逻辑篇章通过 structLink 关联到损坏的物理页');
  assert.ok(c1.via.includes('structLink'));
  assert.ok(!result.affected.some(entry => entry.divId === 'c2'));
});

test('来源不可用时保留其它资料，缺口可重查补齐', async () => {
  let blocked = true;
  const artifacts = new Map([['http://source.test/pages/p1.txt', Buffer.from('正文一')],
    ['http://source.test/pages/p2.txt', Buffer.from('正文二')]]);
  const fetchBytes = async (source, href) => {
    if (blocked && href.endsWith('p2.txt')) throw new Error('source_status_404');
    return { bytes: artifacts.get(href) };
  };
  const first = await plan(primary, fetchBytes);
  assert.equal(first.record.counts.acquired, 1);
  assert.equal(first.record.counts.issues, 2);
  assert.deepEqual(first.record.affected.map(entry => entry.divId).sort(), ['chapter', 'p2']);
  assert.ok(first.record.regions.some(region => region.state === 'available'));
  blocked = false;
  const { recheckDelivery } = await import('../src/intake.mjs');
  const recovered = await recheckDelivery(first.record, { source: 'http://source.test',
    fetchBytes, now: () => 'later' });
  assert.equal(recovered.record.counts.issues, 0);
  assert.equal(recovered.record.counts.acquired, 2);
  assert.equal(recovered.record.attempts, 2);
  assert.deepEqual(recovered.record.affected, []);
});

test('同源外的区域指向不被领取，缺失时不臆造替代资源', async () => {
  const xml = Buffer.from(`<mets:mets xmlns:mets="http://www.loc.gov/METS/" xmlns:xlink="http://www.w3.org/1999/xlink">
    <mets:fileSec><mets:fileGrp USE="master">
      <mets:file ID="f1"><mets:FLocat xlink:href="https://elsewhere.invalid/a.txt"/></mets:file>
    </mets:fileGrp></mets:fileSec>
    <mets:structMap TYPE="LOGICAL"><mets:div ID="c1" LABEL="章">
      <mets:fptr FILEID="f1"/></mets:div></mets:structMap></mets:mets>`);
  const requested = [];
  const fetchBytes = async (source, href) => {
    requested.push(href);
    throw new Error('should_not_fetch');
  };
  const { record } = await plan(xml, fetchBytes);
  assert.deepEqual(requested, []);
  assert.equal(record.files[0].reason, 'outside_source');
  assert.equal(record.counts.issues, 1);
});
