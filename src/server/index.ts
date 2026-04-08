import express from 'express';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { apiRouter } from './api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = resolve(__dirname, 'static');
const PORT = parseInt(process.env.REVIEW_PORT || '3000', 10);

const app = express();
app.use(express.json());
app.use('/api', apiRouter);
app.use(express.static(STATIC_DIR));

// SPA fallback — serve index.html for non-API routes
app.get('/{*splat}', (_req, res) => {
  res.sendFile(resolve(STATIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Review UI running at http://localhost:${PORT}`);
  // Auto-open browser (skip if NO_OPEN env var is set — used by scheduled task)
  if (!process.env.NO_OPEN) {
    const open = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    import('child_process').then(({ exec }) => exec(`${open} http://localhost:${PORT}`));
  }
});
