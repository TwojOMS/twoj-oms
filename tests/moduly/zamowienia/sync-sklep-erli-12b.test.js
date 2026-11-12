import { it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { createSyncSklep } from '../../../src/moduly/zamowienia/services/sync-sklep.js';

// PRZ-157.12b (recenzja): klient ERLI w mapie kanałów nie może zrobić z zamówienia Allegro bez konta Allegro sprawy na karcie.
const zam = (id) => ({ zrodlo_id: String(id), numer: 'A-' + id, klient: {}, dostawa: {}, metoda_wysylki: 'allegro_dpd',
  kwota_pobrania: null, chce_fakture: 0, nip: null, oplacone_at: null, anulowane: 0, punkt_odbioru: null,
  kwota_brutto: '10.00', status_woo: 'READY_FOR_PROCESSING', utworzone_at: '2026-11-11T10:00:00Z', pozycje: [] });

for (const [opis, mapa] of [['pusta mapa', {}], ['tylko klient ERLI w mapie', { erli_polcien: { atrapa: true } }]]) {
  it(`zamówienie Allegro bez konta Allegro (${opis}) — kanał milczy, bez błędu na karcie`, async () => {
    const db = openOmsDb();
    const id = zapiszZamowienie(db, 'allegro_polcien', zam(5551), {});
    db.prepare("UPDATE zamowienia SET wyslane_at='2026-11-11T12:00:00' WHERE id=?").run(id);
    const s = createSyncSklep({ db, klienci: {}, klienciKanalow: mapa, czynny: () => Object.keys(mapa).length > 0 });  // jak zamowienia/modul.ts
    const w = await s.odeslijStatus(id);
    expect(w.blad).toBeUndefined();
    expect(pobierzZamowienie(db, id).sync_woo_blad ?? null).toBeNull();
    db.close();
  });
}

// Wiele kont Allegro: brak konta zamówienia przy innym koncie Allegro w mapie to nadal „brak konfiguracji”,
// także gdy obok jest klient ERLI (ERLI ani nie dodaje, ani nie zdejmuje tego błędu).
for (const mapa of [{ allegro_a: { atrapa: true } }, { allegro_a: { atrapa: true }, erli_polcien: { atrapa: true } }]) {
  it(`wiele kont Allegro: zamówienie allegro_b przy mapie {${Object.keys(mapa)}} — brak konfiguracji`, async () => {
    const db = openOmsDb();
    const id = zapiszZamowienie(db, 'allegro_b', zam(7771), {});
    db.prepare("UPDATE zamowienia SET wyslane_at='2026-11-11T12:00:00' WHERE id=?").run(id);
    const s = createSyncSklep({ db, klienci: {}, klienciKanalow: mapa, czynny: () => true });
    await s.odeslijStatus(id);
    expect(pobierzZamowienie(db, id).sync_woo_blad).toContain('brak konfiguracji');
    db.close();
  });
}
