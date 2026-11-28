import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import { initDb, getDb } from './db/index.js';
import { loadChannels } from './services/channelRegistry.js';
import { startHealthProbe, startBackupCron } from './services/backup.js';
import { logStartupSecurityChecks } from './services/deployChecks.js';
import proxyRoutes from './routes/proxy.js';
import adminRoutes from './routes/admin.js';
import dashboardRoutes from './routes/dashboard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
// Disable caching for static files in development
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

app.use(express.static(join(__dirname, '../public')));

app.use('/v1', proxyRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/dashboard', dashboardRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

async function start() {
  try {
    // 部署期安全检查（第二轮安全审查）：只提示、不阻断，生产环境由 adminAuth 兜底拒绝
    logStartupSecurityChecks(join(__dirname, '..'));

    await initDb();
    await loadChannels();
    startHealthProbe();
    startBackupCron();
    
    app.listen(PORT, () => {
      console.log(`[Gateway] Server running on http://localhost:${PORT}`);
      console.log(`[Gateway] Health check: http://localhost:${PORT}/health`);
      console.log(`[Gateway] Dashboard: http://localhost:${PORT}/`);
    });
  } catch (error) {
    console.error('[Gateway] Failed to start:', error);
    process.exit(1);
  }
}

start();