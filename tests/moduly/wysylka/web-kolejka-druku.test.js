// Trasy dla czuwacza (deploy/drukarka/czuwacz-etykiet.ps1) — KONTRAKT narzucony przez ten
// skrypt, nie przez ten plik. Nazwy tras i pól JSON-a muszą się z nim zgadzać co do znaku:
// GET /kolejka-druku (pola: id, numerListu, zamowienie), GET /kolejka-druku/:id/zpl (surowe
// bajty), POST /kolejka-druku/:id/wydrukowano, POST /kolejka-druku/:id/blad (JSON {powod}).
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { rozpocznijPrzesylke, zakonczPrzesylke } from '../../../src/moduly/wysylka/db/przesylki.js';
import { dodajDoKolejki, oznaczWydrukowano, porzucPozycje } from '../../../src/moduly/wysylka/db/kolejka-druku.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

const config = { auth: { user: 'adam', pass: 'x' } };
// Dokladnie taki naglowek, jaki wysyla czuwacz: Basic Auth + Origin wskazujacy na panel
// (patrz komentarz w czuwacz-etykiet.ps1 — "klient nie-przegladarkowy ustawia je sam").
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };

const zmapowane = (nad = {}) => ({
  zrodlo_id: Number(nad.numer ?? '1301'), numer: '1301', klient: { email: 'j@k.pl' }, dostawa: { city: 'Pęki' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '212.90',
  status_woo: 'processing', oplacone_at: null, anulowane: 0, utworzone_at: '2026-07-29T13:19:52',
  pozycje: [], ...nad,
});

let db, serwer, katalog;

beforeEach(async () => {
  db = openOmsDb(':memory:');
  serwer = buildOmsServer({ db, config, poller });
  await serwer.ready();
  katalog = mkdtempSync(join(tmpdir(), 'oms-kolejka-'));
});

// Zbuduj jedną "nadaną" przesyłkę z prawdziwym plikiem ZPL na dysku — dokładnie stan, w
// jakim zostawia ją services/nadanie.js po udanym nadaniu.
function przesylkaZZpl({ numer = '1301', numerListu = '1000000000001U', tresc = '^XA^XZ' } = {}) {
  const zamowienieId = zapiszZamowienie(db, 'pro', zmapowane({ numer }), {});
  const p = rozpocznijPrzesylke(db, zamowienieId, 'dpd');
  const sciezkaZpl = join(katalog, `${numer}-${numerListu}.zpl`);
  writeFileSync(sciezkaZpl, tresc);
  zakonczPrzesylke(db, p.id, {
    numerListu, etykietaSciezka: join(katalog, `${numer}-${numerListu}.pdf`), etykietaZplSciezka: sciezkaZpl, surowa: '<xml/>',
  });
  return { zamowienieId, przesylkaId: p.id, sciezkaZpl };
}

describe('GET /kolejka-druku', () => {
  it('bez uwierzytelnienia → 401', async () => {
    const r = await serwer.inject({ method: 'GET', url: '/kolejka-druku' });
    expect(r.statusCode).toBe(401);
  });

  it('pusta kolejka → pusta tablica JSON', async () => {
    const r = await serwer.inject({ method: 'GET', url: '/kolejka-druku', headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual([]);
  });

  it('zwraca DOKŁADNIE pola id, numerListu, zamowienie — kontrakt czuwacza', async () => {
    const { przesylkaId } = przesylkaZZpl();
    const w = dodajDoKolejki(db, przesylkaId);
    const r = await serwer.inject({ method: 'GET', url: '/kolejka-druku', headers: naglowek });
    const pozycje = JSON.parse(r.body);
    expect(pozycje).toEqual([{ id: w.id, numerListu: '1000000000001U', zamowienie: '1301' }]);
  });

  // MUTACJA OBOWIĄZKOWA z briefu: GET /kolejka-druku oddaje też pozycje „wydrukowano" →
  // musi zaczerwienić. Czuwacz drukowałby TĘ SAMĄ etykietę w kółko co 5 sekund.
  it('NIE zwraca pozycji już wydrukowanych', async () => {
    const { przesylkaId } = przesylkaZZpl();
    const w = dodajDoKolejki(db, przesylkaId);
    oznaczWydrukowano(db, w.id);
    const r = await serwer.inject({ method: 'GET', url: '/kolejka-druku', headers: naglowek });
    expect(JSON.parse(r.body)).toEqual([]);
  });

  it('NIE zwraca pozycji porzuconych', async () => {
    const { przesylkaId } = przesylkaZZpl();
    const w = dodajDoKolejki(db, przesylkaId);
    porzucPozycje(db, w.id);
    const r = await serwer.inject({ method: 'GET', url: '/kolejka-druku', headers: naglowek });
    expect(JSON.parse(r.body)).toEqual([]);
  });

  it('pozycja z odroczoną kolejną próbą (jeszcze w przyszłości) NIE wraca', async () => {
    const { przesylkaId } = przesylkaZZpl();
    const w = dodajDoKolejki(db, przesylkaId);
    await serwer.inject({ method: 'POST', url: `/kolejka-druku/${w.id}/blad`, headers: { ...naglowek, 'content-type': 'application/json' }, payload: { powod: 'drukarka offline' } });
    const r = await serwer.inject({ method: 'GET', url: '/kolejka-druku', headers: naglowek });
    expect(JSON.parse(r.body)).toEqual([]);
  });

  it('dwie pozycje w kolejce → obie wracają', async () => {
    const a = przesylkaZZpl({ numer: '1301', numerListu: '1000000000001U' });
    const b = przesylkaZZpl({ numer: '1302', numerListu: '1048069488099X' });
    dodajDoKolejki(db, a.przesylkaId);
    dodajDoKolejki(db, b.przesylkaId);
    const r = await serwer.inject({ method: 'GET', url: '/kolejka-druku', headers: naglowek });
    expect(JSON.parse(r.body)).toHaveLength(2);
  });
});

describe('GET /kolejka-druku/:id/zpl', () => {
  it('bez uwierzytelnienia → 401', async () => {
    const r = await serwer.inject({ method: 'GET', url: '/kolejka-druku/1/zpl' });
    expect(r.statusCode).toBe(401);
  });

  it('oddaje surowe bajty ZPL jako application/octet-stream', async () => {
    const { przesylkaId } = przesylkaZZpl({ tresc: '^XA^FDTEST^FS^XZ' });
    const w = dodajDoKolejki(db, przesylkaId);
    const r = await serwer.inject({ method: 'GET', url: `/kolejka-druku/${w.id}/zpl`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/octet-stream');
    expect(r.rawPayload.toString()).toBe('^XA^FDTEST^FS^XZ');
  });

  it('nieistniejąca pozycja → 404, nie 500', async () => {
    const r = await serwer.inject({ method: 'GET', url: '/kolejka-druku/9999/zpl', headers: naglowek });
    expect(r.statusCode).toBe(404);
  });

  it('plik zniknął z dysku → 404 z czytelnym komunikatem, bez ścieżki serwera', async () => {
    const { przesylkaId, sciezkaZpl } = przesylkaZZpl();
    const w = dodajDoKolejki(db, przesylkaId);
    rmSync(sciezkaZpl);
    const r = await serwer.inject({ method: 'GET', url: `/kolejka-druku/${w.id}/zpl`, headers: naglowek });
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toContain(katalog);
  });
});

describe('POST /kolejka-druku/:id/wydrukowano', () => {
  it('bez uwierzytelnienia → 401 i pozycja nietknięta', async () => {
    const { przesylkaId } = przesylkaZZpl();
    const w = dodajDoKolejki(db, przesylkaId);
    const r = await serwer.inject({ method: 'POST', url: `/kolejka-druku/${w.id}/wydrukowano` });
    expect(r.statusCode).toBe(401);
    expect(db.prepare('SELECT status FROM kolejka_druku WHERE id = ?').get(w.id).status).toBe('oczekuje');
  });

  it('ustawia status „wydrukowano" i znika z kolejki do wzięcia', async () => {
    const { przesylkaId } = przesylkaZZpl();
    const w = dodajDoKolejki(db, przesylkaId);
    const r = await serwer.inject({ method: 'POST', url: `/kolejka-druku/${w.id}/wydrukowano`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(db.prepare('SELECT status, wydrukowane_at FROM kolejka_druku WHERE id = ?').get(w.id).status).toBe('wydrukowano');
    const lista = await serwer.inject({ method: 'GET', url: '/kolejka-druku', headers: naglowek });
    expect(JSON.parse(lista.body)).toEqual([]);
  });

  it('nieistniejąca pozycja → 404', async () => {
    const r = await serwer.inject({ method: 'POST', url: '/kolejka-druku/9999/wydrukowano', headers: naglowek });
    expect(r.statusCode).toBe(404);
  });
});

describe('POST /kolejka-druku/:id/blad', () => {
  it('bez uwierzytelnienia → 401 i pozycja nietknięta', async () => {
    const { przesylkaId } = przesylkaZZpl();
    const w = dodajDoKolejki(db, przesylkaId);
    const r = await serwer.inject({ method: 'POST', url: `/kolejka-druku/${w.id}/blad`, payload: { powod: 'x' } });
    expect(r.statusCode).toBe(401);
    expect(db.prepare('SELECT proby FROM kolejka_druku WHERE id = ?').get(w.id).proby).toBe(0);
  });

  it('czyta {powod} z JSON-a, zwiększa próby i zapisuje powód', async () => {
    const { przesylkaId } = przesylkaZZpl();
    const w = dodajDoKolejki(db, przesylkaId);
    const r = await serwer.inject({
      method: 'POST', url: `/kolejka-druku/${w.id}/blad`,
      headers: { ...naglowek, 'content-type': 'application/json' },
      payload: { powod: 'Nie znaleziono drukarki "ZEBRA" (blad 1801)' },
    });
    expect(r.statusCode).toBe(200);
    const wiersz = db.prepare('SELECT * FROM kolejka_druku WHERE id = ?').get(w.id);
    expect(wiersz.proby).toBe(1);
    expect(wiersz.ostatni_blad).toBe('Nie znaleziono drukarki "ZEBRA" (blad 1801)');
    expect(wiersz.status).toBe('oczekuje');
  });

  // MUTACJA OBOWIĄZKOWA z briefu: odsunięcie kolejnej próby usunięte → musi zaczerwienić.
  it('odsuwa kolejną próbę — pozycja NIE wraca natychmiast do GET /kolejka-druku', async () => {
    const { przesylkaId } = przesylkaZZpl();
    const w = dodajDoKolejki(db, przesylkaId);
    await serwer.inject({
      method: 'POST', url: `/kolejka-druku/${w.id}/blad`,
      headers: { ...naglowek, 'content-type': 'application/json' }, payload: { powod: 'drukarka offline' },
    });
    const lista = await serwer.inject({ method: 'GET', url: '/kolejka-druku', headers: naglowek });
    expect(JSON.parse(lista.body)).toEqual([]);
  });

  it('nieistniejąca pozycja → 404', async () => {
    const r = await serwer.inject({
      method: 'POST', url: '/kolejka-druku/9999/blad',
      headers: { ...naglowek, 'content-type': 'application/json' }, payload: { powod: 'x' },
    });
    expect(r.statusCode).toBe(404);
  });
});

// Karta zamówienia — przycisk „Drukuj". W odróżnieniu od tras dla czuwacza wyżej, te trasy
// NIE mają narzuconego kontraktu — nazwy dobrane po wzorcu istniejących
// (/przesylki/:id/odblokuj, /przesylki/:id/domknij, /przesylki/:id/sprawa-zalatwiona).
describe('POST /zamowienia/:id/przesylki/:przesylkaId/drukuj — karta zamówienia', () => {
  it('bez uwierzytelnienia → 401 i kolejka nietknięta', async () => {
    const { zamowienieId, przesylkaId } = przesylkaZZpl();
    const r = await serwer.inject({ method: 'POST', url: `/zamowienia/${zamowienieId}/przesylki/${przesylkaId}/drukuj` });
    expect(r.statusCode).toBe(401);
    expect(db.prepare('SELECT COUNT(*) c FROM kolejka_druku').get().c).toBe(0);
  });

  it('wstawia pozycję do kolejki i wraca na kartę', async () => {
    const { zamowienieId, przesylkaId } = przesylkaZZpl();
    const r = await serwer.inject({ method: 'POST', url: `/zamowienia/${zamowienieId}/przesylki/${przesylkaId}/drukuj`, headers: naglowek });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe(`/zamowienia/${zamowienieId}`);
    const wiersz = db.prepare('SELECT * FROM kolejka_druku WHERE przesylka_id = ?').get(przesylkaId);
    expect(wiersz.status).toBe('oczekuje');
  });

  // Powtórny wydruk jest dozwolony — dokładnie zasada z briefu: „Drukuj" na już
  // wydrukowanej (albo już czekającej) przesyłce tworzy NOWY wiersz.
  it('drugie kliknięcie tworzy DRUGI wiersz w kolejce, nie odbija się od żadnej blokady', async () => {
    const { zamowienieId, przesylkaId } = przesylkaZZpl();
    await serwer.inject({ method: 'POST', url: `/zamowienia/${zamowienieId}/przesylki/${przesylkaId}/drukuj`, headers: naglowek });
    const r = await serwer.inject({ method: 'POST', url: `/zamowienia/${zamowienieId}/przesylki/${przesylkaId}/drukuj`, headers: naglowek });
    expect(r.statusCode).toBe(302);
    expect(db.prepare('SELECT COUNT(*) c FROM kolejka_druku WHERE przesylka_id = ?').get(przesylkaId).c).toBe(2);
  });

  it('brak etykiety ZPL dla przesyłki → 400, nic nie wstawia do kolejki', async () => {
    const zamowienieId = zapiszZamowienie(db, 'pro', zmapowane({ numer: '1305' }), {});
    const p = rozpocznijPrzesylke(db, zamowienieId, 'dpd');
    zakonczPrzesylke(db, p.id, { numerListu: 'X1', etykietaSciezka: '/e/1.pdf', etykietaZplSciezka: null, surowa: '<xml/>' });
    const r = await serwer.inject({ method: 'POST', url: `/zamowienia/${zamowienieId}/przesylki/${p.id}/drukuj`, headers: naglowek });
    expect(r.statusCode).toBe(400);
    expect(db.prepare('SELECT COUNT(*) c FROM kolejka_druku').get().c).toBe(0);
  });

  it('nieistniejące zamówienie → 404', async () => {
    const r = await serwer.inject({ method: 'POST', url: '/zamowienia/9999/przesylki/1/drukuj', headers: naglowek });
    expect(r.statusCode).toBe(404);
  });
});

describe('POST /zamowienia/:id/przesylki/:przesylkaId/drukuj/:kolejkaId/porzuc', () => {
  it('bez uwierzytelnienia → 401 i pozycja nietknięta', async () => {
    const { zamowienieId, przesylkaId } = przesylkaZZpl();
    const w = dodajDoKolejki(db, przesylkaId);
    const r = await serwer.inject({ method: 'POST', url: `/zamowienia/${zamowienieId}/przesylki/${przesylkaId}/drukuj/${w.id}/porzuc` });
    expect(r.statusCode).toBe(401);
    expect(db.prepare('SELECT status FROM kolejka_druku WHERE id = ?').get(w.id).status).toBe('oczekuje');
  });

  it('ustawia status „porzucone" i zapisuje decyzję człowieka w logu', async () => {
    const { zamowienieId, przesylkaId } = przesylkaZZpl();
    const w = dodajDoKolejki(db, przesylkaId);
    const r = await serwer.inject({ method: 'POST', url: `/zamowienia/${zamowienieId}/przesylki/${przesylkaId}/drukuj/${w.id}/porzuc`, headers: naglowek });
    expect(r.statusCode).toBe(302);
    expect(db.prepare('SELECT status FROM kolejka_druku WHERE id = ?').get(w.id).status).toBe('porzucone');
    const wpis = db.prepare("SELECT * FROM log WHERE zamowienie_id = ? AND akcja = 'kolejka-druku.porzucenie'").get(zamowienieId);
    expect(wpis.wynik).toMatch(/Ręcznie( \(|:)/);
    expect(wpis.wynik).toContain('adam');
  });

  it('nieistniejąca pozycja kolejki → 400, nie 500', async () => {
    const { zamowienieId, przesylkaId } = przesylkaZZpl();
    const r = await serwer.inject({ method: 'POST', url: `/zamowienia/${zamowienieId}/przesylki/${przesylkaId}/drukuj/9999/porzuc`, headers: naglowek });
    expect(r.statusCode).toBe(400);
  });

  it('nieistniejące zamówienie → 404', async () => {
    const r = await serwer.inject({ method: 'POST', url: '/zamowienia/9999/przesylki/1/drukuj/1/porzuc', headers: naglowek });
    expect(r.statusCode).toBe(404);
  });
});
