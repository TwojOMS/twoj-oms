import { describe, expect, it } from 'vitest';
import { diagnozaTerminow, normalizujTelefon, ofertyPodjazdu } from '../../src/domena/podjazdy.js';

// PRZ-055: ten sam numer w dwóch zapisach (9 cyfr i +48) to ten sam kontakt odbioru.
// Porównanie adresu normalizuje telefon TĄ SAMĄ funkcją po obu stronach; każda inna
// różnica — inny numer, ulica, kod — nadal blokuje ofertę.
const adres = { name: 'Firma', street: 'Polna 1', postalCode: '32-600', city: 'Pęki', countryCode: 'PL', email: 'test@example.com', phone: '500600700' };
const termin = { date: '2026-10-09', minTime: '13:00', maxTime: '17:00' };
const odpowiedz = (address) => [{ proposals: [{ shipmentId: 'a', pickupTimes: [termin] }], address }];
const terminy = (wyslany, odeslany) => ofertyPodjazdu(odpowiedz(odeslany), ['a'], wyslany);
const przyczyna = (wyslany, odeslany) => diagnozaTerminow(odpowiedz(odeslany), ['a'], wyslany).przyczyna;

describe('normalizujTelefon', () => {
  it.each([
    ['PL', '500600700', '+48500600700'],
    ['PL', ' (500) 600-700 ', '+48500600700'],
    ['PL', '0048500600700', '+48500600700'],
    ['PL', '00 48 500 600 700', '+48500600700'],
    ['PL', ' +48 500 600 700 ', '+48500600700'],
    ['DE', '500600700', '500600700'],
    ['PL', '50060070', '50060070'],
    ['PL', '', ''],
  ])('%s / %j → %j', (kraj, telefon, wynik) => {
    expect(normalizujTelefon(telefon, kraj)).toBe(wynik);
  });
  it('brak numeru daje pusty tekst, nie wyjątek', () => {
    expect(normalizujTelefon(null, 'PL')).toBe('');
    expect(normalizujTelefon(undefined, 'PL')).toBe('');
  });
});

describe('porównanie adresu odesłanego przez Allegro', () => {
  it.each([
    ['wysłany +48, odesłany 9 cyfr', '+48500600700', '500600700'],
    ['wysłany 9 cyfr, odesłany +48', '500600700', '+48500600700'],
    ['wysłany +48, odesłany ze spacjami', '+48500600700', '+48 500 600 700'],
    ['wysłany 0048, odesłany +48', '0048500600700', '+48500600700'],
  ])('ten sam numer w dwóch zapisach daje terminy: %s', (_n, wyslany, odeslany) => {
    expect(terminy({ ...adres, phone: wyslany }, { ...adres, phone: odeslany, company: null, state: null })).toEqual([termin]);
    expect(przyczyna({ ...adres, phone: wyslany }, { ...adres, phone: odeslany })).toBe('rozne-okna');
  });

  it.each([
    ['inny numer +48', { phone: '+48500600701' }],
    ['inny numer 9 cyfr', { phone: '500600701' }],
    ['brak numeru w odpowiedzi', { phone: null }],
    ['inna ulica', { phone: '+48500600700', street: 'Polna 2' }],
    ['inny kod pocztowy', { phone: '+48500600700', postalCode: '32-601' }],
    ['inny kraj przy tych samych cyfrach', { phone: '+48500600700', countryCode: 'DE' }],
  ])('%s nadal daje niezgodny-adres', (_n, zmiana) => {
    const wyslany = { ...adres, phone: '+48500600700' };
    expect(terminy(wyslany, { ...adres, ...zmiana })).toEqual([]);
    expect(przyczyna(wyslany, { ...adres, ...zmiana })).toBe('niezgodny-adres');
  });

  it('numer zagraniczny nie jest dopasowywany do +48', () => {
    const wyslany = { ...adres, countryCode: 'DE', phone: '500600700' };
    expect(terminy(wyslany, { ...wyslany, phone: '+48500600700' })).toEqual([]);
  });

  it('porównanie nie zmienia obiektów wejściowych', () => {
    const wyslany = { ...adres };
    const odeslany = { ...adres, phone: '+48500600700' };
    terminy(wyslany, odeslany);
    expect(wyslany.phone).toBe('500600700');
    expect(odeslany.phone).toBe('+48500600700');
  });
});
