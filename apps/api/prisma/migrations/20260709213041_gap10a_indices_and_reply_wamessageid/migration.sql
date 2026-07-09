-- AlterTable
ALTER TABLE "Reply" ADD COLUMN     "waMessageId" TEXT;

-- CreateIndex
CREATE INDEX "Session_proxyId_idx" ON "Session"("proxyId");

-- CreateIndex
CREATE INDEX "Campaign_templateId_idx" ON "Campaign"("templateId");

-- CreateIndex
CREATE UNIQUE INDEX "Reply_waMessageId_key" ON "Reply"("waMessageId");

-- CreateIndex
CREATE INDEX "Reply_campaignId_idx" ON "Reply"("campaignId");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_campaignId_idx" ON "AnalyticsEvent"("campaignId");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_sessionId_idx" ON "AnalyticsEvent"("sessionId");
