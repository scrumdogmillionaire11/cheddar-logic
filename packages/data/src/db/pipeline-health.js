'use strict';
// Read surface for WI-0761: Model Health Dashboard
// Table: pipeline_health (written exclusively by apps/worker/src/jobs/check_pipeline_health.js)
// Schema: id, phase, check_name, status ('ok'|'warning'|'failed'), reason, created_at

const { getDatabase } = require('./connection');

const DEGRADED_STATUSES = new Set(['failed', 'warning']);

function slugifyToken(value, fallback) {
  const token = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return token || fallback;
}

function buildPipelineHealthCheckId(phase, checkName) {
  return `${slugifyToken(phase, 'unknown')}:${slugifyToken(checkName, 'check')}`;
}

function normalizeStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'ok' || normalized === 'warning' || normalized === 'failed') {
    return normalized;
  }
  return 'warning';
}

function defaultDedupeKey(status, reason) {
  return `${status}:${String(reason || '').trim()}`;
}

/**
 * Write pipeline health row with one-active-condition semantics.
 *
 * - failed/warning: maintain a single active degraded row per check_id
 * - ok: resolve active degraded row and append an informational ok row
 */
function writePipelineHealthState({ phase, checkName, status, reason, checkId, dedupeKey, createdAt }) {
  const db = getDatabase();
  const normalizedStatus = normalizeStatus(status);
  const nowIso = createdAt || new Date().toISOString();
  const resolvedCheckId = checkId || buildPipelineHealthCheckId(phase, checkName);

  const findActiveStmt = db.prepare(
    `SELECT id, status, dedupe_key, first_seen_at, last_seen_at
     FROM pipeline_health
     WHERE check_id = ?
       AND resolved_at IS NULL
     ORDER BY id DESC
     LIMIT 1`,
  );
  const resolveActiveStmt = db.prepare(
    `UPDATE pipeline_health
     SET resolved_at = ?, last_seen_at = ?
     WHERE check_id = ?
       AND resolved_at IS NULL`,
  );
  const insertStmt = db.prepare(
    `INSERT INTO pipeline_health
      (phase, check_name, status, reason, created_at, check_id, dedupe_key, first_seen_at, last_seen_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateActiveStmt = db.prepare(
    `UPDATE pipeline_health
     SET status = ?, reason = ?, last_seen_at = ?
     WHERE id = ?`,
  );

  const tx = db.transaction(() => {
    const activeRow = findActiveStmt.get(resolvedCheckId) || null;

    if (!DEGRADED_STATUSES.has(normalizedStatus)) {
      if (activeRow && DEGRADED_STATUSES.has(String(activeRow.status || '').toLowerCase())) {
        resolveActiveStmt.run(nowIso, nowIso, resolvedCheckId);
      }

      insertStmt.run(
        phase,
        checkName,
        normalizedStatus,
        reason,
        nowIso,
        resolvedCheckId,
        null,
        nowIso,
        nowIso,
        nowIso,
      );
      return;
    }

    const resolvedDedupeKey = dedupeKey || defaultDedupeKey(normalizedStatus, reason);
    if (!activeRow) {
      insertStmt.run(
        phase,
        checkName,
        normalizedStatus,
        reason,
        nowIso,
        resolvedCheckId,
        resolvedDedupeKey,
        nowIso,
        nowIso,
        null,
      );
      return;
    }

    const activeStatus = String(activeRow.status || '').toLowerCase();
    const activeDedupe = String(activeRow.dedupe_key || '');
    const sameCondition = activeStatus === normalizedStatus && activeDedupe === resolvedDedupeKey;

    if (sameCondition) {
      updateActiveStmt.run(normalizedStatus, reason, nowIso, activeRow.id);
      return;
    }

    resolveActiveStmt.run(nowIso, nowIso, resolvedCheckId);
    insertStmt.run(
      phase,
      checkName,
      normalizedStatus,
      reason,
      nowIso,
      resolvedCheckId,
      resolvedDedupeKey,
      nowIso,
      nowIso,
      null,
    );
  });

  tx();
}

/**
 * Get the most recent pipeline_health rows, newest first.
 *
 * @param {number} [limit=50] - Max rows to return
 * @returns {{ id: number, phase: string, check_name: string, status: string, reason: string|null, created_at: string }[]}
 */
function getPipelineHealth(limit = 50) {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT
      id,
      phase,
      check_name,
      status,
      reason,
      created_at,
      check_id,
      dedupe_key,
      first_seen_at,
      last_seen_at,
      resolved_at
    FROM pipeline_health
    ORDER BY COALESCE(last_seen_at, created_at) DESC, id DESC
    LIMIT ?
  `);
  return stmt.all(limit);
}

module.exports = {
  getPipelineHealth,
  writePipelineHealthState,
  buildPipelineHealthCheckId,
};
