// PRZ-118.04 — karta zamówienia dla wierszy STAREGO OBRAZU: zapisanych po migracji rdzen/0008 przez kod sprzed
// PRZ-118 (okno wycofania), czyli z samym `infakt_uuid`, bez `program` i `dokument_id`. Karta czyta identyfikator
// przez domena/dokument-programu.js (model: `idDokumentuFaktury`, `idDokumentuOkresu`; JOIN rezerwacji KSeF
// w oms/db/zamowienia.js przez `idDokumentuSql`). Istniejące testy karty zakładają wiersze funkcjami zapisu,
// które od 03 piszą obie kolumny — odczyt bez zapasu `infakt_uuid` przechodził je (zmierzone przy 04).
import { describe, it, expect, afterEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zajmijWysylkeKsef } from '../../../src/moduly/faktury/db/wysylki-ksef.js';
import { zapewnijOkres } from '../../../src/oms/db/okresy.js';
import { createFakturyWidok } from '../../../src/moduly/faktury/services/faktury-widok.js';
import { createWysylkaKsef } from '../../../src/moduly/faktury/services/wysylka-ksef.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

const NIP = '5250000000';
const AUTH = { authorization: `Basic ${Buffer.from('t:h').toString('base64')}`, origin: 'http://localhost' };
const apki = [];
afterEach(async () => { for (const a of apki.splice(0)) await a.close(); });

const bezSieci = { listaFaktur: async () => [], listaKorekt: async () => [] };

function panel() {
  const db = openOmsDb(':memory:');
  const fakturyWidok = createFakturyWidok({ db, infakt: bezSieci });
  const wysylkaKsef = createWysylkaKsef({ db, infakt: bezSieci, fakturyWidok, log: () => {} });
  const app = buildOmsServer({ db, config: { auth: { user: 't', pass: 'h' } }, fakturyWidok, wysylkaKsef });
  apki.push(app);
  return { db, app };
}

function zamowienie(db, nr, utworzone = '2026-10-05T09:00:00') {
  return zapiszZamowienie(db, 'pro', {
    zrodlo_id: `w-${nr}`, numer: `Z-${nr}`, klient: { first_name: 'Ida', last_name: 'Lampowa', company: 'Pracownia Półcień' },
    dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: NIP, kwota_brutto: '249.00',
    koszt_dostawy_brutto: '0.00', status_woo: 'processing', oplacone_at: null, anulowane: 0, pozycje: [], utworzone_at: utworzone,
  }, {});
}

const karta = (app, id) => app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: AUTH });

describe('karta zamówienia — wiersze starego obrazu (sam infakt_uuid)', () => {
  it('faktura z wysyłką do KSeF zleconą z panelu: przycisk PDF i stan „zlecona z panelu”', async () => {
    const { db, app } = panel();
    const id = zamowienie(db, 1);
    // `ksef_odczyt = 'ok'`: czuwacz pytał, inFakt dokument zna, numeru KSeF brak — sprawa na pasku karty.
    db.prepare("INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at, ksef_odczyt) VALUES (?, 'U-STARY', 'FV 7/10/2026', '2026-10-20T10:00:00.000Z', 'ok')")
      .run(id);
    expect(db.prepare('SELECT program, dokument_id FROM faktury').get()).toEqual({ program: null, dokument_id: null });
    zajmijWysylkeKsef(db, 'U-STARY', { numer: 'FV 7/10/2026', kiedy: '2026-10-20T18:00:00.000Z' });

    const r = await karta(app, id);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(`href="/zamowienia/${id}/faktura/pdf"`);
    // Model karty (`ksefKarty` z `idDokumentu`): stan dokumentu jak na liście Faktur.
    expect(r.body).toContain('zlecona z panelu — czeka na numer KSeF');
    expect(r.body).not.toContain('jeszcze nie wysłana do KSeF');
    // JOIN rezerwacji w oms/db/zamowienia.js (`ksef_zlecona_at`): sprawa „panel zlecił, numeru nie ma od …”.
    expect(r.body).toContain('Panel zlecił wysyłkę faktury FV 7/10/2026 do KSeF, a numeru nie ma od 2026-10-20T18:00:00.000Z');
  });

  it('zamówienie w okresie, którego faktura ma sam infakt_uuid: zdanie o fakturze okresu już w programie', async () => {
    const { db, app } = panel();
    const id = zamowienie(db, 2);
    const okres = zapewnijOkres(db, { klientKlucz: NIP, rok: 2026, miesiac: 10 });
    db.prepare('UPDATE zamowienia SET okres_rozliczeniowy_id = ? WHERE id = ?').run(okres.id, id);
    db.prepare("UPDATE okresy_rozliczeniowe SET infakt_uuid = 'U-OKRES-STARY', numer = 'FZ/1/10/2026', stan = 'zafakturowany' WHERE id = ?")
      .run(okres.id);

    const r = await karta(app, id);
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/do KSeF wysyłasz ją z zakładki <a href="\/faktury[^"]*">Faktury<\/a>/);
  });
});
