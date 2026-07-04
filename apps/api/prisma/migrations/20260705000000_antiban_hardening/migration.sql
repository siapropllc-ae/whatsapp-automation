-- Anti-ban hardening: stranger sub-cap counter + circuit-breaker failure counter
ALTER TABLE "Session" ADD COLUMN "strangerSent" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Session" ADD COLUMN "consecutiveFailures" INTEGER NOT NULL DEFAULT 0;
