import { describe, it, expect } from 'vitest';
import { brakiAdresuNabywcy, zdanieBrakuAdresu } from '../../src/domena/adres-nabywcy-faktury.js';

// PRZ-126.PT5 (decyzja 8): adres nabywcy wymagany na każdej fakturze (art. 106e ust. 1 pkt 3),
// kod pocztowy tylko dla Polski. Dane zmyślone.
const pelny = { ulica: 'Lampowa 1', kod: '00-950', miasto: 'Warszawa', kraj: 'PL' };

describe('braki adresu nabywcy', () => {
  it('pełny polski adres — brak braków', () => {
    expect(brakiAdresuNabywcy(pelny)).toEqual([]);
  });

  it('Polska bez kodu — brak kodu pocztowego', () => {
    expect(brakiAdresuNabywcy({ ...pelny, kod: null })).toEqual(['kod pocztowy']);
  });

  it('nabywca zagraniczny bez kodu — można', () => {
    expect(brakiAdresuNabywcy({ ...pelny, kod: null, kraj: 'DE' })).toEqual([]);
    expect(brakiAdresuNabywcy({ ...pelny, kod: '', kraj: ' de ' })).toEqual([]);
  });

  it('pusty kraj znaczy Polska — kod wymagany', () => {
    expect(brakiAdresuNabywcy({ ...pelny, kod: null, kraj: '' })).toEqual(['kod pocztowy']);
    expect(brakiAdresuNabywcy({ ...pelny, kod: null, kraj: undefined })).toEqual(['kod pocztowy']);
    expect(brakiAdresuNabywcy({ ...pelny, kod: '   ', kraj: ' pl ' })).toEqual(['kod pocztowy']);
  });

  it('pełna nazwa Polski (po polsku i angielsku) też wymaga kodu', () => {
    for (const kraj of ['Polska', ' POLSKA ', 'Poland', 'polska', 'Rzeczpospolita Polska']) {
      expect(brakiAdresuNabywcy({ ...pelny, kod: null, kraj })).toEqual(['kod pocztowy']);
    }
    expect(brakiAdresuNabywcy({ ...pelny, kod: null, kraj: 'Niemcy' })).toEqual([]);
  });

  it('ulica z samych spacji to brak ulicy', () => {
    expect(brakiAdresuNabywcy({ ...pelny, ulica: '  ' })).toEqual(['ulica']);
    expect(brakiAdresuNabywcy({ ...pelny, miasto: ' \t' })).toEqual(['miasto']);
  });

  it('nic — wszystkie trzy braki po kolei', () => {
    expect(brakiAdresuNabywcy({})).toEqual(['ulica', 'kod pocztowy', 'miasto']);
    expect(brakiAdresuNabywcy(null)).toEqual(['ulica', 'kod pocztowy', 'miasto']);
  });
});

describe('zdanie braku adresu', () => {
  it('skleja braki przecinkami', () => {
    expect(zdanieBrakuAdresu(['ulica', 'kod pocztowy'])).toBe('ulica, kod pocztowy');
    expect(zdanieBrakuAdresu(['ulica', 'kod pocztowy', 'miasto'])).toBe('ulica, kod pocztowy, miasto');
  });
});

// Recenzja PT5: brak adresu mówi OSTATNI — po stanie faktury w hurcie, po anulowaniu i okresie na karcie.
describe('kolejność powodu „brak adresu”', () => {
  const bezAdresu = { id: 1, numer: 'PT5-K', anulowane: 0, chce_fakture: 1, kwota_brutto: '123.00',
    pozycje: [{ nazwa: 'Lampa', ilosc: 1, cena_brutto: '123.00', brutto_linii: '123.00' }],
    platnosci: [{ kwota: '123.00' }], klient: { company: 'Pracownia Półcień' } };

  it('hurt: zamówienie z wystawioną fakturą i bez adresu słyszy o fakturze', async () => {
    const { podzielDoFaktury } = await import('../../src/domena/masowe.js');
    const { pominiete } = podzielDoFaktury([{ ...bezAdresu, faktura: { numer: 'FV/1/2026', ksef_status: null } }]);
    expect(pominiete[0].powod).toContain('FV/1/2026');
    expect(pominiete[0].powod).not.toContain('Brak adresu');
  });

  it('hurt: bez faktury i bez adresu — powód z brakami', async () => {
    const { podzielDoFaktury } = await import('../../src/domena/masowe.js');
    const { pominiete } = podzielDoFaktury([{ ...bezAdresu, faktura: null }]);
    expect(pominiete[0].powod).toContain('Brak adresu nabywcy (ulica, kod pocztowy, miasto)');
  });

  it('karta: anulowane bez adresu pokazuje anulowanie, okres bez adresu pokazuje okres', async () => {
    const { wystawienieFaktury } = await import('../../src/domena/wystawienie-faktury.js');
    const opcje = { mozliwaFaktura: true, mozeAdres: true, okresyWlaczone: true, nazwaOkresu: 'X' };
    expect(wystawienieFaktury({ ...bezAdresu, anulowane: 1 }, opcje).powod).toContain('anulowane');
    const okres = wystawienieFaktury({ ...bezAdresu, okres_rozliczeniowy_id: 7 }, opcje);
    expect(okres.powod).toContain('fakturą zbiorczą');
    expect(okres.powod).not.toContain('Brak adresu');
  });
});
