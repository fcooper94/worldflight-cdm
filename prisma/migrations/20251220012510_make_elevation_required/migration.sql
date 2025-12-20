/*
  Warnings:

  - Made the column `elev` on table `Airport` required. This step will fail if there are existing NULL values in that column.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Airport" (
    "icao" TEXT NOT NULL PRIMARY KEY,
    "lat" REAL NOT NULL,
    "lon" REAL NOT NULL,
    "elev" INTEGER NOT NULL
);
INSERT INTO "new_Airport" ("elev", "icao", "lat", "lon") SELECT "elev", "icao", "lat", "lon" FROM "Airport";
DROP TABLE "Airport";
ALTER TABLE "new_Airport" RENAME TO "Airport";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
