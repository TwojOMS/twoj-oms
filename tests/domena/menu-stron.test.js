import { describe, it, expect } from 'vitest';
import { menuStron, nawigacjaDla, STRONY } from '../../src/domena/menu-stron.js';

// ⚠️ JEDNA LISTA STRON DLA CALEGO PANELU. Do 17.08.2026 wejscia na te ekrany istnialy
// wylacznie jako ikony w prawym gornym rogu — bez podpisow i bez zaznaczenia, gdzie sie
// jest. Boczne menu je nazywa; ikony ZOSTAJA (decyzja właściciela), bo na waskim ekranie kolumna
// schodzi pod tresc i wtedy sa jedynym wejsciem.

describe('menuStron', () => {
  it('oddaje wszystkie strony panelu, w stalej kolejnosci', () => {
    // ⚠️ Zadanie 8 (2026-09-12): „Wiadomości" dolaczyla tutaj, bo STRONY wylicza sie teraz
    // z EKRANY (domain/ekrany.js) — jedynej listy dzielonej takze ze straznikiem i paskiem
    // ikon. Do tego dnia menu i pasek mialy DWIE ROZNE listy i byly rozjechane: menu mialo
    // „Stali klienci" bez „Wiadomosci", pasek odwrotnie.
    // ⚠️ „Statystyki" dolaczyla 13.09.2026 (Zadanie 8, zakladka wysylki i platnosci) —
    // zaraz po „Raporty", tak samo jak w EKRANY.
    // ⚠️ „Cele" dolaczyly 13.09.2026 (spec 2026-09-13, cele i zadania okresowe) — zaraz po
    // „Kampania", tak samo jak w EKRANY. Ten test jest dowodem, ze menu boczne, pasek ikon
    // i straznik dalej czytaja JEDNA liste: zakladka dopisana tylko do paska nie przeszlaby tedy.
    expect(menuStron('/koszty').map((p) => p.etykieta)).toEqual([
      'Zamówienia', 'Przesyłki', 'Okresy rozliczeniowe', 'Faktury', 'Koszty', 'Raporty', 'Statystyki', 'Reklamy', 'Cele', 'Finanse', 'Magazyn', 'Stali klienci', 'Wiadomości', 'Ustawienia',
    ]);
  });

  it('zaznacza strone, na ktorej stoimy', () => {
    const aktywne = (s) => menuStron(s).filter((p) => p.aktywna).map((p) => p.etykieta);
    expect(aktywne('/koszty')).toEqual(['Koszty']);
    expect(aktywne('/przesylki')).toEqual(['Przesyłki']);
    expect(aktywne('/raporty')).toEqual(['Raporty']);
    expect(aktywne('/magazyn')).toEqual(['Magazyn']);
    // ⚠️ Kampania z parametrem w adresie (`?kampania=`, `?dzien=`) to DALEJ ta sama strona —
    // menu czyta sciezke bez zapytania, wiec przelaczenie kampanii nie gasi pozycji.
    expect(aktywne('/kampania')).toEqual(['Reklamy']);
    expect(aktywne('/kampania?kampania=wrzesien30')).toEqual(['Reklamy']);
  });

  // ⚠️ PODSTRONA TO DALEJ TA SAMA POZYCJA. `/raporty/zarzadczy` i `/okresy/7` musza swiecic
  // sie tak samo jak ekran nadrzedny — inaczej menu gasnie dokladnie wtedy, gdy operator
  // wszedl glebiej i najbardziej potrzebuje wiedziec, gdzie jest.
  it('podstrona zaznacza swoja sekcje', () => {
    const aktywne = (s) => menuStron(s).filter((p) => p.aktywna).map((p) => p.etykieta);
    // ⚠️ Od 17.08.2026 rachunek zarzadczy i dane miesiaca mieszkaja pod /finanse
    // (decyzja właściciela przy przebudowie raportow) — podstrona danych swieci „Finanse".
    expect(aktywne('/finanse/dane')).toEqual(['Finanse']);
    expect(aktywne('/finanse/dane/2026-07')).toEqual(['Finanse']);
    expect(aktywne('/okresy/7')).toEqual(['Okresy rozliczeniowe']);
    expect(aktywne('/magazyn/powiazania')).toEqual(['Magazyn']);
  });

  // ⚠️⚠️ „ZAMOWIENIA" TO `/`, WIEC DOPASOWANIE PO PREFIKSIE ZAZNACZALOBY JE ZAWSZE.
  // Ta pozycja ma wlasna regule: sama „/" albo cokolwiek pod „/zamowienia".
  it('„Zamówienia" swieci sie na liscie i na karcie, ale NIE na innych ekranach', () => {
    const aktywne = (s) => menuStron(s).filter((p) => p.aktywna).map((p) => p.etykieta);
    expect(aktywne('/')).toEqual(['Zamówienia']);
    expect(aktywne('/zamowienia/1171')).toEqual(['Zamówienia']);
    expect(aktywne('/koszty')).not.toContain('Zamówienia');
    expect(aktywne('/faktury')).not.toContain('Zamówienia');
  });

  // ⚠️ ZAWSZE DOKLADNIE JEDNA POZYCJA — zero znaczy „menu nie mowi, gdzie jestes",
  // a dwie znacza, ze mowi nieprawde.
  it('na kazdym znanym ekranie swieci sie dokladnie jedna pozycja', () => {
    for (const s of ['/', '/zamowienia/5', '/okresy', '/okresy/2', '/faktury', '/koszty',
      '/raporty', '/finanse', '/finanse/dane', '/finanse/dane/2026-07', '/magazyn', '/ustawienia']) {
      expect(menuStron(s).filter((p) => p.aktywna)).toHaveLength(1);
    }
  });

  // Nieznany adres (stary link, literowka) nie moze zaznaczyc niczego na sile — menu ma
  // wtedy milczec, a nie wskazywac przypadkowej strony.
  it('nieznany adres nie zaznacza niczego', () => {
    expect(menuStron('/cos-czego-nie-ma').filter((p) => p.aktywna)).toHaveLength(0);
  });

  it('kazda pozycja niesie adres', () => {
    for (const p of menuStron('/')) expect(p.href).toMatch(/^\//);
  });

  // ⚠️ BEZ LICZNIKOW (decyzja właściciela 17.08.2026). Menu nazywa strony, nie mierzy ich.
  it('pozycje menu NIE niosa licznikow', () => {
    for (const p of menuStron('/')) expect(p).not.toHaveProperty('liczba');
  });

  it('STRONY sa ta sama lista, z ktorej powstaje menu', () => {
    expect(STRONY.map((s) => s.href)).toEqual(menuStron('/').map((p) => p.href));
  });
});

describe('nawigacjaDla', () => {
  const konto = (uprawnienia, nad = {}) => ({
    admin: false, imie: 'Ania', rola: 'niestandardowa',
    uprawnienia: new Set(uprawnienia), ...nad,
  });

  it('grupuje pełny panel w trzy nazwane działy', () => {
    const model = nawigacjaDla({ sciezka: '/', konto: konto([], { admin: true }) });
    expect(model.dzialy.map((d) => d.etykieta)).toEqual(['Sprzedaż', 'Magazyn', 'Analizy i cele']);
    expect(model.ustawienia).toEqual({ href: '/ustawienia', etykieta: 'Ustawienia', aktywna: false });
  });

  it('bez konta zachowuje pelna nawigacje pierwszego startu', () => {
    const model = nawigacjaDla({ sciezka: '/', konto: null });
    expect(model.dzialy.map((d) => d.etykieta)).toEqual(['Sprzedaż', 'Magazyn', 'Analizy i cele']);
    expect(model.ustawienia?.href).toBe('/ustawienia');
    expect(model.kontekst.statusy).toHaveLength(9);
  });

  it('prowadzi dział do pierwszej dozwolonej trasy i nie pokazuje pustych działów', () => {
    const model = nawigacjaDla({ sciezka: '/cele', konto: konto(['cele']) });
    expect(model.dzialy).toEqual([
      { klucz: 'analizy-cele', etykieta: 'Analizy i cele', href: '/cele', aktywny: true },
    ]);
    expect(model.ustawienia).toBeNull();
    expect(model.kontekst.grupy.flatMap((g) => g.pozycje).map((p) => p.href)).toEqual(['/cele']);
  });

  it('nie ujawnia statusów zamówień osobie mającej tylko Przesyłki', () => {
    const model = nawigacjaDla({ sciezka: '/przesylki', konto: konto(['przesylki']) });
    expect(model.dzialy[0].href).toBe('/przesylki');
    expect(model.kontekst.statusy).toEqual([]);
    expect(model.kontekst.grupy.flatMap((g) => g.pozycje).map((p) => p.etykieta)).toEqual(['Przesyłki']);
  });

  it('statusy mają zamknięty zestaw i poprzedzają operacyjne pozycje Sprzedaży w modelu', () => {
    const model = nawigacjaDla({ sciezka: '/faktury', konto: konto(['zamowienia', 'przesylki', 'faktury']) });
    expect(model.kontekst.statusy.map((p) => p.etykieta)).toEqual([
      'Do zrobienia', 'Wszystkie', 'Po terminie', 'Nowe', 'Indywidualne',
      'W realizacji', 'Wysłane', 'Zwrot', 'Anulowane',
    ]);
    expect(model.kontekst.grupy.flatMap((g) => g.pozycje).map((p) => p.etykieta))
      .toEqual(['Przesyłki', 'Faktury']);
  });
});
