/* eslint-disable @typescript-eslint/no-require-imports */
const dbBackup = require('./db-backup.js');

const backups = dbBackup.listBackups();
console.log('Recent backups:');
backups.forEach((f, i) => {
  const sizeMB = (f.stats.size / 1024 / 1024).toFixed(1);
  console.log(`  [${i}] ${f.name} (${sizeMB}MB)`);
});
console.log(`Total: ${backups.length} backups in ${dbBackup.getBackupDir()}`);
