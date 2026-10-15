import {
  describe, it, expect, beforeEach, vi,
} from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { dodajZwrot, zwrot, zarezerwujKorekte, zapiszKorekte } from '../../../src/oms/db/zwroty.js';
import { createKorekta } from '../../../src/moduly/zwroty/services/korekta.js';

// ⚠️ Rozbieznosc z briefem: `zapiszZamowienie` oddaje LICZBOWE `id` wprost (db/zamowienia.js:
// `return id`), nie obiekt `{ id }` — ta sama pulapka, co w tests/oms/korekta-service.test.js
// i tests/oms/web-zwroty.test.js. `.id` na liczbie dawaloby `undefined` i psulo fikture cicho.
const zmapowane = () => ({
  zrodlo_id: 1301, numer: '1301', klient: {}, dostawa: {}, metoda_wysylki: 'dpd',
  kwota_pobrania: null, chce_fakture: 1, nip: null, kwota_brutto: '217.00',
  status_woo: 'processing', oplacone_at: null, anulowane: 0,
  utworzone_at: '2026-08-01T10:00:00', pozycje: [],
});

let db; let id; let zwrotId;
beforeEach(() => {
  db = openOmsDb(':memory:');
  id = zapiszZamowienie(db, 'pro', zmapowane(), {});
  // ⚠️ Faktura zamowienia potrzebna, bo `doczytaj` czyta numer korygowanej faktury z
  // `z.faktura.numer` (db/zamowienia.js: `fakturaZamowienia`) — bez wiersza w `faktury`
  // `z.faktura` jest `null` i `doczytaj` odmawia PRZED wywolaniem inFaktu.
  db.prepare(
    'INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?,?,?,?)',
  ).run(id, 'uuid-fv', 'FV 1/08/2026', '2026-08-01T10:00:00Z');
  zwrotId = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [] }).id;
  zarezerwujKorekte(db, id, zwrotId);
  zapiszKorekte(db, id, zwrotId, { referencja: 'REF-1' });
});

// ⚠️ DOPASOWANIE PO `corrected_invoice_number`, NIE PO REFERENCJI ZADANIA. Encja korekty
// NIE NIESIE `invoice_task_reference_number` — sprawdzone wprost na zywym koncie (notatka
// 2026-08-14-oms-zwroty-pomiar.md: `REF? null`, klucza nie ma na liscie pol).
// Numer korygowanej faktury panel zna z `z.faktura.numer`.
describe('doczytanie numeru korekty', () => {
  it('znajduje korekte po numerze KORYGOWANEJ faktury i zapisuje numer', async () => {
    const infakt = { listaKorekt: vi.fn().mockResolvedValue([
      { uuid: 'uuid-innej', number: '1/KOR/06/2026', corrected_invoice_number: 'FV 9/06/2026' },
      { uuid: 'uuid-kor', number: '1/KOR/08/2026', corrected_invoice_number: 'FV 1/08/2026' },
    ]) };
    await createKorekta({ db, infakt }).doczytaj(id, zwrotId);
    const w = zwrot(db, id, zwrotId);
    expect(w.korekta_numer).toBe('1/KOR/08/2026');
    expect(w.korekta_uuid).toBe('uuid-kor');
  });

  it('NIE RZUCA, gdy inFakt jest nieosiagalny — ekran ma sie otworzyc mimo to', async () => {
    const infakt = { listaKorekt: vi.fn().mockRejectedValue(new Error('ECONNRESET')) };
    await expect(createKorekta({ db, infakt }).doczytaj(id, zwrotId)).resolves.toBeUndefined();
  });

  it('nie pyta, gdy numer juz jest', async () => {
    zapiszKorekte(db, id, zwrotId, { numer: 'KOR 1/08/2026' });
    const infakt = { listaKorekt: vi.fn() };
    await createKorekta({ db, infakt }).doczytaj(id, zwrotId);
    expect(infakt.listaKorekt).not.toHaveBeenCalled();
  });

  it('nie pyta, gdy korekty nigdy nie zlecono (brak korekta_zlecona_at)', async () => {
    const swiezyZwrotId = dodajZwrot(db, id, { data: '2026-08-14', kwota: '50.00', pozycje: [] }).id;
    const infakt = { listaKorekt: vi.fn() };
    await createKorekta({ db, infakt }).doczytaj(id, swiezyZwrotId);
    expect(infakt.listaKorekt).not.toHaveBeenCalled();
  });

  it('nie pyta, gdy zamowienie nie ma faktury', async () => {
    const idBezFaktury = zapiszZamowienie(db, 'pro', { ...zmapowane(), zrodlo_id: 1302, numer: '1302' }, {});
    const wId = dodajZwrot(db, idBezFaktury, { data: '2026-08-14', kwota: '10.00', pozycje: [] }).id;
    zarezerwujKorekte(db, idBezFaktury, wId);
    const infakt = { listaKorekt: vi.fn() };
    await createKorekta({ db, infakt }).doczytaj(idBezFaktury, wId);
    expect(infakt.listaKorekt).not.toHaveBeenCalled();
  });

  it('brak dopasowania w liscie korekt — nic nie zapisuje i nie rzuca', async () => {
    const infakt = { listaKorekt: vi.fn().mockResolvedValue([
      { uuid: 'uuid-innej', number: '1/KOR/06/2026', corrected_invoice_number: 'FV 9/06/2026' },
    ]) };
    await expect(createKorekta({ db, infakt }).doczytaj(id, zwrotId)).resolves.toBeUndefined();
    const w = zwrot(db, id, zwrotId);
    expect(w.korekta_numer).toBeNull();
  });
});
