// PRZ-091 — stany magazynowe: przełącznik, ruchy ręczne, rozchód wyliczany z zamówień (decyzje właściciela 17.10).
import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszProduktSklepowy, utworzKarte, powiazProdukt } from '../../../src/oms/db/magazyn.js';
import { zapiszZamowienie, zapiszFaktyStatusu, zapiszNadpisaniaPozycji, dodajPozycjeReczna } from '../../../src/oms/db/zamowienia.js';
import {
  przelacznikStanow, przelaczStany, stanyKart, stanKarty, historiaKarty, dodajRuch, pozycjeBezKarty,
  podgladImportuOtwarcia, zapiszImportOtwarcia,
} from '../../../src/oms/db/stany-magazynowe.js';

const WLACZONE_AT = '2026-10-17T08:00:00.000Z';
const PO = '2026-10-17T09:00:00.000Z';
const PRZED = '2026-10-16T09:00:00.000Z';
const konto = { id: 1, login: 'adam' };

let db;
let karta;
let kartaB;
let numer = 0;
beforeEach(() => {
  db = openOmsDb(':memory:');
  numer = 0;
  karta = utworzKarte(db, { nazwa: 'Lampa stołowa Grzybek', sku: 'LMP-GRZ-30' });
  kartaB = utworzKarte(db, { nazwa: 'Kinkiet Ramię', sku: 'LMP-KIN-01' });
  const lustro = (kanal, produktId, wariantId, kartaId) => powiazProdukt(db, zapiszProduktSklepowy(db, {
    kanal, produkt_id: produktId, wariant_id: wariantId, nazwa: 'x', odczytane_at: WLACZONE_AT }), kartaId);
  lustro('sklep', '10', '', karta);
  lustro('sklep', '20', '201', kartaB);
  lustro('sklep', '20', '202', karta);
  lustro('allegro_a', '9000000001', '', karta);
});

const wlacz = (at = WLACZONE_AT) => przelaczStany(db, { wlacz: true, konto, at });
const zamowienie = (sklep, pozycje, { at = PO, anulowane = 0, status = null } = {}) => {
  numer += 1;
  return zapiszZamowienie(db, sklep, {
    zrodlo_id: String(numer), numer: String(numer), klient: { first_name: 'Anna' }, dostawa: { city: 'Pęki' },
    metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '100.00', status_woo: null,
    oplacone_at: null, anulowane, utworzone_at: at, status_woo: status,
    pozycje: pozycje.map((p, i) => ({ nazwa: 'poz', sku: null, cena_brutto: '50.00', vat: '23', zdjecie_url: null,
      zrodlo_id: 1000 + i, produkt_id: null, oferta_id: null, wariant_id: null, ...p })),
  }, {});
};
const stan = (id) => stanKarty(db, id)?.stan;
let kl = 0;
const klucz = () => `test-klucz-${++kl}-xxxxxx`;

describe('przełącznik stanów', () => {
  it('domyślnie wyłączony: brak stanów, ruch odmawia, ekrany nie mają czego pokazać', () => {
    expect(przelacznikStanow(db)).toMatchObject({ wlaczone: false, granica: null });
    expect(stanKarty(db, karta)).toBe(null);
    expect(stanyKart(db).stany.size).toBe(0);
    expect(() => dodajRuch(db, { kartaId: karta, rodzaj: 'przyjecie', ilosc: 5, klucz: klucz() })).toThrow(/wyłączone/);
  });

  it('włączenie ustawia granicę i zapisuje kto; drugie włączenie nie przesuwa granicy', () => {
    expect(wlacz().zmieniono).toBe(true);
    expect(wlacz('2026-10-18T00:00:00.000Z').zmieniono).toBe(false);
    const p = przelacznikStanow(db);
    expect(p).toMatchObject({ wlaczone: true, granica: WLACZONE_AT });
    expect(p.historia[0]).toMatchObject({ wlaczone: true, konto_login: 'adam' });
  });

  it('wyłączenie niczego nie kasuje; ponowne włączenie zaczyna od nowej granicy', () => {
    wlacz();
    dodajRuch(db, { kartaId: karta, rodzaj: 'przyjecie', ilosc: 5, klucz: klucz(), at: PO });
    przelaczStany(db, { wlacz: false, konto, at: '2026-10-17T10:00:00.000Z' });
    expect(stanKarty(db, karta)).toBe(null);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ruchy_magazynowe').get().n).toBe(1);
    przelaczStany(db, { wlacz: true, konto, at: '2026-10-17T11:00:00.000Z' });
    expect(stan(karta)).toBe(0);
  });
});

