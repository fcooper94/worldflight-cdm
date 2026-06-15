import { createInterface } from 'readline';
import { execSync, spawn } from 'child_process';
import { existsSync, copyFileSync, readFileSync, writeFileSync } from 'fs';

const rl = createInterface({ input: process.stdin, output: process.stdout });

// Detect mode from .env. Hybrid is DEV_MODE=true with a postgres DATABASE_URL.
const envContent = existsSync('.env') ? readFileSync('.env', 'utf8') : '';
const envIsDev = envContent.includes('DEV_MODE=true');
const envIsPg  = /^DATABASE_URL\s*=\s*"?postgres/im.test(envContent);
const currentMode = envIsDev ? (envIsPg ? 'hybrid' : 'offline') : 'production';
const currentLabel = currentMode === 'hybrid' ? 'Hybrid' : currentMode === 'offline' ? 'Offline' : 'Production';

console.log('');
console.log('  WorldFlight Planning Portal');
console.log('  ──────────────────────────');
console.log('');
console.log('  1) Production (Online)  — Railway DB + VATSIM SSO');
console.log('  2) Offline (Dev)        — Local SQLite + Dev Login');
console.log('  3) Hybrid               — Railway DB + Dev Login (bypass VATSIM on localhost)');
console.log('');
console.log(`  Current: ${currentLabel}`);
console.log('');

rl.question('  Select mode [1/2/3]: ', (answer) => {
  rl.close();
  const choice = answer.trim();

  if (choice === '2') switchToDev();
  else if (choice === '3') switchToHybrid();
  else switchToProd();
});

function switchToDev() {
  console.log('');
  console.log('  Switching to Offline (Dev) mode...');

  // Backup production .env if not already backed up
  if (existsSync('.env') && !existsSync('.env.prod.bak') && !envContent.includes('DEV_MODE=true')) {
    copyFileSync('.env', '.env.prod.bak');
    console.log('  Backed up .env → .env.prod.bak');
  }

  if (!existsSync('.env.dev')) {
    console.error('  ERROR: .env.dev not found');
    process.exit(1);
  }
  if (!existsSync('prisma/schema.dev.prisma')) {
    console.error('  ERROR: prisma/schema.dev.prisma not found');
    process.exit(1);
  }

  copyFileSync('.env.dev', '.env');

  // Sync production data into local SQLite before starting
  console.log('  Pulling latest production data...');
  try {
    execSync('node sync-prod.mjs', { stdio: 'inherit' });
  } catch (e) {
    console.error('  WARN: Sync failed — continuing with local data.');
  }
  console.log('');

  console.log('  Generating Prisma client (dev schema)...');
  execSync('npx --package=prisma@5 prisma generate --schema=prisma/schema.dev.prisma', { stdio: 'inherit' });
  console.log('  Pushing schema to SQLite...');
  execSync('npx --package=prisma@5 prisma db push --schema=prisma/schema.dev.prisma', { stdio: 'inherit' });

  console.log('');
  console.log('  Offline mode ready. Login auto-bypasses VATSIM.');
  console.log('');
  startServer();
}

async function switchToProd() {
  console.log('');
  console.log('  Switching to Production mode...');

  // Sync local dev data → production before switching
  if (currentMode === 'offline' && existsSync('prisma/dev.db')) {
    console.log('');
    console.log('  Syncing offline changes with production...');
    try {
      execSync('node sync-prod.mjs', { stdio: 'inherit' });
    } catch (e) {
      console.error('  WARN: Sync failed — continuing without sync.');
    }
    console.log('');
  }

  if (existsSync('.env.prod.bak')) {
    copyFileSync('.env.prod.bak', '.env');
    console.log('  Restored .env from backup');
  } else if (envContent.includes('DEV_MODE=true')) {
    console.error('  ERROR: No .env.prod.bak found. Restore your .env manually.');
    process.exit(1);
  }

  console.log('  Generating Prisma client...');
  execSync('npx --package=prisma@5 prisma generate', { stdio: 'inherit' });

  console.log('');
  startServer();
}

// Hybrid: point at the production Railway DB but force DEV_MODE=true so the
// localhost dev-login bypass works (VATSIM OAuth callback URL is registered
// for the production domain and won't redirect back to localhost).
//
// CAUTION: any "Dev Login" account you pick has full session access to PROD
// data. Only use this from your own machine for read-mostly testing.
function switchToHybrid() {
  console.log('');
  console.log('  Switching to Hybrid mode (Production DB + Dev Login)...');
  console.log('  ⚠  Dev login grants prod-data session access. Localhost-only.');
  console.log('');

  // If switching from Production, back up the pristine prod .env first so
  // future "1) Production" runs can restore cleanly.
  if (currentMode === 'production' && existsSync('.env') && !existsSync('.env.prod.bak')) {
    copyFileSync('.env', '.env.prod.bak');
    console.log('  Backed up .env → .env.prod.bak');
  }

  // Need a prod-shaped .env to start from.
  const source = existsSync('.env.prod.bak')
    ? '.env.prod.bak'
    : (currentMode === 'production' && existsSync('.env') ? '.env' : null);
  if (!source) {
    console.error('  ERROR: No prod .env available. Boot mode 1 (Production) once first.');
    process.exit(1);
  }

  // Upsert DEV_MODE=true onto the prod-shaped env.
  let env = readFileSync(source, 'utf8');
  if (/^DEV_MODE=/m.test(env)) {
    env = env.replace(/^DEV_MODE=.*$/m, 'DEV_MODE=true');
  } else {
    env = env.trimEnd() + '\nDEV_MODE=true\n';
  }
  writeFileSync('.env', env);
  console.log(`  Wrote .env (${source} + DEV_MODE=true)`);

  console.log('  Generating Prisma client (prod schema)...');
  execSync('npx --package=prisma@5 prisma generate', { stdio: 'inherit' });

  console.log('');
  console.log('  Hybrid mode ready. Pick any dev user at /auth/login.');
  console.log('');
  startServer();
}

function startServer() {
  const child = spawn('npx', ['nodemon', 'index.js'], {
    stdio: 'inherit',
    shell: true
  });

  child.on('exit', (code) => process.exit(code));
}
