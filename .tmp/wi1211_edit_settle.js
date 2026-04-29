const fs = require('fs');

const path = 'apps/worker/src/jobs/settle_pending_cards.js';
let s = fs.readFileSync(path, 'utf8');

const old1 = "function hasTableColumn(db, tableName, columnName) {\n  if (!db || !tableName || !columnName) return false;\n  try {\n    const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();\n    return columns.some(\n      (column) =>\n        String(column?.name || '').trim().toLowerCase() ===\n        String(columnName).trim().toLowerCase(),\n    );\n  } catch {\n    return false;\n  }\n}\n";

const repl1 = old1 + "\nconst SETTLEMENT_DISPLAY_EXEMPT_CARD_TYPES = Object.freeze([]);\n\nfunction isDisplayExemptSettlementCardType(cardType) {\n  if (!cardType) return false;\n  const normalized = String(cardType).trim().toLowerCase();\n  return SETTLEMENT_DISPLAY_EXEMPT_CARD_TYPES.includes(normalized);\n}\n\nfunction hasSettlementGradingContract(row, payloadData = null) {\n  if (row?.market_key !== null && row?.market_key !== undefined) {\n    return true;\n  }\n\n  if (isNhlShotsOnGoalCard(row, payloadData)) {\n    return true;\n  }\n\n  if (isMlbPitcherKRow(row, payloadData)) {\n    return true;\n  }\n\n  return false;\n}\n";

if (!s.includes(old1)) throw new Error('old1 not found');
s = s.replace(old1, repl1);

const old2 = "        WHERE cr.status = 'pending'\n          AND (\n            (\n              cdl.pick_id IS NOT NULL\n              AND (\n                cr.market_key IS NOT NULL\n                OR (\n                  UPPER(COALESCE(cr.sport, cp.sport, '')) = 'NHL'\n                  AND LOWER(\n                    COALESCE(\n                      json_extract(cp.payload_data, '$.play.prop_type'),\n                      json_extract(cp.payload_data, '$.prop_type'),\n                      ''\n                    )\n                  ) = 'shots_on_goal'\n                )\n              )\n            )\n            OR LOWER(COALESCE(cr.card_type, cp.card_type, '')) = 'mlb-pitcher-k'\n          )\n          AND gr.status = 'final'";

const repl2 = "        WHERE cr.status = 'pending'\n          AND (\n            cdl.pick_id IS NOT NULL\n            OR isDisplayExemptSettlementCardType(COALESCE(cr.card_type, cp.card_type, NULL))\n          )\n          AND gr.status = 'final'";

if (!s.includes(old2)) throw new Error('old2 not found');
s = s.replace(old2, repl2);

const old3 = "        const isNhlShotsCard = isNhlShotsOnGoalCard(pendingCard, payloadData);\n        const isMlbPitcherK = isMlbPitcherKRow(pendingCard, payloadData);\n";

const repl3 = "        const isNhlShotsCard = isNhlShotsOnGoalCard(pendingCard, payloadData);\n        const isMlbPitcherK = isMlbPitcherKRow(pendingCard, payloadData);\n\n        if (!hasSettlementGradingContract(pendingCard, payloadData)) {\n          cardsSkipped++;\n          console.log(\n            '[SettleCards] Skipping row without settlement grading contract ' + pendingCard.card_id + ' (' + pendingCard.result_id + ')',\n          );\n          continue;\n        }\n";

if (!s.includes(old3)) throw new Error('old3 not found');
s = s.replace(old3, repl3);

const old4 = "    isProjectionOnlyF5Row,\n    isProjectionAuditOnlyBlkRow,\n    isProjectionOnlyNoMarketKeyRow,\n    shouldEnableDisplayBackfill,";

const repl4 = "    isProjectionOnlyF5Row,\n    isProjectionAuditOnlyBlkRow,\n    isProjectionOnlyNoMarketKeyRow,\n    SETTLEMENT_DISPLAY_EXEMPT_CARD_TYPES,\n    isDisplayExemptSettlementCardType,\n    hasSettlementGradingContract,\n    shouldEnableDisplayBackfill,";

if (!s.includes(old4)) throw new Error('old4 not found');
s = s.replace(old4, repl4);

fs.writeFileSync(path, s);
console.log('patched settle_pending_cards.js');
