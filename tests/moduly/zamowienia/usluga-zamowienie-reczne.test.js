import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zalozZamowienieReczne } from '../../../src/moduly/zamowienia/services/zamowienie-reczne.js';
import { NAZWA_OBSLUGI, NAZWA_KURIERA } from '../../../src/domena/oplata-obslugi.js';
import { dopiszKlientaZbiorczego } from '../faktury/_klient-zbiorczy-pomocniki.js';

let db;
beforeEach(() => {
  db = openOmsDb(':memory:');
  // Klient zbiorczy istnieje w bazie od poczatku — testy „bez oplaty" i tak uzywaja
  // innego NIP-u, wiec jeden wiersz nie miesza im niczego.
  dopiszKlientaZbiorczego(db);
});

const config = { klienciZbiorczy: [] };
const znacznik = '2026-08-05T09:00:00.000Z';

const dane = {
  klient: { first_name: 'Jan', last_name: 'Kowalski', email: 'jan@example.com' },
  dostawa: { first_name: 'Jan', last_name: 'Kowalski', address_1: 'Długa 45' },
  nip: null,
  chce_fakture: 0,
  metoda_wysylki: 'dpd',
  pobranie: 0,
  metoda_platnosci: 'Przelew',
  koszt_dostawy_brutto: '19.00',
  pozycje: [{
    nazwa: 'Szablon 70x100', sku: null, ilosc: 2, cena_brutto: '100.00', brutto_linii: '200.00',
  }],
};

// Konfiguracja Z KLIENTEM ZBIORCZYM — ta sama, co w tests/oms/oplata-doklejenie.test.js.
// `config` wyzej ma PUSTA liste, wiec doklejOplate wychodzi tam na null w drugiej linii
// i kolejnosci oplata→kwota nie dotyka.
// ⚠️ Od 24.08.2026 warunki umowy stoja na KARCIE KLIENTA — test musi go wstawic do bazy,
// a nie zbudowac drugiej konfiguracji.
const configZbiorczy = {};

describe('zalozZamowienieReczne', () => {
  it('kwota zamowienia obejmuje pozycje I koszt dostawy', () => {
    const { id, numer } = zalozZamowienieReczne({ db, dane, znacznik, okresId: null });
    expect(numer).toMatch(/^R\/2026\/\d+$/);
    expect(pobierzZamowienie(db, id).kwota_brutto).toBe('219.00');
  });

  it('pozycje trafiaja do bazy, a data zlozenia jest TYM SAMYM znacznikiem', () => {
    const { id } = zalozZamowienieReczne({ db, dane, znacznik, okresId: null });
    const z = pobierzZamowienie(db, id);
    expect(z.pozycje).toHaveLength(1);
    expect(z.utworzone_at).toBe(znacznik);
  });

  // ⚠️ KOLEJNOSC OPLATA→KWOTA PILNOWANA NA POZIOMIE MODULU, a nie tylko przez testy trasy
  // formularza: ta sama funkcja obsluguje juz dwie trasy, a kwota policzona PRZED doklejeniem
  // oplaty nie objelaby jej — karta zapalilaby blokade bariery arytmetycznej od pierwszej
  // sekundy i zamowienia nie dalo by sie zafakturowac.
  it('kwota zamowienia obejmuje DOKLEJONA oplate, nie tylko pozycje operatora', () => {
    const zbiorczy = {
      ...dane,
      nip: '1234500011',
      etykietaKlienta: true,
      koszt_dostawy_brutto: '0.00',
      pozycje: [{
        nazwa: 'Szablon', sku: null, ilosc: 1, cena_brutto: '100.00', brutto_linii: '100.00',
      }],
    };
    const { id, oplata } = zalozZamowienieReczne({
      db, dane: zbiorczy, znacznik, okresId: null,
    });
    expect(oplata).toEqual({ nazwa: NAZWA_OBSLUGI, kwotaGr: 400 });
    const z = pobierzZamowienie(db, id);
    expect(z.pozycje.map((p) => p.nazwa)).toEqual(['Szablon', NAZWA_OBSLUGI]);
    expect(z.kwota_brutto).toBe('104.00');
  });

  // Druga polowa tej samej reguly: prog darmowej dostawy liczy sie od wartosci TOWARU, wiec
  // oplata musi wejsc PO pozycjach. Policzona przed nimi widzialaby towar za 0 zl, czyli
  // ponizej progu — kurierskie 19 zl na KAZDYM zamowieniu klienta zbiorczego.
  it('towar powyzej progu nie dostaje oplaty, a kwota zostaje sama pozycjami', () => {
    const zbiorczy = {
      ...dane,
      nip: '1234500011',
      koszt_dostawy_brutto: '0.00',
      pozycje: [{
        nazwa: 'Szablon', sku: null, ilosc: 1, cena_brutto: '600.00', brutto_linii: '600.00',
      }],
    };
    const { id, oplata } = zalozZamowienieReczne({
      db, dane: zbiorczy, znacznik, okresId: null,
    });
    expect(oplata).toBeNull();
    const z = pobierzZamowienie(db, id);
    expect(z.pozycje.map((p) => p.nazwa)).toEqual(['Szablon']);
    expect(z.pozycje.map((p) => p.nazwa)).not.toContain(NAZWA_KURIERA);
    expect(z.kwota_brutto).toBe('600.00');
  });

  // ⚠️ Blad w polowie zakladania zostawia zamowienie z NADANYM numerem — numeru nie da sie
  // zwolnic. Wolajacy musi dostac jego numer wewnetrzny, inaczej powie operatorowi tylko
  // „nie udalo sie", a operator zalozy DRUGIE zamowienie na te sama sprzedaz. Do wyjecia
  // sekwencji z trasy niosla to zmienna `id` widoczna w `catch` trasy.
  it('blad po nadaniu numeru niesie id pol-zalozonego zamowienia', () => {
    // Pozycja nie do zapisania (nazwa nie jest wartoscia, ktora baza umie zwiazac) —
    // zamowienie zdazy powstac, dopisanie pozycji juz nie.
    const zlaPozycja = { ...dane, pozycje: [{ ...dane.pozycje[0], nazwa: {} }] };
    let zlapany = null;
    try {
      zalozZamowienieReczne({ db, dane: zlaPozycja, znacznik, okresId: null });
    } catch (e) {
      zlapany = e;
    }
    expect(zlapany).not.toBeNull();
    expect(zlapany.zamowienieId).toBeGreaterThan(0);
    expect(pobierzZamowienie(db, zlapany.zamowienieId).numer).toMatch(/^R\/2026\/\d+$/);
  });
});
