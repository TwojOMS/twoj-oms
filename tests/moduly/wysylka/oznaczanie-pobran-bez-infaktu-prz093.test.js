// PRZ-093.10, poprawka P2 z recenzji: odmowa pośrednika „inFakt nie jest skonfigurowany” (odłączony z ekranu do
// restartu) i odmowa trybu próby bez atrapy NIE są odpowiedzią inFaktu o dokumencie. Czuwacz pobrań nie może z nich
// zrobić trwałego „nieznana_w_infakcie / NIE BĘDZIE PONAWIAŁ” — po ponownym podłączeniu pobranie ma zostać oznaczone.
// Prawdziwa odmowa 4xx z inFaktu (klucz w pliku, prawdziwy klient) — zachowanie bez zmian (test przypinający niżej).
import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { rozpocznijPrzesylke, zakonczPrzesylke, zapiszStatusDpd } from '../../../src/moduly/wysylka/db/przesylki.js';
import { oznaczDoreczonePobrania } from '../../../src/moduly/wysylka/services/oznaczanie-pobran.js';
import { oznaczenieZaplaty } from '../../../src/moduly/wysylka/db/oznaczenia-zaplaty.js';
import { zapiszKonfiguracjeIntegracji, usunKonfiguracjeIntegracji, wczytajKonfiguracjeIntegracji }
  from '../../../src/oms/db/konfiguracja-integracji.js';
import { infaktZUstawien, odmowaInfaktuWProbie } from '../../../src/moduly/faktury/infakt-ustawien.ts';
import { createInfaktClient } from '../../../src/oms/infakt/client.js';

const zmapowane = (nr) => ({
  zrodlo_id: nr, numer: String(nr), klient: { email: 'k@example.invalid' }, dostawa: {},
  metoda_wysylki: 'dpd', kwota_pobrania: '123.00', pobranie: 1, chce_fakture: 1, nip: null,
  kwota_brutto: '123.00', status_woo: 'processing', oplacone_at: null, anulowane: 0,
  utworzone_at: '2026-08-20T10:00:00Z', pozycje: [],
});

function doreczonePobranie(db, nr, uuid) {
  const id = zapiszZamowienie(db, 'pro', zmapowane(nr), {});
  db.prepare('INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?, ?, ?, ?)')
    .run(id, uuid, `F/${nr}`, '2026-08-20T08:00:00.000Z');
  const p = rozpocznijPrzesylke(db, id, 'dpd', 1);
  zakonczPrzesylke(db, p.id, { numerListu: `N${nr}`, etykietaSciezka: '/tmp/e.pdf', surowa: '<x/>' });
  zapiszStatusDpd(db, p.id, { opis: 'Przesyłka doręczona', at: '2026-08-25T14:00:00.000' });
  return id;
}
const logZamowienia = (db, id) => db.prepare('SELECT wynik FROM log WHERE zamowienie_id = ? ORDER BY id').all(id).map((w) => w.wynik);

let db;
beforeEach(() => { db = openOmsDb(':memory:'); });

describe('PRZ-093.10 P2: odmowa pośrednika inFaktu nie zamyka pobrania na zawsze', () => {
  it('odłączony do restartu: brak rezerwacji i brak „NIE BĘDZIE PONAWIAŁ”; po ponownym podłączeniu pobranie oznaczone', async () => {
    const ids = [doreczonePobranie(db, 1, 'u-1'), doreczonePobranie(db, 2, 'u-2')];
    const zlecenia = [];
    const fabryka = () => ({
      pobierzFakture: async (uuid) => ({ uuid, number: 'F', invoice_date: '2026-08-20', status: 'sent', left_to_pay: 12300 }),
      oznaczZaplacona: async (uuid, o) => { zlecenia.push({ uuid, ...o }); return {}; },
    });
    const infakt = infaktZUstawien({ wczytaj: () => wczytajKonfiguracjeIntegracji(db, 'infakt'), fabryka });
    zapiszKonfiguracjeIntegracji(db, 'infakt', { ustawienia: {}, sekrety: { apiKey: 'zmyslony0klucz0p2000000000001' } });
    usunKonfiguracjeIntegracji(db, 'infakt'); // „Odłącz inFakt” bez restartu

    const wynik = await oznaczDoreczonePobrania({ db, infakt });
    expect(wynik.zlecone).toBe(0);
    expect(wynik.bledy).toBeGreaterThan(0);
    for (const [i, id] of ids.entries()) {
      expect(oznaczenieZaplaty(db, `u-${i + 1}`)).toBeFalsy();
      expect(logZamowienia(db, id).some((t) => t.includes('NIE BĘDZIE PONAWIAŁ'))).toBe(false);
    }

    zapiszKonfiguracjeIntegracji(db, 'infakt', { ustawienia: {}, sekrety: { apiKey: 'zmyslony0klucz0p2000000000002' } });
    const po = await oznaczDoreczonePobrania({ db, infakt });
    expect(po).toMatchObject({ zlecone: 2, bledy: 0 });
    expect(zlecenia.map((z) => z.uuid).sort()).toEqual(['u-1', 'u-2']);
    expect(oznaczenieZaplaty(db, 'u-1')).toMatchObject({ powod: 'pobranie_doreczone' });
  });

  it('tryb próby bez atrapy (odmowa „Piaskownica”): ta sama zasada — nic trwałego', async () => {
    const id = doreczonePobranie(db, 3, 'u-3');
    const wynik = await oznaczDoreczonePobrania({ db, infakt: odmowaInfaktuWProbie() });
    expect(wynik.zlecone).toBe(0);
    expect(oznaczenieZaplaty(db, 'u-3')).toBeFalsy();
    expect(logZamowienia(db, id).some((t) => t.includes('NIE BĘDZIE PONAWIAŁ'))).toBe(false);
  });

  // Przypięcie produkcji: prawdziwy klient (klucz w pliku), inFakt odpowiada 404/400 — dokument zamykany jak dotąd.
  for (const status of [404, 400]) {
    it(`prawdziwe ${status} z inFaktu: nieznana_w_infakcie i „NIE BĘDZIE PONAWIAŁ” — bez zmian`, async () => {
      const id = doreczonePobranie(db, 4, 'u-4');
      const fetchImpl = async () => ({ ok: false, status, json: async () => ({ error: 'Zasób którego szukasz nie został znaleziony' }) });
      const infakt = createInfaktClient({ apiKey: 'zmyslony0klucz0z0pliku0p2000003', fetchImpl });
      const wynik = await oznaczDoreczonePobrania({ db, infakt });
      expect(wynik).toMatchObject({ zlecone: 0, bledy: 1 });
      expect(oznaczenieZaplaty(db, 'u-4')).toMatchObject({ powod: 'nieznana_w_infakcie', data_zaplaty: null });
      expect(logZamowienia(db, id).some((t) => t.includes('NIE BĘDZIE PONAWIAŁ'))).toBe(true);
    });
  }
});
