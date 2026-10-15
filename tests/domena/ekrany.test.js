import { describe, it, expect } from 'vitest';
import {
  EKRANY, ROLE, ekranDlaAdresu, ekranyRoli, maDostepDoEkranu, maDostepDoAdresu,
} from '../../src/domena/ekrany.js';

describe('EKRANY', () => {
  it('ma 17 ekranow o unikalnych kluczach', () => {
    expect(EKRANY).toHaveLength(17);
    expect(new Set(EKRANY.map((e) => e.klucz)).size).toBe(17);
  });
});

describe('ekran CELE (spec 2026-09-13)', () => {
  it('lapie wlasny prefiks', () => {
    expect(ekranDlaAdresu('/cele')).toBe('cele');
    expect(ekranDlaAdresu('/cele/12')).toBe('cele');
    expect(ekranDlaAdresu('/cele/12/zdarzenie')).toBe('cele');
    expect(ekranDlaAdresu('/cele/:id/cofnij')).toBe('cele');
  });

  it('administrator i sprzedaz maja, produkcja NIE', () => {
    // Ewa pracuje na roli Sprzedaz i ma dostac ekran bez zadnej dodatkowej zmiany.
    // Pakowacz nie oglada celow sprzedazowych wlascicieli firmy.
    expect(ekranyRoli('administrator')).toContain('cele');
    expect(ekranyRoli('sprzedaz')).toContain('cele');
    expect(ekranyRoli('produkcja')).not.toContain('cele');
  });
});

