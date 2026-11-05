// PRZ-126.C02 — karta zamówienia: odmowa przy wystawieniu faktury i przy zapisie danych do faktury
// wraca jako KARTA z błędem przy polu (HTML w układzie panelu), a nie jako goły tekst na czarnym tle.
// Udane wystawienie wraca na kartę z kotwicą `#faktura`.
// Dane zmyślone („Pracownia Półcień”), sieć zablokowana.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { createFaktura } from '../../../src/moduly/faktury/services/faktura.js';
import { bladOperatora } from '../../../src/domena/bledy.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { programTestowy } from '../../pomoc/program-testowy.js';

const config = { auth: { user: 'adam', pass: 'x' } };
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: '2026-10-29T08:00:00', ostatni_blad: null }) };

const zmapowane = (nad = {}) => ({
  zrodlo_id: 12602, numer: 'PC-12602',
  // PRZ-126.P1: formularz zachowujący daty wymaga kompletu danych nabywcy.
  klient: { first_name: 'Anna', last_name: 'Półcień', email: 'anna@polcien.invalid', company: 'Pracownia Półcień', address_1: 'Fikcyjna 1', postcode: '00-001', city: 'Miasto Testowe' },
  dostawa: { city: 'Warszawa' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: '1234567890',
  kwota_brutto: '129.00', koszt_dostawy_brutto: '0.00',
  status_woo: 'processing', oplacone_at: '2026-10-28T10:05:00', anulowane: 0, utworzone_at: '2026-10-28T10:00:00',
  pozycje: [{ nazwa: 'Lampa wisząca Półcień', sku: 'LAMPA-W1', ilosc: 1, cena_brutto: '129.00', vat: null }],
  ...nad,
});

// Odmowa walidacji NIP z polem 'nip' — tak jak ją zgłasza domena programu wbudowanego
// (src/domena/twojefaktury/z-ladunku.js; samo `pole` sprawdza tests/domena/twojefaktury/z-ladunku-prz122.test.js).
// Plik wspólny nie importuje programu TF (lista wycięcia, tests/instalacja/wyciecie-twojefaktury.test.js).
const programZlyNip = () => programTestowy({ metody: {
  przygotujNabywce: vi.fn().mockRejectedValue(bladOperatora(
    'NIP nabywcy „1234567890” nie jest poprawnym polskim NIP-em (10 cyfr ze zgodną cyfrą kontrolną) — popraw go w danych do faktury.',
    { pole: 'nip' },
  )),
} });

let db;
let serwer;
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Sieć zabroniona'); }));
  db = openOmsDb(':memory:');
});
afterEach(async () => {
  await serwer?.close();
  serwer = null;
  db.close();
  vi.unstubAllGlobals();
});

async function przygotuj({ program, opcje = {}, nad = {} } = {}) {
  const faktura = program === null ? null : createFaktura({ db, program: program ?? programZlyNip() });
  serwer = buildOmsServer({ db, config, poller, faktura, ...opcje });
  await serwer.ready();
  const id = zapiszZamowienie(db, 'pro', zmapowane(nad), {});
  return id;
}

const wystaw = (id, payload = {}) => serwer.inject({
  method: 'POST', url: `/zamowienia/${id}/faktura`, headers: naglowek,
  payload: { termin: '14', data_wystawienia: '2026-10-27', data_sprzedazy: '2026-10-26', ...payload },
});

