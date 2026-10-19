import { it, expect } from 'vitest';
import { nowyPanel, BASIC, get, post } from '../../pomoc/konta-prz068.js';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';

it('lista i karta renderują pełną 40-znakową nazwę statusu w etykiecie zawijanej osobno od licznika i kropki', async () => {
  const { db, app } = nowyPanel();
  const nazwa = 'Czeka na wpłatę od klienta przed wysyłką';
  try {
    expect([...nazwa]).toHaveLength(40);
    await post(app, '/ustawienia/statusy', BASIC, { akcja: 'edytuj', klucz: 'nowe', etykieta: nazwa, kolor: 'fioletowy' });
    const id = zapiszZamowienie(db, 'reczne', {
      zrodlo_id: 'menu-test', numer: 'LAMPA-MENU', kwota_brutto: '10.00', status_woo: 'processing',
      klient: {}, dostawa: {}, metoda_wysylki: 'dpd', oplacone_at: null, nip: null,
      kwota_pobrania: null, chce_fakture: 0, anulowane: 0,
      pozycje: [], utworzone_at: '2026-10-18T12:00:00Z',
    }, {});
    for (const url of ['/', `/zamowienia/${id}`]) {
      const ekran = await get(app, url, BASIC);
      expect(ekran.statusCode).toBe(200);
      const menu = ekran.body.match(/<ul class="oms-statusy"[\s\S]*?<\/ul>/g);
      expect(menu).toHaveLength(2);
      for (const html of menu) {
        expect(html).toContain(`<span class="oms-status-etykieta">${nazwa}</span>`);
        expect(html).toMatch(/<span class="kropka znacznik--zwrot"><\/span><span class="oms-status-etykieta">/);
        expect(html).toMatch(/<span class="licznik"[^>]*>1<\/span>/);
      }
    }
  } finally { await app.close(); db.close(); }
});
