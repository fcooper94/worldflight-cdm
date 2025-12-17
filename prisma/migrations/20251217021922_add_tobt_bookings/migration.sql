-- CreateTable
CREATE TABLE "TobtBooking" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "slotKey" TEXT NOT NULL,
    "cid" INTEGER NOT NULL,
    "callsign" TEXT NOT NULL,
    "from" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "dateUtc" TEXT NOT NULL,
    "depTimeUtc" TEXT NOT NULL,
    "tobtTimeUtc" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "TobtBooking_slotKey_key" ON "TobtBooking"("slotKey");
