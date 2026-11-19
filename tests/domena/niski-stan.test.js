import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { czyPonizejProgu, klasaStanu, pasujeDoStanu } from '../../src/domena/niski-stan.js';
import { ostrzezeniaNiskiegoStanu } from '../../src/domena/ostrzezenia.js';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { powiazProdukt, utworzKarte, zapiszProduktSklepowy } from '../../src/oms/db/magazyn.js';
import { zapiszZamowienie } from '../../src/oms/db/zamowienia.js';
import { kartyNiskiegoStanu } from '../../src/oms/db/niski-stan.js';

it.each([
  ['jest', [false, false, true]],
  ['niski', [true, true, false]],
  ['brak', [true, true, false]],
  ['minus', [true, false, false]],
])('sprawdza granicę zera dla filtra %s', (rodzaj, oczekiwane) => {
  expect([-1, 0, 1].map((stan) => pasujeDoStanu(rodzaj, stan, 0))).toEqual(oczekiwane);
  expect(pasujeDoStanu('niski', 0, null)).toBe(false);
});
import { dodajRuch, przelaczStany, stanKarty } from '../../src/oms/db/stany-magazynowe.js';

it.each([
  [2, 2, true, 'niski'],
  [3, 2, false, 'zwykly'],
  [0, 0, true, 'niski'],
  [0, null, false, 'zwykly'],
  [-3, 2, true, 'minus'],
  [-3, null, false, 'minus'],
])('stan %i przy progu %s daje ostrzeżenie %s i klasę %s', (stan, prog, ostrzega, klasa) => {
  expect(czyPonizejProgu(stan, prog)).toBe(ostrzega);
  expect(klasaStanu(stan, prog)).toBe(klasa);
});

describe('karty do ostrzeżenia z rzeczywistych stanów', () => {
  let db;
  beforeEach(() => {
    db = openOmsDb(':memory:');
  });
  afterEach(() => db.close());

  function karta(sku, prog, wycofana = 0) {
    const id = utworzKarte(db, { sku, nazwa: `Karta ${sku}` });
    db.prepare('UPDATE karty_produktow SET prog_niskiego_stanu = ?, wycofana = ? WHERE id = ?').run(prog, wycofana, id);
    return id;
  }

  it('przy wyłączonych stanach nie zwraca kart nawet z progiem zero', () => {
    karta('ZERO', 0);
    expect(kartyNiskiegoStanu(db)).toEqual([]);
  });

  it('wybiera aktywne karty z ustawionym progiem i sortuje je od najmniejszego stanu', () => {
    przelaczStany(db, { wlacz: true });
    const rowna = karta('ROWNA', 2);
    const wieksza = karta('WIEKSZA', 2);
    const minus = karta('MINUS', 2);
    const zero = karta('ZERO', 0);
    karta('BEZ-PROGU', null);
    karta('WYCOFANA', 2, 1);
    dodajRuch(db, { kartaId: rowna, rodzaj: 'otwarcie', ilosc: 2, klucz: 'otwarcie-rowna' });
    dodajRuch(db, { kartaId: wieksza, rodzaj: 'otwarcie', ilosc: 3, klucz: 'otwarcie-wieksza' });
    dodajRuch(db, { kartaId: minus, rodzaj: 'korekta', ilosc: -3, powod: 'Inwentaryzacja', klucz: 'korekta-minus' });

    const karty = kartyNiskiegoStanu(db);
    expect(karty).toEqual([
      { id: minus, sku: 'MINUS', nazwa: 'Karta MINUS', stan: -3, prog: 2 },
      { id: zero, sku: 'ZERO', nazwa: 'Karta ZERO', stan: 0, prog: 0 },
      { id: rowna, sku: 'ROWNA', nazwa: 'Karta ROWNA', stan: 2, prog: 2 },
    ]);
    expect(ostrzezeniaNiskiegoStanu(karty)).toMatchObject([
      { tekst: 'Niski stan: 3 karty (MINUS — -3 szt., ZERO — 0 szt., ROWNA — 2 szt.)' },
    ]);
  });

  it('po korekcie stanu otwarcia ostrzeżenie pokazuje ten sam stan co karta', () => {
    przelaczStany(db, { wlacz: true });
    const id = karta('POLCIEN', 2);
    dodajRuch(db, { kartaId: id, rodzaj: 'otwarcie', ilosc: 8, klucz: 'otwarcie' });
    expect(ostrzezeniaNiskiegoStanu(kartyNiskiegoStanu(db))).toEqual([]);

    dodajRuch(db, { kartaId: id, rodzaj: 'korekta', ilosc: -7, powod: 'Inwentaryzacja', klucz: 'korekta' });
    expect(stanKarty(db, id).stan).toBe(1);
    const karty = kartyNiskiegoStanu(db);
    expect(karty).toMatchObject([{ id, stan: stanKarty(db, id).stan }]);
    expect(ostrzezeniaNiskiegoStanu(karty)).toMatchObject([{ tekst: 'Niski stan: 1 karta (POLCIEN — 1 szt.)' }]);
  });
  it('sprzedaż ze sklepu obniża stan w ostrzeżeniu tak samo jak na karcie', () => {
    przelaczStany(db, { wlacz: true, at: '2026-10-17T08:00:00.000Z' });
    const id = karta('POLCIEN-ZAM', 2);
    powiazProdukt(
      db,
      zapiszProduktSklepowy(db, {
        kanal: 'sklep',
        produkt_id: '10',
        wariant_id: '',
        nazwa: 'x',
        odczytane_at: '2026-10-17T08:00:00.000Z',
      }),
      id,
    );
    dodajRuch(db, { kartaId: id, rodzaj: 'otwarcie', ilosc: 3, klucz: 'otwarcie-zam' });
    expect(kartyNiskiegoStanu(db)).toEqual([]);

    zapiszZamowienie(
      db,
      'sklep',
      {
        zrodlo_id: '1',
        numer: '1',
        klient: { first_name: 'Anna' },
        dostawa: { city: 'Pęki' },
        metoda_wysylki: 'dpd',
        kwota_pobrania: null,
        chce_fakture: 0,
        nip: null,
        kwota_brutto: '100.00',
        oplacone_at: null,
        anulowane: 0,
        utworzone_at: '2026-10-17T09:00:00.000Z',
        status_woo: null,
        pozycje: [
          {
            nazwa: 'poz',
            sku: null,
            cena_brutto: '50.00',
            vat: '23',
            zdjecie_url: null,
            zrodlo_id: 1000,
            produkt_id: 10,
            oferta_id: null,
            wariant_id: null,
            ilosc: 2,
          },
        ],
      },
      {},
    );
    expect(stanKarty(db, id).stan).toBe(1);
    expect(kartyNiskiegoStanu(db)).toMatchObject([{ id, stan: 1 }]);
  });
});
