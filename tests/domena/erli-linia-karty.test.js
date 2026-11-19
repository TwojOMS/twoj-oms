import { expect, it } from 'vitest';
import { dniRobocze, etykietaVatErli, liniaDanychKartyErli } from '../../src/domena/erli-linia-karty.js';

it.each([
  [0, '0 dni roboczych'],
  [1, '1 dzień roboczy'],
  [2, '2 dni robocze'],
  [4, '4 dni robocze'],
  [5, '5 dni roboczych'],
  [12, '12 dni roboczych'],
  [13, '13 dni roboczych'],
  [14, '14 dni roboczych'],
  [21, '21 dni roboczych'],
  [22, '22 dni robocze'],
  [23, '23 dni robocze'],
  [24, '24 dni robocze'],
  [25, '25 dni roboczych'],
])('odmienia czas wysyłki dla %i dni', (dni, oczekiwany) => {
  expect(dniRobocze(dni)).toBe(oczekiwany);
});

it.each([
  ['TAX_23', '23%'],
  ['TAX_8', '8%'],
  ['TAX_5', '5%'],
  ['TAX_0', '0%'],
  ['TAX_ZW', 'zw'],
  ['TAX_INNA', 'TAX_INNA'],
])('wyświetla stawkę VAT ERLI %s jako %s', (kod, etykieta) => {
  expect(etykietaVatErli(kod)).toBe(etykieta);
});

it('składa linię danych karty ERLI w kolejności podglądu', () => {
  expect(liniaDanychKartyErli({ cena: 6900, ilosc: 25, czasWysylkiDni: 1, vat: 'TAX_23', zdjecia: 1 })).toBe(
    'Cena: 69,00 zł · Ilość: 25 · Czas wysyłki: 1 dzień roboczy · VAT 23% · Zdjęcia: 1',
  );
});

it('pomija brakujące pola i zachowuje wartości zerowe bez zbędnych separatorów', () => {
  expect(liniaDanychKartyErli({ ilosc: 0, czasWysylkiDni: 0, vat: null, zdjecia: 0 })).toBe(
    'Ilość: 0 · Czas wysyłki: 0 dni roboczych · Zdjęcia: 0',
  );
  expect(liniaDanychKartyErli({ vat: 'TAX_ZW' })).toBe('VAT zw');
  expect(liniaDanychKartyErli({})).toBe('');
});
