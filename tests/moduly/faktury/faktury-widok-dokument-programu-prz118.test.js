import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zapewnijOkres } from '../../../src/oms/db/okresy.js';
import { createFakturyWidok } from '../../../src/moduly/faktury/services/faktury-widok.js';

// PRZ-118.04 — powiązania zakładki FAKTURY (dokument z programu ↔ zamówienie albo okres panelu) czytają
// identyfikator przez `idDokumentuSql`. Dwa kształty wiersza, których nie robi `zakonczFakture`:
//   • wiersz STAREGO OBRAZU — zapisany po migracji 0008 przez kod sprzed PRZ-118 (okno wycofania): tylko `infakt_uuid`;
//   • wiersz innego programu — `dokument_id` bez `infakt_uuid` (podwójny zapis tylko dla inFaktu).
// Istniejące testy widoku zakładają wiersze funkcjami zapisu, które od 03 piszą obie kolumny, więc mutacja
// „okres po samym `dokument_id`” przechodziła je wszystkie (zmierzone przy 04).

function zamowienie(db, nr) {
  return zapiszZamowienie(db, 'pro', {
    zrodlo_id: `w-${nr}`, numer: String(nr), klient: { first_name: 'Ida' }, dostawa: {},
    metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: null,
    kwota_brutto: '249.00', status_woo: 'processing', oplacone_at: null, anulowane: 0,
  }, {});
}

const infaktZ = (faktury) => ({
  listaFaktur: async () => faktury,
  listaKorekt: async () => [],
  listaNieoplaconych: async () => [],
});

const dok = (uuid, number) => ({ uuid, number, invoice_date: '2026-10-05', gross_price: 24900, left_to_pay: 0, rodzaj: 'vat' });

describe('zakładka FAKTURY — powiązania po identyfikatorze dokumentu (PRZ-118.04)', () => {
  it('wiersze starego obrazu (sam infakt_uuid) — faktura zamówienia i faktura okresu powiązane', async () => {
    const db = openOmsDb(':memory:');
    const id = zamowienie(db, 4101);
    db.prepare("INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?, 'U-STARY', 'FV 1/10/2026', '2026-10-05T09:00:00Z')")
      .run(id);
    const okres = zapewnijOkres(db, { klientKlucz: 'nip:5250000000', rok: 2026, miesiac: 9 });
    db.prepare("UPDATE okresy_rozliczeniowe SET infakt_uuid = 'U-OKRES-STARY', numer = 'FV 2/10/2026', stan = 'zafakturowany' WHERE id = ?")
      .run(okres.id);
    expect(db.prepare('SELECT program, dokument_id FROM faktury').get()).toEqual({ program: null, dokument_id: null });

    const w = createFakturyWidok({ db, infakt: infaktZ([dok('U-STARY', 'FV 1/10/2026'), dok('U-OKRES-STARY', 'FV 2/10/2026')]) });
    const lista = await w.dokumenty({ miesiac: '2026-10', pole: 'invoice_date' });
    const faktura = lista.find((d) => d.uuid === 'U-STARY');
    const zbiorcza = lista.find((d) => d.uuid === 'U-OKRES-STARY');
    expect(faktura.zamowienie).toEqual({ id, numer: '4101' });
    expect(zbiorcza.okres).toEqual({ id: okres.id, klient: 'nip:5250000000', rok: 2026, miesiac: 9 });
  });

  it('wiersze innego programu (dokument_id bez infakt_uuid) — też powiązane', async () => {
    const db = openOmsDb(':memory:');
    const id = zamowienie(db, 4102);
    db.prepare("INSERT INTO faktury (zamowienie_id, program, dokument_id, numer, utworzona_at) VALUES (?, 'fakturownia', '4401', 'FV 3/10/2026', '2026-10-05T09:00:00Z')")
      .run(id);
    const okres = zapewnijOkres(db, { klientKlucz: 'nip:5250000000', rok: 2026, miesiac: 10 });
    db.prepare("UPDATE okresy_rozliczeniowe SET program = 'fakturownia', dokument_id = '4402', numer = 'FV 4/10/2026', stan = 'zafakturowany' WHERE id = ?")
      .run(okres.id);

    const w = createFakturyWidok({ db, infakt: infaktZ([dok('4401', 'FV 3/10/2026'), dok('4402', 'FV 4/10/2026')]) });
    const lista = await w.dokumenty({ miesiac: '2026-10', pole: 'invoice_date' });
    const faktura = lista.find((d) => d.uuid === '4401');
    const zbiorcza = lista.find((d) => d.uuid === '4402');
    expect(faktura.zamowienie).toEqual({ id, numer: '4102' });
    expect(zbiorcza.okres).toEqual({ id: okres.id, klient: 'nip:5250000000', rok: 2026, miesiac: 10 });
  });
});
