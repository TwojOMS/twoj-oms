import { describe, it, expect } from 'vitest';
import { definicjeKanalow } from '../../src/moduly/kanaly/konfiguracja.ts';
import { parsujKlientowZbiorczych } from '../../src/domena/klient-zbiorczy.js';

describe('D06: historyczny jawny helper nie ujawnia wpisu', () => {
  it.each([
    ['SEKRET_KLIENTA:FIRMA_TAJNA:9876543210', '7 pól'],
    ['SEKRET_KLIENTA::9876543210:1:1:1:1', 'klucz, nazwa i NIP'],
    ['SEKRET_KLIENTA:FIRMA_TAJNA:9876543210:TAJNA_WARTOSC:1:1:1', 'rabat'],
    ['SEKRET_KLIENTA:FIRMA_TAJNA:9876543210:1:TAJNA_WARTOSC:1:1', 'próg'],
    ['SEKRET_KLIENTA:FIRMA_TAJNA:9876543210:1:1:TAJNA_WARTOSC:1', 'opłata za obsługę'],
    ['SEKRET_KLIENTA:FIRMA_TAJNA:9876543210:1:1:1:TAJNA_WARTOSC', 'opłata kurierska'],
  ])('błąd %s zwraca nazwę pola, bez danych klienta', (wpis, pole) => {
    let blad: Error | undefined;
    try { parsujKlientowZbiorczych({ OMS_KLIENCI_ZBIORCZY: wpis }); } catch (e) { blad = e as Error; }
    expect(blad).toBeInstanceOf(Error);
    expect(blad!.message).toContain('OMS_KLIENCI_ZBIORCZY'); expect(blad!.message).toContain(pole);
    expect(blad!.message).toContain('wpis nr 1');
    for (const dane of ['SEKRET_KLIENTA','FIRMA_TAJNA','9876543210','TAJNA_WARTOSC']) expect(blad!.message).not.toContain(dane);
  });
});
describe('D09: jedna definicja na prefiks instalacji', () => {
  it.each(['woo','allegro'])('współdzielenie prefiksu między dwoma kanałami (%s) jest odrzucone', typ => {
    expect(() => definicjeKanalow({ OMS_KANALY: JSON.stringify([
      { klucz: 'pierwszy', typ, prefiks: 'WSPOLNY' }, { klucz: 'drugi', typ: 'woo', prefiks: 'WSPOLNY' },
    ]) })).toThrow(/OMS_KANALY/);
  });
});
