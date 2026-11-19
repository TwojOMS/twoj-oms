// Limit informacji o bezpieczeństwie jest w dwóch miejscach: w treści oferty Allegro (odmowa przy wystawianiu)
// i w ustawieniach ofert konta (tekst domyślny). Karta pokazuje licznik według pierwszego, a tekst domyślny konta
// zapisuje się według drugiego — rozjazd dałby tekst, który przechodzi w jednym miejscu, a odpada w drugim.
import { describe, it, expect } from 'vitest';
import { LIMIT_INFORMACJI_BEZPIECZENSTWA } from '../../src/domena/allegro-oferta-z-karty.js';
import { BEZPIECZENSTWO_MAKS_ZNAKOW } from '../../src/oms/db/oferty-kanalow.ts';

describe('limit informacji o bezpieczeństwie', () => {
  it('oferta i ustawienia konta mają ten sam limit znaków', () => {
    expect(LIMIT_INFORMACJI_BEZPIECZENSTWA).toBe(BEZPIECZENSTWO_MAKS_ZNAKOW);
    expect(LIMIT_INFORMACJI_BEZPIECZENSTWA).toBe(5000);
  });
});
