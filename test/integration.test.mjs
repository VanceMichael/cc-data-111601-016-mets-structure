import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
import { Store } from '../src/store.mjs';
import { inspect } from '../src/reader.mjs';

test('单件资料可解释，畸形输入被拒绝', async () => {
  const fixture = await readFile(new URL('../fixtures/primary.bin', import.meta.url));
  assert.ok(inspect(fixture));
  assert.throws(() => inspect(Buffer.alloc(0)));
});
test('来源领取、原件持久化、重启查询及无副作用拒收', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'intake-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    const body = JSON.stringify({ path: '/primary' });
    const send = path => fetch(`${service.url}/intakes`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
    const first = await send('/primary');
    assert.equal(first.status, 201);
    const record = await first.json();
    assert.deepEqual(await new Store(directory).list(), [record]);
    assert.deepEqual(Buffer.from(await (await fetch(`${service.url}/objects/${record.digest}`)).arrayBuffer()),
      await readFile(new URL('../fixtures/primary.bin', import.meta.url)));
    const repeated = await send('/primary');
    assert.equal((await repeated.json()).id, record.id);
    assert.equal((await send('/missing')).status, 422);
    assert.equal((await send('https://example.invalid/foreign')).status, 422);
    assert.equal((await new Store(directory).list()).length, 1);
    const range = await fetch(`${provider.url}/primary`, { headers: { range: 'bytes=0-0' } });
    assert.equal(range.status, 206);
    assert.equal((await range.arrayBuffer()).byteLength, 1);
    const reject = await fetch(`${provider.url}/primary`, { headers: { 'if-match': '"old"' } });
    assert.equal(reject.status, 412);
    assert.ok(body.includes('primary'));
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('交付领取保留逻辑目录与物理页序，缩略图不被当作原件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'delivery-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    const response = await fetch(`${service.url}/deliveries`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/primary' }) });
    assert.equal(response.status, 201);
    const delivery = await response.json();
    assert.equal(delivery.status, 'complete');
    assert.equal(delivery.use, 'master');
    assert.deepEqual(delivery.structMaps.map(map => map.type), ['LOGICAL', 'PHYSICAL']);
    const physical = delivery.structMaps.find(map => map.type === 'PHYSICAL');
    assert.equal(physical.divs[0].children.map(div => div.order).join(','), '1,2');
    assert.equal(delivery.resources.length, 2);
    assert.ok(delivery.resources.every(item => item.use === 'master' && item.status === 'received'));
    const requests = await (await fetch(`${provider.url}/_requests`)).json();
    assert.equal(requests.some(request => request.path.startsWith('/pages/t1.txt')), false);
    const listing = await (await fetch(`${service.url}/deliveries`)).json();
    assert.equal(listing.length, 1);
    assert.equal(listing[0].id, delivery.id);
    const fetched = await (await fetch(`${service.url}/deliveries/${delivery.id}`)).json();
    assert.equal(fetched.objectId, 'folio-17');
    for (const region of delivery.regions.filter(region => region.status === 'resolved')) {
      const bytes = Buffer.from(await (await fetch(`${service.url}/objects/${region.digest}`)).arrayBuffer());
      const fixture = region.fileId === 'page1' ? 'resource-01.bin' : 'resource-02.bin';
      assert.deepEqual(bytes, await readFile(new URL(`../fixtures/${fixture}`, import.meta.url)));
    }
    assert.equal((await fetch(`${service.url}/deliveries/bad-id!!`)).status, 422);
    assert.equal((await fetch(`${service.url}/deliveries/unknown`)).status, 422);
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('缺件隔离可定位篇章，来源补件后回到原结构位置并持久化', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'delivery-gap-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  const phase = value => fetch(`${provider.url}/_phase`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phase: value }) });
  try {
    assert.equal((await phase(1)).status, 200);
    const firstResponse = await fetch(`${service.url}/deliveries`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/primary' }) });
    assert.equal(firstResponse.status, 201);
    const first = await firstResponse.json();
    assert.equal(first.status, 'incomplete');
    assert.equal(first.resources.find(item => item.fileId === 'page2').reason, 'source_status_404');
    assert.deepEqual(first.affectedChapters.map(chapter => [chapter.structMapType, chapter.divId]),
      [['LOGICAL', 'chapter'], ['PHYSICAL', 'p2']]);
    const requestsWhileIncomplete = await (await fetch(`${provider.url}/_requests`)).json();
    assert.equal(requestsWhileIncomplete.some(request => request.path.startsWith('/pages/p1.txt')), true);
    assert.equal(requestsWhileIncomplete.some(request => request.path.startsWith('/pages/t1.txt')), false);

    await phase(0);
    const secondResponse = await fetch(`${service.url}/deliveries`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/primary' }) });
    const second = await secondResponse.json();
    assert.equal(second.id, first.id);
    assert.equal(second.status, 'complete');
    assert.deepEqual(second.events.map(event => event.phase), ['initial', 'supplement']);
    const healed = second.regions.find(region => region.fileId === 'page2' && region.structMapType === 'LOGICAL');
    assert.equal(healed.status, 'resolved');
    assert.deepEqual(healed.divPath, ['book', 'chapter']);
    assert.equal(healed.region.begin, 'line1');

    await service.close();
    const reopened = await new Store(directory).initialize();
    const persisted = await reopened.findDelivery(second.mets.digest, new URL('/primary', provider.url).href);
    assert.equal(persisted.status, 'complete');
    assert.equal(persisted.structMaps.length, 2);
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('GET 交付接口无副作用，畸形 METS 不登记交付', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'delivery-guard-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    const before = await (await fetch(`${service.url}/deliveries`)).json();
    await fetch(`${service.url}/deliveries`);
    const after = await (await fetch(`${service.url}/deliveries`)).json();
    assert.deepEqual(after, before);
    const bad = await fetch(`${service.url}/deliveries`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/catalog' }) });
    assert.equal(bad.status, 422);
    assert.deepEqual(await (await fetch(`${service.url}/deliveries`)).json(), []);
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});
