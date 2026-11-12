import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Sandbox only. There is deliberately no setting that changes these hosts.
export const PAYPAL_API_BASE = 'https://api-m.sandbox.paypal.com';
export const PAYPAL_APPROVAL_PREFIX = 'https://www.sandbox.paypal.com/';

const ID_NAMES = ['PAYPAL_CLIENT_ID', 'PAYPAL_SANDBOX_CLIENT_ID', 'CLIENT_ID'];
const SECRET_NAMES = ['PAYPAL_CLIENT_SECRET', 'PAYPAL_SANDBOX_CLIENT_SECRET', 'CLIENT_SECRET', 'PAYPAL_SECRET'];

function parseEnvFile(file) {
  const out = {};
  if (!file || !fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    const key = line.slice(0, i).replace(/^export\s+/, '').trim();
    out[key] = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

function pick(sources, names) {
  for (const src of sources) for (const n of names) if (src[n]) return src[n];
  return null;
}

// Credentials are read on the server only and never returned by any route or log line.
export function loadConfig(overrides = {}) {
  const envFile = process.env.PAYPAL_ENV_FILE || path.resolve(APP_DIR, '..', 'private', 'paypal-sandbox.env');
  const fileVals = parseEnvFile(envFile);
  const sources = [process.env, fileVals];
  const port = Number(process.env.PORT || 8879);
  const cfg = {
    port,
    publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${port}`).replace(/\/$/, ''),
    dataDir: process.env.DATA_DIR || path.join(APP_DIR, 'var'),
    aiProvider: process.env.AI_PROVIDER || 'claude-cli',
    aiModel: process.env.AI_MODEL || 'claude-sonnet-5-5',
    aiTimeoutMs: Number(process.env.AI_TIMEOUT_MS || 45000),
    customerLinkDays: Number(process.env.CUSTOMER_LINK_DAYS || 7),
    paypal: {
      clientId: pick(sources, ID_NAMES),
      clientSecret: pick(sources, SECRET_NAMES),
      envFileFound: fs.existsSync(envFile),
    },
    ...overrides,
  };
  return cfg;
}

export function configSummary(cfg) {
  return {
    paypal_api_base: PAYPAL_API_BASE,
    env_file_found: cfg.paypal.envFileFound,
    client_id_present: Boolean(cfg.paypal.clientId),
    client_secret_present: Boolean(cfg.paypal.clientSecret),
    ai_provider: cfg.aiProvider,
    ai_model: cfg.aiModel,
    public_base_url: cfg.publicBaseUrl,
  };
}
