// PRZ-122.B07c — usługi faktur z flagą `zw` z programu fakturowego: faktura zamówienia (faktura.js), faktura okresu
// (faktura-okresu.js) i proforma (proforma.js). Program wbudowany (`opis.wbudowany === true`) → pozycja ręczna „zw”
// idzie na dokument jako „zw”, a zapisana domyślna „zw” (firma zwolniona) obejmuje też pozycje sklepowe i dostawę.
// Program inny (Testownik) → ładunek znak w znak jak przed zmianą (ręczna „zw” = stawka domyślna, domyślna „zw” = 23).
// Program to atrapa kontraktu (tests/pomoc/program-testowy.js), sieć nie jest używana. Dane zmyślone.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zapewnijOkres } from '../../../src/oms/db/okresy.js';
import { createFaktura } from '../../../src/moduly/faktury/services/faktura.js';
import { createFakturaOkresu, pozycjeOkresu } from '../../../src/moduly/faktury/services/faktura-okresu.js';
import { createProforma } from '../../../src/moduly/faktury/services/proforma.js';
import { zapiszStawkeDomyslna } from '../../../src/moduly/faktury/db/stawka-vat.js';
import { programTestowy } from '../../pomoc/program-testowy.js';

const NIP_PRACOWNI = '5250000009'; // zmyślony, z poprawną sumą kontrolną
const TERAZ = () => '2026-10-27T10:00:00.000Z';

function programWbudowany() {
  const p = programTestowy({ id: 'twojefaktury' });
  return { ...p, opis: Object.freeze({ ...p.opis, wbudowany: true }) };
}

// Zamówienie: pozycja sklepowa 2 × 61,50, dostawa 19,00 i pozycja ręczna „zw” 57,00 (kwota sklepu 142,00 + ręczna).
function bazaZZamowieniem({ zwolniona = false } = {}) {
  const db = openOmsDb(':memory:');
  if (zwolniona) zapiszStawkeDomyslna(db, 'zw', { zw: true });
  const id = zapiszZamowienie(db, 'pro', {
    zrodlo_id: 3301, numer: '3301',
    klient: { first_name: 'Ewa', last_name: 'Półcień', company: 'Pracownia Półcień', email: 'biuro@polcien.invalid',
      address_1: 'Lampowa 7', postcode: '00-950', city: 'Warszawa' },
    dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: NIP_PRACOWNI,
    kwota_brutto: '142.00', koszt_dostawy_brutto: '19.00', status_woo: 'processing',
    oplacone_at: '2026-10-26T13:00:00', anulowane: 0, utworzone_at: '2026-10-26T13:00:00',
    pozycje: [{ zrodlo_id: 1, nazwa: 'Lampa stołowa Kałamarz', sku: 'LMP-KAL-01', ilosc: 2, cena_brutto: '61.50', vat: null }],
  }, {});
  // Wpis wprost SQL-em: tak leży pozycja „zw” dopisana przy TwojeFaktury (także po zmianie programu na inny).
  db.prepare("INSERT INTO pozycje (zamowienie_id, nazwa, ilosc, cena_brutto, brutto_linii, vat, zrodlo) VALUES (?, 'Kurs lutowania', 1, '57.00', '57.00', 'zw', 'reczna')")
    .run(id);
  return { db, id };
}
const stawki = (services) => services.map((s) => [s.name, s.tax_symbol]);

