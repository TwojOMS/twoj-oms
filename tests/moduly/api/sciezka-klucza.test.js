import { isDeepStrictEqual } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { nowyPanel, jako, get, post, BASIC } from '../../pomoc/konta-prz068.js';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { ZAKRESY_API } from '../../../src/domena/klucze-api.js';

const ekran = '/ustawienia/klucze-api';
const ja = '/api/v1/ja';
const panele = [];

afterEach(async () => {
  for (const { app, db } of panele.splice(0)) {
    await app.close();
    db.close();
  }
});

describe('Pełna ścieżka klucza API: ekran → /ja → odwołanie → 401', () => {
  it('tworzy klucz na ekranie, rozpoznaje go niezależnie od sesji i odmawia po odwołaniu', async () => {
    const { app, db } = nowyPanel();
    panele.push({ app, db });
    zalozKonto(db, { login: 'administrator-testowy', imie: 'Tester', haslo: 'h', admin: true, rola: 'administrator' });
    const admin = jako(db, 'administrator-testowy');
    const nazwa = 'Pracownia Półcień — drukarka';
    const zakresy = ['zamowienia:odczyt', 'druk'];

    // 1. Klucz pochodzi wyłącznie z odpowiedzi formularza pełnego panelu.
    const formularz = await get(app, ekran, admin);
    expect(formularz.statusCode).toBe(200);
    const jednorazowy = /name="jednorazowy" value="([^"]+)"/.exec(formularz.body)?.[1];
    expect(Boolean(jednorazowy)).toBe(true);
    const utworzony = await post(app, ekran, admin, { nazwa, zakresy, jednorazowy });
    expect(utworzony.statusCode).toBe(200);
    const klucz = /toms_[a-z0-9]{8}_[A-Za-z0-9_-]{43}/.exec(utworzony.body)?.[0];
    expect(Boolean(klucz)).toBe(true);
    const prefiks = klucz.slice(5, 13);
    const bearer = { authorization: `Bearer ${klucz}` };
    const tozsamosc = { nazwa, prefiks, zakresy: ZAKRESY_API.filter(z => zakresy.includes(z)) };

    // 2–3. Bez ciasteczka oraz z sesją admina odpowiedź opisuje ten sam klucz.
    for (const headers of [bearer, { ...admin, ...bearer }]) {
      const r = await app.inject({ method: 'GET', url: ja, headers });
      expect(r.statusCode).toBe(200);
      // Porównanie boolowskie chroni pełny klucz także w diagnostyce nieudanego testu.
      expect(isDeepStrictEqual(r.json(), tozsamosc)).toBe(true);
    }

    // 4. Ani sesja bez Bearer, ani błędny klucz, ani Basic nie zastępują klucza API.
    const zlyKlucz = `toms_zzzzzzzz_${'D'.repeat(43)}`;
    async function odmowa(headers) {
      const r = await app.inject({ method: 'GET', url: ja, headers });
      expect(r.statusCode, 'Odmowa dostępu do API wymaga 401').toBe(401);
      expect(r.json().kod === 'klucz').toBe(true);
      expect(r.body.includes(klucz)).toBe(false);
      expect(r.body.includes(zlyKlucz)).toBe(false);
    }
    for (const headers of [{}, admin, { authorization: `Bearer ${zlyKlucz}` }, BASIC]) {
      await odmowa(headers);
    }

    // 6. Czynny klucz nie otwiera ekranów panelu bez sesji.
    const ekranKluczem = await get(app, '/zamowienia', bearer);
    expect([302, 303, 401].includes(ekranKluczem.statusCode)).toBe(true);

    // 5. Odwołanie przez ekran musi natychmiast zamknąć dostęp do /ja.
    const { id } = db.prepare('SELECT id FROM klucze_api WHERE prefiks = ?').get(prefiks);
    const odwolany = await post(app, `${ekran}/${id}/odwolaj`, admin, { potwierdzam: 'tak' });
    expect(odwolany.statusCode).toBe(303);
    expect(odwolany.headers.location).toBe(ekran);
    await odmowa(bearer);
  });
});
