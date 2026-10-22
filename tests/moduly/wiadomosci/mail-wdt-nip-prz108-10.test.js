// PRZ-108.10 — mail „Faktura” WDT w PEŁNYM składzie (wzór: test recenzenta po/tests/recenzja-mail-wdt.test.js):
// moduł wiadomości dostaje NIP z konfiguracji faktur (config.nipBdoFirmy) — bez NIP-u złożenie odmawia, z NIP-em z panelu
// potwierdzenie wywozu w kopercie niesie NIP z panelu, bez restartu. Atrapa sieci (PDF faktury), nic nie wychodzi.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { rozpocznijFakture, zakonczFakture } from '../../../src/moduly/faktury/db/faktury.js';
import { zapiszNipFirmy } from '../../../src/oms/db/nip-bdo-firmy.js';
import { zbudujOswiadczenieWywozuPdf } from '../../../src/moduly/faktury/pdf/oswiadczenie-wywozu-pdf.js';

vi.mock('../../../src/moduly/faktury/pdf/oswiadczenie-wywozu-pdf.js', async (o) => {
  const m = await o();
  return { ...m, zbudujOswiadczenieWywozuPdf: vi.fn((...a) => m.zbudujOswiadczenieWywozuPdf(...a)) };
});

let katalog;
beforeEach(() => {
  katalog = mkdtempSync(join(tmpdir(), 'prz108-10-mail-'));
  vi.mocked(zbudujOswiadczenieWywozuPdf).mockClear();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(Buffer.from('%PDF-atrapa'), { status: 200,
    headers: { 'content-type': 'application/pdf' } }));
});
afterEach(() => { vi.restoreAllMocks(); rmSync(katalog, { recursive: true, force: true }); });

describe('PRZ-108.10 mail faktury WDT w pełnym składzie', () => {
  it('bez NIP-u odmowa złożenia; NIP z panelu trafia na potwierdzenie wywozu w kopercie', async () => {
    const env = { OMS_TRYB: 'produkcja', OMS_USER: 'operator', OMS_PASS: 'fixture', OMS_RACHUNEK: '34109010140000000000000000',
      OMS_PROFORMY_KATALOG: katalog, OMS_ETYKIETY_KATALOG: katalog, INFAKT_API_KEY: 'fixture',
      SMTP_HOST: 'smtp.fikcja.invalid', SMTP_USER: 'oms@fikcja.invalid', SMTP_PASS: 'x',
      DPD_NADAWCA_NAZWA: 'Firma Zmyślona', DPD_NADAWCA_ULICA: 'Fikcyjna 1', DPD_NADAWCA_KOD: '00-950', DPD_NADAWCA_MIASTO: 'Nibylandia' };
    const a = await zbudujOms({ env, moduly: modulyDla(env) });
    try {
      const id = zapiszZamowienie(a.db, 'reczne', { zrodlo_id: 1, numer: 'WDT-R', klient: { company: 'Kunde GmbH',
        email: 'kunde@fikcja.invalid', address_1: 'Erfundene 1', postcode: '10115', city: 'Berlin', country: 'DE' },
      dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: 'DE123456789', kwota_brutto: '10.00',
      koszt_dostawy_brutto: '0.00', status_woo: 'processing', oplacone_at: null, anulowane: 0, utworzone_at: '2026-10-01T10:00:00Z',
      pozycje: [{ nazwa: 'Lampa', sku: null, ilosc: 1, cena_brutto: '10.00', vat: null }] }, {});
      const f = rozpocznijFakture(a.db, id);
      zakonczFakture(a.db, f.id, { uuid: 'u-1', numer: 'WDT/1/10/2026', ksefStatus: null });
      const w = a.usluga('wiadomosci', 'wiadomosci');
      await expect(w.podglad(id, 'faktura')).rejects.toThrow('Wpisz NIP firmy w Ustawienia → Firma');
      expect(vi.mocked(zbudujOswiadczenieWywozuPdf)).not.toHaveBeenCalled();
      zapiszNipFirmy(a.db, '2222222222');
      const p = await w.podglad(id, 'faktura');
      expect(p.zalacznik).toBe('Faktura_WDT_1_10_2026.pdf');
      expect(vi.mocked(zbudujOswiadczenieWywozuPdf).mock.calls.at(-1)[0].sprzedawca.nip).toBe('PL2222222222');
    } finally { await a.app.close(); a.db.close(); }
  });
});
