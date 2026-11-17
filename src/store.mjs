import { mkdir, readFile, writeFile, rename, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const DIGEST = /^[a-f0-9]{64}$/;

export class Store {
  constructor(directory) {
    this.directory = directory;
    this.pending = Promise.resolve();
  }
  async initialize() {
    await mkdir(join(this.directory, 'objects'), { recursive: true });
    for (const [name, fallback] of [['index.json', []], ['deliveries.json', []]]) {
      try { await access(join(this.directory, name)); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await this.saveFile(name, fallback);
      }
    }
    return this;
  }
  async saveFile(name, value) {
    const temporary = join(this.directory, `${name}-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(value));
    await rename(temporary, join(this.directory, name));
  }
  async saveIndex(records) {
    return this.saveFile('index.json', records);
  }
  async list() {
    return JSON.parse(await readFile(join(this.directory, 'index.json'), 'utf8'));
  }
  async listDeliveries() {
    return JSON.parse(await readFile(join(this.directory, 'deliveries.json'), 'utf8'));
  }
  async delivery(id) {
    return (await this.listDeliveries()).find(record => record.id === id) ?? null;
  }  async saveObject(bytes) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    const target = join(this.directory, 'objects', digest);
    try { await access(target); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const temporary = join(this.directory, 'objects', `${digest}-${randomUUID()}.tmp`);
      await writeFile(temporary, bytes);
      await rename(temporary, target);
    }
    return digest;
  }
  async upsertDelivery({ source, entryDigest, entryPath, create, update }) {
    const operation = this.pending.then(async () => {
      const records = await this.listDeliveries();
      const index = records.findIndex(item => item.source === source
        && item.entry.digest === entryDigest && item.entry.path === entryPath);
      if (index === -1) {
        const record = create(null);
        records.push(record);
        await this.saveFile('deliveries.json', records);
        return { record, created: true };
      }
      const record = update(records[index]);
      records[index] = record;
      await this.saveFile('deliveries.json', records);
      return { record, created: false };
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async replaceDelivery(record) {
    const operation = this.pending.then(async () => {
      const records = await this.listDeliveries();
      const index = records.findIndex(item => item.id === record.id);
      if (index === -1) throw new Error('delivery_not_found');
      records[index] = record;
      await this.saveFile('deliveries.json', records);
      return record;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async accept(bytes, source, parsed) {
    const digest = await this.saveObject(bytes);
    const operation = this.pending.then(async () => {
      const records = await this.list();
      const existing = records.find(record => record.digest === digest && record.source === source);
      if (existing) return existing;
      const record = { id: randomUUID(), digest, source, bytes: bytes.length, parsed };
      records.push(record);
      await this.saveFile('index.json', records);
      return record;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async object(digest) {
    if (!DIGEST.test(digest)) throw new Error('invalid_digest');
    return readFile(join(this.directory, 'objects', digest));
  }
}
