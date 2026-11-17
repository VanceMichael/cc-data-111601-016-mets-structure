import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { acquire } from './transport.mjs';
import { inspect } from './reader.mjs';
import { planDelivery, createRecord, summarize, reconcile, recheckDelivery,
  affectedView } from './intake.mjs';

async function body(request, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new Error('request_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

async function readCatalog(source) {
  try {
    const result = await acquire(source, '/catalog');
    const catalog = JSON.parse(result.bytes.toString());
    return catalog && typeof catalog === 'object' ? catalog : null;
  } catch {
    return null;
  }
}

export async function startService({ source, directory, port = 0,
  now = () => new Date().toISOString() }) {
  const store = await new Store(directory).initialize();
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/health') return response.end(JSON.stringify({ ready: true }));
      if (url.pathname === '/records' && request.method === 'GET') {
        return response.end(JSON.stringify(await store.list()));
      }
      if (url.pathname === '/deliveries' && request.method === 'GET') {
        return response.end(JSON.stringify((await store.listDeliveries()).map(summarize)));
      }
      const deliveryPath = /^\/deliveries\/([^/]+)(?:\/(recheck|affected))?$/.exec(url.pathname);
      if (deliveryPath && (request.method === 'GET' || request.method === 'POST')) {
        const record = await store.delivery(deliveryPath[1]);
        if (!record) {
          response.writeHead(404);
          return response.end(JSON.stringify({ error: 'not_found' }));
        }
        const action = deliveryPath[2];
        if (!action && request.method === 'GET') return response.end(JSON.stringify(record));
        if (action === 'affected' && request.method === 'GET') {
          return response.end(JSON.stringify(affectedView(record, {
            kind: url.searchParams.get('kind') ?? undefined,
            chapterId: url.searchParams.get('chapterId') ?? undefined
          })));
        }
        if (action === 'recheck' && request.method === 'POST') {
          const outcome = await recheckDelivery(record, { source, now });
          for (const artifact of outcome.artifacts) await store.saveObject(artifact.bytes);
          return response.end(JSON.stringify(await store.replaceDelivery(outcome.record)));
        }
        response.writeHead(404);
        return response.end(JSON.stringify({ error: 'not_found' }));
      }
      if (url.pathname.startsWith('/objects/') && request.method === 'GET') {
        response.setHeader('Content-Type', 'application/octet-stream');
        return response.end(await store.object(url.pathname.slice(9)));
      }
      if (url.pathname === '/intakes' && request.method === 'POST') {
        const payload = await body(request, 16384);
        if (typeof payload.path !== 'string') throw new Error('path_required');
        const result = await acquire(source, payload.path);
        const parsed = inspect(result.bytes);
        const record = await store.accept(result.bytes, new URL(payload.path, source).href, parsed);
        response.statusCode = 201;
        return response.end(JSON.stringify(record));
      }
      if (url.pathname === '/deliveries' && request.method === 'POST') {
        const payload = await body(request, 16384);
        if (payload.path != null && typeof payload.path !== 'string') throw new Error('path_invalid');
        if (payload.fileUse != null && typeof payload.fileUse !== 'string') throw new Error('file_use_invalid');
        const catalog = await readCatalog(source);
        const path = payload.path ?? catalog?.entry ?? '/primary';
        const fileUse = payload.fileUse ?? catalog?.fileUse ?? 'master';
        const target = new URL(path, source);
        if (target.origin !== new URL(source).origin) throw new Error('outside_source');
        const entry = await acquire(source, path);
        const plan = await planDelivery({ source, bytes: entry.bytes, entryPath: path,
          entryHref: target.href, fileUse });
        for (const artifact of plan.artifacts) await store.saveObject(artifact.bytes);
        const sourceKey = target.origin;
        const outcome = await store.upsertDelivery({
          source: sourceKey,
          entryDigest: plan.record.entry.digest,
          entryPath: plan.record.entry.path,
          create: () => createRecord({ ...plan.record, source: sourceKey },
            { id: randomUUID(), source: sourceKey, now: now() }),
          update: existing => reconcile(existing, plan.record, { now: now(), source: sourceKey })
        });
        response.statusCode = outcome.created ? 201 : 200;
        return response.end(JSON.stringify(outcome.record));
      }
      response.writeHead(404);
      response.end(JSON.stringify({ error: 'not_found' }));
    } catch (error) {
      response.statusCode = 422;
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { server, store, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.SOURCE_URL) throw new Error('SOURCE_URL_required');
  const service = await startService({ source: process.env.SOURCE_URL,
    directory: process.env.DATA_DIR ?? './data', port: Number(process.env.PORT ?? 4102) });
  console.log(JSON.stringify({ product: service.url }));
}
