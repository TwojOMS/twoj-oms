import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../pomoc/dane-miesieczne-parytetu.js';
import { zamowieniaOkresu } from '../../pomoc/raporty-parytetu.js';
import { listaZamowien } from '../../../src/oms/db/zamowienia.js';

let db;
beforeEach(() => { db = openOmsDb(':memory:'); });

let kolejny = 0;
const wstaw = (d = {}) => {
  kolejny += 1;
  const w = {
    sklep: 'szkicownia', zrodlo_id: kolejny, numer: `N${kolejny}`,
    metoda_wysylki: 'dpd', metoda_wysylki_nazwa: null, pobranie: 0, b2b: 0, indywidualne: 0,
    metoda_platnosci: 'BLIK', kwota_brutto: '100.00',
    klient_json: JSON.stringify({ email: 'k@klient.pl', first_name: 'Jan' }),
    klient_reczny_json: null, oplacone_at: '2026-08-13T06:00:00Z', wyslane_at: null,
    anulowane: 0, anulowane_recznie: null, utworzone_at: '2026-08-13T06:00:00Z', ...d,
  };
  db.prepare(`INSERT INTO zamowienia
    (sklep, zrodlo_id, numer, metoda_wysylki, metoda_wysylki_nazwa, pobranie, b2b, indywidualne,
     metoda_platnosci, kwota_brutto, klient_json, klient_reczny_json, oplacone_at, wyslane_at,
     anulowane, anulowane_recznie, utworzone_at)
    VALUES (@sklep,@zrodlo_id,@numer,@metoda_wysylki,@metoda_wysylki_nazwa,@pobranie,@b2b,
            @indywidualne,@metoda_platnosci,@kwota_brutto,@klient_json,@klient_reczny_json,
            @oplacone_at,@wyslane_at,@anulowane,@anulowane_recznie,@utworzone_at)`).run(w);
  return db.prepare('SELECT id FROM zamowienia WHERE zrodlo_id = ?').get(w.zrodlo_id).id;
};

// ⚠️ WPŁATA NA LIŚCIE, NIE TYLKO KOLUMNA. Od 13.09.2026 statystyki czytają `oplacone_at`
// EFEKTYWNE (wyliczone z tabeli `platnosci`), dokładnie jak lista zamówień — a poller
// naprawdę dopisuje taki wiersz przy każdej synchronizacji (zsynchronizujWplateSklepu
// w db/platnosci.js). Fikstura z samą kolumną opisywałaby zamówienie, które panel uważa
// za NIEOPŁACONE, czyli stan nieosiągalny na produkcji.
const wplata = (id, { kwota = '100.00', data, zrodlo = 'sklep', metoda = 'BLIK' } = {}) => {
  db.prepare(
    'INSERT INTO platnosci (zamowienie_id, kwota, data, metoda, uwaga, zrodlo, utworzona_at)'
    + ' VALUES (?,?,?,?,NULL,?,?)',
  ).run(id, kwota, data, metoda, zrodlo, data);
};

const SIERPIEN = { od: '2026-08-01', do: '2026-08-31' };

describe('zamowieniaOkresu — okno', () => {
  it('bierze zamówienia z zakresu, po dniu warszawskim złożenia', () => {
    wstaw({ utworzone_at: '2026-08-13T06:00:00Z', numer: 'W-SRODKU' });
    wstaw({ utworzone_at: '2026-07-31T06:00:00Z', numer: 'PRZED' });
    wstaw({ utworzone_at: '2026-09-01T06:00:00Z', numer: 'PO' });
    expect(zamowieniaOkresu(db, SIERPIEN).map((z) => z.numer)).toEqual(['W-SRODKU']);
  });

  // ⚠️ 2026-07-31T22:30:00Z to 1 SIERPNIA 00:30 czasu polskiego. Porównanie napisów w SQL-u
  // wyrzuciłoby ten wiersz z sierpnia — a kolumna z datą na liście pokazuje przy nim 1.08.
  it('granica doby idzie po czasie polskim, nie po UTC', () => {
    wstaw({ utworzone_at: '2026-07-31T22:30:00Z', numer: 'NOCA' });
    expect(zamowieniaOkresu(db, SIERPIEN).map((z) => z.numer)).toEqual(['NOCA']);
  });

  it('granice zakresu są WŁĄCZNE', () => {
    wstaw({ utworzone_at: '2026-08-01T06:00:00Z', numer: 'PIERWSZY' });
    wstaw({ utworzone_at: '2026-08-31T06:00:00Z', numer: 'OSTATNI' });
    expect(zamowieniaOkresu(db, SIERPIEN).map((z) => z.numer).sort())
      .toEqual(['OSTATNI', 'PIERWSZY']);
  });
});

