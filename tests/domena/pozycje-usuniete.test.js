// PRZ-152.G2-01 — ZŁOTY WYNIK kwot zamówienia z usuniętą pozycją sklepową (Woo i Allegro).
//
// Usunięcie to znacznik `{ usunieta: true }` w `pozycje_reczne_json` (plan PRZ-152-G2, rozdz. 3.1).
// Nakładka (`nalozNadpisaniaPozycji`) wiersza nie oddaje, `zLinii` dokłada go do `pozycje_usuniete`,
// a kwota oczekiwana odejmuje jego sklepową wartość. Ten plik sprawdza całą drogę od bazy:
// karta (netto / VAT / brutto), kwota oczekiwana, bariera faktury, saldo, opłacenie i grupa scalona.
// Dane zmyślone („Pracownia Półcień”, example.test).
import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { zapiszZamowienie, zapiszNadpisaniaPozycji, pobierzZamowienie } from '../../src/oms/db/zamowienia.js';
import { dodajWplateReczna } from '../../src/oms/db/platnosci.js';
import { kwotaOczekiwanaGrosze, sumaPozycjiZWysylkaGrosze } from '../../src/domena/suma-pozycji.js';
import { podsumowanieVatKarty, podsumowaniePozycji } from '../../src/domena/tabela-pozycji.js';
import { pozycjeDokumentu, sprawdzSumeDokumentu } from '../../src/domena/pozycje-faktury.js';
import { saldoWplat } from '../../src/domena/platnosci.js';
import { zamowienieGrupy } from '../../src/domena/scalanie.js';
import { parsujZwrot } from '../../src/domena/zwrot.js';
import { formularzZwrotu, przygotujKrok2 } from '../../src/domena/zwrot-formularz.js';

const KLIENT = { first_name: 'Ewa', last_name: 'Cień', company: 'Pracownia Półcień', email: 'biuro@example.test' };

let db;
beforeEach(() => {
  db = openOmsDb(':memory:');
});

