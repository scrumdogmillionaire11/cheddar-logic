-- WI-0829: Extend clv_entries with residual column for residual projection validation.
-- residual = modelFairLine - consensusLine at time of card write.
ALTER TABLE clv_entries ADD COLUMN residual REAL;
