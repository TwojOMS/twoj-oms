// PRZ-147.02b — „zlecenie sprzed wydania” (dopisek właściciela): zwrot z rezerwacją korekty i referencją, które zostawił
// stary kod, a inFakt dla tej referencji oddaje 422. Wejście na ekran zwrotu ma to odblokować samo: odczyt statusu →
// `korekta_blad` po polsku + zwolnienie rezerwacji → przycisk „Wystaw korektę” wraca. Bez operacji na bazie.
//
// Pełna aplikacja (zbudujOms), PRAWDZIWY klient inFaktu z klucza w env, `fetch` podmieniony: status zlecenia oddaje
// zapisaną odpowiedź tests/dane/prz147-korekta-422.json, każde inne żądanie jest zapisywane i odpowiada 404.
// Dane zmyślone (Pracownia Półcień, example.test, referencja REF-POLCIEN-…).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { dodajZwrot, zwrot } from '../../../src/oms/db/zwroty.js';

const ODMOWA_422 = readFileSync(new URL('../../dane/prz147-korekta-422.json', import.meta.url), 'utf8');
const REFERENCJA = 'REF-POLCIEN-SPRZED-WYDANIA';
const env = {
  OMS_DB_PATH: ':memory:', OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
  OMS_USER: 'operator', OMS_PASS: 'test', OMS_PROFORMY_KATALOG: '.', OMS_ETYKIETY_KATALOG: '.',
  INFAKT_API_KEY: 'zmyslony-klucz-prz147-000000000001',
};
const headers = { authorization: `Basic ${Buffer.from('operator:test').toString('base64')}` };

afterEach(() => vi.unstubAllGlobals());

function atrapaFetch() {
  const zadania = [];
  const fetchAtrapa = vi.fn(async (adres) => {
    const u = new URL(String(adres));
    zadania.push(`${u.pathname}${u.search}`);
    if (u.pathname === `/api/v3/async/corrective_invoices/status/${REFERENCJA}.json`) {
      return new Response(ODMOWA_422, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'nieznany zasób' }), { status: 404, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchAtrapa);
  return zadania;
}

describe('PRZ-147.02b zlecenie sprzed wydania odblokowuje się przy wejściu na ekran zwrotu', () => {
  it('422 ze statusu: rezerwacja zwolniona, błąd po polsku, przycisk wraca, jeden wpis w logu; drugie wejście nic nie pyta', async () => {
    const zadania = atrapaFetch();
    const a = await zbudujOms({ env, teraz: () => new Date('2026-11-04T15:00:00Z'), log: () => {} });
    try {
      const id = zapiszZamowienie(a.db, 'reczne', {
        zrodlo_id: 14705, numer: '14705', klient: { company: 'Pracownia Półcień', email: 'biuro@polcien.example.test' },
        dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: null, kwota_brutto: '258.00',
        status_woo: 'processing', oplacone_at: null, anulowane: 0, utworzone_at: '2026-11-01T10:00:00',
        pozycje: [{ zrodlo_id: 11, nazwa: 'Lampa Półcień', sku: 'LAMPA-P1', ilosc: 2, cena_brutto: '129.00',
          brutto_linii: '258.00', vat: null }],
      }, {});
      a.db.prepare('INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?,?,?,?)')
        .run(id, 'polcien-fv-5', 'FV 5/11/2026', '2026-11-02T10:00:00Z');
      const zwrotId = dodajZwrot(a.db, id, { data: '2026-11-04', kwota: '129.00',
        pozycje: [{ klucz_pozycji: 's11', nazwa: 'Lampa Półcień', ilosc: 1, kwota: '129.00' }] }).id;
      // Wiersz wprost — tak, jak go zostawił stary kod: zlecenie ponad 15 min temu, referencja, bez numeru i bez błędu.
      a.db.prepare('UPDATE zwroty SET korekta_zlecona_at = ?, korekta_referencja = ?, korekta_numer = NULL, korekta_blad = NULL WHERE id = ?')
        .run('2026-11-04T14:19:49Z', REFERENCJA, zwrotId);
      const wpisy = () => a.db.prepare("SELECT wynik FROM log WHERE zamowienie_id = ? AND akcja = 'zwrot.korekta.odczyt'").all(id);

      const r = await a.app.inject({ method: 'GET', url: `/zamowienia/${id}/zwrot`, headers });
      expect(r.statusCode, r.body).toBe(200);
      expect(zadania).toEqual([`/api/v3/async/corrective_invoices/status/${REFERENCJA}.json`]);
      const w = zwrot(a.db, id, zwrotId);
      expect(w.korekta_zlecona_at).toBeNull();
      expect(w.korekta_blad).toContain('klient — Proszę wybrać klienta.');
      expect(w.korekta_blad).toContain('powód korekty — Proszę podać powód korekty.');
      expect(r.body).toContain(`action="/zamowienia/${id}/zwroty/${zwrotId}/korekta"`);
      expect(r.body).toContain('Wystaw korektę');
      expect(r.body).toContain('<span class="pasek-blokada">inFakt nie wystawił korekty: klient — Proszę wybrać klienta.;'
        + ' powód korekty — Proszę podać powód korekty. Popraw i wystaw ponownie.</span>');
      expect(wpisy()).toHaveLength(1);

      const r2 = await a.app.inject({ method: 'GET', url: `/zamowienia/${id}/zwrot`, headers });
      expect(r2.statusCode).toBe(200);
      expect(zadania).toHaveLength(1);
      expect(wpisy()).toHaveLength(1);
      expect(r2.body).toContain(`action="/zamowienia/${id}/zwroty/${zwrotId}/korekta"`);
    } finally {
      await a.app.close();
      a.db.close();
    }
  });
});
