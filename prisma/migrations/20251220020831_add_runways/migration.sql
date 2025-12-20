-- CreateTable
CREATE TABLE "Runway" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "airportIcao" TEXT NOT NULL,
    "ident1" TEXT NOT NULL,
    "ident2" TEXT NOT NULL,
    "lat1" REAL NOT NULL,
    "lon1" REAL NOT NULL,
    "lat2" REAL NOT NULL,
    "lon2" REAL NOT NULL,
    CONSTRAINT "Runway_airportIcao_fkey" FOREIGN KEY ("airportIcao") REFERENCES "Airport" ("icao") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Airport" (
    "icao" TEXT NOT NULL PRIMARY KEY,
    "lat" REAL NOT NULL,
    "lon" REAL NOT NULL,
    "elev" INTEGER
);
INSERT INTO "new_Airport" ("elev", "icao", "lat", "lon") SELECT "elev", "icao", "lat", "lon" FROM "Airport";
DROP TABLE "Airport";
ALTER TABLE "new_Airport" RENAME TO "Airport";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
