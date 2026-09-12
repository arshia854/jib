-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN "transferGroupId" TEXT;

-- CreateIndex
CREATE INDEX "Transaction_transferGroupId_idx" ON "Transaction"("transferGroupId");
