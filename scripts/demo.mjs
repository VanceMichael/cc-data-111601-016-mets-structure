import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';

const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const provider = await startProvider();
const service = await startService({ source: provider.url, directory });
const intake = async () => {
  const response = await fetch(`${service.url}/deliveries`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: '/primary' }) });
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(await response.text());
  }
  return response.json();
};
try {
  console.log(JSON.stringify({ source: provider.url, product: service.url }));
  console.log('来源目录', await (await fetch(`${provider.url}/catalog`)).json());

  const first = await intake();
  console.log('接收结果', {
    id: first.id,
    entry: first.entry.path,
    counts: first.counts,
    logical: first.logical[0].entries.map(entry => ({ id: entry.id, label: entry.label,
      fileIds: entry.fileIds })),
    physical: first.physical[0].pages.map(page => ({ id: page.id, order: page.order,
      label: page.label })),
    regions: first.regions.map(region => ({ div: region.divId, kind: region.kind,
      fileId: region.fileId, begin: region.begin, end: region.end,
      spansFiles: region.spansFiles }))
  });

  await fetch(`${provider.url}/_phase`, { method: 'POST', body: JSON.stringify({ phase: 1 }) });
  const degraded = await intake();
  console.log('来源缺页时', {
    id: degraded.id,
    counts: degraded.counts,
    affected: (await (await fetch(
      `${service.url}/deliveries/${degraded.id}/affected`)).json())
      .map(entry => ({ divId: entry.divId, kind: entry.kind,
        labelPath: entry.labelPath, reasons: entry.issues.map(issue => issue.reason) }))
  });

  await fetch(`${provider.url}/_phase`, { method: 'POST', body: JSON.stringify({ phase: 0 }) });
  const rechecked = await (await fetch(`${service.url}/deliveries/${degraded.id}/recheck`,
    { method: 'POST' })).json();
  console.log('补件重查后', { id: rechecked.id, counts: rechecked.counts });

  console.log('已保存投递', await (await fetch(`${service.url}/deliveries`)).json());
} finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
