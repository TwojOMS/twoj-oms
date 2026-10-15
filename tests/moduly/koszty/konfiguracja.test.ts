import { describe, it, expect } from 'vitest';
import { wczytajKoszty } from '../../../src/moduly/koszty/modul.ts';

const env = {OMS_SPRZEDAWCA_NIP:'1000001193',OMS_RACHUNEK:'34109010140000000000000000'};
describe('PRZ-025 konfiguracja KSeF: sekcja cała albo nic', () => {
  it.each([
    ['KSEF_API','https://ksef-test.mf.gov.pl/api/v2'],
    ['KSEF_NIP','1000001193'],
    ['KSEF_ARCHIWUM','C:/fixture/koszty'],
  ])('%s bez tokenu odmawia startu', (klucz,wartosc) => {
    expect(() => wczytajKoszty({...env,[klucz]:wartosc})).toThrow(/KSEF_TOKEN/);
    expect(() => wczytajKoszty({...env,[klucz]:wartosc,KSEF_TOKEN:'   '})).toThrow(/KSEF_TOKEN/);
  });
  it('usuwa wszystkie końcowe ukośniki API', () => {
    expect(wczytajKoszty({...env,KSEF_TOKEN:'fixture',KSEF_API:'https://ksef-test.mf.gov.pl/api/v2///'})
      .ksef?.baseUrl).toBe('https://ksef-test.mf.gov.pl/api/v2');
  });
  it('normalizuje legacy NIP przed porównaniem z rzeczywistym sprzedawcą OMS', () => {
    expect(() => wczytajKoszty({...env,KSEF_TOKEN:'fixture',KSEF_NIP:'PL 100-000-11-93'})).not.toThrow();
    expect(wczytajKoszty({...env,KSEF_TOKEN:'fixture',KSEF_NIP:'PL 100-000-11-93'}).ksef?.nip)
      .toBe('1000001193');
    expect(() => wczytajKoszty({...env,KSEF_TOKEN:'fixture',KSEF_NIP:'PL 123-456-32-18'}))
      .toThrow(/KSEF_NIP/);
  });
  it('token używa NIP sprzedawcy OMS bez obowiązku legacy KSEF_NIP', () => {
    expect(wczytajKoszty({...env,KSEF_TOKEN:'fixture'}).ksef?.nip).toBe('1000001193');
    expect(wczytajKoszty({...env,KSEF_TOKEN:'fixture',KSEF_NIP:' '}).ksef?.nip).toBe('1000001193');
  });
  it('brak API i puste dane nieaktywnej sekcji pozostawiają KSeF wyłączony', () => {
    expect(wczytajKoszty({...env,KSEF_NIP:'',KSEF_ARCHIWUM:''}).ksef).toBeNull();
    expect(wczytajKoszty({...env,KSEF_API:undefined,KSEF_NIP:'',KSEF_ARCHIWUM:''}).ksef).toBeNull();
    expect(wczytajKoszty({...env,KSEF_API:'',KSEF_NIP:'',KSEF_ARCHIWUM:''}).ksef).toBeNull();
  });
  it.each(['   ', ' https://fixture.invalid/SYNTHETIC_URL_SECRET/// ', 'file:///SYNTHETIC_URL_SECRET'])('jawne niepoprawne API %s odmawia nazwanym błędem również bez tokenu', KSEF_API => {
    let blad: Error | undefined;
    try { wczytajKoszty({...env,KSEF_API,KSEF_NIP:'',KSEF_ARCHIWUM:''}); }
    catch(e) { blad=e as Error; }
    expect(blad).toBeInstanceOf(Error);
    expect(blad?.message).toBe('KSEF_API: wymagany absolutny URL http/https');
    expect(blad?.message).not.toContain('SYNTHETIC_URL_SECRET');
  });
});