describe('zamowieniaOkresu — wykluczenia', () => {
  it('anulowane ze sklepu wypada', () => {
    wstaw({ anulowane: 1, numer: 'ANUL' });
    wstaw({ numer: 'ZYWE' });
    expect(zamowieniaOkresu(db, SIERPIEN).map((z) => z.numer)).toEqual(['ZYWE']);
  });

  it('anulowane ręcznie wypada, choć sklep o tym nie wie', () => {
    wstaw({ anulowane: 0, anulowane_recznie: 1, numer: 'ANUL-RECZ' });
    expect(zamowieniaOkresu(db, SIERPIEN)).toEqual([]);
  });

  it('zamówienie własne wypada — także gdy adres siedzi w poprawce ręcznej', () => {
    wstaw({ klient_json: JSON.stringify({ email: 'wlasciciel@example.com' }), numer: 'MOJE' });
    wstaw({
      klient_json: JSON.stringify({ email: 'k@klient.pl' }),
      klient_reczny_json: JSON.stringify({ email: 'ewa.zywiecki@gmail.com' }),
      numer: 'EWA',
    });
    wstaw({ numer: 'PRAWDZIWE' });
    expect(zamowieniaOkresu(db, SIERPIEN).map((z) => z.numer)).toEqual(['PRAWDZIWE']);
  });
});

describe('zamowieniaOkresu — nazwy pozycji dla ekspresu', () => {
  it('dokleja nazwy pozycji, jednym zapytaniem dla całego zakresu', () => {
    const id = wstaw({ numer: 'Z-EKSPRESEM' });
    db.prepare(`INSERT INTO pozycje (zamowienie_id, zrodlo_id, nazwa, ilosc, cena_brutto)
                VALUES (?, 1, 'Realizacja ekspresowa', 1, '49.00')`).run(id);
    db.prepare(`INSERT INTO pozycje (zamowienie_id, zrodlo_id, nazwa, ilosc, cena_brutto)
                VALUES (?, 2, 'Szablon Hamptons', 1, '99.00')`).run(id);
    const [z] = zamowieniaOkresu(db, SIERPIEN);
    expect(z.pozycje.map((p) => p.nazwa).sort())
      .toEqual(['Realizacja ekspresowa', 'Szablon Hamptons']);
  });

  it('zamówienie bez pozycji ma pustą tablicę, nie undefined', () => {
    wstaw({ numer: 'GOLE' });
    expect(zamowieniaOkresu(db, SIERPIEN)[0].pozycje).toEqual([]);
  });
});

