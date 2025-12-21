-- CreateTable
CREATE TABLE "AirportScenery" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "icao" TEXT NOT NULL,
    "sim" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "developer" TEXT,
    "store" TEXT,
    "url" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "submittedBy" TEXT NOT NULL,
    "submittedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "approvedBy" TEXT,
    "approvedAt" DATETIME
);

-- CreateIndex
CREATE INDEX "AirportScenery_icao_idx" ON "AirportScenery"("icao");

-- CreateIndex
CREATE INDEX "AirportScenery_approved_idx" ON "AirportScenery"("approved");
