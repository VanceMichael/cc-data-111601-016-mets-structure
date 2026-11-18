import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class Store {
  constructor(directory) {
    this.directory = directory;
    this.pending = Promise.resolve();
  }
  async initialize() {
    await mkdir(join(this.directory, 'objects'), { recursive: true });
    await mkdir(join(this.directory, 'deliveries'), { recursive: true });
    try { await this.list(); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.saveIndex([]);
    }
    try { await this.listDeliveries(); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.writeJson(join(this.directory, 'deliveries-index.json'), []);
    }
    return this;
  }
  async writeJson(path, value) {
    const temporary = join(this.directory, `tmp-${randomUUID()}`);
    await writeFile(temporary, JSON.stringify(value));
    await rename(temporary, path);
  }
  async saveIndex(records) {
    await this.writeJson(join(this.directory, 'index.json'), records);
  }
  async list() {
    return JSON.parse(await readFile(join(this.directory, 'index.json'), 'utf8'));
  }
  async listDeliveries() {
    return JSON.parse(await readFile(join(this.directory, 'deliveries-index.json'), 'utf8'));
  }
  // 内容寻址：同字节只存一份，METS 与各文件原件共用对象仓，交付记录只引用摘要。
  async saveObject(bytes) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    const path = join(this.directory, 'objects', digest);
    await writeFile(path, bytes, { flag: 'wx' }).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    return digest;
  }
  async accept(bytes, source, parsed) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    const operation = this.pending.then(async () => {
      const records = await this.list();
      const existing = records.find(record => record.digest === digest && record.source === source);
      if (existing) return existing;
      await this.saveObject(bytes);
      const record = { id: randomUUID(), digest, source, bytes: bytes.length, parsed };
      records.push(record);
      await this.saveIndex(records);
      return record;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async findDelivery(digest, source) {
    const index = await this.listDeliveries();
    const entry = index.find(record => record.digest === digest && record.source === source);
    if (!entry) return null;
    return JSON.parse(await readFile(join(this.directory, 'deliveries', `${entry.id}.json`), 'utf8'));
  }
  async saveDelivery(delivery) {
    const operation = this.pending.then(async () => {
      await this.writeJson(join(this.directory, 'deliveries', `${delivery.id}.json`), delivery);
      const index = await this.listDeliveries();
      const entry = { id: delivery.id, digest: delivery.mets.digest, source: delivery.source,
        use: delivery.use, status: delivery.status, objectId: delivery.objectId };
      const position = index.findIndex(record => record.id === delivery.id);
      if (position === -1) index.push(entry); else index[position] = entry;
      await this.writeJson(join(this.directory, 'deliveries-index.json'), index);
      return delivery;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async delivery(id) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('invalid_delivery_id');
    return JSON.parse(await readFile(join(this.directory, 'deliveries', `${id}.json`), 'utf8'));
  }
  async object(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid_digest');
    return readFile(join(this.directory, 'objects', digest));
  }
}