describe('PRZ-122.B07c faktura zamówienia (faktura.js) — flaga z programu', () => {
  it('program wbudowany: pozycja ręczna „zw” idzie jako „zw”, reszta stawką domyślną', async () => {
    const { db, id } = bazaZZamowieniem();
    const program = programWbudowany();
    await createFaktura({ db, program, nipSprzedawcy: '1234563218', teraz: TERAZ }).wystaw(id);
    expect(stawki(program.wystaw.mock.calls[0][0].services))
      .toEqual([['Lampa stołowa Kałamarz', '23'], ['Kurs lutowania', 'zw'], ['Dostawa', '23']]);
  });

  it('program wbudowany, firma zwolniona (domyślna „zw”): wszystkie linie „zw”', async () => {
    const { db, id } = bazaZZamowieniem({ zwolniona: true });
    const program = programWbudowany();
    await createFaktura({ db, program, nipSprzedawcy: '1234563218', teraz: TERAZ }).wystaw(id);
    expect(stawki(program.wystaw.mock.calls[0][0].services))
      .toEqual([['Lampa stołowa Kałamarz', 'zw'], ['Kurs lutowania', 'zw'], ['Dostawa', 'zw']]);
  });

  it('program inny (Testownik): jak dotąd — ręczna „zw” i domyślna „zw” dają 23', async () => {
    for (const zwolniona of [false, true]) {
      const { db, id } = bazaZZamowieniem({ zwolniona });
      const program = programTestowy();
      await createFaktura({ db, program, nipSprzedawcy: '1234563218', teraz: TERAZ }).wystaw(id);
      expect(stawki(program.wystaw.mock.calls[0][0].services))
        .toEqual([['Lampa stołowa Kałamarz', '23'], ['Kurs lutowania', '23'], ['Dostawa', '23']]);
    }
  });
});

function bazaZOkresem({ zwolniona = false } = {}) {
  const db = openOmsDb();
  if (zwolniona) zapiszStawkeDomyslna(db, 'zw', { zw: true });
  const okres = zapewnijOkres(db, { klientKlucz: 'polcien', rok: 2026, miesiac: 9 });
  db.prepare('INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, okres_rozliczeniowy_id, utworzone_at)'
    + " VALUES ('reczne', 202600051, 'R/2026/051', '161.00', ?, '2026-09-10T10:00:00.000Z')").run(okres.id);
  const zamId = db.prepare('SELECT id FROM zamowienia WHERE numer = ?').get('R/2026/051').id;
  db.prepare('INSERT INTO pozycje (zamowienie_id, nazwa, ilosc, cena_brutto, brutto_linii, vat, zrodlo) VALUES'
    + " (?, 'Lampa wisząca Półksiężyc', 1, '100.00', '100.00', '8', 'reczna'), (?, 'Kurs lutowania', 1, '57.00', '57.00', 'zw', 'reczna'),"
    + " (?, 'Obsługa zamówienia', 1, '4.00', '4.00', NULL, 'reczna')").run(zamId, zamId, zamId);
  return { db, okres };
}

describe('PRZ-122.B07c faktura okresu (faktura-okresu.js) — flaga z programu', () => {
  it('program wbudowany: „zw” zostaje „zw”, 8 zostaje 8, pozycja bez stawki — domyślna', async () => {
    const { db, okres } = bazaZOkresem();
    const program = programWbudowany();
    await createFakturaOkresu({ db, program, teraz: TERAZ }).wystaw(okres.id, { nip: NIP_PRACOWNI });
    expect(stawki(program.wystaw.mock.calls[0][0].services))
      .toEqual([['Lampa wisząca Półksiężyc', '8'], ['Kurs lutowania', 'zw'], ['Obsługa zamówienia', '23']]);
  });

  it('program wbudowany, firma zwolniona: pozycja bez stawki dostaje „zw”', async () => {
    const { db, okres } = bazaZOkresem({ zwolniona: true });
    const program = programWbudowany();
    await createFakturaOkresu({ db, program, teraz: TERAZ }).wystaw(okres.id, { nip: NIP_PRACOWNI });
    expect(stawki(program.wystaw.mock.calls[0][0].services))
      .toEqual([['Lampa wisząca Półksiężyc', '8'], ['Kurs lutowania', 'zw'], ['Obsługa zamówienia', 'zw']]);
  });

  it('program inny (Testownik): jak dotąd — „zw” daje domyślną 23', async () => {
    for (const zwolniona of [false, true]) {
      const { db, okres } = bazaZOkresem({ zwolniona });
      const program = programTestowy();
      await createFakturaOkresu({ db, program, teraz: TERAZ }).wystaw(okres.id, { nip: NIP_PRACOWNI });
      expect(stawki(program.wystaw.mock.calls[0][0].services))
        .toEqual([['Lampa wisząca Półksiężyc', '8'], ['Kurs lutowania', '23'], ['Obsługa zamówienia', '23']]);
    }
  });

  it('pozycjeOkresu: domyślna „zw” tylko z flagą; bez niej wyjątek jak dotąd', () => {
    const z = [{ koszt_dostawy_brutto: '10.00', pozycje: [{ nazwa: 'Kurs', ilosc: 1, brutto_linii: '57.00', zrodlo: 'reczna', vat: 'zw' }] }];
    expect(pozycjeOkresu(z, { stawkaDomyslna: 'zw', zw: true }).map((s) => s.tax_symbol)).toEqual(['zw', 'zw']);
    expect(() => pozycjeOkresu(z, { stawkaDomyslna: 'zw' })).toThrow(/stawka domyślna/u);
    expect(pozycjeOkresu(z, { stawkaDomyslna: '23' }).map((s) => s.tax_symbol)).toEqual(['23', '23']);
  });
});