describe('ekranDlaAdresu', () => {
  it('lista zamowien stoi pod "/" i to jest ekran zamowien', () => {
    expect(ekranDlaAdresu('/')).toBe('zamowienia');
    expect(ekranDlaAdresu('/?status=nowe')).toBe('zamowienia');
  });

  it('karta zamowienia, nadanie i etykiety naleza do ekranu zamowien', () => {
    expect(ekranDlaAdresu('/zamowienia/12')).toBe('zamowienia');
    expect(ekranDlaAdresu('/zamowienia/12/nadaj')).toBe('zamowienia');
    expect(ekranDlaAdresu('/zamowienia/12/status')).toBe('zamowienia');
    expect(ekranDlaAdresu('/kolejka-druku/3/zpl')).toBe('zamowienia');
    expect(ekranDlaAdresu('/ostrzezenia/odrzuc')).toBe('zamowienia');
  });

  it('SPECYFIKACJA PACZKI zostaje przy zamowieniach, mimo ze brzmi jak dokument', () => {
    expect(ekranDlaAdresu('/zamowienia/specyfikacje.pdf')).toBe('zamowienia');
  });

  it('rozdziela faktury, zwroty i pozostale dokumenty na trzy zakresy', () => {
    expect(ekranDlaAdresu('/zamowienia/12/faktura')).toBe('faktury-zamowienia');
    expect(ekranDlaAdresu('/zamowienia/12/faktura/odblokuj')).toBe('faktury-zamowienia');
    expect(ekranDlaAdresu('/zamowienia/12/faktura-allegro')).toBe('faktury-zamowienia');
    expect(ekranDlaAdresu('/zamowienia/faktury-hurtem/podglad')).toBe('faktury-zamowienia');
    expect(ekranDlaAdresu('/zamowienia/12/zwrot')).toBe('zwroty-zamowienia');
    expect(ekranDlaAdresu('/zamowienia/12/zwroty/4/korekta')).toBe('zwroty-zamowienia');
    expect(ekranDlaAdresu('/zamowienia/12/proforma')).toBe('pozostale-dokumenty-zamowienia');
    expect(ekranDlaAdresu('/proformy/7/pdf')).toBe('pozostale-dokumenty-zamowienia');
    expect(ekranDlaAdresu('/kolejka-druku-faktur/7/pdf')).toBe('pozostale-dokumenty-zamowienia');
  });

  it('rozpoznaje TAKZE postac z parametrem Fastify, bo tego uzywa test kompletnosci', () => {
    expect(ekranDlaAdresu('/zamowienia/:id/faktura')).toBe('faktury-zamowienia');
    expect(ekranDlaAdresu('/zamowienia/:id/nadaj')).toBe('zamowienia');
  });

  // ⚠️ REGRESJA (recenzja 12.09.2026): `/zamowienia/:id/dane/faktura` NIE lapal sie na
  // WZORCE_DOKUMENTOW, bo ten wymagal „faktura" jako PIERWSZEGO segmentu po identyfikatorze.
  // Trasa spadala do prefiksu `/zamowienia` i ladowala na ekranie „zamowienia" — rola
  // Produkcja mogla wiec zmienic NIP nabywcy i, przez rabat kontraktowy wywolywany po
  // zapisie NIP-u, cene calego zamowienia. Domyslnosc gałęzi `/dane/` idzie w strone
  // dokumentow WLASNIE dlatego: pomylka „za wasko" zglosi sam operator bez dostepu,
  // pomylka „za szeroko" nie zostawia sladu.
  it('cala galaz /zamowienia/:id/dane/ nalezy do dokumentow — z jawnymi wyjatkami wysylkowymi', () => {
    expect(ekranDlaAdresu('/zamowienia/12/dane/faktura')).toBe('faktury-zamowienia');
    expect(ekranDlaAdresu('/zamowienia/:id/dane/faktura')).toBe('faktury-zamowienia');
    expect(ekranDlaAdresu('/zamowienia/12/dane/gus')).toBe('faktury-zamowienia');
    expect(ekranDlaAdresu('/zamowienia/12/dane/przywroc')).toBe('faktury-zamowienia');
    // Wyjatki wysylkowe: Produkcja musi umiec poprawic adres paczki.
    expect(ekranDlaAdresu('/zamowienia/12/dane/wysylka')).toBe('zamowienia');
    expect(ekranDlaAdresu('/zamowienia/12/dane/kopiuj-do-wysylki')).toBe('zamowienia');
    // Trasa przyszla, dzis nieistniejaca: dowod, ze domyslnosc idzie w bezpieczna strone.
    expect(ekranDlaAdresu('/zamowienia/12/dane/cokolwiek')).toBe('faktury-zamowienia');
  });

  it('trasy otwarte i trasy dla kazdego zalogowanego maja wlasne odpowiedzi', () => {
    expect(ekranDlaAdresu('/login')).toBe('otwarte');
    expect(ekranDlaAdresu('/health')).toBe('otwarte');
    expect(ekranDlaAdresu('/public/app.css')).toBe('otwarte');
    expect(ekranDlaAdresu('/wyloguj')).toBe('kazdy');
    expect(ekranDlaAdresu('/wyloguj-wszystkie')).toBeNull();
    expect(ekranDlaAdresu('/ustawienia/konta/wyloguj-wszystkie')).toBe('ustawienia');
    expect(ekranDlaAdresu('/motyw')).toBe('kazdy');
  });

  it('trasy integracyjne to uprawnienie api, nie ekran', () => {
    expect(ekranDlaAdresu('/api/zamowienia')).toBe('api');
  });

  it('FAIL-CLOSED: adres spoza listy nie nalezy do niczego', () => {
    expect(ekranDlaAdresu('/cokolwiek-nowego')).toBeNull();
    expect(ekranDlaAdresu('/zamowieniaXYZ')).toBeNull();
  });
});

