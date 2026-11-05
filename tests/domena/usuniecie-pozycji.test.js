import { it, expect } from 'vitest';
import { sprawdzUsunieciePozycji, planZapisuPozycji } from '../../src/domena/usuniecie-pozycji.js';

const z = { pozycje: [{ klucz: 's2', nazwa: 'A' }, { klucz: 'r7', reczna: true }] };
it.each([
  ['U1', { pozycje: [{ klucz: 'p0' }, { klucz: 's2' }] }, 'p0', {}, /identyfikatora sklepu/],
  ['U2', { pozycje: [...z.pozycje, { klucz: 'p2' }] }, 's2', {}, /bez identyfikatora/],
  ['U3', { ...z, faktura: {} }, 's2', {}, /faktur/],
  ['U4', z, 's2', { zwroty: [{ pozycje: [{ klucz_pozycji: 's2' }] }] }, /zwrot/],
  ['U5', { pozycje: [z.pozycje[0], { klucz: 'wysylka' }] }, 's2', {}, /ostatniej/],
  ['U6', { ...z, scalone_do: 9 }, 's2', {}, /dołączonego/],
  ['wysyłka', z, 'wysylka', {}, /wysyłki/],
])('%s odmawia zdaniem dla operatora', (_, zam, klucz, opcje, zdanie) => {
  let blad;
  try { sprawdzUsunieciePozycji(zam, klucz, opcje); } catch (e) { blad = e; }
  expect(blad).toMatchObject({ dlaOperatora: true });
  expect(blad.message).toMatch(zdanie);
  expect(() => planZapisuPozycji(zam, {
    klucz: '', nazwa: '', ilosc: '1', cena_brutto: '', usun: klucz,
  }, opcje)).toThrow(zdanie);
});
it('ręczne usuwa jak dotąd, dopłatę jak każdą sklepową', () => {
  expect(() => sprawdzUsunieciePozycji({ ...z, faktura: {}, scalone_do: 9 }, 'r7')).not.toThrow();
  expect(() => sprawdzUsunieciePozycji({ pozycje: [{ klucz: 'sdoplata' }, z.pozycje[1]] }, 'sdoplata')).not.toThrow();
});
it.each(['w_toku', 'do_wyjasnienia', null])('blokuje stan faktury %s', (ksef_status) => {
  expect(() => sprawdzUsunieciePozycji({ ...z, faktura: {
    ksef_status, utworzona_at: new Date().toISOString(),
  } }, 's2')).toThrow(/faktur/);
});

for (const reczna of [false, true]) {
  for (const ksef_status of ['w_toku', 'do_wyjasnienia', null]) {
    it.each([{ cena_brutto: '124.00' }, { cena_netto: '101.00' }, { ilosc: '2' }])(
      `plan: ręczna=${reczna}, faktura=${ksef_status}, zmiana %j odmawia`, (zmiana) => {
        const sklep = { nazwa: 'Pracownia Półcień', ilosc: 1, cena_brutto: '123.00', cena_netto: '100.00', vat: '23' };
        const p = { ...sklep, klucz: reczna ? 'r7' : 's1', id: 7, reczna, sklep };
        expect(() => planZapisuPozycji({ pozycje: [p], faktura: { ksef_status, utworzona_at: new Date().toISOString() } }, {
          ...sklep, klucz: p.klucz, ...zmiana,
        })).toThrow('Nie można zmienić pozycji po rozpoczęciu wystawiania faktury — zmianę kwoty obsługuje korekta.');
      });
  }
}

it('plan: cena liczbą 12.3 wobec tekstu „12,30” i zmiana samej nazwy — po fakturze bez odmowy', () => {
  const sklep = { nazwa: 'Pracownia Półcień', ilosc: 1, cena_brutto: 12.3, cena_netto: '10.00', vat: '23' };
  const p = { ...sklep, klucz: 's1', id: 7, reczna: false, sklep };
  const zam = { pozycje: [p], faktura: { ksef_status: 'w_toku', utworzona_at: new Date().toISOString() } };
  expect(() => planZapisuPozycji(zam, { ...sklep, klucz: 's1', nazwa: 'Nowa nazwa', cena_brutto: '12,30' })).not.toThrow();
});
