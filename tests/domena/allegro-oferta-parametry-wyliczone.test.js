// `parametryWyliczone`: wartość każdego parametru, którą dostanie oferta — karta pokazuje ją w tabeli
// „Parametry kategorii” także wtedy, gdy oferta ma jeszcze braki (żądania wtedy nie ma).
import { expect, it } from 'vitest';
import { ofertaAllegroZKarty } from '../../src/domena/allegro-oferta-z-karty.js';

// Dane zmyślone: katalog lamp „Pracownia Półcień”, kategoria „Lampy stołowe”.
const KAT = '257';
const OPIS = {
  wersja: 2,
  lisc: true,
  tworzenieProduktu: true,
  sciezka: [{ id: KAT, nazwa: 'Lampy stołowe' }],
  parametry: [
    { id: '11323', nazwa: 'Stan', typ: 'dictionary', opisujeProdukt: false, wymagany: true },
    { id: '224017', nazwa: 'Kod producenta', typ: 'string', opisujeProdukt: true, wymaganyDlaProduktu: true },
    { id: '248811', nazwa: 'Marka', typ: 'dictionary', opisujeProdukt: true, wymaganyDlaProduktu: true },
    { id: '5100', nazwa: 'Kolor', typ: 'string', opisujeProdukt: true, wymagany: false },
  ],
};
const REGULY = [
  { kategoriaAllegroId: KAT, parametrId: '11323', rodzaj: 'stala', wartosc: '{"valuesIds":["11323_1"]}' },
  { kategoriaAllegroId: KAT, parametrId: '224017', rodzaj: 'pole', pole: 'sku' },
  { kategoriaAllegroId: KAT, parametrId: '248811', rodzaj: 'pole', pole: 'marka' },
  { kategoriaAllegroId: KAT, parametrId: '5100', rodzaj: 'stala', wartosc: '{"values":["mleczny"]}' },
];

function wejscie(zmiany = {}) {
  return {
    konto: { klucz: 'allegro-polcien', nazwa: 'Półcień Allegro' },
    znakInstalacji: 'OMS7',
    kategorieKarty: ['Lampy stołowe'],
    zdjecia: [
      { id: 101, kolejnosc: 1, adres_zrodlowy: null, sha256: '1'.repeat(64), typ: 'image/jpeg', ai: 0, ai_reczne: 1 },
    ],
    wgraneZdjecia: [],
    kartaAllegro: null,
    mapaKategorii: [{ kategoriaKarty: 'Lampy stołowe', kategoriaAllegroId: KAT }],
    reguly: REGULY,
    opisyKategorii: { [KAT]: OPIS },
    marki: [{ marka: 'Pracownia Półcień', wartoscId: '248811_9001', kategorieSprawdzone: [KAT] }],
    producenciMarek: [{ marka: 'Pracownia Półcień', zrodlo: 'konto' }],
    teraz: '2026-11-14T12:00:00.000Z',
    ...zmiany,
    karta: {
      id: 42,
      nazwa: 'Lampa stołowa Gliwka',
      sku: 'LMP-STO-001',
      ean: null,
      marka: 'Pracownia Półcień',
      cena_gr: 5900,
      stawka_vat: '23',
      kategoria_glowna: 'Lampy stołowe',
      informacja_bezpieczenstwa: JSON.stringify({ typ: 'TEXT', tekst: 'Nie zostawiaj włączonej lampy bez nadzoru.' }),
      ...zmiany.karta,
    },
    ustawienia: {
      klucz: 'allegro-polcien',
      narzutBp: 0,
      stalaIlosc: 5,
      czasWysylkiDni: 2,
      cennikDostaw: 'cennik-1',
      stawkaVat: '23',
      zwrotyId: 'zwrot-1',
      reklamacjeId: 'rekl-1',
      producentId: 'prod-konta',
    },
  };
}

const wyliczone = (wynik) => Object.fromEntries(wynik.parametryWyliczone);

