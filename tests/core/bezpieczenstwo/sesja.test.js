import { describe, it, expect } from 'vitest';
import {
  NAZWA_CIASTECZKA_PANEL, NAZWA_CIASTECZKA_OMS, WAZNOSC_MS,
  nowySekret, podpisz, sprawdz, wartoOdswiezyc,
  ciasteczkoSesji, ciasteczkoWyczyszczenia, zNaglowka,
} from '../../../src/core/bezpieczenstwo/sesja.js';

const SEKRET = 'a'.repeat(64);
const TERAZ = 1_770_000_000_000;

describe('podpisz / sprawdz', () => {
  it('oddaje konto i date waznosci dla wlasnego podpisu', () => {
    const c = podpisz('adam', SEKRET, TERAZ);
    expect(sprawdz(c, SEKRET, TERAZ)).toEqual({ uzytkownik: 'adam', wygasa: TERAZ + WAZNOSC_MS });
  });

  it('odmawia przy INNYM sekrecie — to jest cala istota "wyloguj wszystkie urzadzenia"', () => {
    const c = podpisz('adam', SEKRET, TERAZ);
    expect(sprawdz(c, nowySekret(), TERAZ)).toBeNull();
  });

  it('odmawia, gdy ktos podmienil nazwe konta zachowujac podpis', () => {
    const c = podpisz('adam', SEKRET, TERAZ);
    const [, podpis] = c.split('.');
    const obca = Buffer.from(JSON.stringify({ u: 'ktos', do: TERAZ + WAZNOSC_MS }))
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(sprawdz(`${obca}.${podpis}`, SEKRET, TERAZ)).toBeNull();
  });

  it('odmawia, gdy ktos przedluzyl sobie waznosc', () => {
    const c = podpisz('adam', SEKRET, TERAZ);
    const [, podpis] = c.split('.');
    const dluzej = Buffer.from(JSON.stringify({ u: 'adam', do: TERAZ + WAZNOSC_MS * 100 }))
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(sprawdz(`${dluzej}.${podpis}`, SEKRET, TERAZ)).toBeNull();
  });

  it('odmawia przy podmienionym podpisie', () => {
    const c = podpisz('adam', SEKRET, TERAZ);
    const [tresc, podpis] = c.split('.');
    const inny = podpis.slice(0, -1) + (podpis.at(-1) === 'A' ? 'B' : 'A');
    expect(sprawdz(`${tresc}.${inny}`, SEKRET, TERAZ)).toBeNull();
  });

  it('odmawia sekunde PO terminie i przepuszcza sekunde przed', () => {
    const c = podpisz('adam', SEKRET, TERAZ);
    expect(sprawdz(c, SEKRET, TERAZ + WAZNOSC_MS - 1000)).not.toBeNull();
    expect(sprawdz(c, SEKRET, TERAZ + WAZNOSC_MS)).toBeNull();
    expect(sprawdz(c, SEKRET, TERAZ + WAZNOSC_MS + 1000)).toBeNull();
  });

  it.each([
    ['pusty tekst', ''],
    ['bez kropki', 'samatresc'],
    ['sama kropka', '.'],
    ['pusta tresc', '.podpis'],
    ['pusty podpis', 'tresc.'],
    ['tresc nie jest JSON-em', `${Buffer.from('nie-json').toString('base64url')}.x`],
    ['nie tekst', 12345],
    ['null', null],
  ])('odmawia dla smiecia: %s', (_nazwa, wartosc) => {
    expect(sprawdz(wartosc, SEKRET, TERAZ)).toBeNull();
  });

  it('odmawia, gdy sekretu nie ma — brak konfiguracji nie moze znaczyc "wpuszczaj"', () => {
    const c = podpisz('adam', SEKRET, TERAZ);
    expect(sprawdz(c, '', TERAZ)).toBeNull();
    expect(sprawdz(c, null, TERAZ)).toBeNull();
    expect(sprawdz(c, undefined, TERAZ)).toBeNull();
  });

  // ⚠️ Ten przypadek jest wazniejszy od powyzszego i wyszedl dopiero przy weryfikacji
  // mutacyjnej. Powyzsze przechodzi nawet BEZ straznika `!sekret`, bo HMAC liczony
  // pustym kluczem i tak nie zgadza sie z podpisem zlozonym prawdziwym sekretem.
  // Grozny jest przypadek SPOJNY: gdyby sekret nie dojechal z bazy, podpis liczylby sie
  // kluczem pustym — czyli publicznym — i kazdy moglby sobie wystawic wazne ciasteczko.
  it('odmawia ciasteczku podpisanemu pustym sekretem i sprawdzanemu pustym sekretem', () => {
    for (const brak of ['', null, undefined]) {
      expect(sprawdz(podpisz('ktokolwiek', brak, TERAZ), brak, TERAZ)).toBeNull();
    }
  });

  it('dwa kolejne sekrety daja rozne podpisy', () => {
    expect(nowySekret()).not.toBe(nowySekret());
    expect(nowySekret()).toHaveLength(64);
  });
});