// ⚠️⚠️ WADA KRYTYCZNA Z RECENZJI 13.09.2026. Statystyka brała `oplacone_at` z SUROWEJ
// KOLUMNY, a `startZegara` (domain/termin-wysylki.js) na niej stoi. Tymczasem lista zamówień
// oddaje `oplacone_at` WYLICZONE z tabeli `platnosci` (progiem jest kwota oczekiwana od
// klienta), a surową kolumnę wystawia obok jako `oplacone_at_sklep`. Do tego migracja
// `przeniesWplatyDoListy` (db/db.js) przy wpłacie ręcznej ZERUJE surową kolumnę, a
// `dodajWplateReczna` nigdy jej nie zapisuje.
//
// Skutek zmierzony: 16 z 132 zamówień sierpnia (12% miesiąca) wypadało z „% w terminie"
// i „% tego samego dnia" pod etykietą „bez daty startu zegara" — a ta etykieta opisuje
// NIEOPŁACONĄ PRZEDPŁATĘ, czyli coś innego niż przelew zaksięgowany ręcznie.
describe('zamowieniaOkresu — `oplacone_at` jest wartością EFEKTYWNĄ, tą samą co na liście', () => {
  it('przelew zaksięgowany ręcznie daje start zegara, choć surowa kolumna jest pusta', () => {
    const id = wstaw({ numer: 'RECZNY', oplacone_at: null });
    wplata(id, { data: '2026-08-14T09:00:00Z', zrodlo: 'reczna', metoda: 'Przelew' });
    const [z] = zamowieniaOkresu(db, SIERPIEN);
    expect(z.oplacone_at).toBe('2026-08-14T09:00:00Z');
  });

  it('kolumna ze sklepu BEZ wpłaty na liście nie jest opłaceniem — surowa leży obok', () => {
    wstaw({ numer: 'WIDMO', oplacone_at: '2026-08-13T06:00:00Z' });
    const [z] = zamowieniaOkresu(db, SIERPIEN);
    expect(z.oplacone_at).toBeNull();
    expect(z.oplacone_at_sklep).toBe('2026-08-13T06:00:00Z');
  });

  // ⚠️ DRUGI TRYB TEJ SAMEJ WADY: przy dopłacie efektywna data pokrycia jest PÓŹNIEJSZA
  // niż sklepowa, więc statystyka liczyła od wcześniejszej i schlebiała wynikowi.
  it('przy dopłacie start zegara to wpłata DOMYKAJĄCA kwotę, nie ta wcześniejsza', () => {
    const id = wstaw({ numer: 'DOPLATA', kwota_brutto: '200.00', oplacone_at: '2026-08-13T06:00:00Z' });
    wplata(id, { kwota: '100.00', data: '2026-08-13T06:00:00Z' });
    wplata(id, { kwota: '100.00', data: '2026-08-17T11:00:00Z', zrodlo: 'reczna' });
    const [z] = zamowieniaOkresu(db, SIERPIEN);
    expect(z.oplacone_at).toBe('2026-08-17T11:00:00Z');
  });

  // ⚠️ PROGIEM JEST KWOTA OCZEKIWANA OD KLIENTA, nie `kwota_brutto` — i to jest powód,
  // dla którego statystyka potrzebuje pozycji Z CENAMI, a nie samych nazw (dawny
  // `nazwyPozycji` w db/statystyki.js brał wyłącznie `nazwa`). Pozycja dopisana ręcznie
  // podnosi próg, więc wpłata na samą kwotę sklepową NIE domyka zamówienia.
  it('pozycja dopisana ręcznie podnosi próg — wpłata na kwotę sklepową nie domyka', () => {
    const id = wstaw({ numer: 'Z-DOPISKIEM', kwota_brutto: '100.00' });
    db.prepare(`INSERT INTO pozycje (zamowienie_id, zrodlo_id, nazwa, ilosc, cena_brutto, zrodlo)
                VALUES (?, 1, 'Szablon Hamptons', 1, '100.00', 'sklep')`).run(id);
    db.prepare(`INSERT INTO pozycje (zamowienie_id, zrodlo_id, nazwa, ilosc, cena_brutto, zrodlo)
                VALUES (?, NULL, 'Dodatkowy szablon', 1, '50.00', 'reczna')`).run(id);
    wplata(id, { kwota: '100.00', data: '2026-08-13T06:00:00Z' });
    expect(zamowieniaOkresu(db, SIERPIEN)[0].oplacone_at).toBeNull();

    wplata(id, { kwota: '50.00', data: '2026-08-19T08:00:00Z', zrodlo: 'reczna' });
    expect(zamowieniaOkresu(db, SIERPIEN)[0].oplacone_at).toBe('2026-08-19T08:00:00Z');
  });

  // ⚠️ Statystyka i lista MUSZĄ mówić o tej samej paczce to samo — to jest cała treść tej
  // poprawki. Strażnik porównuje wprost dwa odczyty, a nie dwa razy tę samą funkcję.
  it('wiersz statystyki zgadza się z wierszem listy zamówień co do pola', () => {
    const id = wstaw({ numer: 'ZGODNY', oplacone_at: null });
    wplata(id, { data: '2026-08-14T09:00:00Z', zrodlo: 'reczna', metoda: 'Przelew' });
    const zeStatystyk = zamowieniaOkresu(db, SIERPIEN).find((z) => z.numer === 'ZGODNY');
    const zListy = listaZamowien(db).find((z) => z.numer === 'ZGODNY');
    for (const pole of ['oplacone_at', 'oplacone_at_sklep', 'metoda_wysylki', 'pobranie', 'anulowane']) {
      expect(zeStatystyk[pole]).toEqual(zListy[pole]);
    }
  });
});
