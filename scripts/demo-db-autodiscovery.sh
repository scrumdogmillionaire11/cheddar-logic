#!/bin/bash
# Demo: Database Auto-Discovery
# Shows how CHEDDAR_DATA_DIR finds databases with card_payloads and prefers -prod

set -euo pipefail

DEMO_DIR="/tmp/cheddar-db-autodiscovery-demo"
rm -rf "$DEMO_DIR"
mkdir -p "$DEMO_DIR"

echo "=== Database Auto-Discovery Demo ==="
echo ""
echo "Creating test databases in: $DEMO_DIR"
echo ""

# Create test databases using Node.js and sql.js
cd /Users/ajcolubiale/projects/cheddar-logic
node <<'EOF'
const initSqlJs = require('./packages/data/node_modules/sql.js/dist/sql-asm.js');
const fs = require('fs');
const path = require('path');

const demoDir = '/tmp/cheddar-db-autodiscovery-demo';

async function createDatabases() {
  const SQL = await initSqlJs();
  
  // Create databases
  const databases = [
    { name: 'legacy.db', hasCardPayloads: false },
    { name: 'cheddar-test.db', hasCardPayloads: true },
    { name: 'cheddar-prod.db', hasCardPayloads: true },
    { name: 'backup-2026-03-06.db', hasCardPayloads: true }
  ];
  
  for (const { name, hasCardPayloads } of databases) {
    const db = new SQL.Database();
    db.run('CREATE TABLE games (game_id TEXT PRIMARY KEY);');
    db.run("INSERT INTO games VALUES ('test-game-1');");
    
    if (hasCardPayloads) {
      db.run(`
        CREATE TABLE card_payloads (
          id TEXT PRIMARY KEY,
          game_id TEXT NOT NULL,
          sport TEXT NOT NULL,
          card_type TEXT NOT NULL,
          payload_data TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
      db.run("INSERT INTO card_payloads VALUES ('card-1', 'test-game-1', 'NHL', 'score', '{}', '2026-03-06');");
      console.log(`✓ Created ${name} (WITH card_payloads)`);
    } else {
      console.log(`✓ Created ${name} (without card_payloads)`);
    }
    
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(path.join(demoDir, name), buffer);
    db.close();
  }
}

createDatabases().catch(err => {
  console.error('Error creating databases:', err);
  process.exit(1);
});
EOF

echo ""
echo "=== Testing Auto-Discovery ==="
echo ""

# Test the auto-discovery
RESULT=$(CHEDDAR_DATA_DIR="$DEMO_DIR" node -e "
const { resolveDatabasePath } = require('./packages/data/src/db-path');
const result = resolveDatabasePath();
console.log(JSON.stringify(result, null, 2));
")

echo "Result:"
echo "$RESULT"
echo ""

SELECTED_DB=$(echo "$RESULT" | grep '"dbPath":' | sed 's/.*": "//;s/",$//')
SELECTED_NAME=$(basename "$SELECTED_DB")

echo "=== Expected Behavior ==="
echo "Should select: cheddar-prod.db (has card_payloads AND contains '-prod')"
echo "Actually selected: $SELECTED_NAME"
echo ""

if [ "$SELECTED_NAME" = "cheddar-prod.db" ]; then
  echo "✅ SUCCESS: Auto-discovery correctly preferred -prod database!"
else
  echo "❌ FAILED: Expected cheddar-prod.db but got $SELECTED_NAME"
  rm -rf "$DEMO_DIR"
  exit 1
fi

echo ""
echo "=== Cleanup ==="
rm -rf "$DEMO_DIR"
echo "✓ Removed test directory"