describe('rozchód z zamówień — od razu, wyliczany', () => {
  beforeEach(() => {
    wlacz();
    dodajRuch(db, { kartaId: karta, rodzaj: 'przyjecie', ilosc: 10, klucz: klucz(), at: PO });
  });

  it('zamówienie ze sklepu i z Allegro zdejmuje towar od razu', () => {
    zamowienie('sklep', [{ produkt_id: 10, ilosc: 2 }]);
    zamowienie('allegro_a', [{ oferta_id: '9000000001', ilosc: 3 }]);
    expect(stanKarty(db, karta)).toEqual({ ruchy: 10, zuzycie: 5, stan: 5 });
  });

  it('ponowny odczyt tego samego zamówienia (pozycje wstawione od nowa) nie odejmuje drugi raz', () => {
    zamowienie('sklep', [{ produkt_id: 10, ilosc: 2 }]);
    numer -= 1;
    zamowienie('sklep', [{ produkt_id: 10, ilosc: 2 }]);
    expect(stan(karta)).toBe(8);
  });

  it('anulowanie oddaje towar — w kanale i ręcznie przy panelu; przywrócenie znów zdejmuje', () => {
    const id = zamowienie('sklep', [{ produkt_id: 10, ilosc: 4 }]);
    zamowienie('sklep', [{ produkt_id: 10, ilosc: 1 }], { anulowane: 1 });
    expect(stan(karta)).toBe(6);
    zapiszFaktyStatusu(db, id, { w_realizacji_at: null, wyslane_at: null, zwrot_at: null, zwrot_powod: null, anulowane_recznie: 1 });
    expect(stan(karta)).toBe(10);
    zapiszFaktyStatusu(db, id, { w_realizacji_at: null, wyslane_at: null, zwrot_at: null, zwrot_powod: null, anulowane_recznie: 0 });
    expect(stan(karta)).toBe(6);
  });

  it('Woo: nieudana płatność, kosz i szkic koszyka nie zdejmują; zwrot pieniędzy (refunded) zdejmuje — zwrot towaru to przyjęcie', () => {
    zamowienie('sklep', [{ produkt_id: 10, ilosc: 1 }], { status: 'failed' });
    zamowienie('sklep', [{ produkt_id: 10, ilosc: 1 }], { status: 'trash' });
    zamowienie('sklep', [{ produkt_id: 10, ilosc: 1 }], { status: 'checkout-draft' });
    expect(stan(karta)).toBe(10);
    zamowienie('sklep', [{ produkt_id: 10, ilosc: 2 }], { status: 'refunded' });
    zamowienie('sklep', [{ produkt_id: 10, ilosc: 1 }], { status: 'pending' });
    expect(stan(karta)).toBe(7);
    // ta sama reguła na drodze zamówień z ręczną poprawką ilości
    const id = zamowienie('sklep', [{ produkt_id: 10, ilosc: 1 }], { status: 'failed' });
    zapiszNadpisaniaPozycji(db, id, { s1000: { ilosc: 3 } });
    expect(stan(karta)).toBe(7);
  });

  it('wiersz lustra bez karty obok wiersza z kartą: pozycja bez karty, a nie cichy rozchód z tej jednej', () => {
    // pozycja ręczna nie zna kanału cennika — produkt 30 jest w dwóch sklepach, z kartą tylko w jednym
    zapiszProduktSklepowy(db, { kanal: 'sklep', produkt_id: '30', wariant_id: '', nazwa: 'x', odczytane_at: WLACZONE_AT });
    powiazProdukt(db, zapiszProduktSklepowy(db, { kanal: 'sklep_b', produkt_id: '30', wariant_id: '', nazwa: 'x',
      odczytane_at: WLACZONE_AT }), karta);
    const id = zamowienie('reczne', []);
    dodajPozycjeReczna(db, id, { nazwa: 'Nie wiadomo który', ilosc: 3, cena_brutto: '50.00', brutto_linii: '150.00', produkt_id: 30, wariant_id: null });
    expect(stan(karta)).toBe(10);
    expect(pozycjeBezKarty(db).map((p) => p.nazwa)).toEqual(['Nie wiadomo który']);
  });

  it('zamówienie sprzed włączenia nie zdejmuje', () => {
    zamowienie('sklep', [{ produkt_id: 10, ilosc: 4 }], { at: PRZED });
    // także z ręczną poprawką ilości (ta droga liczy się osobno, pozycja po pozycji)
    const poprawione = zamowienie('sklep', [{ produkt_id: 10, ilosc: 1 }], { at: PRZED });
    zapiszNadpisaniaPozycji(db, poprawione, { s1000: { ilosc: 3 } });
    expect(stan(karta)).toBe(10);
  });

  it('ręczna poprawka ilości liczy się tak, jak na fakturze', () => {
    const id = zamowienie('sklep', [{ produkt_id: 10, ilosc: 1 }]);
    zapiszNadpisaniaPozycji(db, id, { s1000: { ilosc: 3 } });
    expect(stan(karta)).toBe(7);
  });

  it('wariant Woo trafia w swoją kartę; produkt wariantowy bez wariantu — pozycja bez karty, stan nietknięty', () => {
    zamowienie('sklep', [{ produkt_id: 20, wariant_id: '202', ilosc: 2 }, { produkt_id: 20, wariant_id: '201', ilosc: 1 }]);
    zamowienie('sklep', [{ produkt_id: 20, ilosc: 5, nazwa: 'Kinkiet bez wariantu' }]);
    const s = stanyKart(db);
    expect(s.stany.get(karta).stan).toBe(8);
    expect(s.stany.get(kartaB).stan).toBe(-1);
    expect(s.bezKarty).toBe(1);
    expect(pozycjeBezKarty(db)).toEqual([expect.objectContaining({ nazwa: 'Kinkiet bez wariantu', ilosc: 5,
      powod: expect.stringMatching(/kilka wariantów/) })]);
  });

  it('brak na stanie: zamówienie przyjęte, stan na minusie (ostrzeżenie robi ekran)', () => {
    zamowienie('sklep', [{ produkt_id: 10, ilosc: 12 }]);
    expect(stan(karta)).toBe(-2);
  });

  it('oferta bez karty i pozycja bez identyfikatora: pierwsza na liście bez karty, druga pominięta (dopłata)', () => {
    zamowienie('allegro_a', [{ oferta_id: '9999999999', ilosc: 1, nazwa: 'Oferta nieznana' }, { ilosc: 1, nazwa: 'Dopłata' }]);
    expect(pozycjeBezKarty(db).map((p) => p.nazwa)).toEqual(['Oferta nieznana']);
    expect(stanyKart(db).bezKarty).toBe(1);
  });

  it('pozycja ręczna z magazynu (bez kanału) zdejmuje z karty po identyfikatorze produktu', () => {
    const id = zamowienie('reczne', []);
    dodajPozycjeReczna(db, id, { nazwa: 'Grzybek', ilosc: 2, cena_brutto: '50.00', brutto_linii: '100.00', produkt_id: 10, wariant_id: null });
    expect(stan(karta)).toBe(8);
  });

  it('historia karty: ruch ręczny i zamówienie, najnowsze pierwsze', () => {
    zamowienie('sklep', [{ produkt_id: 10, ilosc: 2 }], { at: '2026-10-17T12:00:00.000Z' });
    const h = historiaKarty(db, karta);
    expect(h.map((w) => [w.typ, w.ilosc])).toEqual([['zamowienie', -2], ['ruch', 10]]);
  });
});

