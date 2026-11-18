import { it, expect, beforeEach, afterEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { dopiszKlienta } from '../../../src/oms/db/klienci.js';
import {
  pobierzZamowienie,
  dodajPozycjeReczna,
  zapiszPozycjeReczna,
  zapiszNadpisaniaPozycji,
} from '../../../src/oms/db/zamowienia.js';
import { przeliczKwoteRecznego } from '../../../src/oms/db/zamowienia-reczne.js';
import { planZapisuPozycji } from '../../../src/domena/usuniecie-pozycji.js';
import { przypiszDoOkresu } from '../../../src/moduly/faktury/services/okres.js';
import { zamowieniaOkresu } from '../../../src/oms/db/okresy.js';
import { zalozZamowienieReczne } from '../../../src/moduly/zamowienia/services/zamowienie-reczne.js';
import { doklejOplate } from '../../../src/moduly/zamowienia/services/oplata.js';
import { wartoscTowaruGrosze } from '../../../src/domena/oplata-obslugi.js';
let db;
const nip = '1234500011';
beforeEach(() => {
  db = openOmsDb(':memory:');
  dopiszKlienta(db, {
    klucz: 'polcien',
    nazwa: 'Pracownia Półcień',
    nip,
    aktywny: 1,
    b2b: 1,
    rabat_procent: 0,
    chce_fakture: 1,
    metoda_wysylki: 'dpd',
    platnosc: 'przelew',
    koszt_dostawy_brutto: '19.00',
    rozliczenie_zbiorcze: 0,
    prog_darmowej_dostawy_gr: 50000,
    oplata_obslugi_gr: 400,
  });
});
afterEach(() => db.close());
function zamow(cena = '100.00', inne = {}, naliczajOplate = true, okresId = null) {
  const { id } = zalozZamowienieReczne({
    db,
    znacznik: '2026-11-13T10:00:00Z',
    naliczajOplate,
    okresId,
    dane: {
      nip,
      klient: {},
      dostawa: {},
      metoda_wysylki: 'dpd',
      koszt_dostawy_brutto: '19.00',
      pozycje: [{ nazwa: 'Lampa', ilosc: 1, cena_brutto: cena, cena_katalogowa: cena, brutto_linii: cena }],
      ...inne,
    },
  });
  return pobierzZamowienie(db, id);
}
it('niezbiorczy z własną etykietą płaci obsługę, z domyślnym VAT, bez dostawy', () => {
  const z = zamow('100.00', { etykietaKlienta: true });
  expect(z.koszt_dostawy_brutto).toBe('0.00');
  expect(z.kwota_brutto).toBe('104.00');
  expect(z.pozycje.find((p) => p.nazwa === 'Obsługa zamówienia')).toMatchObject({ cena_brutto: '4.00', vat: '23' });
});
it.each([
  ['499.99', '19.00'],
  ['500.00', '0.00'],
])('towar %s → dostawa %s', (cena, koszt) => {
  const z = zamow(cena);
  expect(z.koszt_dostawy_brutto).toBe(koszt);
  expect(z.kwota_brutto).toBe((Number(cena) + Number(koszt)).toFixed(2));
  expect(z.pozycje.map((p) => p.nazwa)).not.toContain('Usługa kurierska');
});
it('próg jest liczony po rabacie umownym', () => {
  db.prepare('UPDATE klienci SET rabat_procent = 40').run();
  const z = zamow('520.00', { rabat_procent: 0 });
  expect(wartoscTowaruGrosze(z.pozycje)).toBe(31200);
  expect(z.koszt_dostawy_brutto).toBe('19.00');
  expect(z.kwota_brutto).toBe('331.00');
});
it('wyłączony próg nie daje darmowej dostawy', () => {
  db.prepare('UPDATE klienci SET prog_darmowej_dostawy_gr = NULL').run();
  expect(zamow('900.00').koszt_dostawy_brutto).toBe('19.00');
});
it('pod progiem zachowuje kwotę operatora zamiast ponownie podstawiać kartę klienta', () => {
  const z = zamow('100.00', { koszt_dostawy_brutto: '27.50' });
  expect(z.koszt_dostawy_brutto).toBe('27.50');
  expect(z.kwota_brutto).toBe('127.50');
});
it('odbiór osobisty wygrywa z etykietą', () => {
  const z = zamow('100.00', { metoda_wysylki: 'odbior_osobisty', etykietaKlienta: true });
  expect(z.koszt_dostawy_brutto).toBe('0.00');
  expect(z.pozycje).toHaveLength(1);
  expect(z.kwota_brutto).toBe('100.00');
});
it('etykieta bez obsługi zeruje tylko dostawę', () => {
  db.prepare('UPDATE klienci SET oplata_obslugi_gr = NULL').run();
  const z = zamow('100.00', { etykietaKlienta: true });
  expect(z.koszt_dostawy_brutto).toBe('0.00');
  expect(z.pozycje).toHaveLength(1);
});
it('naliczajOplate false zachowuje formularz', () => {
  expect(zamow('900.00', { etykietaKlienta: true }, false).koszt_dostawy_brutto).toBe('19.00');
});
it('stara kurierska blokuje drugą opłatę i nie podnosi wartości towaru', () => {
  const z = zamow();
  dodajPozycjeReczna(db, z.id, { nazwa: 'Usługa kurierska', ilosc: 1, cena_brutto: '19.00', brutto_linii: '19.00' });
  expect(doklejOplate({ db, zamowienieId: z.id, nip, etykietaKlienta: true, wartoscTowaruGr: 10000 })).toBeNull();
  expect(wartoscTowaruGrosze(pobierzZamowienie(db, z.id).pozycje)).toBe(10000);
});

it.each([
  ['próg 500 zł', '600.00', {}, '0.00'],
  ['odbiór osobisty', '400.00', { metoda_wysylki: 'odbior_osobisty' }, '0.00'],
  ['poniżej progu', '400.00', {}, '19.00'],
])('%s: koszt bazowy pozwala zapisać pozycje z karty', (_opis, cena, inne, koszt) => {
  const z = zamow(cena, inne);
  expect(z.kwota_brutto).toBe((Number(cena) + Number(koszt)).toFixed(2));
  const p = z.pozycje[0];
  let plan;
  expect(() => {
    plan = planZapisuPozycji(z, {
      klucz: [p.klucz, 'wysylka'],
      nazwa: ['Lampa po poprawce', 'Wysyłka'],
      ilosc: ['1', '1'],
      cena_brutto: [cena, koszt],
    });
  }).not.toThrow();
  const surowe = db.prepare('SELECT koszt_dostawy_brutto, pozycje_reczne_json FROM zamowienia WHERE id = ?').get(z.id);
  expect(surowe.koszt_dostawy_brutto).toBe(koszt);
  expect(JSON.parse(surowe.pozycje_reczne_json ?? '{}')).not.toHaveProperty('wysylka');
  for (const zmiana of plan.reczneZmiany) zapiszPozycjeReczna(db, z.id, zmiana.id, zmiana.pozycja);
  zapiszNadpisaniaPozycji(db, z.id, plan.mapa);
  przeliczKwoteRecznego(db, z.id);
  const po = pobierzZamowienie(db, z.id);
  expect(po.pozycje[0].nazwa).toBe('Lampa po poprawce');
  expect(po.koszt_dostawy_brutto).toBe(koszt);
  expect(po.kwota_brutto).toBe(z.kwota_brutto);
});

it('okres i opłata obsługi działają razem przy etykiecie klienta', () => {
  db.prepare('UPDATE klienci SET rozliczenie_zbiorcze = 1').run();
  const okresId = przypiszDoOkresu({ db, nip, dataZlozenia: '2026-11-13T10:00:00Z', hurt: false });
  expect(okresId).not.toBeNull();
  const z = zamow('100.00', { etykietaKlienta: true }, true, okresId);
  expect(z.okres_rozliczeniowy_id).toBe(okresId);
  expect(zamowieniaOkresu(db, okresId)).toContain(z.id);
  expect(z.pozycje.find((p) => p.nazwa === 'Obsługa zamówienia')).toMatchObject({ cena_brutto: '4.00' });
  expect(z.koszt_dostawy_brutto).toBe('0.00');
  expect(z.kwota_brutto).toBe('104.00');
});
