-- CreateIndex
CREATE INDEX "Transaction_userId_accountId_type_amount_idx" ON "Transaction"("userId", "accountId", "type", "amount");
