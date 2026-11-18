import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspect, parseMets, collectReferences } from '../src/reader.mjs';
import { parseXml, descendants } from '../src/xml.mjs';
const primary=await readFile(new URL('../fixtures/primary.bin',import.meta.url));
const manifest=JSON.parse(await readFile(new URL('../fixtures/upstream.json',import.meta.url),'utf8'));
async function resource(path) {
  const item=manifest.resources[path];
  return item.file ? readFile(new URL(`../fixtures/${item.file}`,import.meta.url)) : Buffer.from(item.body);
}

test('不同用途文件组分开返回',()=>{
  const result=inspect(primary);assert.equal(result.groups.length,2);assert.equal(result.groups[0].use,'master');
  assert.equal(result.groups[1].use,'thumbnail');assert.equal(result.groups[0].files[0].locations[0],'pages/p1.txt');
});
test('平行结构图存在且不是线性页清单',()=>{
  const root=parseXml(primary);assert.equal(descendants(root,'structMap').length,2);
  assert.equal(descendants(root,'area').length,2);assert.equal(descendants(root,'smLink').length,1);
});
test('文件资源可独立领取且非法根不能登记',async()=>{
  assert.match((await resource('/pages/p2.txt')).toString(),/续页/);assert.throws(()=>inspect(Buffer.from('<other/>')));
});

test('两套 structMap 按 TYPE 平行保存，不合并成一棵树', () => {
  const parsed = parseMets(primary);
  assert.equal(parsed.kind, 'mets-structure');
  assert.equal(parsed.objectId, 'folio-17');
  assert.deepEqual(parsed.structMaps.map(map => map.type), ['LOGICAL', 'PHYSICAL']);
  const [logical, physical] = parsed.structMaps;
  assert.equal(logical.divs[0].id, 'book');
  assert.equal(logical.divs[0].children[0].label, '交通');
  assert.equal(physical.divs[0].children[0].order, '1');
  assert.equal(physical.divs[0].children[0].label, '一');
  assert.equal(physical.divs[0].children[1].order, '2');
  assert.equal(physical.divs[0].children[1].label, null);
  assert.deepEqual(parsed.links, [{ from: 'chapter', to: 'p1' }]);
});

test('ORDER 与 LABEL 原样区分，区域 FILEID/BEGIN/END 保留', () => {
  const parsed = parseMets(primary);
  const pages = parsed.structMaps.find(map => map.type === 'PHYSICAL').divs[0].children;
  assert.notEqual(pages[0].order, pages[0].label);
  const seq = parsed.structMaps[0].divs[0].children[0].pointers[0].items[0];
  assert.equal(seq.kind, 'seq');
  assert.deepEqual(seq.items.map(item => [item.area.fileId, item.area.begin, item.area.end]),
    [['page1', 'line1', 'line9'], ['page2', 'line1', 'line5']]);
});

test('引用收集保留 structMap 身份、篇章路径与区域，跨文件区域可定位', () => {
  const references = collectReferences(parseMets(primary));
  assert.equal(references.length, 4);
  const chapterRefs = references.filter(ref => ref.structMapType === 'LOGICAL');
  assert.deepEqual(chapterRefs.map(ref => ref.fileId), ['page1', 'page2']);
  assert.deepEqual(chapterRefs.map(ref => ref.divPath), [['book', 'chapter'], ['book', 'chapter']]);
  const physicalRefs = references.filter(ref => ref.structMapType === 'PHYSICAL');
  assert.deepEqual(physicalRefs.map(ref => ref.divId), ['p1', 'p2']);
  assert.equal(physicalRefs[0].region, null);
});

test('文件组用途随文件保留，缩略图与原件用途可区分', () => {
  const parsed = parseMets(primary);
  const uses = new Map(parsed.fileGroups.flatMap(group => group.files.map(file => [file.id, group.use])));
  assert.equal(uses.get('page1'), 'master');
  assert.equal(uses.get('thumb1'), 'thumbnail');
});

test('inspect 兼容视图形状不变', () => {
  const result = inspect(primary);
  assert.equal(result.kind, 'mets-file-catalog');
  assert.deepEqual(result.groups[1].files[0], { id: 'thumb1', mime: null, checksum: null,
    checksumType: null, locations: ['pages/t1.txt'] });
});
