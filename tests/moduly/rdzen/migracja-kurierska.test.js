import { it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { wykonajMigracje } from '../../../src/core/baza.ts';
import { dopiszKlienta } from '../../../src/oms/db/klienci.js';
import { zalozZamowienieReczne } from '../../../src/moduly/zamowienia/services/zamowienie-reczne.js';
import { pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { przypiszDoOkresu } from '../../../src/moduly/faktury/services/okres.js';
import { pozycjeOkresu } from '../../../src/moduly/faktury/services/faktura-okresu.js';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { ENV_DEMO, wygenerujDaneDemo } from '../../../scripts/demo-dane.mjs';
import { mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

it('0015 przenosi dwie kurierskie w formacie złotych, raz i bez usuwania starej kolumny', () => {
  const db = openOmsDb(':memory:', { moduly: [{ ...modulRdzen, migracje: modulRdzen.migracje.filter(m => m.numer !== 15) }] });
  for (const [i, kwota] of [1900, 1600, null].entries()) dopiszKlienta(db, {
    klucz: `polcien-${i}`, nazwa: `Półcień ${i}`, aktywny: 1, koszt_dostawy_brutto: i === 2 ? '7.50' : '0.00', oplata_kurierska_gr: kwota,
    b2b: 1, rabat_procent: 0, chce_fakture: 1, metoda_wysylki: 'dpd', platnosc: 'przelew',
  });
  const mig = modulRdzen.migracje.find(m => m.numer === 15);
  expect(mig).toBeDefined();
  expect(wykonajMigracje(db, [modulRdzen]).map(m => m.numer)).toEqual([15]);
  const kwoty = () => db.prepare('SELECT koszt_dostawy_brutto, oplata_kurierska_gr FROM klienci ORDER BY id').all();
  expect(kwoty()).toEqual([
    { koszt_dostawy_brutto: '19.00', oplata_kurierska_gr: 1900 },
    { koszt_dostawy_brutto: '16.00', oplata_kurierska_gr: 1600 },
    { koszt_dostawy_brutto: '7.50', oplata_kurierska_gr: null },
  ]);
  db.prepare("UPDATE klienci SET koszt_dostawy_brutto = '25.00' WHERE klucz = 'polcien-0'").run();
  const po = kwoty();
  mig.wykonaj(db);
  expect(wykonajMigracje(db, [modulRdzen])).toEqual([]);
  expect(kwoty()).toEqual(po);
  db.close();
});

it('po migracji okres zawiera Dostawę 19 zł pod progiem i nie zawiera kurierskiej', () => {
  const db = openOmsDb(':memory:', { moduly: [{ ...modulRdzen, migracje: modulRdzen.migracje.filter(m => m.numer !== 15) }] });
  try {
    dopiszKlienta(db, { klucz: 'polcien', nazwa: 'Pracownia Półcień', nip: '1234500011', aktywny: 1,
      b2b: 1, rabat_procent: 0, chce_fakture: 1, metoda_wysylki: 'dpd', platnosc: 'przelew',
      rozliczenie_zbiorcze: 1, koszt_dostawy_brutto: '0.00', oplata_kurierska_gr: 1900,
      prog_darmowej_dostawy_gr: 50000, oplata_obslugi_gr: 0 });
    wykonajMigracje(db, [modulRdzen]);
    const znacznik = '2026-11-13T10:00:00Z';
    const okresId = przypiszDoOkresu({ db, nip: '1234500011', dataZlozenia: znacznik, hurt: false });
    expect(okresId).toBeTypeOf('number');
    const klient = db.prepare('SELECT * FROM klienci').get();
    const zamowienia = ['499.99', '500.00'].map(cena => {
      const { id } = zalozZamowienieReczne({ db, znacznik, okresId,
        dane: { nip: klient.nip, klient: {}, dostawa: {}, metoda_wysylki: 'dpd', koszt_dostawy_brutto: klient.koszt_dostawy_brutto,
          pozycje: [{ nazwa: 'Lampa', ilosc: 1, cena_brutto: cena, brutto_linii: cena }] } });
      return pobierzZamowienie(db, id);
    });
    expect(zamowienia.map(z => z.okres_rozliczeniowy_id)).toEqual([okresId, okresId]);
    expect(zamowienia.map(z => z.koszt_dostawy_brutto)).toEqual(['19.00', '0.00']);
    const faktura = pozycjeOkresu(zamowienia, { stawkaDomyslna: '23' });
    expect(faktura.filter(p => p.name === 'Dostawa')).toEqual([{ name: 'Dostawa', quantity: 1, gross_price: 1900, tax_symbol: '23' }]);
    expect(faktura.map(p => p.name)).not.toContain('Usługa kurierska');
  } finally { db.close(); }
});

it('kopia starej bazy demo: kwoty dostawy klientów pozostają takie same', () => {
  const katalog = mkdtempSync(join(tmpdir(), 'p203-demo-'));
  const plik = join(katalog, 'przed.sqlite');
  const kopia = join(katalog, 'kopia.sqlite');
  const moduly = modulyDla(ENV_DEMO);
  let db;
  try {
    db = openOmsDb(plik, { moduly: moduly.map(m => m.nazwa === 'rdzen' ? { ...m, migracje: m.migracje.filter(x => x.numer !== 15) } : m) });
    wygenerujDaneDemo(db, { dzis: '2026-11-13', env: ENV_DEMO });
    // Odtworzenie pola dawnego generatora; nowy generator już nie zapisuje kurierskiej.
    db.exec('UPDATE klienci SET oplata_kurierska_gr = CAST(ROUND(CAST(koszt_dostawy_brutto AS REAL) * 100) AS INTEGER) WHERE rozliczenie_zbiorcze = 1');
    const przed = db.prepare('SELECT id, koszt_dostawy_brutto FROM klienci ORDER BY id').all();
    const ile = db.prepare('SELECT COUNT(*) AS ile FROM klienci WHERE oplata_kurierska_gr IS NOT NULL').get().ile;
    expect(ile).toBeGreaterThan(0);
    db.close(); db = null;
    copyFileSync(plik, kopia);
    db = openOmsDb(kopia, { moduly });
    const po = db.prepare('SELECT id, koszt_dostawy_brutto FROM klienci ORDER BY id').all();
    expect(po).toEqual(przed);
    console.log('Kopia demo:', JSON.stringify({ klienci: przed.length, przeniesieni: ile, przed, po }));
  } finally { db?.close(); rmSync(katalog, { recursive: true, force: true }); }
});
