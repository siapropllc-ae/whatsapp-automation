-- Interactive message buttons: quick-reply/URL/call buttons on Template,
-- and button-tap tracking on Reply.
ALTER TABLE "Template" ADD COLUMN "buttons" JSONB;
ALTER TABLE "Reply" ADD COLUMN "buttonId" TEXT;
ALTER TABLE "Reply" ADD COLUMN "buttonLabel" TEXT;
CREATE INDEX "Reply_buttonId_idx" ON "Reply"("buttonId");
