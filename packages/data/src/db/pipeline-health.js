'use strict';
// Read surface for WI-0761: Model Health Dashboard
// Table: pipeline_health (written exclusively by apps/worker/src/jobs/check_pipeline_health.js)
// Schema: id, phase, check_name, status ('ok'|'warning'|'failed'), reason, created_at

const { getDatabase } = require('./connection');

/**
 * Get the most recent pipeline_health rows, newest first.
 *
 * @param {number} [limit=50] - Max rows to return
 * @returns {{ id: number, phase: string, check_name: string, status: string, reason: string|null, created_at: string }[]}
 */
function getPipelineHealth(limit = 50) {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT id, phase, check_name, status, reason, created_at
    FROM pipeline_health
    ORDER BY created_at DESC
    LIMIT ?
  `);
  return stmt.all(limit);
}

module.exports = { getPipelineHealth };
