-- CreateTable
CREATE TABLE "DepFlow" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "sector" TEXT NOT NULL,
    "rate" INTEGER NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "DepFlow_sector_key" ON "DepFlow"("sector");
