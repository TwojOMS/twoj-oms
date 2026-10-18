import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2]);
try {
  db.exec("PRAGMA busy_timeout = 1000; UPDATE zamowienia SET uwagi = 'poller innego procesu' WHERE id = 1");
} finally { db.close(); }
