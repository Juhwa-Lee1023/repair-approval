// Creates the sample job and a shop key if the database has no job yet.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createService } from '../src/service.js';
import { seedJob } from './seed-data.js';

const cfg = loadConfig();
const db = openDb(cfg.dataDir);
const svc = createService({ db, paypal: null, ai: null, cfg });

if (svc.listJobs().length) {
  console.log('Sample job already exists. Use `npm run reset` to start over.');
  process.exit(0);
}
const ids = seedJob(db, svc);
const key = svc.createShopKey();
const keyFile = path.join(cfg.dataDir, 'shop-key.txt');
fs.writeFileSync(keyFile, key + '\n', { mode: 0o600 });
console.log(`Created sample job ${ids.jobId} (RO-1042).`);
console.log(`Shop sign-in: ${cfg.publicBaseUrl}/shop/login#key=${key}`);
console.log(`The shop key is also saved in ${path.relative(process.cwd(), keyFile)} (local only, git-ignored).`);
