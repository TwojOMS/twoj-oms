import { describe, it, expect } from 'vitest';
import {
  POLA_HURTU,
  polecenieZFormularza,
  polaDoPrzeniesienia,
  zmianyHurtem,
} from '../../../src/domena/magazyn-hurt.js';
import { dzienWarszawa } from '../../../src/domena/format-daty.js';
import { dzienPolski } from '../../../src/domena/cena-zakupu.js';

// CENA ZAKUPU W EDYCJI HURTEM — część czysta (formularz → polecenie → plan podglądu).
// Cena zakupu nie jest kolumną karty, tylko wpisem w historii „obowiązuje od”, więc plan niesie ją
// osobnym polem `cenaZakupu`, a „stara” cena to ta, która obowiązuje w dniu `od` — podaje ją wołający
// mapą `cenyNaDzien` (id karty → grosze).

const DZIS = '2026-11-18';
const karta = (id, reszta = {}) => ({ id, nazwa: `Lampa Kopuła ${id}`, ...reszta });

describe('POLA_HURTU', () => {
  it('przenosi cenę zakupu i jej datę z listy do podglądu i z podglądu do zatwierdzenia', () => {
    expect(POLA_HURTU).toContain('cena_zakupu_netto');
    expect(POLA_HURTU).toContain('cena_zakupu_od');
    expect(polaDoPrzeniesienia({ cena_zakupu_netto: '13,10', cena_zakupu_od: '2026-12-01', sku: 'X' })).toEqual([
      { name: 'cena_zakupu_netto', value: '13,10' },
      { name: 'cena_zakupu_od', value: '2026-12-01' },
    ]);
  });
});

describe('polecenieZFormularza — cena zakupu', () => {
  it('puste pole ceny → polecenie bez cenaZakupu (także gdy data jest wpisana)', () => {
    expect(polecenieZFormularza({ cena_zakupu_netto: '' }, { dzis: DZIS })).toEqual({ polecenie: {}, blad: null });
    expect(polecenieZFormularza({ cena_zakupu_netto: '  ', cena_zakupu_od: '2026-12-01' }, { dzis: DZIS })).toEqual({
      polecenie: {},
      blad: null,
    });
    expect(polecenieZFormularza({}, { dzis: DZIS }).polecenie).not.toHaveProperty('cenaZakupu');
  });

  it('cena bez daty obowiązuje od dziś', () => {
    const { polecenie, blad } = polecenieZFormularza(
      { cena_zakupu_netto: '13,10', cena_zakupu_od: '' },
      { dzis: DZIS },
    );
    expect(blad).toBeNull();
    expect(polecenie.cenaZakupu).toEqual({ gr: 1310, od: DZIS });
  });

  it('„dziś” bez podanego dnia to dzień Warszawy', () => {
    const { polecenie } = polecenieZFormularza({ cena_zakupu_netto: '13.10' });
    expect(polecenie.cenaZakupu).toEqual({ gr: 1310, od: dzienWarszawa(new Date().toISOString()) });
  });

  it('cena z datą', () => {
    const { polecenie } = polecenieZFormularza(
      { cena_zakupu_netto: '0', cena_zakupu_od: '2026-12-01' },
      { dzis: DZIS },
    );
    expect(polecenie.cenaZakupu).toEqual({ gr: 0, od: '2026-12-01' });
  });

  it.each([
    ['zła kwota', { cena_zakupu_netto: 'dwanaście' }],
    ['trzecia cyfra po przecinku', { cena_zakupu_netto: '12,345' }],
    ['kwota ujemna', { cena_zakupu_netto: '-1' }],
    ['dzień spoza kalendarza', { cena_zakupu_netto: '13,10', cena_zakupu_od: '2026-02-30' }],
    ['cena przysłana dwa razy', { cena_zakupu_netto: ['13,10', '14,00'] }],
    ['data przysłana dwa razy', { cena_zakupu_netto: '13,10', cena_zakupu_od: ['2026-12-01', '2026-12-02'] }],
  ])('%s → odmowa całego polecenia, także pól obok', (_, pola) => {
    const { polecenie, blad } = polecenieZFormularza({ ...pola, paczkomat: 'tak', stawka_vat: '23' }, { dzis: DZIS });
    expect(polecenie).toBeNull();
    expect(blad).toMatch(/Cena zakupu|Obowiązuje od/);
  });
});

