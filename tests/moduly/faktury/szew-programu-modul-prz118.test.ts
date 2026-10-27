import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { createModulFaktury } from '../../../src/moduly/faktury/modul.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { programTestowy } from '../../pomoc/program-testowy.js';

const ENV = { OMS_PROFORMY_KATALOG: mkdtempSync(join(tmpdir(), 'prz118-06-szew-')), OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000', OMS_TRYB: 'proba' };
const zam = {
  zrodlo_id: 4101, numer: 'R/2026/041',
  klient: { first_name: 'Ewa', last_name: 'Półcień', company: 'Pracownia Półcień', email: 'b@polcien.invalid', address_1: 'Lampowa 7', postcode: '00-950', city: 'Warszawa' },
  dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: '5250000009', kwota_brutto: '123.00', koszt_dostawy_brutto: '0.00',
  status_woo: 'processing', oplacone_at: '2026-10-14T13:00:00', anulowane: 0, utworzone_at: '2026-10-14T13:00:00',
  pozycje: [{ nazwa: 'Lampa', sku: 'L1', ilosc: 2, cena_brutto: '61.50', vat: null }],
};

// PRZ-118.06 (recenzja): program z szwu `fabryki.programFakturowy` modułu faktur trafia do usługi wystawiania
// bez drugiego owinięcia adapterem inFaktu (zProgramu, 5939b34) — kolumna `program` = id programu, `infakt_uuid` puste.
describe('program z fabryki modułu trafia do usługi faktura', () => {
  it('usługa faktura woła przygotujNabywce programu i zapisuje jego id', async () => {
    const p = programTestowy() as any;
    const db = openOmsDb();
    const modul = createModulFaktury({ fabryki: { programFakturowy: () => p, createVies: () => ({ sprawdz: async () => ({ wynik: 'wazny' }) }) } });
    const obce: Record<string, unknown> = { 'kanaly.klienciKanalow': {}, 'kanaly.config': { definicje: [], sklepy: {} } };
    const { uslugi } = modul.zbuduj({ db, konfiguracja: modul.konfiguracja(ENV), teraz: () => new Date('2026-10-27T10:00:00Z'), log: () => {},
      usluga: (m: string, n: string) => { const k = `${m}.${n}`; if (!Object.hasOwn(obce, k)) throw new Error(k); return obce[k]; } } as any) as any;
    expect(uslugi.programFakturowy).toBe(p);
    const id = zapiszZamowienie(db, 'pro', zam, {});
    let blad: any = null;
    try { await uslugi.faktura.wystaw(id); } catch (e) { blad = e; }
    expect(blad).toBeNull();
    expect(p.ile('przygotujNabywce')).toBe(1);
    expect(db.prepare('SELECT program, dokument_id, infakt_uuid FROM faktury WHERE zamowienie_id = ?').get(id))
      .toEqual({ program: 'testowy', dokument_id: 'dok-t1', infakt_uuid: null });
  });
});