describe('wspolne sprawdzenie uprawnienia', () => {
  const konto = (uprawnienia = []) => ({ admin: false, uprawnienia: new Set(uprawnienia) });

  it('jest fail-closed dla braku konta, klucza i nieznanego adresu', () => {
    expect(maDostepDoEkranu(null, 'zamowienia')).toBe(false);
    expect(maDostepDoEkranu(konto(['zamowienia']), null)).toBe(false);
    expect(maDostepDoAdresu({ admin: true }, '/nieznana-trasa')).toBe(false);
  });

  it('admin omija ptaszki, a zwykle konto dostaje tylko przyznany zakres', () => {
    expect(maDostepDoEkranu({ admin: true }, 'faktury-zamowienia')).toBe(true);
    expect(maDostepDoEkranu(konto(['faktury-zamowienia']), 'faktury-zamowienia')).toBe(true);
    expect(maDostepDoEkranu(konto(['faktury-zamowienia']), 'zwroty-zamowienia')).toBe(false);
  });

  it('adapter adresu rozdziela trzy zakresy i obsluguje wzorce Fastify', () => {
    const wszystkie = konto([
      'faktury-zamowienia', 'zwroty-zamowienia', 'pozostale-dokumenty-zamowienia',
    ]);
    expect(maDostepDoAdresu(wszystkie, '/zamowienia/:id/faktura')).toBe(true);
    expect(maDostepDoAdresu(konto(['zwroty-zamowienia']), '/zamowienia/7/zwrot/podglad')).toBe(true);
    expect(maDostepDoAdresu(konto(['pozostale-dokumenty-zamowienia']), '/proformy/:id/pdf')).toBe(true);
    expect(maDostepDoAdresu(konto(['zamowienia']), '/zamowienia/7/proforma')).toBe(false);
  });

  it('zachowuje semantyke tras otwartych, dla kazdego zalogowanego i API', () => {
    expect(maDostepDoAdresu(null, '/login')).toBe(true);
    expect(maDostepDoAdresu(null, '/wyloguj')).toBe(false);
    expect(maDostepDoAdresu(konto(), '/wyloguj')).toBe(true);
    expect(maDostepDoAdresu(konto(['api']), '/api/zamowienia')).toBe(true);
    expect(maDostepDoAdresu(konto(), '/api/zamowienia')).toBe(false);
  });

  it('trzy bezlinkowe zakresy dokumentow zachowuja kontekst Sprzedazy', () => {
    for (const klucz of [
      'faktury-zamowienia', 'zwroty-zamowienia', 'pozostale-dokumenty-zamowienia',
    ]) {
      const ekran = EKRANY.find((pozycja) => pozycja.klucz === klucz);
      expect(ekran).toMatchObject({ href: null, nawigacja: { dzial: 'sprzedaz' } });
    }
  });
});

describe('ROLE jako presety', () => {
  it('administrator dostaje wszystkie 17 ekranow', () => {
    expect(ekranyRoli('administrator')).toHaveLength(17);
  });

  it('sprzedaz widzi raporty i koszty, NIE widzi finansow ani ustawien', () => {
    const e = ekranyRoli('sprzedaz');
    expect(e).toContain('raporty');
    expect(e).toContain('koszty');
    expect(e).not.toContain('finanse');
    expect(e).not.toContain('ustawienia');
    expect(e).toContain('faktury-zamowienia');
    expect(e).toContain('zwroty-zamowienia');
    expect(e).toContain('pozostale-dokumenty-zamowienia');
    expect(e).not.toContain('dokumenty-zamowienia');
    expect(e).toHaveLength(15);
  });

  it('produkcja ma zamowienia, przesylki, faktury i zwroty bez pozostalych dokumentow', () => {
    expect(ekranyRoli('produkcja')).toEqual([
      'zamowienia', 'przesylki', 'faktury-zamowienia', 'zwroty-zamowienia',
    ]);
  });

  it('nieznana rola nie daje zadnego ekranu', () => {
    expect(ekranyRoli('ksiegowa')).toEqual([]);
  });

  it('ROLE nie wymienia ekranu, ktorego nie ma w EKRANY', () => {
    const znane = new Set(EKRANY.map((e) => e.klucz));
    for (const rola of Object.keys(ROLE)) {
      for (const klucz of ekranyRoli(rola)) expect(znane.has(klucz)).toBe(true);
    }
  });
});
