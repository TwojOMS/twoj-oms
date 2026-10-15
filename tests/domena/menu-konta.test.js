import { describe, expect, it } from 'vitest';
import { ekranyRoli } from '../../src/domena/ekrany.js';
import { menuKontaDla } from '../../src/domena/menu-konta.js';

const konto = (rola, nad = {}) => ({
  imie: 'Barbara',
  rola,
  admin: rola === 'administrator',
  uprawnienia: new Set(ekranyRoli(rola)),
  serwisowe: false,
  ...nad,
});

describe('menuKontaDla', () => {
  it.each([
    ['administrator', 'Administrator'],
    ['sprzedaz', 'Sprzedaż'],
    ['produkcja', 'Produkcja'],
  ])('nazywa zgodny preset %s', (rola, opisRoli) => {
    expect(menuKontaDla(konto(rola), { powrot: '/faktury?miesiac=2026-09' })).toEqual({
      imie: 'Barbara',
      opisRoli,
      motywAction: '/motyw',
      wylogujAction: '/wyloguj',
      powrot: '/faktury?miesiac=2026-09',
      pokazAdministracje: rola === 'administrator',
    });
  });

  it('ujawnia ręczną zmianę uprawnień zamiast nazywać ją czystym presetem', () => {
    const zmienione = konto('sprzedaz', {
      uprawnienia: new Set([...ekranyRoli('sprzedaz'), 'finanse']),
    });

    expect(menuKontaDla(zmienione).opisRoli).toBe('Sprzedaż + zmiany');
  });

  it.each([false, true])('konto serwisowe ma jawną etykietę i nie dostaje skrótu administracyjnego (admin=%s)', (admin) => {
    const serwisowe = konto(undefined, {
      imie: 'konto serwisowe', rola: 'serwisowe', serwisowe: true, admin,
      uprawnienia: new Set(admin ? ekranyRoli('administrator') : ['api']),
    });

    expect(menuKontaDla(serwisowe).opisRoli).toBe('Konto serwisowe');
    expect(menuKontaDla(serwisowe).pokazAdministracje).toBe(false);
  });
});
