import { describe, expect, it } from 'vitest';
import { podmenuUstawien } from '../../src/domena/podmenu-ustawien.js';

describe('podmenu Ustawień', () => {
  it('administrator dostaje dokładnie pięć istniejących kategorii', () => {
    const menu = podmenuUstawien('/ustawienia/integracje', { admin: true });

    expect(menu.map(({ klucz, etykieta, href }) => ({ klucz, etykieta, href }))).toEqual([
      { klucz: 'konta', etykieta: 'Użytkownicy i uprawnienia', href: '/ustawienia/konta' },
      { klucz: 'zamowienia-i-wysylka', etykieta: 'Zamówienia i wysyłka', href: '/ustawienia/zamowienia-i-wysylka' },
      { klucz: 'integracje', etykieta: 'Integracje', href: '/ustawienia/integracje' },
      { klucz: 'wiadomosci-i-automatyzacje', etykieta: 'Wiadomości i automatyzacje', href: '/ustawienia/wiadomosci-i-automatyzacje' },
      { klucz: 'diagnostyka', etykieta: 'Diagnostyka', href: '/ustawienia/lacznosc' },
    ]);
    expect(menu.filter((pozycja) => pozycja.aktywna).map((pozycja) => pozycja.klucz)).toEqual(['integracje']);
  });

  it('konto bez admina nie dostaje zarządzania użytkownikami, ale ma cztery pozostałe sekcje', () => {
    const menu = podmenuUstawien('/ustawienia/zamowienia-i-wysylka?zapisano=paczka', { admin: false });

    expect(menu).toHaveLength(4);
    expect(menu.map((pozycja) => pozycja.klucz)).toEqual([
      'zamowienia-i-wysylka', 'integracje', 'wiadomosci-i-automatyzacje', 'diagnostyka',
    ]);
    expect(menu.filter((pozycja) => pozycja.aktywna)).toEqual([
      expect.objectContaining({ klucz: 'zamowienia-i-wysylka' }),
    ]);
  });

  it('nie tworzy pustych kategorii ani osobnej pozycji wyglądu', () => {
    const etykiety = podmenuUstawien('/ustawienia', { admin: true }).map((pozycja) => pozycja.etykieta);

    expect(etykiety).not.toContain('Wygląd');
    expect(etykiety).not.toContain('Dane firmy');
    expect(etykiety).not.toContain('Bezpieczeństwo');
  });

  it.each([
    ['/ustawienia/paczka', 'zamowienia-i-wysylka'],
    ['/ustawienia/dostawa', 'zamowienia-i-wysylka'],
    ['/ustawienia/formulka', 'wiadomosci-i-automatyzacje'],
    ['/ustawienia/kanaly/allegro_szkicownia/wiazanie', 'integracje'],
    ['/ustawienia/konta/3/uprawnienia', 'konta'],
  ])('formularz %s zachowuje aktywną sekcję na odpowiedzi 400', (sciezka, aktywnyKlucz) => {
    const aktywne = podmenuUstawien(sciezka, { admin: true }).filter((pozycja) => pozycja.aktywna);

    expect(aktywne).toEqual([expect.objectContaining({ klucz: aktywnyKlucz })]);
  });
});
