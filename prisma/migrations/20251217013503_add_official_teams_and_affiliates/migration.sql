-- CreateTable
CREATE TABLE "OfficialTeam" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "teamName" TEXT NOT NULL,
    "callsign" TEXT NOT NULL,
    "mainCid" INTEGER NOT NULL,
    "aircraftType" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "participatingWf26" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Affiliate" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "callsign" TEXT NOT NULL,
    "simType" TEXT NOT NULL,
    "cid" INTEGER NOT NULL,
    "participatingWf26" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
