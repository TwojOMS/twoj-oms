import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { migracjaOfertKanalow } from '../../src/moduly/magazyn/migracje/0001-oferty-kanalow.ts';
import { wstawOferte } from '../../src/oms/db/oferty-kanalow.ts';
import { zapiszZamowienie, zapiszNadpisaniaPozycji } from '../../src/oms/db/zamowienia.js';
import { zapiszProduktSklepowy, powiazProdukt } from '../../src/oms/db/magazyn.js';
import {
  przelaczStany,
  stanKarty,
  historiaKarty,
  pozycjeBezKarty,
  kartyLustraZ,
} from '../../src/oms/db/stany-magazynowe.js';

const T0 = '2026-11-13T08:00:00.000Z';
const T1 = '2026-11-13T09:00:00.000Z';
const konto = 'erli_polcien';
const ofertaId = 'LMP-oferta-17';
let db;
let numer;
beforeEach(() => {
  db = openOmsDb(':memory:');
  migracjaOfertKanalow.wykonaj(db);
  numer = 0;
  for (const id of [17, 18])
    db.prepare(
      `INSERT INTO karty_produktow
    (id, sku, nazwa, utworzony_at, zmieniony_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(id, `LMP-${id}`, `Lampa Półcień ${id}`, T0, T0);
  przelaczStany(db, { wlacz: true, at: T0 });
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

function oferta(kanal = konto, kartaId = 17, pochodzenie = 'oms') {
  return wstawOferte(db, { kanal, kartaId, idZewnetrzne: ofertaId, pochodzenie }, { teraz: T0 });
}
function zamowienie(sklep = konto, poprawka = false) {
  const id = zapiszZamowienie(
    db,
    sklep,
    {
      zrodlo_id: String(++numer),
      numer: `E-${numer}`,
      klient: {},
      dostawa: {},
      utworzone_at: T1,
      kwota_brutto: '20.00',
      metoda_wysylki: 'dpd',
      kwota_pobrania: null,
      chce_fakture: 0,
      nip: null,
      status_woo: null,
      oplacone_at: null,
      anulowane: 0,
      pozycje: [
        {
          zrodlo_id: 'p1',
          oferta_id: ofertaId,
          produkt_id: null,
          wariant_id: null,
          nazwa: 'Lampa Półcień',
          sku: null,
          zdjecie_url: null,
          ilosc: 2,
          cena_brutto: '10.00',
          vat: '23',
        },
      ],
    },
    {},
  );
  if (poprawka) zapiszNadpisaniaPozycji(db, id, { sp1: { ilosc: 3 } });
  return id;
}
function lustro(kartaId) {
  powiazProdukt(
    db,
    zapiszProduktSklepowy(db, {
      kanal: konto,
      produkt_id: ofertaId,
      wariant_id: '',
      nazwa: 'Lampa Półcień',
      odczytane_at: T0,
    }),
    kartaId,
  );
}

it.each(['oms', 'przejeta'])(
  'oferta %s wiąże zużycie, historię i listę bez karty (obie drogi ilości)',
  (pochodzenie) => {
    const o = oferta(konto, 17, pochodzenie);
    expect(o.tryb).toBe(pochodzenie === 'oms' ? 'zarzadzana' : 'obserwowana');
    const a = zamowienie();
    const b = zamowienie(konto, true);
    expect(stanKarty(db, 17)).toEqual({ ruchy: 0, zuzycie: 5, stan: -5 });
    expect(historiaKarty(db, 17)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ zamowienie_id: a, sklep: konto, ilosc: -2 }),
        expect.objectContaining({ zamowienie_id: b, sklep: konto, ilosc: -3 }),
      ]),
    );
    expect(historiaKarty(db, 17)).toHaveLength(2);
    expect(pozycjeBezKarty(db)).toEqual([]);
  },
);

it('konto ERLI z pliku env (klucz bez przedrostka erli_) też wiąże zamówienie z kartą', () => {
  oferta('polcien');
  const a = zamowienie('polcien');
  expect(stanKarty(db, 17)).toEqual({ ruchy: 0, zuzycie: 2, stan: -2 });
  expect(historiaKarty(db, 17)).toEqual([expect.objectContaining({ zamowienie_id: a, sklep: 'polcien', ilosc: -2 })]);
});

it('ten sam identyfikator na innym koncie nie trafia na kartę 17', () => {
  oferta();
  zamowienie('erli_inne');
  expect(stanKarty(db, 17).zuzycie).toBe(0);
  expect(historiaKarty(db, 17)).toEqual([]);
  expect(pozycjeBezKarty(db)).toHaveLength(1);
  oferta('erli_inne', 18);
  expect(stanKarty(db, 17).zuzycie).toBe(0);
  expect(stanKarty(db, 18).zuzycie).toBe(2);
  expect(historiaKarty(db, 18)).toHaveLength(1);
});

it.each([17, 18])('lustro karty %i wygrywa z rejestrem bez podwójnego liczenia', (kartaId) => {
  oferta();
  lustro(kartaId);
  zamowienie();
  zamowienie(konto, true);
  expect(stanKarty(db, kartaId).zuzycie).toBe(5);
  expect(stanKarty(db, kartaId === 17 ? 18 : 17).zuzycie).toBe(0);
  expect(historiaKarty(db, kartaId)).toHaveLength(2);
  expect(historiaKarty(db, kartaId === 17 ? 18 : 17)).toEqual([]);
});

it('bez wpisu rejestru zachowuje dotychczasowe wiązanie przez lustro', () => {
  zamowienie();
  expect(stanKarty(db, 17).zuzycie).toBe(0);
  expect(pozycjeBezKarty(db)).toHaveLength(1);
  lustro(17);
  expect(stanKarty(db, 17).zuzycie).toBe(2);
  expect(historiaKarty(db, 17)).toHaveLength(1);
});

it('bez tabeli opcjonalnego modułu magazynu nadal działa lustro', () => {
  db.exec('DROP TABLE oferty_kanalow');
  lustro(17);
  zamowienie();
  expect(stanKarty(db, 17).zuzycie).toBe(2);
  expect(historiaKarty(db, 17)).toHaveLength(1);
});

it('rejestr czyta jednym zapytaniem niezależnie od liczby identyfikatorów', () => {
  oferta();
  const zapytania = [];
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, 'prepare').mockImplementation((sql) => {
    zapytania.push(sql);
    return prepare(sql);
  });
  const karty = kartyLustraZ(db);
  for (let i = 0; i < 40; i++) karty({ kanal: konto, produktId: i ? `brak-${i}` : ofertaId, wariantId: null });
  expect(karty({ kanal: konto, produktId: ofertaId, wariantId: null })).toEqual([17]);
  expect(zapytania.filter((sql) => /FROM oferty_kanalow/.test(sql))).toHaveLength(1);
});
