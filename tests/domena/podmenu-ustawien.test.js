import { describe, expect, it } from 'vitest';
import { grupyUstawien, podmenuUstawien, POZYCJE_USTAWIEN } from '../../src/domena/podmenu-ustawien.js';

const uklad = (grupy) => grupy.map((g) => [g.etykieta, g.pozycje.map((p) => p.etykieta)]);
const aktywne = (sciezka, opcje = { admin: true }) => grupyUstawien(sciezka, opcje)
  .flatMap((g) => g.pozycje).filter((p) => p.aktywna).map((p) => p.klucz);

describe('podmenu Ustawień', () => {
  // PRZ-101.01 (właściciel 18.10): poziomy pasek nie mieścił się w wierszu — menu z lewej, w pięciu grupach.
  // „Firma” i „Role i uprawnienia” mieszkają w tej samej liście, nie są doklejane w nawigacja.js.
  it('administrator dostaje pięć grup w kolejności planu, pozycje w kolejności planu', () => {
    expect(uklad(grupyUstawien('/ustawienia/integracje', { admin: true }))).toEqual([
      ['Firma', ['Dane firmy', 'Użytkownicy', 'Role i uprawnienia']],
      ['Sprzedaż', ['Statusy zamówień', 'Paczki i koszty dostawy', 'Magazyn', 'Druk i etykiety']],
      ['Komunikacja', ['Szablony wiadomości', 'Autoodpowiedź Allegro', 'Powiadomienia']],
      ['Integracje', ['Sklepy i usługi']],
      ['System', ['Diagnostyka', 'Aktualizacje', 'Kopie zapasowe', 'Import i eksport', 'API i webhooki']],
    ]);
  });

  it('adresy dotychczasowych ekranów zostają bez zmian, nowe atrapy mają własne', () => {
    const adresy = Object.fromEntries(podmenuUstawien('/ustawienia', { admin: true }).map((p) => [p.klucz, p.href]));
    expect(adresy).toEqual({
      firma: '/ustawienia/firma', konta: '/ustawienia/konta', role: '/ustawienia/role',
      statusy: '/ustawienia/statusy', 'zamowienia-i-wysylka': '/ustawienia/zamowienia-i-wysylka', magazyn: '/ustawienia/magazyn', druk: '/ustawienia/druk',
      'szablony-wiadomosci': '/ustawienia/szablony-wiadomosci', 'wiadomosci-i-automatyzacje': '/ustawienia/wiadomosci-i-automatyzacje', powiadomienia: '/ustawienia/powiadomienia',
      integracje: '/ustawienia/integracje',
      diagnostyka: '/ustawienia/lacznosc', aktualizacje: '/ustawienia/aktualizacje', kopie: '/ustawienia/kopie',
      'import-eksport': '/ustawienia/import-eksport', api: '/ustawienia/api',
    });
  });

  it('„wkrótce” mają dokładnie pięć atrap, reszta to działające ekrany', () => {
    const menu = podmenuUstawien('/ustawienia', { admin: true });
    expect(menu.filter((p) => p.wkrotce).map((p) => p.klucz)).toEqual(['druk', 'powiadomienia', 'kopie', 'import-eksport', 'api']);
    expect(menu.find((p) => p.klucz === 'integracje').wkrotce).toBe(false);
  });

  it('konto bez admina nie widzi Użytkowników, Ról ani Aktualizacji — reszta jak u admina', () => {
    expect(uklad(grupyUstawien('/ustawienia/zamowienia-i-wysylka?zapisano=paczka', { admin: false }))).toEqual([
      ['Firma', ['Dane firmy']],
      ['Sprzedaż', ['Statusy zamówień', 'Paczki i koszty dostawy', 'Magazyn', 'Druk i etykiety']],
      ['Komunikacja', ['Szablony wiadomości', 'Autoodpowiedź Allegro', 'Powiadomienia']],
      ['Integracje', ['Sklepy i usługi']],
      ['System', ['Diagnostyka', 'Kopie zapasowe', 'Import i eksport', 'API i webhooki']],
    ]);
    expect(aktywne('/ustawienia/zamowienia-i-wysylka?zapisano=paczka', { admin: false })).toEqual(['zamowienia-i-wysylka']);
  });

  it('grupa bez widocznej pozycji znika razem z nagłówkiem', () => {
    const pozycje = [...POZYCJE_USTAWIEN.filter((p) => p.grupa !== 'firma'), { klucz: 'x', etykieta: 'X', href: '/ustawienia/x', grupa: 'firma', tylkoAdmin: true }];
    expect(grupyUstawien('/ustawienia', { admin: false, pozycje }).map((g) => g.klucz)).toEqual(['sprzedaz', 'komunikacja', 'integracje', 'system']);
  });

  it.each([
    ['/ustawienia/firma', 'firma'],
    ['/ustawienia/paczka', 'zamowienia-i-wysylka'],
    ['/ustawienia/dostawa', 'zamowienia-i-wysylka'],
    ['/ustawienia/paczka/szablon/4/usun', 'zamowienia-i-wysylka'],
    ['/ustawienia/formulka', 'wiadomosci-i-automatyzacje'],
    ['/ustawienia/integracje/dpd', 'integracje'],
    ['/ustawienia/integracje/inpost', 'integracje'],
    ['/ustawienia/integracje/infakt', 'integracje'],
    ['/ustawienia/integracje/poczta', 'integracje'],
    ['/ustawienia/integracje/reklamy', 'integracje'],
    ['/ustawienia/kanaly/allegro_glowny/wiazanie', 'integracje'],
    ['/ustawienia/konta/5', 'konta'],
    ['/ustawienia/konta/3/uprawnienia', 'konta'],
    ['/ustawienia/role', 'role'],
    ['/ustawienia/role/sprzedaz', 'role'],
    ['/ustawienia/magazyn', 'magazyn'],
    ['/ustawienia/lacznosc', 'diagnostyka'],
    ['/ustawienia/aktualizacje/sprawdz', 'aktualizacje'],
    ['/ustawienia/kopie', 'kopie'],
    ['/ustawienia/szablony-wiadomosci', 'szablony-wiadomosci'], // PRZ-101.03
    ['/ustawienia/statusy', 'statusy'], // PRZ-101.02
  ])('%s podświetla dokładnie jedną pozycję: %s', (sciezka, klucz) => {
    expect(aktywne(sciezka)).toEqual([klucz]);
  });

  it('adres podobny, ale nie podstrona, niczego nie podświetla', () => {
    expect(aktywne('/ustawienia/kontakt')).toEqual([]);
    expect(aktywne('/ustawienia/integracjex')).toEqual([]);
  });

  // Wykonawcy 02 i 03 dopisują swoje pozycje NA KOŃCU tablicy — tylko {klucz, etykieta, href, grupa}.
  it('obca pozycja dopisana na końcu trafia do swojej grupy, statusy i szablony na miejsce z planu', () => {
    // PRZ-101.03 jest już w liście — tu sprawdzamy mechanizm dopisania, więc bez niej w bazie.
    const pozycje = [...POZYCJE_USTAWIEN.filter((p) => !['szablony-wiadomosci', 'statusy'].includes(p.klucz)),
      { klucz: 'statusy', etykieta: 'Statusy zamówień', href: '/ustawienia/statusy', grupa: 'sprzedaz' },
      { klucz: 'szablony-wiadomosci', etykieta: 'Szablony wiadomości', href: '/ustawienia/szablony-wiadomosci', grupa: 'komunikacja' },
      { klucz: 'nowa', etykieta: 'Nowa', href: '/ustawienia/nowa', grupa: 'system' },
    ];
    const grupy = grupyUstawien('/ustawienia/statusy/7', { admin: true, pozycje });
    expect(uklad(grupy).slice(1, 3)).toEqual([
      ['Sprzedaż', ['Statusy zamówień', 'Paczki i koszty dostawy', 'Magazyn', 'Druk i etykiety']],
      ['Komunikacja', ['Szablony wiadomości', 'Autoodpowiedź Allegro', 'Powiadomienia']],
    ]);
    expect(uklad(grupy)[4][1].at(-1)).toBe('Nowa');
    expect(grupy.flatMap((g) => g.pozycje).filter((p) => p.aktywna).map((p) => p.klucz)).toEqual(['statusy']);
    expect(grupy[1].pozycje[0]).toEqual({ klucz: 'statusy', etykieta: 'Statusy zamówień', href: '/ustawienia/statusy', grupa: 'sprzedaz', wkrotce: false, aktywna: true });
  });

  it('pozycja z nieznaną grupą nie znika po cichu — błąd od razu', () => {
    const pozycje = [...POZYCJE_USTAWIEN, { klucz: 'z', etykieta: 'Z', href: '/ustawienia/z', grupa: 'brak' }];
    expect(() => grupyUstawien('/ustawienia', { admin: true, pozycje })).toThrow(/brak/);
  });
});
