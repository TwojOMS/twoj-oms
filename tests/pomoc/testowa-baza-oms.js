import { readFileSync } from 'node:fs';
import { otworzBaze } from '../../src/core/baza.ts';

// Adapter testowy starej nazwy fabryki, na rzeczywistych migracjach rdzenia.
export function openOmsDb(sciezka = ':memory:') {
  const db = otworzBaze(sciezka);
  const sql = readFileSync(new URL('../../src/moduly/rdzen/migracje/0001-baseline.sql', import.meta.url), 'utf8');
  db.exec(sql.replace(/CREATE TABLE /g, 'CREATE TABLE IF NOT EXISTS ').replace(/CREATE (UNIQUE )?INDEX /g, 'CREATE $1INDEX IF NOT EXISTS '));
  return db;
}
