import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';

describe('PRZ-024 — zwroty w produkcyjnej kompozycji', () => {
  it('domyślny zbudujOms rejestruje POST zwrotu i utrwala zapis oraz log', async () => {
    const katalog = mkdtempSync(join(tmpdir(), 'oms-prz024-kompozycja-'));
    const plik = join(katalog, 'oms.sqlite');
    const fetch = vi.fn(async () => { throw new Error('Test kompozycji nie zezwala na sieć'); });
    vi.stubGlobal('fetch', fetch);
    let aplikacja, ponownie;
    try {
      // Bez listy moduly, nadpisania i ręcznie zbudowanego Fastify: ścieżka produktu.
      aplikacja = await zbudujOms({ env: {
        OMS_DB_PATH: plik, OMS_SPRZEDAWCA_NIP: '1234563218',
        OMS_RACHUNEK: '34109010140000000000000000', OMS_USER: 'operator', OMS_PASS: 'test',
        OMS_PROFORMY_KATALOG: katalog, OMS_ETYKIETY_KATALOG: katalog,
      } });
      const id = zapiszZamowienie(aplikacja.db, 'kanal-testowy', {
        zrodlo_id: 901, numer: '901', klient: null, dostawa: null, metoda_wysylki: 'dpd',
        kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '220.00',
        koszt_dostawy_brutto: '20.00', koszt_dostawy_netto: '16.26', status_woo: 'processing',
        oplacone_at: null, anulowane: 0, utworzone_at: '2026-08-01T12:00:00',
        pozycje: [{ zrodlo_id: 731, nazwa: 'Produkt testowy', sku: 'TEST', ilosc: 4,
          cena_brutto: '50.00', cena_netto: '40.65', brutto_linii: '200.00', netto_linii: '162.60', vat: null }],
      }, {});
      const klucz = pobierzZamowienie(aplikacja.db, id).pozycje[0].klucz;
      const r = await aplikacja.app.inject({ method: 'POST', url: `/zamowienia/${id}/zwrot`,
        headers: { authorization: 'Basic ' + Buffer.from('operator:test').toString('base64'),
          origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ data: '2026-08-02', kwota: '50,00', kwota_dostawy: '10,00',
          powod: 'Uszkodzenie', klucz, nazwa: 'Produkt testowy', ilosc: '1', pozycja_kwota: '50,00' }).toString(),
      });
      // Ta asercja musi dać 404 zamiast 302 po wyłączeniu manifestu w bootstrapie.
      expect(r.statusCode).toBe(302);
      expect(r.headers.location).toBe(`/zamowienia/${id}`);
      await aplikacja.app.close(); aplikacja.db.close(); aplikacja = null;
      ponownie = openOmsDb(plik);
      const zwroty = ponownie.prepare('SELECT * FROM zwroty WHERE zamowienie_id=?').all(id);
      expect(zwroty).toHaveLength(1);
      expect(zwroty[0]).toMatchObject({ data: '2026-08-02', kwota: '50.00', kwota_dostawy: '10.00', powod: 'Uszkodzenie' });
      expect(ponownie.prepare('SELECT klucz_pozycji,nazwa,ilosc,kwota FROM zwroty_pozycje WHERE zwrot_id=?').all(zwroty[0].id))
        .toEqual([{ klucz_pozycji: klucz, nazwa: 'Produkt testowy', ilosc: 1, kwota: '50.00' }]);
      expect(ponownie.prepare("SELECT wynik FROM log WHERE zamowienie_id=? AND akcja='zwrot.rejestracja'").all(id))
        .toEqual([{ wynik: 'DECYZJA CZŁOWIEKA (operator): zarejestrowany zwrot z 2026-08-02 na 50.00 zł + dostawa 10.00 zł, pozycji: 1; powód: Uszkodzenie.' }]);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      if (aplikacja) { await aplikacja.app.close(); aplikacja.db.close(); }
      ponownie?.close();
      rmSync(katalog, { recursive: true, force: true });
      vi.unstubAllGlobals();
    }
  });
});
