/**
 * bootstrap-pack.js
 *
 * Ensures all shared static files exist in the Euroscope_Files/WorldFlight/
 * output directory. Copies from the UK EuroScope pack where needed.
 *
 * Usage:
 *   node scripts/bootstrap-pack.js
 *
 * Environment variables:
 *   UK_PACK_DIR  - path to the UK EuroScope pack (default: D:\Documents\Euroscope\UK)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PACK_WF_DIR } from '../lib/paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = PACK_WF_DIR;
const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const UK_DIR = process.env.UK_PACK_DIR || 'D:\\Documents\\Euroscope\\UK';

// ── File manifest ──────────────────────────────────────────────────────────

// Copy from templates/ directory (our master files, not UK pack)
const TEMPLATE_DIRS = [
  { src: 'Settings', dest: 'Data/Settings' },
  { src: 'Datafiles', dest: 'Data/Datafiles' },
  { src: 'Alias', dest: 'Data/Alias' },
  { src: 'Plugin/vSMR', dest: 'Data/Plugin/vSMR' },
  { src: 'Plugin/TopSky', dest: 'Data/Plugin/TopSky' },
  // Optional — only ships when the DLL has been dropped into templates/.
  { src: 'Plugin/VATCAN', dest: 'Data/Plugin/VATCAN', optional: true },
];


// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  console.log('=== WorldFlight Bootstrap: Shared Static Files ===\n');
  console.log(`Output dir   : ${OUTPUT_DIR}`);
  console.log(`Templates dir: ${TEMPLATES_DIR}\n`);

  if (!fs.existsSync(TEMPLATES_DIR)) {
    console.error(`ERROR: Templates directory not found at ${TEMPLATES_DIR}`);
    process.exit(1);
  }

  const skipped = [];
  const copied = [];
  const failed = [];

  // Copy template directories recursively
  for (const dir of TEMPLATE_DIRS) {
    const srcDir = path.join(TEMPLATES_DIR, ...dir.src.split('/'));
    const destDir = path.join(OUTPUT_DIR, ...dir.dest.split('/'));
    if (!fs.existsSync(srcDir)) {
      if (dir.optional) skipped.push({ file: dir.src, reason: 'Optional template not present' });
      else failed.push({ file: dir.src, reason: 'Template dir not found' });
      continue;
    }
    fs.mkdirSync(destDir, { recursive: true });
    const files = fs.readdirSync(srcDir);
    for (const f of files) {
      const srcPath = path.join(srcDir, f);
      const destPath = path.join(destDir, f);
      if (fs.statSync(srcPath).isDirectory()) {
        // Skip subdirectories (e.g. TopSky bigcursors)
        continue;
      }
      if (fs.existsSync(destPath)) { skipped.push(`${dir.dest}/${f}`); continue; }
      fs.copyFileSync(srcPath, destPath);
      console.log(`  COPY ${dir.src}/${f} -> ${dir.dest}/${f}`);
      copied.push(`${dir.dest}/${f}`);
    }
  }

  // Summary
  console.log(`\n=== Summary ===`);
  console.log(`  Already present : ${skipped.length}`);
  console.log(`  Copied          : ${copied.length}`);
  console.log(`  Failed/missing  : ${failed.length}`);

  if (failed.length > 0) {
    console.log('\nFiles that could not be resolved:');
    for (const f of failed) {
      console.log(`  - ${f.file}: ${f.reason}`);
    }
  }

  if (failed.length > 0) {
    process.exit(1);
  }

  console.log('\nAll shared static files are present.');
}

main();
