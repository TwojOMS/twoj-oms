import { expect, it } from 'vitest';
import { DZIALY_USTAWIEN } from '../../src/domena/dzialy-ustawien.js';
import { POZYCJE_USTAWIEN } from '../../src/domena/podmenu-ustawien.js';

it('każda dostępna pozycja Ustawień ma adres w menu działów', () => {
  const adresy = new Set(DZIALY_USTAWIEN.flatMap((dzial) => dzial.zakladki.map((zakladka) => zakladka.href)));
  const brakujace = POZYCJE_USTAWIEN.filter(({ wkrotce, href }) => !wkrotce && !adresy.has(href)).map(
    ({ etykieta, href }) => `${etykieta} → ${href}`,
  );
  expect(brakujace).toEqual([]);
});

it('Powiadomienia są zaraz po Komunikacji i mają jedną zakładkę dostępną bez uprawnień administratora', () => {
  const indeksKomunikacji = DZIALY_USTAWIEN.findIndex(({ klucz }) => klucz === 'komunikacja');
  expect(indeksKomunikacji).toBeGreaterThanOrEqual(0);
  expect(DZIALY_USTAWIEN[indeksKomunikacji + 1]).toMatchObject({
    klucz: 'powiadomienia',
    etykieta: 'Powiadomienia',
    zakladki: [{ etykieta: 'Powiadomienia', href: '/ustawienia/powiadomienia', tylkoAdmin: false }],
  });
});
