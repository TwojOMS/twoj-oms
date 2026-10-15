import type { DatabaseSync } from 'node:sqlite';
import type { ModulOms } from './kontrakty.ts';

const TABELA = 'CREATE TABLE IF NOT EXISTS uprawnienia_rozdane (klucz TEXT PRIMARY KEY, rozdane_at TEXT NOT NULL)';

/** Stare ptaszki ustawiali ludzie — oznaczenie chroni je przed ponownym rozdaniem. */
export function oznaczKluczeZamrozenia(db: DatabaseSync, klucze: readonly string[], teraz: () => Date): void {
  db.exec(TABELA);
  const wstaw = db.prepare('INSERT OR IGNORE INTO uprawnienia_rozdane (klucz, rozdane_at) VALUES (?, ?)');
  for (const k of klucze) wstaw.run(k, teraz().toISOString());
}

export function rozdajNoweUprawnienia(db: DatabaseSync, moduly: readonly ModulOms[], teraz: () => Date): string[] {
  db.exec(TABELA);
  const bylo = db.prepare('SELECT 1 FROM uprawnienia_rozdane WHERE klucz = ?');
  const wstaw = db.prepare('INSERT OR IGNORE INTO uprawnienia (konto_id, ekran) VALUES (?, ?)');
  const odnotuj = db.prepare('INSERT INTO uprawnienia_rozdane (klucz, rozdane_at) VALUES (?, ?)');
  const konta = db.prepare('SELECT id, rola FROM konta').all() as { id: number; rola: string }[];
  // PRZ-068: gdy są role w bazie, nowy klucz dostają także role wymienione w manifeście (bez mapowania nazw).
  const zRolami = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'role_ekrany'").get());
  const role = zRolami ? new Set((db.prepare('SELECT klucz FROM role').all() as { klucz: string }[]).map((r) => r.klucz)) : new Set<string>();
  const wstawRoli = zRolami ? db.prepare('INSERT OR IGNORE INTO role_ekrany (rola, ekran) VALUES (?, ?)') : null;
  const rozdane: string[] = [];
  for (const m of moduly) {
    for (const u of m.uprawnienia) {
      if (bylo.get(u.klucz)) continue;
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const k of konta) if (u.role.includes(k.rola)) wstaw.run(k.id, u.klucz);
        for (const r of u.role) if (role.has(r)) wstawRoli!.run(r, u.klucz);
        odnotuj.run(u.klucz, teraz().toISOString());
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      rozdane.push(u.klucz);
    }
  }
  return rozdane;
}