describe('zmianyHurtem — cena zakupu', () => {
  const polecenie = { cenaZakupu: { gr: 1310, od: DZIS } };
  const karty = [karta(1), karta(2), karta(3)];
  const ceny = new Map([
    [2, 1000],
    [3, 1310],
  ]);

  it('podgląd: brak ceny i inna cena wchodzą, ta sama nie', () => {
    const plan = zmianyHurtem(karty, polecenie, { cenyNaDzien: ceny });
    expect(plan.map((w) => w.id)).toEqual([1, 2]);
    const na = `13,10 zł od ${dzienPolski(DZIS)}`;
    expect(plan[0]).toEqual({
      id: 1,
      nazwa: 'Lampa Kopuła 1',
      zmiany: {},
      cenaZakupu: { gr: 1310, od: DZIS },
      opisy: [{ pole: 'Cena zakupu netto', z: null, na }],
    });
    expect(plan[1].opisy).toEqual([{ pole: 'Cena zakupu netto', z: '10,00 zł', na }]);
    expect(plan[1].cenaZakupu).toEqual({ gr: 1310, od: DZIS });
  });

  it('stara cena to ta obowiązująca w dniu `od` (mapa liczona na ten dzień) — równa → karta nie wchodzi', () => {
    const naPrzyszlosc = { cenaZakupu: { gr: 1200, od: '2099-06-01' } };
    const plan = zmianyHurtem([karta(7)], naPrzyszlosc, { cenyNaDzien: new Map([[7, 1200]]) });
    expect(plan).toEqual([]);
  });

  it('cena + stawka VAT razem w jednym wpisie planu', () => {
    const plan = zmianyHurtem(
      [karta(1, { stawka_vat: '8' }), karta(2, { stawka_vat: '23' }), karta(3, { stawka_vat: '23' })],
      { stawka_vat: '23', cenaZakupu: { gr: 1310, od: '2026-12-01' } },
      { cenyNaDzien: ceny },
    );
    expect(plan.map((w) => w.id)).toEqual([1, 2]);
    expect(plan[0].zmiany).toEqual({ stawka_vat: '23' });
    expect(plan[0].cenaZakupu).toEqual({ gr: 1310, od: '2026-12-01' });
    expect(plan[0].opisy).toEqual([
      { pole: 'Stawka VAT', z: '8%', na: '23%' },
      { pole: 'Cena zakupu netto', z: null, na: '13,10 zł od 01.12.2026' },
    ]);
    // Karta 2 ma już stawkę 23% — wchodzi wyłącznie z powodu ceny, bez zmian kolumn.
    expect(plan[1].zmiany).toEqual({});
    expect(plan[1].opisy).toEqual([{ pole: 'Cena zakupu netto', z: '10,00 zł', na: '13,10 zł od 01.12.2026' }]);
  });

  it('karta, której zmienia się tylko kolumna, nie dostaje pola cenaZakupu', () => {
    const plan = zmianyHurtem(
      [karta(3, { stawka_vat: '8' })],
      { stawka_vat: '23', cenaZakupu: { gr: 1310, od: DZIS } },
      { cenyNaDzien: ceny },
    );
    expect(plan).toHaveLength(1);
    expect(plan[0]).not.toHaveProperty('cenaZakupu');
    expect(plan[0].opisy).toEqual([{ pole: 'Stawka VAT', z: '8%', na: '23%' }]);
  });

  it('polecenie z ceną bez mapy cen → błąd programisty, nie cichy pominięty krok', () => {
    expect(() => zmianyHurtem(karty, polecenie)).toThrow(/cenyNaDzien/);
    expect(() => zmianyHurtem(karty, polecenie, {})).toThrow(/cenyNaDzien/);
  });

  it('polecenie bez ceny działa jak dotąd z dwoma argumentami', () => {
    const plan = zmianyHurtem([karta(1, { paczkomat: 'nie' })], { paczkomat: 'tak' });
    expect(plan).toEqual([
      {
        id: 1,
        nazwa: 'Lampa Kopuła 1',
        zmiany: { paczkomat: 'tak' },
        opisy: [{ pole: 'Paczkomat', z: 'nie', na: 'tak' }],
      },
    ]);
  });
});
