import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';

const katalogi: string[] = [];
const bazy: ReturnType<typeof openOmsDb>[] = [];
const open = (path?: string) => { const db = openOmsDb(path); bazy.push(db); return db; };
const plik = () => {
  const katalog = mkdtempSync(join(tmpdir(), 'koszty-neutralne-')); katalogi.push(katalog);
  return join(katalog, 'oms.sqlite');
};
afterEach(() => {
  for (const db of bazy.splice(0)) if (db.isOpen) db.close();
  for (const katalog of katalogi.splice(0)) {
    const cel = resolve(katalog);
    if (dirname(cel) !== resolve(tmpdir()) || !basename(cel).startsWith('koszty-neutralne-')) throw new Error('Nieprawidłowy katalog fixture');
    rmSync(cel, { recursive: true, force: true });
  }
});
describe('PRZ-025 neutralna inicjalizacja danych kosztów', () => {
  it('świeża baza nie narzuca NIP ani firm, udostępnia 11 neutralnych kategorii', () => {
    const db = open();
    try {
      expect(db.prepare('SELECT count(*) n FROM kategorie_kosztow').get()?.n).toBe(0);
      expect(db.prepare('SELECT count(*) n FROM firmy_reczne').get()?.n).toBe(0);
      expect(db.prepare('SELECT count(*) n FROM slownik_kategorii_kosztow').get()?.n).toBe(11);
    } finally { db.close(); }
  });
  it('reopen zachowuje przypisania, dostawcę i typ kategorii wybrany przez człowieka', () => {
    const path = plik(); const db = open(path);
    db.prepare("UPDATE slownik_kategorii_kosztow SET typ='drobne' WHERE kategoria='Reklama'").run();
    db.prepare('INSERT INTO kategorie_kosztow VALUES (?,?,?,?)').run('1111111111', 'Własna', 'staly', '2026-10-01');
    db.prepare('INSERT INTO firmy_reczne VALUES (?,?,?,?,?)').run('Fixture', 'Fixture Spółka', 'Własna', 'staly', '2026-10-01');
    db.close(); const po = open(path);
    try {
      expect(po.prepare("SELECT typ FROM slownik_kategorii_kosztow WHERE kategoria='Reklama'").get()?.typ).toBe('drobne');
      expect(po.prepare("SELECT kategoria FROM kategorie_kosztow WHERE nip='1111111111'").get()?.kategoria).toBe('Własna');
      expect(po.prepare("SELECT sprzedawca FROM firmy_reczne WHERE nazwa='Fixture'").get()?.sprzedawca).toBe('Fixture Spółka');
      expect(po.prepare('SELECT count(*) n FROM kategorie_kosztow').get()?.n).toBe(1);
      expect(po.prepare('SELECT count(*) n FROM firmy_reczne').get()?.n).toBe(1);
    } finally { po.close(); }
  });
  it('jednorazowy rename migruje stary Hosting i nie cofa późniejszej decyzji', () => {
    const path = plik(); const db = open(path);
    db.prepare("DELETE FROM migracje_jednorazowe WHERE nazwa='kategorie-kosztow/hosting-i-domeny'").run();
    db.prepare('INSERT INTO kategorie_kosztow VALUES (?,?,?,?)').run('1111111111', 'Hosting', 'staly', '2026-10-01');
    db.prepare('INSERT INTO kategorie_kosztow VALUES (?,?,?,?)').run('2222222222', 'Serwery', 'drobne', '2026-10-01');
    db.close(); const po = open(path);
    expect(po.prepare("SELECT kategoria FROM kategorie_kosztow WHERE nip='1111111111'").get()?.kategoria).toBe('Hosting i domeny');
    expect(po.prepare("SELECT kategoria FROM kategorie_kosztow WHERE nip='2222222222'").get()?.kategoria).toBe('Serwery');
    po.prepare("UPDATE kategorie_kosztow SET kategoria='Hosting' WHERE nip='1111111111'").run();
    po.close(); const jeszcze = open(path);
    try { expect(jeszcze.prepare("SELECT kategoria FROM kategorie_kosztow WHERE nip='1111111111'").get()?.kategoria).toBe('Hosting'); }
    finally { jeszcze.close(); }
  });
});