describe('ruchy ręczne i import otwarcia', () => {
  beforeEach(() => wlacz());

  it('ten sam klucz drugi raz (podwójne kliknięcie) — jeden ruch', () => {
    const k = klucz();
    expect(dodajRuch(db, { kartaId: karta, rodzaj: 'przyjecie', ilosc: 3, klucz: k }).dopisano).toBe(true);
    expect(dodajRuch(db, { kartaId: karta, rodzaj: 'przyjecie', ilosc: 3, klucz: k }).dopisano).toBe(false);
    expect(stan(karta)).toBe(3);
  });

  it('import otwarcia: SKU bez względu na wielkość liter, nieznane i duplikaty odrzucone z powodem', () => {
    const p = podgladImportuOtwarcia(db, 'SKU;ilosc\nlmp-grz-30;7\nLMP-XXX;1\nLMP-KIN-01;2\nLMP-KIN-01;3\n');
    expect(p.doZapisu).toEqual([expect.objectContaining({ karta_id: karta, ilosc: 7 })]);
    expect(p.odrzucone.map((o) => o.wiersz)).toEqual([3, 4, 5]);
  });

  it('ponowny import tego samego pliku nie podwaja zapasu', () => {
    expect(zapiszImportOtwarcia(db, 'LMP-GRZ-30;7', { konto, at: PO }).zapisane).toBe(1);
    const drugi = zapiszImportOtwarcia(db, 'LMP-GRZ-30;7', { konto, at: PO });
    expect(drugi.zapisane).toBe(0);
    expect(drugi.odrzucone[0].powod).toMatch(/ma już stan otwarcia/);
    expect(stan(karta)).toBe(7);
  });
});
