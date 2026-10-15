import { describe, it, expect } from 'vitest';
import {
  WYMAGANE_UPRAWNIENIA, uprawnieniaZTokenu, brakujaceUprawnienia,
} from '../../src/domena/uprawnienia-kanalu.js';

// ⚠️⚠️ ODSWIEZENIE TOKENU ZACHOWUJE ZAKRESY Z PIERWOTNEJ AUTORYZACJI. Uprawnienie dodane
// pozniej w aplikacji na apps.developer.allegro.pl NIE POJAWI SIE w tokenie samo — wchodzi
// wylacznie przy NOWEJ autoryzacji (device flow). Zmierzone 28.08.2026: oba kanaly mialy
// dokladnie te same piec zakresow co 05.08, mimo ze `messaging` i `disputes` byly juz
// nadane w aplikacji, a para tokenow odswiezala sie tego samego dnia rano.

const jwt = (payload) => [
  'naglowek',
  Buffer.from(JSON.stringify(payload)).toString('base64url'),
  'podpis',
].join('.');

const PELNE = WYMAGANE_UPRAWNIENIA;
const PIEC_STARYCH = [
  'allegro:api:orders:read', 'allegro:api:sale:offers:read',
  'allegro:api:shipments:read', 'allegro:api:shipments:write', 'allegro:api:orders:write',
];

describe('uprawnienia kanału z tokenu', () => {
  it('czyta listę zakresów z tokenu JWT', () => {
    expect(uprawnieniaZTokenu(jwt({ scope: PIEC_STARYCH }))).toEqual(PIEC_STARYCH);
  });

  // ⚠️ NIGDY NIE RZUCA — to woła ekran stanu kanału i pasek spraw. Wyjątek tutaj wywaliłby
  // listę zamówień z powodu tokenu, którego kształtu nie znamy.
  it.each([
    ['pusty', ''],
    ['null', null],
    ['nie JWT', 'zwykly-napis'],
    ['zepsuty base64', 'a.!!!.c'],
    ['payload bez scope', jwt({ user_name: '36457435' })],
    ['scope nie jest tablicą', jwt({ scope: 'allegro:api:orders:read' })],
  ])('token %s daje pustą listę, a nie wyjątek', (_opis, token) => {
    expect(() => uprawnieniaZTokenu(token)).not.toThrow();
    expect(uprawnieniaZTokenu(token)).toEqual([]);
  });

  it('komplet uprawnień daje pustą listę braków', () => {
    expect(brakujaceUprawnienia(jwt({ scope: PELNE }))).toEqual([]);
  });

  it('token sprzed dodania uprawnień pokazuje OBA braki', () => {
    const braki = brakujaceUprawnienia(jwt({ scope: PIEC_STARYCH }));
    expect(braki).toContain('allegro:api:messaging');
    expect(braki).toContain('allegro:api:disputes');
  });

  it('nadmiarowe uprawnienie NIE jest brakiem', () => {
    expect(brakujaceUprawnienia(jwt({ scope: [...PELNE, 'allegro:api:ratings'] }))).toEqual([]);
  });

  // ⚠️⚠️ NIECZYTELNY TOKEN TO „NIE WIEM", NIE „BRAK". Ta lista otwiera barierę ponownego
  // wiązania, a wiązanie NADPISUJE działającą parę tokenów nieodwracalnie. Otwieranie jej
  // na domyśle znaczyłoby, że token o nieznanym kształcie zaprasza do zabicia sprawnego
  // kanału. Kanał bez pary tokenów i tak ma `polaczony: false` i otwiera wiązanie inną drogą.
  it.each([['brak tokenu', null], ['nie JWT', 'a'], ['pusty', '']])(
    '%s NIE jest zgłaszany jako brak uprawnień',
    (_opis, token) => { expect(brakujaceUprawnienia(token)).toEqual([]); },
  );

  it('lista wymaganych obejmuje Centrum wiadomości i dyskusje', () => {
    expect(WYMAGANE_UPRAWNIENIA).toContain('allegro:api:messaging');
    expect(WYMAGANE_UPRAWNIENIA).toContain('allegro:api:disputes');
    // ⚠️ I NIE GUBI TYCH, KTORE JUZ DZIALAJA — lista jest kompletem, nie dodatkiem.
    expect(WYMAGANE_UPRAWNIENIA).toContain('allegro:api:orders:write');
    expect(WYMAGANE_UPRAWNIENIA).toContain('allegro:api:shipments:write');
  });
});
