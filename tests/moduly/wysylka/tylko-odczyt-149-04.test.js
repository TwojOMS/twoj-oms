// PRZ-149.04 (C8): sklep podłączony kluczem „Odczyt”. Nadanie NIE pada — paczka jedzie, a notatka z numerem
// listu jest świadomie pominięta (log), bez wołania sklepu i bez śladu „notatka:” z zegarem ponowień.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { createNadanie } from '../../../src/moduly/wysylka/services/nadanie.js';
import { ponowNotatkeNadania } from '../../../src/moduly/wysylka/services/notatka-nadania.js';
import { zapiszBladSync } from '../../../src/moduly/wysylka/db/przesylki.js';
import { TYLKO_ODCZYT } from '../../../src/domena/woo-uprawnienia.js';

const NUMER = '1048069400000U';
const zmapowane = () => ({
  zrodlo_id: 1301, numer: '1301', klient: { email: 'anna@polcien.example', phone: '+48500600700' },
  dostawa: { first_name: 'Anna', last_name: 'Półcień', address_1: 'Cicha 1', postcode: '00-950', city: 'Warszawa', country: 'PL' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '120.00',
  status_woo: 'processing', oplacone_at: '2026-11-03T13:00:00', anulowane: 0,
  utworzone_at: '2026-11-03T13:19:52', pozycje: [],
});
const logi = (db) => db.prepare("SELECT wynik FROM log WHERE akcja = 'sync-woo' ORDER BY id").all().map((w) => w.wynik);

/** Atrapa klienta sklepu „Odczyt”: liczy wołania zapisów, które NIE mają prawa paść. */
const klientOdczyt = () => ({ tylkoOdczyt: true, dodajNotatke: vi.fn().mockResolvedValue({}), ustawStatus: vi.fn().mockResolvedValue({}) });

async function nadana(woo) {
  const db = openOmsDb(':memory:');
  const dpd = { nadaj: vi.fn().mockResolvedValue({ numerListu: NUMER, etykietaPdf: Buffer.from('%PDF-x'), surowa: '<xml/>' }) };
  const nadanie = createNadanie({
    db, kurierzy: { dpd }, klienci: { pro: woo }, katalogEtykiet: mkdtempSync(join(tmpdir(), 'oms-')), czekaj: vi.fn(),
  });
  const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
  await nadanie.nadaj(id);
  return { db, id, p: pobierzZamowienie(db, id).przesylki[0] };
}

describe('PRZ-149.04: nadanie przy sklepie „Odczyt”', () => {
  it('paczka nadana, notatka pominięta bez wołania sklepu, komunikat w logu, bez śladu do ponowień', async () => {
    const woo = klientOdczyt();
    const { db, p } = await nadana(woo);
    expect(p.numer_listu).toBe(NUMER);
    expect(p.status).toBe('nadana');
    expect(woo.dodajNotatke).not.toHaveBeenCalled();
    expect(woo.ustawStatus).not.toHaveBeenCalled();
    expect(p.sync_woo_blad).toBeNull();
    expect(logi(db)).toEqual([`POMINIĘTO: ${TYLKO_ODCZYT}`]);
  });

  it('„Spróbuj ponownie” na sklepie „Odczyt” odmawia komunikatem i nie woła sklepu', async () => {
    const woo = klientOdczyt();
    const { db, p } = await nadana(woo);
    zapiszBladSync(db, p.id, 'notatka: Sklep odpowiedział 500: awaria');
    await expect(ponowNotatkeNadania({ db, klienci: { pro: woo } }, p.id)).rejects.toThrow(TYLKO_ODCZYT);
    expect(woo.dodajNotatke).not.toHaveBeenCalled();
    expect(pobierzZamowienie(db, p.zamowienie_id).przesylki[0].sync_woo_blad).toBeNull();
  });
});