describe('wartoOdswiezyc', () => {
  it('nie odswieza ciasteczka swiezo wydanego', () => {
    const s = sprawdz(podpisz('adam', SEKRET, TERAZ), SEKRET, TERAZ);
    expect(wartoOdswiezyc(s, TERAZ)).toBe(false);
  });

  it('nie odswieza tuz przed uplywem doby', () => {
    const s = sprawdz(podpisz('adam', SEKRET, TERAZ), SEKRET, TERAZ);
    expect(wartoOdswiezyc(s, TERAZ + 23 * 60 * 60 * 1000)).toBe(false);
  });

  it('odswieza po dobie — inaczej 90-dniowe ciasteczko wygaslo by mimo codziennej pracy', () => {
    const s = sprawdz(podpisz('adam', SEKRET, TERAZ), SEKRET, TERAZ);
    expect(wartoOdswiezyc(s, TERAZ + 25 * 60 * 60 * 1000)).toBe(true);
  });

  it('brak sesji to nie powod do odswiezania', () => {
    expect(wartoOdswiezyc(null, TERAZ)).toBe(false);
  });
});

describe('naglowek Set-Cookie', () => {
  it('zawsze niesie HttpOnly, SameSite=Lax i Path=/', () => {
    const c = ciasteczkoSesji(NAZWA_CIASTECZKA_PANEL, 'abc', { bezpieczne: false });
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Path=/');
    expect(c.startsWith(`${NAZWA_CIASTECZKA_PANEL}=abc;`)).toBe(true);
  });

  it('dokleja Secure WYLACZNIE po HTTPS — po HTTP przegladarka odrzucilaby ciasteczko', () => {
    expect(ciasteczkoSesji(NAZWA_CIASTECZKA_PANEL, 'abc', { bezpieczne: true })).toContain('Secure');
    expect(ciasteczkoSesji(NAZWA_CIASTECZKA_PANEL, 'abc', { bezpieczne: false })).not.toContain('Secure');
  });

  it('domyslny czas zycia zgadza sie z waznoscia podpisu', () => {
    expect(ciasteczkoSesji(NAZWA_CIASTECZKA_PANEL, 'abc', { bezpieczne: false }))
      .toContain(`Max-Age=${Math.floor(WAZNOSC_MS / 1000)}`);
  });

  it('ciasteczko kasujace ma zerowy czas zycia i te same flagi', () => {
    const c = ciasteczkoWyczyszczenia(NAZWA_CIASTECZKA_PANEL, { bezpieczne: true });
    expect(c).toContain('Max-Age=0');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('Secure');
    expect(c).toContain('Path=/');
  });
});

describe('zNaglowka', () => {
  it('znajduje sesje obok ciasteczka motywu', () => {
    expect(zNaglowka(NAZWA_CIASTECZKA_PANEL, `motyw=ciemny; ${NAZWA_CIASTECZKA_PANEL}=wartosc.podpis`)).toBe('wartosc.podpis');
    expect(zNaglowka(NAZWA_CIASTECZKA_PANEL, `${NAZWA_CIASTECZKA_PANEL}=wartosc.podpis; motyw=jasny`)).toBe('wartosc.podpis');
  });

  it('nie myli sie z ciasteczkiem o nazwie zawierajacej nasza', () => {
    expect(zNaglowka(NAZWA_CIASTECZKA_PANEL, `inna${NAZWA_CIASTECZKA_PANEL}=obca`)).toBeNull();
    expect(zNaglowka(NAZWA_CIASTECZKA_PANEL, `${NAZWA_CIASTECZKA_PANEL}_stara=obca`)).toBeNull();
  });

  it.each([
    ['brak naglowka', undefined],
    ['pusty naglowek', ''],
    ['tylko inne ciasteczka', 'motyw=ciemny'],
    ['pusta wartosc', `${NAZWA_CIASTECZKA_PANEL}=`],
    ['nie tekst', 42],
  ])('oddaje null: %s', (_nazwa, naglowek) => {
    expect(zNaglowka(NAZWA_CIASTECZKA_PANEL, naglowek)).toBeNull();
  });
});
