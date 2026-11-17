import { describe, it, expect } from 'vitest';
import {
  WYMAGANE_UPRAWNIENIA, UPRAWNIENIA_OFERT, brakujaceUprawnienia, maZgodeNaOferty,
} from '../../src/domena/uprawnienia-kanalu.js';
import { UPRAWNIENIA_NOWEGO_POLACZENIA, odczytajPare } from '../../src/oms/allegro/oauth-code.ts';

// Zakresy ofert sa OPCJONALNE. Konto bez nich dziala jak dzis —
// nie jest „niekompletne", wiec nie otwiera bariery wiazania i nie trafia na pasek spraw.

const jwt = (scope) => [
  'naglowek', Buffer.from(JSON.stringify({ scope })).toString('base64url'), 'podpis',
].join('.');

describe('zakresy ofert (D42)', () => {
  it('lista zakresow ofert to dokladnie zapis ofert i odczyt ustawien sprzedazy', () => {
    expect(UPRAWNIENIA_OFERT).toEqual(['allegro:api:sale:offers:write', 'allegro:api:sale:settings:read']);
  });

  it('konto bez zgody na oferty jest kompletne', () => {
    // Lista dosłowna (nie ze stałej) — zgoda zwykłego, działającego konta sprzed E3.
    const t = jwt([
      'allegro:api:orders:read', 'allegro:api:orders:write', 'allegro:api:sale:offers:read',
      'allegro:api:shipments:read', 'allegro:api:shipments:write', 'allegro:api:messaging',
      'allegro:api:disputes', 'allegro:api:profile:read',
    ]);
    expect(brakujaceUprawnienia(t)).toEqual([]);
    expect(maZgodeNaOferty(t)).toBe(false);
  });

  it('zakresy ofert nie sa wymagane ani w nowym polaczeniu', () => {
    for (const u of UPRAWNIENIA_OFERT) {
      expect(WYMAGANE_UPRAWNIENIA).not.toContain(u);
      expect(UPRAWNIENIA_NOWEGO_POLACZENIA).not.toContain(u);
    }
    expect(UPRAWNIENIA_NOWEGO_POLACZENIA).toHaveLength(8);
  });

  it('zgoda na oferty wymaga obu zakresow', () => {
    expect(maZgodeNaOferty(jwt([...WYMAGANE_UPRAWNIENIA, ...UPRAWNIENIA_OFERT]))).toBe(true);
    expect(maZgodeNaOferty(jwt([...WYMAGANE_UPRAWNIENIA, 'allegro:api:sale:offers:write']))).toBe(false);
  });

  it('nieczytelny token to brak zgody, bez wyjatku', () => {
    expect(maZgodeNaOferty(null)).toBe(false);
    expect(maZgodeNaOferty('bez-kropek')).toBe(false);
  });

  it('zgoda bez zakresów ofert przechodzi, z nimi też — opcjonalne nie są błędem', () => {
    const para = (scope) => odczytajPare({ access_token: 'a.b.c', refresh_token: 'r', expires_in: 60, scope: scope.join(' ') },
      () => new Date('2026-11-14T00:00:00Z'));
    expect(para([...UPRAWNIENIA_NOWEGO_POLACZENIA]).ok).toBe(true);
    const z = para([...UPRAWNIENIA_NOWEGO_POLACZENIA, ...UPRAWNIENIA_OFERT]);
    expect(z.ok && z.dane.uprawnienia).toEqual(expect.arrayContaining([...UPRAWNIENIA_OFERT]));
    const legacy = odczytajPare({ access_token: 'a.b.c', refresh_token: 'r', scope: WYMAGANE_UPRAWNIENIA.join(' ') }, undefined, true);
    expect(legacy.ok).toBe(true);
  });
});
