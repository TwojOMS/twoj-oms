import { it, expect } from 'vitest';
import { nowyPanel, BASIC, get, post } from '../../pomoc/konta-prz068.js';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { dopiszKlienta } from '../../../src/oms/db/klienci.js';
import { znormalizujKlienta } from '../../../src/domena/klient-staly.js';

it('lista, karta i historia klienta zawijają pełną nazwę statusu, a pole masowej zmiany ma ograniczoną szerokość', async () => {
  const { db, app } = nowyPanel();
  const nazwa = 'Czeka na wpłatę od klienta przed wysyłką';
  try {
    await post(app, '/ustawienia/statusy', BASIC, { akcja: 'edytuj', klucz: 'nowe', etykieta: nazwa, kolor: 'fioletowy' });
    const id = zapiszZamowienie(db, 'reczne', {
      zrodlo_id: 'pastylka-test', numer: 'LAMPA-STATUS', kwota_brutto: '10.00', status_woo: 'processing',
      klient: {}, dostawa: {}, metoda_wysylki: 'dpd', oplacone_at: null, nip: '0000000000',
      kwota_pobrania: null, chce_fakture: 0, anulowane: 0,
      pozycje: [], utworzone_at: '2026-10-18T12:00:00Z',
    }, {});
    const klientId = dopiszKlienta(db, znormalizujKlienta({ klucz: 'lampy-test', nazwa: 'Pracownia Przykładowa', nip: '0000000000' }));
    for (const url of ['/', `/zamowienia/${id}`, `/klienci/${klientId}`]) {
      const ekran = await get(app, url, BASIC);
      expect(ekran.statusCode, url).toBe(200);
      expect(new RegExp(`<span class="[^"]*znacznik-statusu[^"]*">${nazwa}</span>`).test(ekran.body), url).toBe(true);
      const stylPastylki = ekran.body.match(/\.znacznik-statusu\s*\{([^}]+)\}/)?.[1];
      expect(stylPastylki).toMatch(/white-space:\s*normal/);
      expect(stylPastylki).toMatch(/max-width:\s*100%/);
      expect(stylPastylki).toMatch(/overflow-wrap:\s*anywhere/);
      if (url === '/') expect(ekran.body).toMatch(/#masowy-status\s*\{[^}]*max-width:\s*10rem/);
    }
  } finally { await app.close(); db.close(); }
});
