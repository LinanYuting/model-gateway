import { getDb } from './src/db/index.js';

const db = getDb();
db.prepare(`UPDATE channels SET config_json = ? WHERE id = 'free'`).run(JSON.stringify({
  endpoint: 'https://opencode.ai/v1/chat/completions',
  model: 'gpt-3.5-turbo',
  apiKey: '',
  apiKeys: []
}));

console.log('免费通道已更新为 OpenCode Zen 公共端点');
console.log(JSON.stringify(db.prepare('SELECT * FROM channels WHERE id = \'free\'').get(), null, 2));
process.exit(0);