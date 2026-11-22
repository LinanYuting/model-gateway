import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let dbInstance = null;
let currentDbPath = null;

function resolveDbPath() {
  const p = process.env.DB_PATH || join(__dirname, '../../data/gateway.db');
  return resolve(p);
}

export function getDb() {
  const dbPath = resolveDbPath();
  if (!dbInstance || currentDbPath !== dbPath) {
    if (dbInstance) {
      try { dbInstance.close(); } catch (_) {}
    }
    mkdirSync(dirname(dbPath), { recursive: true });
    dbInstance = new Database(dbPath);
    currentDbPath = dbPath;
    // Enable WAL mode for better concurrency
    dbInstance.pragma('journal_mode = WAL');
    dbInstance.pragma('foreign_keys = ON');
    dbInstance.pragma('synchronous = NORMAL');
    dbInstance.pragma('cache_size = -2000'); // 2MB cache
    dbInstance.pragma('temp_store = MEMORY');
    dbInstance.pragma('mmap_size = 268435456'); // 256MB
  }
  return dbInstance;
}

export function initDb() {
  const db = getDb();
  const schemaPath = join(__dirname, 'schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  db.exec(schema);
  
  // Seed default channels if not exist
  seedChannels(db);
  
  console.log('[DB] Database initialized at:', resolveDbPath());
  return db;
}

function seedChannels(db) {
  const defaultChannels = [
    // 免费通道：基于 OFM 默认免费池，开箱即用，无需 API Key
    { id: 'free', type: 'free', name: '免费公共通道', enabled: 1, config_json: JSON.stringify({ endpoint: 'http://localhost:18900/v1/chat/completions', model: 'gpt-3.5-turbo', apiKey: '', apiKeys: [] }) },
    // 赞助通道和 aiping 需用户自行配置
    { id: 'sponsored', type: 'sponsored', name: '赞助密钥通道', enabled: 0, config_json: JSON.stringify({ endpoint: '', model: '', apiKey: '', apiKeys: [] }) },
    { id: 'aiping', type: 'aiping', name: 'aiping 通道', enabled: 0, config_json: JSON.stringify({ endpoint: '', model: '', apiKey: '', apiKeys: [] }) }
  ];

  const checkStmt = db.prepare('SELECT COUNT(*) as count FROM channels');
  const result = checkStmt.get();
  
  if (result.count === 0) {
    const insertStmt = db.prepare(`
      INSERT INTO channels (id, type, name, enabled, config_json, health_status)
      VALUES (?, ?, ?, ?, ?, 'unconfigured')
    `);
    
    const insertMany = db.transaction((channels) => {
      for (const ch of channels) {
        insertStmt.run(ch.id, ch.type, ch.name, ch.enabled, ch.config_json);
      }
    });
    
    insertMany(defaultChannels);
    console.log('[DB] Seeded default channels');
  }
}

export function closeDb() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}