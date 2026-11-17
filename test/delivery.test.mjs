import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';

async function withService(run) {
  const directory = await mkdtemp(join(tmpdir(), 'delivery-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  const post = async (body) => {
    const response = await fetch(`${service.url}/deliveries`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const phase = value => fetch(`${provider.url}/_phase`, { method: 'POST',
    body: JSON.stringify({ phase: value }) });
  try {
    await run({ directory, provider, service, post, phase });
  } finally {
    await service.close();
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('从 METS 入口领取版本文件并分别保存逻辑、物理与区域', async () => {
  await withService(async ({ service, post }) => {
    const first = await post({ path: '/primary' });
    assert.equal(first.status, 201);
    const record = first.body;
    assert.equal(record.kind, 'mets-delivery');
    assert.equal(record.entry.path, '/primary');
    assert.equal(record.logical.length, 1);
    assert.equal(record.physical.length, 1);
    assert.notEqual(record.logical[0].structMap, record.physical[0].structMap);
    assert.deepEqual(record.files.map(file => [file.id, file.use, file.state]), [
      ['page1', 'master', 'acquired'],
      ['page2', 'master', 'acquired'],
      ['thumb1', 'thumbnail', 'described']
    ]);
    for (const file of record.files.filter(item => item.state === 'acquired')) {
      const bytes = await (await fetch(`${service.url}/objects/${file.digest}`)).arrayBuffer();
      assert.ok(Buffer.from(bytes).length > 0);
    }
    const reopened = await (await fetch(`${service.url}/deliveries`)).json();
    assert.equal(reopened.length, 1);
    assert.equal(reopened[0].complete, true);
    const detail = await (await fetch(`${service.url}/deliveries/${record.id}`)).json();
    assert.deepEqual(detail.logical, record.logical);
    assert.deepEqual(detail.physical, record.physical);
  });
});

test('来源缺失时定位受影响篇章并继续接收，补件后回到原结构位置', async () => {
  await withService(async ({ service, provider, post, phase }) => {
    await phase(1);
    const degraded = await post({ path: '/primary' });
    assert.equal(degraded.status, 201);
    const broken = degraded.body;
    assert.equal(broken.counts.acquired, 1);
    assert.equal(broken.counts.unavailable, 1);
    assert.ok(broken.counts.chapters >= 1);
    const affected = await (await fetch(`${service.url}/deliveries/${broken.id}/affected`)).json();
    const chapter = affected.find(entry => entry.kind === 'chapter');
    assert.equal(chapter.divId, 'chapter');
    assert.deepEqual(chapter.labelPath, ['地方志', '交通']);
    assert.ok(chapter.regions.some(region => region.fileId === 'page2'
      && region.state === 'unavailable'));
    assert.ok(chapter.regions.some(region => region.fileId === 'page1'
      && region.state === 'available'));

    await phase(0);
    const repeat = await post({ path: '/primary' });
    assert.equal(repeat.status, 200);
    assert.equal(repeat.body.id, broken.id);
    assert.equal(repeat.body.attempts, 2);
    assert.equal(repeat.body.counts.acquired, 2);
    assert.equal(repeat.body.counts.issues, 0);
    const restored = (await (await fetch(`${service.url}/deliveries/${broken.id}`)).json())
      .regions.find(region => region.divId === 'chapter' && region.fileId === 'page2');
    assert.equal(restored.state, 'available');
    assert.equal(restored.begin, 'line1');
    assert.equal(restored.end, 'line5');
  });
});

test('重查补齐不等依赖的缺口，不产生重复投递记录', async () => {
  await withService(async ({ service, provider, post, phase }) => {
    await phase(1);
    const received = await post({ path: '/primary' });
    await phase(0);
    const rechecked = await fetch(`${service.url}/deliveries/${received.body.id}/recheck`,
      { method: 'POST' });
    assert.equal(rechecked.status, 200);
    const record = await rechecked.json();
    assert.equal(record.counts.issues, 0);
    assert.equal(record.counts.availableRegions, 4);
    assert.equal(record.attempts, 2);
    const list = await (await fetch(`${service.url}/deliveries`)).json();
    assert.equal(list.length, 1);
  });
});

test('同一入口同内容重领返回原 id，异源与非法请求被拒绝', async () => {
  await withService(async ({ post }) => {
    const first = await post({ path: '/primary' });
    const second = await post({ path: '/primary' });
    assert.equal(second.status, 200);
    assert.equal(second.body.id, first.body.id);
    assert.equal(second.body.createdAt, first.body.createdAt);
    assert.equal(first.body.counts.issues, 0);
    assert.equal((await post({ path: 'https://example.invalid/foreign' })).status, 422);
    assert.equal((await post({ path: 42 })).status, 422);
  });
});

test('持久重开后逻辑、物理及区域关系仍可查询', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'delivery-reopen-'));
  const provider = await startProvider();
  const first = await startService({ source: provider.url, directory });
  let record;
  try {
    const response = await fetch(`${first.url}/deliveries`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/primary' }) });
    record = await response.json();
  } finally { await first.close(); }
  const second = await startService({ source: provider.url, directory });
  try {
    const reopened = await (await fetch(`${second.url}/deliveries/${record.id}`)).json();
    assert.deepEqual(reopened.logical, record.logical);
    assert.deepEqual(reopened.physical, record.physical);
    assert.deepEqual(reopened.regions, record.regions);
    assert.equal(reopened.structureFingerprint, record.structureFingerprint);
    const bytes = Buffer.from(await (await fetch(
      `${second.url}/objects/${record.files[0].digest}`)).arrayBuffer());
    assert.deepEqual(bytes, await readFile(new URL('../fixtures/resource-01.bin', import.meta.url)));
  } finally { await second.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('缺省入口与用途来自来源目录，未知用途明确拒绝且不落库', async () => {
  await withService(async ({ service, post }) => {
    const response = await fetch(`${service.url}/deliveries`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 201);
    const record = await response.json();
    assert.equal(record.entry.path, '/primary');
    assert.equal(record.fileUse, 'master');
    const unknown = await post({ fileUse: 'nope' });
    assert.equal(unknown.status, 422);
    assert.equal(unknown.body.error, 'file_use_not_found');
    assert.equal((await (await fetch(`${service.url}/deliveries`)).json()).length, 1);
  });
});

test('GET 只查询，不触发投递写入', async () => {
  await withService(async ({ service }) => {
    assert.equal((await fetch(`${service.url}/deliveries`)).status, 200);
    assert.equal((await fetch(`${service.url}/deliveries/missing`)).status, 404);
    assert.equal((await fetch(`${service.url}/deliveries/missing/affected`)).status, 404);
    assert.equal((await fetch(`${service.url}/deliveries/missing/recheck`)).status, 404);
    assert.deepEqual(await (await fetch(`${service.url}/deliveries`)).json(), []);
  });
});
