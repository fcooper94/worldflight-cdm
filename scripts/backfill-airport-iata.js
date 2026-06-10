import { PrismaClient } from '@prisma/client';
import https from 'https';
import fs from 'fs';
import csv from 'csv-parser';

const prisma = new PrismaClient();

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, res => {
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', reject);
  });
}

async function run() {
  const csvPath = 'airports_tmp.csv';

  console.log('Downloading airports.csv from OurAirports...');
  await download('https://davidmegginson.github.io/ourairports-data/airports.csv', csvPath);

  console.log('Parsing CSV...');
  const iatas = new Map();
  await new Promise((resolve, reject) => {
    fs.createReadStream(csvPath)
      .pipe(csv())
      .on('data', row => {
        const iata = (row.iata_code || '').trim().toUpperCase();
        if (row.ident && row.ident.length === 4 && /^[A-Z]{3}$/.test(iata)) {
          iatas.set(row.ident.toUpperCase(), iata);
        }
      })
      .on('end', resolve)
      .on('error', reject);
  });

  console.log(`Parsed ${iatas.size} airports with IATA codes.`);

  // Get only airports that exist in our DB
  const dbAirports = await prisma.airport.findMany({ select: { icao: true } });
  const toUpdate = dbAirports.filter(a => iatas.has(a.icao));
  console.log(`Updating ${toUpdate.length} airports in batches...`);

  // CASE-based batch update — portable across SQLite (dev) and Postgres (prod)
  const BATCH = 500;
  let done = 0;

  for (let i = 0; i < toUpdate.length; i += BATCH) {
    const batch = toUpdate.slice(i, i + BATCH);
    const cases = batch.map(a => `WHEN '${a.icao}' THEN '${iatas.get(a.icao)}'`).join(' ');
    const inList = batch.map(a => `'${a.icao}'`).join(',');

    await prisma.$executeRawUnsafe(`
      UPDATE "Airport"
      SET iata = CASE icao ${cases} END
      WHERE icao IN (${inList})
    `);

    done += batch.length;
    console.log(`  ${done} / ${toUpdate.length}`);
  }

  const filled = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) AS n FROM "Airport" WHERE iata IS NOT NULL`
  );
  console.log('Rows with iata set:', filled[0].n);

  if (fs.existsSync(csvPath)) fs.unlinkSync(csvPath);
  await prisma.$disconnect();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
