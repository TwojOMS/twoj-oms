import { describe, it, expect } from 'vitest';
import * as nawigacja from '../../../src/domena/podmenu-ustawien.js';

const model = (url, o = { admin: true }) => nawigacja.modelNawigacjiUstawien?.(url, o);
describe('PRZ-127: działy Ustawień', () => {
  it('pokazuje dokładnie 10 działów i zakładki wyłącznie bieżącego działu', () => {
    const m = model('/ustawienia/firma');
    expect(m?.dzialy.map(d => d.etykieta)).toEqual(['Firma', 'Integracje', 'Zamówienia i magazyn', 'Wysyłka i druk', 'Faktury i podatki', 'Komunikacja', 'Automatyzacje', 'Zespół i dostęp', 'Kopie zapasowe', 'System']);
    expect(m.zakladki.map(z => z.etykieta)).toEqual(['Dane i logo', 'Dane rejestrowe', 'Rachunek bankowy']);
    expect(m.aktywnyDzial).toBe('firma');
  });
  it.each([
    ['/ustawienia/integracje/program-fakturowy', 'faktury', 'program'],
    ['/ustawienia/integracje/program-fakturowy/serie', 'faktury', 'numeracja'],
    ['/ustawienia/integracje/program-fakturowy/ksef/konsumenckie', 'faktury', 'ksef'],
    ['/ustawienia/integracje/program-fakturowy/dla-kazdego', 'faktury', 'zasady'],
    ['/ustawienia/firma/zwolnienie-vat', 'faktury', 'vat'],
    ['/ustawienia/integracje/ksef', 'integracje', 'polaczenia'],
    ['/ustawienia/integracje/dpd', 'integracje', 'polaczenia'],
    ['/ustawienia/integracje/infakt/ksef-automat', 'automatyzacje', 'systemowe'],
    ['/ustawienia/paczka', 'wysylka', 'paczki'],
    ['/ustawienia/dostawa', 'wysylka', 'dostawa'],
    ['/ustawienia/integracje/poczta/podpis', 'komunikacja', 'podpis'],
    ['/ustawienia/firma/rachunek', 'firma', 'rachunek'],
  ])('mapuje GET i adres odpowiedzi POST 400 %s', (url, dzial, zakladka) => {
    expect(model(`${url}?zapisano=1`)).toMatchObject({ aktywnyDzial: dzial, aktywnaZakladka: zakladka });
    expect(model(url).dzialy.filter(d => d.aktywna)).toHaveLength(1);
  });
  it('nie udostępnia administracyjnych zakładek kontu bez praw administratora', () => {
    expect(model('/ustawienia/konta', { admin: false }).dzialy.some(d => d.klucz === 'zespol')).toBe(false);
    expect(model('/ustawienia/konta', { podgladDemo: true }).dzialy.some(d => d.klucz === 'zespol')).toBe(true);
  });
  it('dane demo pojawiają się tylko przy istniejącej trasie', () => {
    expect(model('/ustawienia/moduly').zakladki.some(z => z.klucz === 'demo')).toBe(false);
    expect(model('/ustawienia/moduly', { admin: true, daneDemo: true }).zakladki.some(z => z.klucz === 'demo')).toBe(true);
  });
});
