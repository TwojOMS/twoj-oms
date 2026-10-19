import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { ENV_DEMO, wygenerujDaneDemo } from '../../../scripts/demo-dane.mjs';
import { wczytajRaporty } from '../../../src/moduly/raporty/konfiguracja.ts';
import { statystykiWOkresie } from '../../../src/domena/statystyki-okresu.js';
import { sprzedazWOkresieAsync, zwrotyWOkresie } from '../../../src/domena/sprzedaz-okresu.js';
import { rachunekOkresuAsync } from '../../../src/domena/rachunek-zarzadczy.js';
import { scalZamowienia } from '../../../src/oms/db/scalenia.js';
import { czyKanalAllegro } from '../../../src/domena/wysylka.js';

// PRZ-101.04 — scalenie jest LOGICZNE (bez kopiowania pozycji), więc Raporty, Statystyki
// i Finanse muszą dać po scaleniu DOKŁADNIE te same liczby. Test na danych demo (sklep Woo,
// Allegro, ręczne), dwa scalenia: „suma wysyłek” i „z zamówienia głównego”.
let db;
const { regulySprzedazy: reguly } = wczytajRaporty(ENV_DEMO);
const okres = { od: '2024-01-01', do: '2026-12-31' };
const zakres = { od: '2026-01-01', do: '2026-10-18' };
const opcje = { regulySprzedazy: reguly, podlogaKosztow: '2024-01' };

async function sumy() {
  return {
    sprzedaz: await sprzedazWOkresieAsync(db, okres, reguly),
    zwroty: zwrotyWOkresie(db, okres, reguly),
    statystyki: await statystykiWOkresie(db, okres, reguly),
    finanse: await rachunekOkresuAsync(db, zakres, opcje),
  };
}

beforeAll(() => {
  db = openOmsDb(':memory:', { moduly: modulyDla(ENV_DEMO) });
  wygenerujDaneDemo(db, { dzis: '2026-10-18', env: ENV_DEMO });
});
afterAll(() => db.close());

describe('scalenie nie zmienia sum raportów, statystyk ani finansów', () => {
  it('przed i po dwóch scaleniach — te same liczby', async () => {
    const kandydaci = db.prepare('SELECT id, sklep FROM zamowienia WHERE scalone_do IS NULL ORDER BY id').all()
      .filter((z) => !czyKanalAllegro(z));
    expect(kandydaci.length).toBeGreaterThanOrEqual(5);
    const przed = await sumy();
    // Sanity: sumy nie są puste (inaczej porównanie niczego by nie dowodziło).
    expect(przed.sprzedaz.length).toBeGreaterThan(0);
    scalZamowienia(db, { glowneId: kandydaci[0].id, dolaczoneIds: [kandydaci[1].id, kandydaci[2].id], wysylka: 'suma', kto: 'test' });
    scalZamowienia(db, { glowneId: kandydaci[3].id, dolaczoneIds: [kandydaci[4].id], wysylka: 'glowne', kto: 'test' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM zamowienia WHERE scalone_do IS NOT NULL').get().n).toBe(3);
    expect(await sumy()).toEqual(przed);
  });
});
