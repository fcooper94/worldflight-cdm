import fs from 'fs';
import csv from 'csv-parser';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  const rows = [];

  fs.createReadStream('./runways.csv')
    .pipe(csv())
    .on('data', row => rows.push(row))
    .on('end', async () => {
      console.log(`Importing ${rows.length} runways...`);

      for (const row of rows) {
        if (!row.le_ident || !row.he_ident || !row.airport_ident) continue;

        try {
          await prisma.runway.create({
            data: {
              airportIcao: row.airport_ident.toUpperCase(),
              ident1: row.le_ident,
              ident2: row.he_ident,
              lat1: parseFloat(row.le_latitude_deg),
              lon1: parseFloat(row.le_longitude_deg),
              lat2: parseFloat(row.he_latitude_deg),
              lon2: parseFloat(row.he_longitude_deg)
            }
          });
        } catch (e) {
          // Ignore duplicates / missing airports
        }
      }

      console.log('Runways seeded');
      await prisma.$disconnect();
    });
}

run();
