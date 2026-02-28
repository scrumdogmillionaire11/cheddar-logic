#!/usr/bin/env node

const crypto = require('crypto');
const db = require('../packages/data/src/db.js');

const email = process.argv[2];

if (!email) {
  console.error('Usage: node add-ambassador.js <email>');
  process.exit(1);
}

function makeId() {
  return crypto.randomBytes(16).toString('hex');
}

(async () => {
  await db.initDb();
  const conn = db.getDatabase();
  
  // Check if user exists
  let user = conn.prepare('SELECT * FROM users WHERE email = ?').get(email);
  
  if (!user) {
    // Create new user with AMBASSADOR flag
    const userId = makeId();
    const subscriptionId = makeId();
    
    conn.prepare(`
      INSERT INTO users (id, email, role, user_status, flags, ambassador_since)
      VALUES (?, ?, 'FREE_ACCOUNT', 'ACTIVE', json('["AMBASSADOR"]'), datetime('now'))
    `).run(userId, email);
    console.log('✅ Created new ambassador user:', email);
    
    // Create subscription for new user
    conn.prepare(`
      INSERT INTO subscriptions (id, user_id, plan_id, status)
      VALUES (?, ?, 'free', 'NONE')
    `).run(subscriptionId, userId);
    
    // Fetch the newly created user
    user = conn.prepare('SELECT * FROM users WHERE email = ?').get(email);
  } else {
    // Update existing user to add AMBASSADOR flag
    const currentFlags = JSON.parse(user.flags || '[]');
    if (!currentFlags.includes('AMBASSADOR')) {
      currentFlags.push('AMBASSADOR');
      conn.prepare(`
        UPDATE users 
        SET flags = ?, 
            ambassador_since = COALESCE(ambassador_since, datetime('now')),
            user_status = 'ACTIVE'
        WHERE email = ?
      `).run(JSON.stringify(currentFlags), email);
      console.log('✅ Updated existing user to ambassador:', email);
      // Refresh user data
      user = conn.prepare('SELECT * FROM users WHERE email = ?').get(email);
    } else {
      console.log('ℹ️  User already has AMBASSADOR flag');
    }
    
    // Ensure subscription exists for existing user
    const existingSub = conn.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(user.id);
    if (!existingSub) {
      const subscriptionId = makeId();
      conn.prepare(`
        INSERT INTO subscriptions (id, user_id, plan_id, status)
        VALUES (?, ?, 'free', 'NONE')
      `).run(subscriptionId, user.id);
    }
  }
  
  if (!user || !user.id) {
    console.error('❌ Failed to retrieve user after insert/update');
    process.exit(1);
  }
  
  // Display final state
  const finalUser = conn.prepare(`
    SELECT u.email, u.role, u.user_status, u.flags, u.ambassador_since, u.ambassador_expires_at,
           s.status as sub_status, s.plan_id
    FROM users u
    LEFT JOIN subscriptions s ON s.user_id = u.id
    WHERE u.email = ?
  `).get(email);
  
  console.log('\n📋 Ambassador Account Details:');
  console.log(JSON.stringify(finalUser, null, 2));
  console.log('\n✨ Access granted to: CHEDDAR_BOARD (/cards) + FPL_SAGE (/fpl)');
})();
