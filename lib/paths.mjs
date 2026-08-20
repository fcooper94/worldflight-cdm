/* Where the controller pack and its caches live.

   Railway's filesystem is ephemeral: anything written while the server runs is
   gone at the next deploy. That is why a pack built on the server disappeared
   and the WF ATC Hub reported "No sector files supplied yet" -- the zip was
   only ever on the machine that built it.

   Point WF_VOLUME_DIR at a mounted volume and the pack, the portal's airport
   ground cache and the generator's Overpass cache all move onto storage that
   survives a deploy. Leave it unset -- local dev -- and the repo layout is
   used exactly as before. */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VOL = (process.env.WF_VOLUME_DIR || '').trim();

export const USING_VOLUME = Boolean(VOL);

/* Finished zips, and the working tree they are built from. */
export const PACK_DIR = VOL ? path.join(VOL, 'Euroscope_Files') : path.join(ROOT, 'Euroscope_Files');
export const PACK_WF_DIR = path.join(PACK_DIR, 'WorldFlight');

/* Airport ground layout for the portal map (lib/osm-ground.mjs). */
export const GROUND_CACHE_DIR = VOL ? path.join(VOL, 'ground') : path.join(ROOT, 'data', 'ground');

/* Raw Overpass responses for the pack generator. Deliberately NOT under
   PACK_WF_DIR: that tree is deleted after every zip, so a cache kept inside it
   never survived to a second build and each run re-fetched all 43 airports
   from Overpass -- ten minutes, and only when the mirrors cooperate. */
export const PACK_OSM_CACHE_DIR = VOL ? path.join(VOL, 'pack-osm-cache') : path.join(ROOT, 'data', 'pack-osm-cache');

/* A freshly mounted volume is empty, so every consumer would otherwise have to
   guard its own writes. */
export function ensurePackDirs() {
  for (const d of [PACK_DIR, GROUND_CACHE_DIR, PACK_OSM_CACHE_DIR]) {
    try {
      fs.mkdirSync(d, { recursive: true });
    } catch (err) {
      console.warn('[PATHS] could not create ' + d + ':', err.message);
    }
  }
  console.log(VOL
    ? '[PATHS] volume mode - controller pack at ' + PACK_DIR
    : '[PATHS] no WF_VOLUME_DIR - using repo paths (pack will not survive a deploy)');
}
