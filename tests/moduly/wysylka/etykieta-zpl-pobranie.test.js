// PRZ-152.G6z: „Pobierz ZPL” — plik ZPL paczki (Allegro WzA „Nadaj i drukuj”, DPD/InPost z ZPL)
// do ręcznego wysłania na Zebrę, gdy czuwacz/komputer z drukarką nie działa. Ścieżka tylko z bazy,
// plik bajt w bajt, jako załącznik, wpis w logu zamówienia.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { rozpocznijPrzesylke, zakonczPrzesylke } from '../../../src/moduly/wysylka/db/przesylki.js';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { nowyPanel, jako, get, BASIC } from '../../pomoc/konta-prz068.js';

const zmapowane = (id) => ({
  zrodlo_id: id, numer: String(id), klient: { first_name: 'Jan', email: 'jan@przyklad.test', address_1: 'Lampowa 1', postcode: '00-950', city: 'Warszawa' },
  dostawa: { city: 'Warszawa' }, metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '99.00',
  status_woo: 'processing', oplacone_at: null, anulowane: 0, utworzone_at: '2026-11-05T10:00:00',
  pozycje: [{ nazwa: 'Szablon Półcień', sku: 'PC-001', ilosc: 1, cena_brutto: '99.00', vat: null }],
});

// Bajty spoza ASCII: 0x00, 0xFF, „ż” w UTF-8 (0xC5 0xBC) i samotny 0xC5 — konwersja na tekst
// (utf8/latin1) zmieniłaby choć jeden z nich.
const BAJTY = Buffer.concat([
  Buffer.from('^XA^FO50,50^FDPracownia Półcień^FS'),
  Buffer.from([0x00, 0xff, 0xc5, 0xbc, 0xc5, 0x0d, 0x0a, 0x80]),
  Buffer.from('^XZ'),
]);

let katalog, p;
beforeEach(() => {
  katalog = mkdtempSync(join(tmpdir(), 'g6z-zpl-'));
  p = nowyPanel();
});
afterEach(() => rmSync(katalog, { recursive: true, force: true }));

function paczka(numer, { zpl = 'plik', numerListu = 'ZMYSLONY0001' } = {}) {
  const id = zapiszZamowienie(p.db, 'pro', zmapowane(numer), {});
  const prz = rozpocznijPrzesylke(p.db, id, 'allegro_wza');
  let sciezka = null;
  if (zpl) {
    sciezka = join(katalog, `etykieta-${numerListu}.zpl`);
    if (zpl === 'plik') writeFileSync(sciezka, BAJTY);
  }
  zakonczPrzesylke(p.db, prz.id, { numerListu, etykietaSciezka: join(katalog, 'e.pdf'), etykietaZplSciezka: sciezka, surowa: '<x/>' });
  return { id, przesylkaId: prz.id, sciezka };
}
const adres = (id, pid) => `/zamowienia/${id}/przesylki/${pid}/etykieta-zpl`;