const zamowienie = (sklep, { zrodloId, kwota, dostawa, pozycje }) => zapiszZamowienie(db, sklep, {
  zrodlo_id: zrodloId, numer: zrodloId, klient: KLIENT, dostawa: { city: 'Pęki' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: null, kwota_brutto: kwota,
  koszt_dostawy_brutto: dostawa, status_woo: 'processing', oplacone_at: null, anulowane: 0,
  utworzone_at: '2026-11-04T09:00:00.000Z',
  pozycje: pozycje.map((p) => ({ sku: null, vat: '23', zdjecie_url: null, produkt_id: null, oferta_id: null, wariant_id: null, ...p })),
}, {});

// Woo: 2 × 61,50 + 1 × 45,00 (usuwana) + 1 × 50,00 + wysyłka 19,99 = 237,99.
const woo = () => zamowienie('sklep', {
  zrodloId: '7101', kwota: '237.99', dostawa: '19.99',
  pozycje: [
    { zrodlo_id: 11, nazwa: 'Szablon „Liść”', ilosc: 2, cena_brutto: '61.50', brutto_linii: '123.00' },
    { zrodlo_id: 12, nazwa: 'Szablon „Kropka”', ilosc: 1, cena_brutto: '45.00', brutto_linii: '45.00' },
    { zrodlo_id: 13, nazwa: 'Wałek piankowy', ilosc: 1, cena_brutto: '50.00', brutto_linii: '50.00' },
  ],
});

// Allegro: 1 × 129,00 + 2 × 35,00 (usuwana) + wysyłka 12,99 = 211,99. Linia Allegro ma id-napis.
const allegro = () => zamowienie('allegro_a', {
  zrodloId: 'a-7202', kwota: '211.99', dostawa: '12.99',
  pozycje: [
    { zrodlo_id: 'li-aa01', nazwa: 'Zestaw szablonów „Ogród”', ilosc: 1, cena_brutto: '129.00', brutto_linii: '129.00' },
    { zrodlo_id: 'li-bb02', nazwa: 'Pędzel okrągły', ilosc: 2, cena_brutto: '35.00', brutto_linii: '70.00' },
  ],
});

const dokument = (z) => {
  const linie = pozycjeDokumentu(z, { stawkaDomyslna: '23' });
  sprawdzSumeDokumentu(linie, z);
  return linie;
};

describe('złoty wynik — Woo z usuniętą pozycją', () => {
  it('karta: 2 z 3 pozycji, netto 156,90 / VAT 36,09 / brutto 192,99, kwota oczekiwana 192,99', () => {
    const id = woo();
    zapiszNadpisaniaPozycji(db, id, { s12: { usunieta: true } });
    const z = pobierzZamowienie(db, id);
    expect(z.pozycje.map((p) => p.klucz)).toEqual(['s11', 's13']);
    expect(z.pozycje_usuniete.map((p) => [p.klucz, p.nazwa, p.brutto_linii])).toEqual([['s12', 'Szablon „Kropka”', '45.00']]);
    expect(kwotaOczekiwanaGrosze(z)).toBe(19299);
    expect(sumaPozycjiZWysylkaGrosze(z)).toBe(19299);
    expect(podsumowaniePozycji(z)).toMatchObject({ sumaZl: '192.99', oczekiwanaZl: '192.99', zgadzaSie: true });
    expect(podsumowanieVatKarty(z, { stawkaDomyslna: '23' })).toMatchObject({
      nettoZl: '156.90', vatZl: '36.09', bruttoZl: '192.99', blad: null,
    });
  });

  it('bariera faktury przepuszcza, a na dokumencie nie ma usuniętej linii', () => {
    const id = woo();
    zapiszNadpisaniaPozycji(db, id, { s12: { usunieta: true } });
    const linie = dokument(pobierzZamowienie(db, id));
    expect(linie.map((l) => [l.name, l.gross_price])).toEqual([
      ['Szablon „Liść”', 12300], ['Wałek piankowy', 5000], ['Dostawa', 1999],
    ]);
  });

  it('saldo: wpłata 237,99 przy kwocie 192,99 to nadpłata 45,00', () => {
    const id = woo();
    zapiszNadpisaniaPozycji(db, id, { s12: { usunieta: true } });
    dodajWplateReczna(db, id, { kwota: '237.99', data: '2026-11-04' });
    expect(saldoWplat(pobierzZamowienie(db, id))).toMatchObject({ kwotaZl: '192.99', stan: 'nadplata', roznicaZl: '45.00' });
  });

  it('wpłata 192,99 pokrywa zamówienie po usunięciu (opłacone), a przed — nie', () => {
    const id = woo();
    dodajWplateReczna(db, id, { kwota: '192.99', data: '2026-11-04' });
    expect(pobierzZamowienie(db, id).oplacone_at).toBeNull();
    zapiszNadpisaniaPozycji(db, id, { s12: { usunieta: true } });
    expect(pobierzZamowienie(db, id).oplacone_at).toBeTruthy();
  });

  it('przywrócenie (skasowanie znacznika) oddaje 3 pozycje i kwotę 237,99', () => {
    const id = woo();
    zapiszNadpisaniaPozycji(db, id, { s12: { usunieta: true } });
    zapiszNadpisaniaPozycji(db, id, null);
    const z = pobierzZamowienie(db, id);
    expect(z.pozycje).toHaveLength(3);
    expect(z.pozycje_usuniete).toEqual([]);
    expect(kwotaOczekiwanaGrosze(z)).toBe(23799);
    expect(podsumowanieVatKarty(z, { stawkaDomyslna: '23' })).toMatchObject({ bruttoZl: '237.99', blad: null });
    expect(() => dokument(z)).not.toThrow();
  });
});

describe('złoty wynik — Allegro z usuniętą pozycją', () => {
  it('netto 115,44 / VAT 26,55 / brutto 141,99, kwota oczekiwana 141,99, bariera przechodzi', () => {
    const id = allegro();
    zapiszNadpisaniaPozycji(db, id, { 'sli-bb02': { usunieta: true } });
    const z = pobierzZamowienie(db, id);
    expect(z.pozycje.map((p) => p.nazwa)).toEqual(['Zestaw szablonów „Ogród”']);
    expect(kwotaOczekiwanaGrosze(z)).toBe(14199);
    expect(podsumowanieVatKarty(z, { stawkaDomyslna: '23' })).toMatchObject({
      nettoZl: '115.44', vatZl: '26.55', bruttoZl: '141.99', blad: null,
    });
    expect(dokument(z).map((l) => l.gross_price)).toEqual([12900, 1299]);
  });
});

// Grupa scalona bierze `...glowne` — gdyby niosła dalej `pozycje_usuniete` głównego, kwota grupy
// (już pomniejszona przez kwotaOczekiwanaGrosze członków) zostałaby pomniejszona DRUGI RAZ.
describe('grupa scalona z usuniętą pozycją w obu członkach', () => {
  it('kwota grupy = suma tabeli grupy; bariera przechodzi', () => {
    const glowneId = woo();
    const dolaczoneId = allegro();
    zapiszNadpisaniaPozycji(db, glowneId, { s12: { usunieta: true } });
    zapiszNadpisaniaPozycji(db, dolaczoneId, { 'sli-bb02': { usunieta: true } });
    const g = zamowienieGrupy(pobierzZamowienie(db, glowneId), [pobierzZamowienie(db, dolaczoneId)]);
    expect(g.pozycje).toHaveLength(3);
    expect(sumaPozycjiZWysylkaGrosze(g)).toBe(kwotaOczekiwanaGrosze(g));
    expect(() => dokument(g)).not.toThrow();
  });
});

// Zwrot po usunięciu: pozycje BEZ `zrodlo_id` mają klucz zapasowy `p<indeks>` liczony z listy
// SUROWEJ. Po odfiltrowaniu usuniętej indeksy się przesuwają, więc zwrot musi brać `p.klucz`
// z nakładki — inaczej „Wałek” (p2) dostałby klucz p1 usuniętego „Kropki”.
describe('zwrot zamówienia z usuniętą pozycją (klucz z nakładki)', () => {
  const bezIdLinii = () => {
    const id = zamowienie('sklep', {
      zrodloId: '7303', kwota: '237.99', dostawa: '19.99',
      pozycje: [
        { zrodlo_id: null, nazwa: 'Szablon „Liść”', ilosc: 2, cena_brutto: '61.50', brutto_linii: '123.00' },
        { zrodlo_id: null, nazwa: 'Szablon „Kropka”', ilosc: 1, cena_brutto: '45.00', brutto_linii: '45.00' },
        { zrodlo_id: null, nazwa: 'Wałek piankowy', ilosc: 2, cena_brutto: '25.00', brutto_linii: '50.00' },
      ],
    });
    zapiszNadpisaniaPozycji(db, id, { p1: { usunieta: true } });
    return pobierzZamowienie(db, id);
  };
  const cialo = (nad = {}) => ({
    data: '2026-11-04', kwota: '50.00', kwota_dostawy: '', powod: 'nie pasuje',
    klucz: ['p2'], ilosc: ['2'], nazwa: ['Wałek piankowy'], pozycja_kwota: ['50.00'], ...nad,
  });

  it('formularz zwrotu niesie klucze p0 i p2', () => {
    const z = bezIdLinii();
    expect(z.pozycje.map((p) => p.klucz)).toEqual(['p0', 'p2']);
    expect(formularzZwrotu(z, { dzis: '2026-11-04' }).pozycje.map((p) => [p.klucz, p.nazwa]))
      .toEqual([['p0', 'Szablon „Liść”'], ['p2', 'Wałek piankowy']]);
  });

  it('parsujZwrot przyjmuje 2 szt. pozycji p2', () => {
    const { zwrot, blad } = parsujZwrot(bezIdLinii(), cialo(), { dzis: '2026-11-04' });
    expect(blad).toBeNull();
    expect(zwrot.pozycje).toEqual([{ klucz_pozycji: 'p2', nazwa: 'Wałek piankowy', ilosc: 2, kwota: '50.00' }]);
  });

  it('krok 2 przelicza kwotę pozycji p2 dla 1 z 2 szt.', () => {
    const { cialo: c } = przygotujKrok2(bezIdLinii(), cialo({ ilosc: ['1'], pozycja_kwota_propozycja: ['50.00'] }));
    expect(c.pozycja_kwota).toEqual(['25.00']);
  });
});
