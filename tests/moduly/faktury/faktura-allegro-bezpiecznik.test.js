import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zapiszStanWeryfikacji } from '../../../src/oms/db/stan-weryfikacji.js';
import { createFakturaAllegro } from '../../../src/moduly/faktury/services/faktura-allegro.js';

// DRUGIE WYWOLANIE `GET .../invoices` siedzi na sciezce CZLOWIEKA — przy wystawianiu faktury,
// jako POMOCNICZY bezpiecznik przed duplikatem. Zasob oddaje dzis 400, wiec i tak zwraca pusta
// liste; przy otwartym bezpieczniku pomijamy je, zeby operator nie czekal przy przycisku na
// wywolanie skazane na porazke. Gdy bezpiecznik sie zamknie, wywolanie wraca samo.

const PDF = Buffer.concat([Buffer.from('%PDF-1.4'), Buffer.alloc(64)]);

function baza() {
  const db = openOmsDb(':memory:');
  const id = zapiszZamowienie(db, 'allegro_szkicownia', {
    zrodlo_id: 'CF-1', numer: 'CF-1', kwota_brutto: '100.00', chce_fakture: 1, pozycje: [],
    klient: { first_name: 'Jan', email: 'j@k.pl' }, dostawa: { city: 'Pęki' },
    metoda_wysylki: 'allegro_dpd', kwota_pobrania: null, nip: null, status_woo: null,
    oplacone_at: '2026-08-05T09:00:00', anulowane: 0, utworzone_at: '2026-08-05T08:00:00',
  }, {});
  db.prepare(`INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, ksef_numer, allegro_invoice_id,
    allegro_wyslana_at, allegro_zgloszenie_at, allegro_weryfikacja, utworzona_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, 'u1', '12/08/2026', 'KS-1', null, null, null, null, '2026-08-05T10:00:00Z');
  return { db, id };
}

const klient = (log) => ({
  pobierzFakturyZamowienia: async () => { log.push('lista'); return []; },
  zglosFakture: async () => { log.push('zglos'); return { id: 'INV-1' }; },
  wyslijPlikFaktury: async () => {
    log.push('plik');
    return { file: { securityVerification: { status: 'WAITING' } } };
  },
});

const usluga = (db, log) => createFakturaAllegro({
  db, infakt: { pobierzPdf: async () => PDF }, klienciKanalow: { allegro_szkicownia: klient(log) },
});

describe('bezpiecznik na ścieżce wystawiania faktury', () => {
  it('bezpiecznik ZAMKNIĘTY — pyta o listę faktur, tak jak dotąd', async () => {
    const { db, id } = baza();
    const log = [];

    await usluga(db, log).wyslij(id);

    expect(log).toContain('lista');
    expect(log).toContain('plik');
  });

  it('bezpiecznik OTWARTY — NIE pyta o listę, ale fakturę wysyła normalnie', async () => {
    const { db, id } = baza();
    zapiszStanWeryfikacji(db, 'allegro_szkicownia', {
      kolejnePuste: 3, bezpiecznikOd: '2026-08-20T10:00:00Z', ostatniaProbaAt: '2026-08-28T11:00:00Z',
    });
    const log = [];

    await usluga(db, log).wyslij(id);

    expect(log).not.toContain('lista');
    expect(log).toContain('zglos');
    expect(log).toContain('plik');
  });
});
