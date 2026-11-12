// Deletes only this app's local database and shop key, then reseeds. PayPal Sandbox orders are not touched.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig, APP_DIR } from '../src/config.js';

const cfg = loadConfig();
const dir = path.resolve(cfg.dataDir);
if (!dir.startsWith(path.join(APP_DIR, 'var')) && !process.env.ALLOW_RESET_OUTSIDE_APP) {
  console.error(`Refusing to reset ${dir}: not inside app/var.`);
  process.exit(1);
}
for (const f of ['repair.sqlite', 'repair.sqlite-wal', 'repair.sqlite-shm', 'shop-key.txt']) {
  const p = path.join(dir, f);
  if (fs.existsSync(p)) { fs.rmSync(p); console.log('removed', path.relative(APP_DIR, p)); }
}
execFileSync(process.execPath, [path.join(APP_DIR, 'scripts', 'seed.js')], { stdio: 'inherit' });
