import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { ENV_DEMO } from '../../../scripts/demo-dane.mjs';
import { wczytajRaporty } from '../../../src/moduly/raporty/konfiguracja.ts';
import { rachunekOkresuAsync } from '../../../src/domena/rachunek-zarzadczy.js';
import { sprzedazWOkresieAsync } from '../../../src/domena/sprzedaz-okresu.js';
import { idZamowienWOkresie } from '../../../src/oms/db/okno-zamowien.js';
import { rachunekOkresu as staryRachunek } from '../../pomoc/skala-referencja/rachunek-zarzadczy.js';

const { regulySprzedazy } = wczytajRaporty(ENV_DEMO);
const zakres = { od: '2026-01-01', do: '2026-03-31' };
function przygotuj(plik = ':memory:') {
  const db = openOmsDb(plik, { moduly: modulyDla(ENV_DEMO) });
  for (const kanal of regulySprzedazy.klasyfikacja.raporty) {
    db.prepare('INSERT INTO granice_historii(kanal,do_dnia,zrodlo) VALUES (?,?,?)')
      .run(kanal, '2023-12-31', 'test');
  }
  const dodaj = db.prepare(`INSERT INTO zamowienia(sklep,zrodlo_id,numer,utworzone_at,kwota_brutto)
    VALUES ('reczne',?,?,?,'100.00')`);
  db.exec('BEGIN');
  for (let i = 1; i <= 1500; i++) dodaj.run(i, `TEST-${i}`, `2026-0${1 + i % 3}-15T12:00:00Z`);
  db.exec('COMMIT');
  return { db, dodaj };
}

describe('PRZ-094.13 — spójny rachunek i zamknięte kursory', () => {
  it('obsługuje również bazę samego rdzenia bez modułowego indeksu daty', () => {
    const db = openOmsDb(':memory:');
    try { expect([...idZamowienWOkresie(db, zakres.od, zakres.do)]).toEqual([]); }
    finally { db.close(); }
  });
  it('czyta sprzedaż jednym przebiegiem dla okresu, roku i miesięcy', async () => {
    const { db } = przygotuj();
    let odczytow = 0;
    const baza = { prepare(sql) {
      if (sql.includes('kwota_brutto') && sql.includes('FROM zamowienia')) odczytow += 1;
      return db.prepare(sql);
    } };
    try {
      await rachunekOkresuAsync(baza, zakres, { regulySprzedazy, podlogaKosztow: '2024-01' });
      expect(odczytow).toBe(1);
    } finally { db.close(); }
  });
  it.each([
    { od: '2026-01-01', do: '2026-03-10' },
    { od: '2025-12-20', do: '2026-03-10' },
  ])('nie zmienia rozbicia pełnych miesięcy przy niepełnym zakresie $od — $do', async (zakres) => {
    const { db, dodaj } = przygotuj();
    dodaj.run(3000, 'PRZED-OKRESEM', '2025-12-15T12:00:00Z');
    const opcje = { regulySprzedazy, podlogaKosztow: '2024-01' };
    try {
      expect(await rachunekOkresuAsync(db, zakres, opcje)).toEqual(staryRachunek(db, zakres, opcje));
    } finally { db.close(); }
  });
  it('przychód okresu jest sumą miesięcy mimo dopisywania zamówień między porcjami', async () => {
    const { db, dodaj } = przygotuj();
    let pracuje = true;
    let dopisanych = 0;
    let kolejny;
    const poller = () => {
      if (!pracuje || dopisanych >= 8) return;
      dopisanych += 1;
      dodaj.run(2000 + dopisanych, `POLLER-${dopisanych}`, '2026-02-15T12:00:00Z');
      kolejny = setImmediate(poller);
    };
    kolejny = setImmediate(poller);
    try {
      const wynik = await rachunekOkresuAsync(db, zakres, { regulySprzedazy, podlogaKosztow: '2024-01' });
      expect(dopisanych).toBeGreaterThan(0);
      expect(wynik.miesiacami.reduce((s, m) => s + m.przychodNettoGrosze, 0))
        .toBe(wynik.przychodNettoGrosze);
    } finally { pracuje = false; clearImmediate(kolejny); db.close(); }
  });

  it.each(['id', 'sprzedaz'])('po oddaniu porcji %s odczyt nie blokuje zapisu po zmianie WAL przez inny proces', async (tryb) => {
    const katalogGlowny = path.join(process.cwd(), 'dane-lokalne');
    fs.mkdirSync(katalogGlowny, { recursive: true });
    const katalog = fs.mkdtempSync(path.join(katalogGlowny, 'test-kursor-'));
    const plik = path.join(katalog, 'oms.sqlite');
    const { db } = przygotuj(plik);
    const porcje = idZamowienWOkresie(db, zakres.od, zakres.do);
    let sprzedaz;
    try {
      if (tryb === 'id') expect(porcje.next().value).toHaveLength(500);
      else {
        sprzedaz = sprzedazWOkresieAsync(db, zakres, regulySprzedazy);
        await new Promise(resolve => setImmediate(resolve));
      }
      const r = spawnSync(process.execPath, ['tests/pomoc/skala-zapis-innego-procesu.mjs', plik], { encoding: 'utf8', windowsHide: true });
      expect(r.status, r.stderr).toBe(0);
      expect(() => db.prepare("UPDATE zamowienia SET uwagi = 'poller aplikacji' WHERE id = 2").run()).not.toThrow();
    } finally {
      porcje.return();
      if (sprzedaz) await sprzedaz;
      db.close();
      fs.rmSync(katalog, { recursive: true, force: true });
    }
  });
  it('rzeczywisty plan stronicowania id nadal korzysta z indeksu daty bez SCAN', () => {
    const { db } = przygotuj();
    let plan;
    const baza = { prepare(sql) {
      if (sql.includes('FROM zamowienia')) {
        plan = db.prepare('EXPLAIN QUERY PLAN ' + sql).all(zakres.od, zakres.do, 0).map(w => w.detail).join('\n');
      }
      return db.prepare(sql);
    } };
    const porcje = idZamowienWOkresie(baza, zakres.od, zakres.do);
    try {
      expect(porcje.next().value).toHaveLength(500);
      expect(plan).toContain('zamowienia_julianday_utworzenia');
      expect(plan).not.toMatch(/SCAN/);
    } finally { porcje.return(); db.close(); }
  });
});
