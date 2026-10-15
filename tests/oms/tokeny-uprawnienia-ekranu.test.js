import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { createTokeny } from '../../src/oms/allegro/tokeny.js';
import { WYMAGANE_UPRAWNIENIA } from '../../src/domena/uprawnienia-kanalu.js';

// OKABLOWANIE: `stanDlaEkranu()` musi NAPRAWDE liczyc braki z tokenu, a nie tylko oddawac
// pusta liste. Regula w domenie i tak byla przetestowana osobno — tu chodzi o to, czy
// ktokolwiek jej uzywa. Bez tego bariera wiazania nigdy sie nie otworzy, a panel bedzie
// twierdzil, ze kanal ma komplet.

const ustawienia = {
  auth: 'https://allegro.pl/auth/oauth',
  clientId: 'id', clientSecret: 'sekret',
  userAgent: 'Panel/0.0.0 (+https://przyklad.invalid)',
};

const jwt = (scope) => [
  'naglowek', Buffer.from(JSON.stringify({ scope })).toString('base64url'), 'podpis',
].join('.');

function baza(accessToken) {
  const db = openOmsDb(':memory:');
  db.prepare(`INSERT INTO tokeny_kanalu
    (kanal, access_token, refresh_token, wygasa_at, refresh_wygasa_at, zaktualizowane_at)
    VALUES (?,?,?,?,?,?)`)
    .run('allegro_szkicownia', accessToken, 'refresz', '2027-01-01T00:00:00.000Z',
      '2027-01-01T00:00:00.000Z', '2026-08-28T06:39:38.999Z');
  return db;
}

const stan = (db) => createTokeny({ db, kanal: 'allegro_szkicownia', ustawienia }).stanDlaEkranu();

describe('stanDlaEkranu — brakujące uprawnienia', () => {
  it('token z kompletem nie zgłasza braków', () => {
    expect(stan(baza(jwt(WYMAGANE_UPRAWNIENIA))).brakujaceUprawnienia).toEqual([]);
  });

  // Dokladnie ten zestaw zmierzono na produkcji 28.08.2026 na OBU kanalach.
  it('token sprzed dodania uprawnień zgłasza messaging i disputes', () => {
    const piec = [
      'allegro:api:orders:read', 'allegro:api:sale:offers:read',
      'allegro:api:shipments:read', 'allegro:api:shipments:write', 'allegro:api:orders:write',
    ];
    const braki = stan(baza(jwt(piec))).brakujaceUprawnienia;
    expect(braki).toEqual(['allegro:api:messaging', 'allegro:api:disputes']);
  });

  // ⚠️ NIEZMIENNIK 4.10: na ekran ida NAZWY ZAKRESOW, nigdy sam token.
  it('stan dla ekranu NIE niesie tokenu ani refresh tokenu', () => {
    const s = stan(baza(jwt(WYMAGANE_UPRAWNIENIA)));
    const tekst = JSON.stringify(s);
    expect(tekst).not.toContain('refresz');
    expect(tekst).not.toContain('naglowek.');
    expect(s.access_token).toBeUndefined();
    expect(s.refresh_token).toBeUndefined();
  });

  // ⚠️ Kanal bez pary tokenow ma `polaczony: false` i wiazanie otwiera sie przez `pilne`,
  // a nie przez liste brakow — wiec „nie wiem" zostaje puste i nie otwiera bariery na domysle.
  it('kanał bez wiersza w bazie nie zgłasza braków — to nie jest wiedza, tylko jej brak', () => {
    const db = openOmsDb(':memory:');
    expect(stan(db).brakujaceUprawnienia).toEqual([]);
    expect(stan(db).polaczony).toBe(false);
  });
});

// ⚠️⚠️ OKABLOWANIE KONTA ALLEGRO. Regula (`domain/tozsamosc-kanalu.js`) byla przetestowana
// osobno — tu chodzi o to, czy KTOKOLWIEK jej uzywa. Bez tego pola ekran nie ma czego
// pokazac, a bariera kolizji nie ma czego porownac: kanal zwiazany z cudzym kontem znowu
// przeszedlby jako zdrowy, dokladnie jak 28.08.2026.
describe('stanDlaEkranu — konto Allegro', () => {
  const jwtZKontem = (user_name) => [
    'naglowek', Buffer.from(JSON.stringify({ user_name, scope: [] })).toString('base64url'), 'podpis',
  ].join('.');

  it('oddaje identyfikator konta z tokenu', () => {
    expect(stan(baza(jwtZKontem('36457435'))).kontoAllegro).toBe('36457435');
  });

  it('oddaje null, gdy tokenu nie da sie odczytac — i NIE rzuca', () => {
    expect(stan(baza('nie-jest-jwt')).kontoAllegro).toBeNull();
  });

  it('⚠️ NIE WYPYCHA SAMEGO TOKENU na ekran (niezmiennik 4.10)', () => {
    const wynik = stan(baza(jwtZKontem('36457435')));
    expect(JSON.stringify(wynik)).not.toContain('naglowek');
    expect(wynik.access_token).toBeUndefined();
    expect(wynik.refresh_token).toBeUndefined();
  });
});
