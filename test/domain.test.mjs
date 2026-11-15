import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspect } from '../src/reader.mjs';
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
