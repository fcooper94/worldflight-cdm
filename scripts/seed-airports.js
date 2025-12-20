import fs from 'fs';
import csv from 'csv-parser';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  const airports = [];

  fs.createReadStream('airports.csv')
    .pipe(csv())
    .on('data', row => {
      if (
        row.ident &&
        row.ident.length === 4 &&
        row.latitude_deg &&
        row.longitude_deg
      ) {
        airports.push({
  icao: row.ident.toUpperCase(),
  lat: parseFloat(row.latitude_deg),
  lon: parseFloat(row.longitude_deg),
  elev: parseInt(row.elevation_ft || '0', 10)
});

      }
    })
    .on('end', async () => {
      for (const a of airports) {
        await prisma.airport.upsert({
  where: { icao: a.icao },
  update: {
    elev: a.elev
  },
  create: a
});

      }

      console.log(`Seeded ${airports.length} airports`);
      await prisma.$disconnect();
    });
}

run();