describe('PRZ-122.B07c proforma (proforma.js) — flaga przy wystawieniu', () => {
  function zestaw(opcje = {}) {
    const { db, id } = bazaZZamowieniem(opcje);
    const budujPdf = vi.fn(() => Buffer.from('%PDF-1.3 atrapa'));
    const katalog = join(mkdtempSync(join(tmpdir(), 'prz122-b07c-pf-')), 'proformy');
    const proforma = createProforma({ db, budujPdf, teraz: () => new Date('2026-10-27T10:00:00.000Z'), config: {
      nadawca: { nazwa: 'Pracownia Półcień', ulica: 'Lampowa 7', kod: '00-950', miasto: 'Warszawa', kraj: 'PL', phone: '' },
      proforma: { nip: '1234563218', rachunek: '34109010140000000000000000', bank: 'Bank Przykładowy', katalog },
    } });
    return { id, proforma, budujPdf };
  }
  const wiersze = (budujPdf) => budujPdf.mock.calls[0][0].podsumowanieVat.map((w) => [w.suma ? 'suma' : w.stawka, w.nettoGr, w.vatGr, w.bruttoGr]);

  it('z flagą: linia „zw”, osobny wiersz „zw” w podsumowaniu (VAT 0), do zapłaty 199,00', () => {
    const { id, proforma, budujPdf } = zestaw();
    proforma.wystaw(id, { zw: true });
    expect(stawki(budujPdf.mock.calls[0][0].pozycje)).toEqual([['Lampa stołowa Kałamarz', '23'], ['Kurs lutowania', 'zw'], ['Dostawa', '23']]);
    expect(wiersze(budujPdf)).toEqual([[23, 11545, 2655, 14200], ['zw', 5700, 0, 5700], ['suma', 17245, 2655, 19900]]);
  });

  it('z flagą, firma zwolniona: wszystko „zw”, VAT 0', () => {
    const { id, proforma, budujPdf } = zestaw({ zwolniona: true });
    proforma.wystaw(id, { zw: true });
    expect(wiersze(budujPdf)).toEqual([['zw', 19900, 0, 19900], ['suma', 19900, 0, 19900]]);
  });

  it('bez flagi: jak dotąd — „zw” liczona stawką domyślną 23', () => {
    for (const zwolniona of [false, true]) {
      const { id, proforma, budujPdf } = zestaw({ zwolniona });
      proforma.wystaw(id);
      expect(stawki(budujPdf.mock.calls[0][0].pozycje)).toEqual([['Lampa stołowa Kałamarz', '23'], ['Kurs lutowania', '23'], ['Dostawa', '23']]);
      expect(wiersze(budujPdf)).toEqual([[23, 16179, 3721, 19900], ['suma', 16179, 3721, 19900]]);
    }
  });
});