describe('GET /zamowienia/:id/przesylki/:przesylkaId/etykieta-zpl', () => {
  it('oddaje plik bajt w bajt jako załącznik .zpl, application/octet-stream', async () => {
    const { id, przesylkaId } = paczka(5101);
    const r = await get(p.app, adres(id, przesylkaId), BASIC);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['content-type']).toContain('application/octet-stream');
    expect(r.headers['content-disposition']).toBe('attachment; filename="etykieta-ZMYSLONY0001.zpl"');
    expect(Buffer.compare(r.rawPayload, BAJTY)).toBe(0);
    expect(r.rawPayload.equals(BAJTY)).toBe(true);
  });

  it('nazwa pliku z dysku jest oczyszczona (bez cudzysłowów, ukośników), zawsze z .zpl', async () => {
    const { id, przesylkaId } = paczka(5102, { zpl: 'plik', numerListu: 'A"b;c' });
    const r = await get(p.app, adres(id, przesylkaId), BASIC);
    expect(r.statusCode, r.body).toBe(200);
    const cd = r.headers['content-disposition'];
    expect(cd).toMatch(/^attachment; filename="[\p{L}\p{N}_-]+\.zpl"$/u);
  });

  it('wpis w logu zamówienia: akcja etykieta-zpl.pobranie, kto i numer listu', async () => {
    const { id, przesylkaId } = paczka(5103);
    await get(p.app, adres(id, przesylkaId), BASIC);
    const wpis = p.db.prepare("SELECT * FROM log WHERE zamowienie_id = ? AND akcja = 'etykieta-zpl.pobranie'").get(id);
    expect(wpis).toBeTruthy();
    expect(wpis.wynik).toContain('serwis');
    expect(wpis.wynik).toContain('ZMYSLONY0001');
  });

  it('konto z sesji: wpis w logu z loginem konta', async () => {
    zalozKonto(p.db, { login: 'ola', imie: 'Ola', haslo: 'h', rola: 'sprzedaz', ekrany: ['zamowienia'] });
    const { id, przesylkaId } = paczka(5104);
    const r = await get(p.app, adres(id, przesylkaId), jako(p.db, 'ola'));
    expect(r.statusCode, r.body).toBe(200);
    const wpis = p.db.prepare("SELECT * FROM log WHERE zamowienie_id = ? AND akcja = 'etykieta-zpl.pobranie'").get(id);
    expect(wpis.wynik).toContain('ola');
  });

  it('brak ścieżki ZPL w bazie → 404 z komunikatem po polsku, bez wpisu w logu', async () => {
    const { id, przesylkaId } = paczka(5105, { zpl: null });
    const r = await get(p.app, adres(id, przesylkaId), BASIC);
    expect(r.statusCode).toBe(404);
    expect(r.body).toMatch(/ZPL/);
    expect(p.db.prepare("SELECT COUNT(*) AS n FROM log WHERE akcja = 'etykieta-zpl.pobranie'").get().n).toBe(0);
  });

  it('ścieżka w bazie, pliku brak → 404 bez ścieżki serwera w treści', async () => {
    const { id, przesylkaId } = paczka(5106, { zpl: 'brak' });
    const r = await get(p.app, adres(id, przesylkaId), BASIC);
    expect(r.statusCode).toBe(404);
    expect(r.body).toMatch(/ZPL/);
    expect(r.body).not.toContain(katalog);
    expect(r.body).not.toContain('.zpl');
  });

  it('przesyłka innego zamówienia → 404 jak w trasie PDF', async () => {
    const a = paczka(5107);
    const b = paczka(5108);
    const r = await get(p.app, adres(a.id, b.przesylkaId), BASIC);
    const pdf = await get(p.app, `/zamowienia/${a.id}/przesylki/${b.przesylkaId}/etykieta`, BASIC);
    expect(r.statusCode).toBe(404);
    expect(pdf.statusCode).toBe(404);
    // PRZ-152.G13 W1: odmowa to strona w układzie OMS (formularz motywu niesie własny adres),
    // więc porównujemy komunikat z paska, nie cały dokument.
    const pasek = (body) => body.match(/<p class="pasek-uwaga" role="alert">([^<]*)<\/p>/)?.[1];
    expect(pasek(r.body)).toBe('To zamówienie nie ma takiej przesyłki.');
    expect(pasek(r.body)).toBe(pasek(pdf.body));
  });

  it('parametr z ../ nie zmienia czytanego pliku', async () => {
    const { id, przesylkaId } = paczka(5109);
    writeFileSync(join(katalog, 'obcy.txt'), 'TAJNE');
    for (const zly of [
      `/zamowienia/${id}/przesylki/${przesylkaId}/etykieta-zpl?sciezka=${encodeURIComponent(join(katalog, 'obcy.txt'))}`,
      `/zamowienia/${id}/przesylki/..%2F..%2Fobcy.txt/etykieta-zpl`,
      `/zamowienia/${id}/przesylki/${przesylkaId}/etykieta-zpl/..%2F..%2Fobcy.txt`,
    ]) {
      const r = await get(p.app, zly, BASIC);
      expect(r.body).not.toContain('TAJNE');
      if (r.statusCode === 200) expect(r.rawPayload.equals(BAJTY)).toBe(true);
    }
  });

  it('bez uwierzytelnienia → odmowa jak w trasie PDF', async () => {
    const { id, przesylkaId } = paczka(5110);
    const r = await p.app.inject({ method: 'GET', url: adres(id, przesylkaId) });
    const pdf = await p.app.inject({ method: 'GET', url: `/zamowienia/${id}/przesylki/${przesylkaId}/etykieta` });
    expect(r.statusCode).toBe(401);
    expect(r.statusCode).toBe(pdf.statusCode);
  });

  it('konto bez ekranu zamówień → 403 jak w trasie PDF, bez pliku i bez wpisu', async () => {
    zalozKonto(p.db, { login: 'magda', imie: 'Magda', haslo: 'h', rola: 'sprzedaz', ekrany: ['przesylki'] });
    const { id, przesylkaId } = paczka(5111);
    const r = await get(p.app, adres(id, przesylkaId), jako(p.db, 'magda'));
    const pdf = await get(p.app, `/zamowienia/${id}/przesylki/${przesylkaId}/etykieta`, jako(p.db, 'magda'));
    expect(r.statusCode).toBe(403);
    expect(pdf.statusCode).toBe(403);
    expect(r.rawPayload.includes(BAJTY)).toBe(false);
    expect(p.db.prepare("SELECT COUNT(*) AS n FROM log WHERE akcja = 'etykieta-zpl.pobranie'").get().n).toBe(0);
  });
});

describe('karta zamówienia: link „Pobierz ZPL” (G16b)', () => {
  it('paczka z ZPL ma link do pobrania pliku', async () => {
    const { id, przesylkaId } = paczka(5201);
    const r = await get(p.app, `/zamowienia/${id}`, BASIC);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).toContain(`href="${adres(id, przesylkaId)}"`);
    expect(r.body).toContain('Pobierz ZPL');
  });

  it('paczka bez ZPL — bez linku', async () => {
    const { id, przesylkaId } = paczka(5202, { zpl: null });
    const r = await get(p.app, `/zamowienia/${id}`, BASIC);
    expect(r.body).not.toContain(adres(id, przesylkaId));
  });
});
