import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';

const post = (service, path) => fetch(`${service.url}/deliveries`, { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });

const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const provider = await startProvider();
const service = await startService({ source: provider.url, directory });
try {
  console.log(JSON.stringify({ source: provider.url, product: service.url }));
  console.log('来源目录', await (await fetch(`${provider.url}/catalog`)).json());

  // 阶段 1：一个正文文件暂时 404，验证隔离领取与受影响篇章定位。
  await fetch(`${provider.url}/_phase`, { method: 'POST', body: JSON.stringify({ phase: 1 }) });
  const partial = await (await post(service, '/primary')).json();
  console.log('缺件时交付状态', partial.status);
  console.log('正文文件', partial.resources.map(item => `${item.fileId}:${item.status}`));
  console.log('受影响篇章', partial.affectedChapters.map(chapter =>
    `${chapter.structMapType}/${chapter.divId}(${chapter.divPath.join('>')})`));
  console.log('逻辑目录', partial.structMaps.find(map => map.type === 'LOGICAL').divs
    .map(div => `${div.label}(${div.id})`));
  console.log('物理页序', partial.structMaps.find(map => map.type === 'PHYSICAL').divs[0].children
    .map(div => `ORDER=${div.order} LABEL=${div.label ?? '∅'}`));

  // 阶段 0：来源补件，重新领取后回到原结构位置。
  await fetch(`${provider.url}/_phase`, { method: 'POST', body: JSON.stringify({ phase: 0 }) });
  const healed = await (await post(service, '/primary')).json();
  console.log('补件后交付状态', healed.status, '交付编号不变', healed.id === partial.id);
  console.log('区域指向', healed.regions.map(region =>
    `${region.structMapType}/${region.divId}->${region.fileId}` +
    `${region.region ? `[${region.region.begin}-${region.region.end}]` : ''}:${region.status}`));
  const requests = await (await fetch(`${provider.url}/_requests`)).json();
  console.log('缩略图从未被领取', requests.every(request => !request.path.includes('t1.txt')));
  console.log('交付目录', await (await fetch(`${service.url}/deliveries`)).json());
} finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
