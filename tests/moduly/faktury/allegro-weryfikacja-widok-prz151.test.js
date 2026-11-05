import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

async function karta(weryfikacja) {
  const db = openOmsDb(':memory:');
  const id = zapiszZamowienie(db, 'allegro_polcien', {
    zrodlo_id: 'PC-1', numer: 'PC-1', kwota_brutto: '100.00', chce_fakture: 1, pozycje: [],
    klient: { first_name: 'Jan', company: 'Pracownia Półcień', email: 'jan@example.test' },
    dostawa: { city: 'Warszawa' }, metoda_wysylki: 'allegro_dpd', kwota_pobrania: null,
    nip: null, status_woo: null, oplacone_at: null, anulowane: 0, utworzone_at: '2026-10-20T08:00:00',
  }, {});
  db.prepare(`INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, allegro_invoice_id,
    allegro_wyslana_at, allegro_weryfikacja, utworzona_at) VALUES (?,?,?,?,?,?,?)`)
    .run(id, 'u-1', 'FV/1', 'INV-1', '2026-10-29T11:00:00', weryfikacja, '2026-10-20T10:00:00');
  const app = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'test' } } });
  try {
    await app.ready();
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`,
      headers: { authorization: 'Basic ' + Buffer.from('operator:test').toString('base64') } });
    expect(r.statusCode).toBe(200);
    return r.body.replace(/\s+/g, ' ');
  } finally {
    await app.close();
    db.close();
  }
}

describe('weryfikacja pliku Allegro na karcie zamówienia', () => {
  it('WAITING wyjaśnia brak wyniku', async () => {
    const html = await karta('WAITING');
    expect(html).toContain('Weryfikacja pliku: Allegro nie podaje jej wyniku — panel nie wie, czy plik przeszedł.');
    expect(html).not.toContain('Weryfikacja pliku: WAITING.');
    expect(html).toMatch(/class="waga waga--ok" title="Weryfikacja pliku: Allegro nie podaje jej wyniku — panel nie wie, czy plik przeszedł\.">Wysłana do Allegro 29\.10<\/span>/u);
    expect(html).toContain('Faktura jest na koncie kupującego w Allegro — błąd poprawisz tylko korektą.');
    expect(html).not.toMatch(/WAITING|Allegro sprawdza/u);
    expect(html).not.toContain('Tego się nie cofa');
  });

  it('REJECTED ma plakietkę odmowy i nie mówi o fakturze na koncie kupującego', async () => {
    const html = await karta('REJECTED');
    expect(html).toContain('<span class="waga waga--blokada">Allegro odrzuciło plik</span>');
    expect(html).not.toContain('Faktura jest na koncie kupującego w Allegro');
    expect(html).not.toContain('REJECTED');
  });

  it('ACCEPTED pokazuje bez zmian', async () => {
    expect(await karta('ACCEPTED')).toContain('Weryfikacja pliku: ACCEPTED.');
  });

  it('brak weryfikacji pokazuje jako nieznaną', async () => {
    expect(await karta(null)).toContain('Weryfikacja pliku: nieznana.');
  });
});