describe('PRZ-126.C02 — błąd przy polu przy wystawieniu faktury', () => {
  it('zły NIP (odmowa z polem nip): 400, karta w HTML, komunikat przy polu NIP, wpisane daty zostają', async () => {
    const id = await przygotuj();
    const r = await wystaw(id);
    expect(r.statusCode).toBe(400);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.body).toContain('<html');
    expect(r.body).toContain('id="dane-faktury"');
    // komunikat domeny bez zmian, pod polem NIP
    expect(r.body).toMatch(/<p class="blad-pola pasek-blokada" id="blad-nip">[^<]*nie jest poprawnym polskim NIP-em/);
    expect(r.body).toMatch(/name="nip"[^>]*aria-invalid="true"[^>]*aria-describedby="blad-nip"/);
    expect(r.body).toContain('value="1234567890"');
    // formularz wystawienia pamięta wpisane daty i termin
    expect(r.body).toContain('name="data_wystawienia" value="2026-10-27"');
    expect(r.body).toContain('name="data_sprzedazy" value="2026-10-26"');
    expect(r.body).toMatch(/<option value="14" selected>/);
    // ślad w logu zostaje jak dotąd
    const log = db.prepare("SELECT wynik FROM log WHERE zamowienie_id = ? AND akcja = 'faktura.http'").all(id);
    expect(log.length).toBe(1);
  });

  it('udane wystawienie wraca na kartę z kotwicą #faktura', async () => {
    const id = await przygotuj({ program: programTestowy(), nad: { nip: '1234563218' } });
    const r = await wystaw(id);
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toMatch(new RegExp(`^/zamowienia/${id}[^#]*#faktura$`));
  });

  it('odmowa bez wskazanego pola: komunikat nad formularzem w sekcji #faktura, 400, HTML', async () => {
    const program = programTestowy({ metody: {
      przygotujNabywce: vi.fn().mockRejectedValue(bladOperatora('Testownik nie odpowiada — spróbuj za chwilę.')),
    } });
    const id = await przygotuj({ program, nad: { nip: '1234563218' } });
    const r = await wystaw(id);
    expect(r.statusCode).toBe(400);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    const sekcja = r.body.slice(r.body.indexOf('id="faktura"'));
    expect(sekcja).toMatch(/<p class="pasek-blokada" id="blad-faktury">Nie udało się wystawić faktury: Testownik nie odpowiada/);
    expect(r.body).not.toContain('aria-invalid="true"');
  });

  it('brak programu: 503 i zdanie o konfiguracji bez zmian (poza zakresem C02, pilnuje PRZ-121)', async () => {
    const id = await przygotuj({ program: null });
    const r = await wystaw(id);
    expect(r.statusCode).toBe(503);
    expect(r.body).toMatch(/>inFakt nie jest skonfigurowany\./); // PRZ-152.G13f1: ekran odmowy karty zamiast gołego tekstu
  });

  it('usługa karty niedostępna: strona zapasowa w HTML z odnośnikiem na kartę', async () => {
    const id = await przygotuj({ opcje: { nadpisania: { 'zamowienia.renderujKarte': null } } });
    const r = await wystaw(id);
    expect(r.statusCode).toBe(400);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.body).toContain(`href="/zamowienia/${id}#faktura"`);
    expect(r.body).toContain('nie jest poprawnym polskim NIP-em');
  });
});

describe('PRZ-126.C02 — błąd przy zapisie danych do faktury', () => {
  it('odmowa zapisu: 400, karta w HTML z sekcją w edycji i wpisaną nazwą w polu', async () => {
    const id = await przygotuj();
    db.exec("CREATE TRIGGER t_c02 BEFORE UPDATE ON zamowienia BEGIN SELECT RAISE(ABORT, 'baza tylko do odczytu'); END");
    const r = await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/dane/faktura`, headers: naglowek,
      payload: { chce_fakture: '1', firma: 'Pracownia Półcień Nowa', nip: '1234563218', ulica: 'Cicha "1"<b>', kod: '00-001', miasto: 'Warszawa', email: '' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.body).toContain('<html');
    expect(r.body).toContain('panel panel--edycja" id="dane-faktury"');
    expect(r.body).toContain('name="firma" value="Pracownia Półcień Nowa"');
    // wpisane wartości escapowane
    expect(r.body).toContain('name="ulica" value="Cicha &#34;1&#34;&lt;b&gt;"');
    expect(r.body).not.toContain('Cicha "1"<b>');
    expect(r.body).toMatch(/<p class="pasek-blokada" id="blad-dane-faktury">Nie udało się zapisać danych:/);
  });

  it('odmowa zapisu danych do wysyłki: ta sama karta, sekcja wysyłki w edycji z wpisanymi danymi', async () => {
    const id = await przygotuj();
    db.exec("CREATE TRIGGER t_c02 BEFORE UPDATE ON zamowienia BEGIN SELECT RAISE(ABORT, 'baza tylko do odczytu'); END");
    const r = await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/dane/wysylka`, headers: naglowek,
      payload: { nazwa: 'Anna Półcień', company: '', ulica: 'Jasna 7', kod: '00-002', miasto: 'Warszawa', phone: '', email: '' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.body).toContain('panel panel--edycja" id="wysylka"');
    expect(r.body).toContain('name="ulica" value="Jasna 7"');
    expect(r.body).toContain('id="blad-dane-wysylki"');
  });

  it('żądanie bez pól (odmowa operatora): 400, karta z komunikatem', async () => {
    const id = await przygotuj();
    const r = await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/dane/faktura`, headers: naglowek, payload: { chce_fakture: '1' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.body).toContain('id="blad-dane-faktury"');
  });
});