it('reguły stała, pole „sku” i pole „marka” → wartości parametrów takie, jakie idą w żądaniu', () => {
  const wynik = ofertaAllegroZKarty(wejscie());
  expect(wynik.bledy).toEqual([]);
  expect(wyliczone(wynik)).toEqual({
    11323: { wartosc: { id: '11323', valuesIds: ['11323_1'] }, zKatalogu: false },
    224017: { wartosc: { id: '224017', values: ['LMP-STO-001'] }, zKatalogu: false },
    248811: { wartosc: { id: '248811', valuesIds: ['248811_9001'] }, zKatalogu: false },
    5100: { wartosc: { id: '5100', values: ['mleczny'] }, zKatalogu: false },
  });
  // Żądanie bez zmian: parametry oferty i produktu w tej samej postaci i kolejności.
  expect(wynik.zadanie.parameters).toEqual([{ id: '11323', valuesIds: ['11323_1'] }]);
  expect(wynik.zadanie.productSet[0].product.parameters).toEqual([
    { id: '224017', values: ['LMP-STO-001'] },
    { id: '248811', valuesIds: ['248811_9001'] },
    { id: '5100', values: ['mleczny'] },
  ]);
});

it('karta z błędem (brak zdjęcia) → żądania nie ma, wartości parametrów są', () => {
  const wynik = ofertaAllegroZKarty(wejscie({ zdjecia: [] }));
  expect(wynik.bledy.map((b) => b.kod)).toEqual(['zdjecia']);
  expect(wynik.zadanie).toBeNull();
  expect(wynik.parametryWyliczone.get('224017')).toEqual({
    wartosc: { id: '224017', values: ['LMP-STO-001'] },
    zKatalogu: false,
  });
});

it('nadpisanie na karcie wygrywa z regułą i trafia do żądania', () => {
  const wynik = ofertaAllegroZKarty(
    wejscie({ kartaAllegro: { parametry: [{ id: '11323', valuesIds: ['11323_2'] }] } }),
  );
  expect(wynik.parametryWyliczone.get('11323')).toEqual({
    wartosc: { id: '11323', valuesIds: ['11323_2'] },
    zKatalogu: false,
  });
  expect(wynik.zadanie.parameters).toEqual([{ id: '11323', valuesIds: ['11323_2'] }]);
});

it('Stan bez reguły i reguła stała bez wartości → domyślnie „Nowy”', () => {
  const nowy = { wartosc: { id: '11323', valuesIds: ['11323_1'] }, zKatalogu: false };
  const bezReguly = ofertaAllegroZKarty(wejscie({ reguly: REGULY.slice(1) }));
  expect(bezReguly.parametryWyliczone.get('11323')).toEqual(nowy);
  const pustaStala = ofertaAllegroZKarty(
    wejscie({
      reguly: [{ kategoriaAllegroId: KAT, parametrId: '11323', rodzaj: 'stala', wartosc: null }, ...REGULY.slice(1)],
    }),
  );
  expect(pustaStala.parametryWyliczone.get('11323')).toEqual(nowy);
});

it('droga „ean”: parametry produktu oznaczone „z Katalogu” bez wartości; parametr bez wartości — brak wpisu', () => {
  const wynik = ofertaAllegroZKarty(wejscie({ karta: { ean: '5900000000017' } }));
  expect(wynik.droga).toBe('ean');
  expect(wyliczone(wynik)).toEqual({
    11323: { wartosc: { id: '11323', valuesIds: ['11323_1'] }, zKatalogu: false },
    224017: { wartosc: null, zKatalogu: true },
    248811: { wartosc: null, zKatalogu: true },
    5100: { wartosc: null, zKatalogu: true },
  });
  const bezKoloru = ofertaAllegroZKarty(wejscie({ reguly: REGULY.slice(0, 3) }));
  expect(bezKoloru.parametryWyliczone.has('5100')).toBe(false);
});
