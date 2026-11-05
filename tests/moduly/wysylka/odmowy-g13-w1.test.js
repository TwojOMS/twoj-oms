// PRZ-152.G13 W1: odmowy tras przesyłek na karcie zamówienia (wysylka/trasy/etykiety.js) w układzie OMS.
// Status i tekst bez zmian, zmienia się opakowanie: strona z menu, paskiem uwagi i powrotem na kartę.
// Kolejka druku dla czuwacza (kategoria A) zostaje gołym tekstem — test pilnuje i tego.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { rozpocznijPrzesylke, zakonczPrzesylke, odblokujPrzesylke, domknijPrzesylke, zalatwPrzesylkeRecznie, skasujPrzesylkeReczna } from '../../../src/moduly/wysylka/db/przesylki.js';
import { porzucPozycje } from '../../../src/moduly/wysylka/db/kolejka-druku.js';
import { komunikatDlaOperatora } from '../../../src/domena/bledy.js';
import { panelKuriera } from '../../../src/domena/moduly-kurierow.ts';
import { nowyPanel, get, BASIC, HTML, ORIGIN } from '../../pomoc/konta-prz068.js';

const zmapowane = (id) => ({
  zrodlo_id: id, numer: String(id), klient: { first_name: 'Jan', email: 'jan@przyklad.test', address_1: 'Lampowa 1', postcode: '00-950', city: 'Warszawa' },
  dostawa: { city: 'Warszawa' }, metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '99.00',
  status_woo: 'processing', oplacone_at: null, anulowane: 0, utworzone_at: '2026-11-05T10:00:00',
  pozycje: [{ nazwa: 'Szablon Półcień', sku: 'PC-001', ilosc: 1, cena_brutto: '99.00', vat: null }],
});

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&#34;').replace(/'/g, '&#39;');
const blad = (fn) => {
  try { fn(); } catch (e) { return komunikatDlaOperatora(e); }
  throw new Error('miało rzucić');
};

let katalog, p, numer = 7100;
beforeEach(() => {
  katalog = mkdtempSync(join(tmpdir(), 'g13w1-'));
  p = nowyPanel();
});
afterEach(async () => {
  await p.app.close();
  p.db.close();
  rmSync(katalog, { recursive: true, force: true });
});

function paczka({ pdf = 'brak', zpl = null, kurier = 'dpd' } = {}) {
  const id = zapiszZamowienie(p.db, 'pro', zmapowane(numer++), {});
  const prz = rozpocznijPrzesylke(p.db, id, kurier);
  const pdfSciezka = pdf ? join(katalog, `e-${prz.id}.pdf`) : null;
  if (pdf === 'plik') writeFileSync(pdfSciezka, '%PDF-1.4 zmyślona etykieta');
  const zplSciezka = zpl ? join(katalog, `e-${prz.id}.zpl`) : null;
  if (zpl === 'plik') writeFileSync(zplSciezka, '^XA^XZ');
  zakonczPrzesylke(p.db, prz.id, { numerListu: `ZMYSLONY${prz.id}`, etykietaSciezka: pdfSciezka, etykietaZplSciezka: zplSciezka, surowa: '<x/>' });
  return { id, pid: prz.id };
}

const wyslij = (url, payload = '') => p.app.inject({
  method: 'POST', url, payload,
  headers: { ...HTML, ...ORIGIN, ...BASIC, 'content-type': 'application/x-www-form-urlencoded' },
});

function stronaOms(r, status, tekst, { tytul, wroc, napisWroc = 'Wróć do zamówienia' }) {
  expect(r.statusCode, r.body).toBe(status);
  expect(r.headers['content-type']).toMatch(/^text\/html/);
  expect(r.body).toMatch(/<html/);
  expect(r.body).toContain(`<p class="pasek-uwaga" role="alert">${esc(tekst)}</p>`);
  expect(r.body).toContain(`<h1>${esc(tytul)}</h1>`);
  expect(r.body).toContain(`<a class="btn" href="${esc(wroc)}">${napisWroc}</a>`);
}

describe('odmowy tras przesyłek na karcie — strona w układzie OMS', () => {
  it('nie ma zamówienia → 404, powrót na listę', async () => {
    const r = await wyslij('/zamowienia/999999/przesylki/1/domknij');
    stronaOms(r, 404, 'Nie ma takiego zamówienia', { tytul: 'Nie znaleziono zamówienia', wroc: '/', napisWroc: 'Wróć do listy' });
  });

  it('nie ma przesyłki w tym zamówieniu (GET etykiety) → 404, powrót na kartę', async () => {
    const { id } = paczka();
    const r = await get(p.app, `/zamowienia/${id}/przesylki/999999/etykieta`, BASIC);
    stronaOms(r, 404, 'To zamówienie nie ma takiej przesyłki.', { tytul: 'Nie znaleziono przesyłki', wroc: `/zamowienia/${id}` });
  });

  it('sprawdź bez skonfigurowanego nadania → 503', async () => {
    const { id, pid } = paczka();
    const r = await wyslij(`/zamowienia/${id}/przesylki/${pid}/sprawdz`);
    stronaOms(r, 503, 'Nadawanie nie jest skonfigurowane (brak danych kuriera).', { tytul: 'Nie udało się sprawdzić przesyłki', wroc: `/zamowienia/${id}` });
  });

  it('notatka bez skonfigurowanego nadania → 503', async () => {
    const { id, pid } = paczka();
    const r = await wyslij(`/zamowienia/${id}/przesylki/${pid}/notatka`);
    stronaOms(r, 503, 'Nadawanie nie jest skonfigurowane (brak sklepu albo kuriera).', { tytul: 'Nie udało się ponowić notatki', wroc: `/zamowienia/${id}` });
  });

  it('sprawdź i notatka: wyjątek nadania → 400 (fetch do kuriera nie wychodzi)', async () => {
    await p.app.close();
    p.db.close();
    const nadanie = {
      gotowe: () => true,
      sprawdzPonownie: async () => { throw new Error('fetch zablokowany w teście'); },
      ponowNotatke: async () => { throw new Error('fetch zablokowany w teście'); },
    };
    p = nowyPanel({ nadanie });
    const { id, pid } = paczka();
    const techniczny = 'błąd techniczny panelu — szczegóły w logu zamówienia.';
    stronaOms(await wyslij(`/zamowienia/${id}/przesylki/${pid}/sprawdz`), 400, `Nie udało się sprawdzić przesyłki: ${techniczny}`, { tytul: 'Nie udało się sprawdzić przesyłki', wroc: `/zamowienia/${id}` });
    stronaOms(await wyslij(`/zamowienia/${id}/przesylki/${pid}/notatka`), 400, `Nie udało się ponowić notatki: ${techniczny}`, { tytul: 'Nie udało się ponowić notatki', wroc: `/zamowienia/${id}` });
  });

  it('odblokuj nadanej paczki → 400; powrót niesie filtr listy', async () => {
    const { id, pid } = paczka();
    const r = await wyslij(`/zamowienia/${id}/przesylki/${pid}/odblokuj`, 'powrot=%2F%3Fszukaj%3DJan');
    const tekst = blad(() => odblokujPrzesylke(p.db, pid, { opis: 'x' }));
    stronaOms(r, 400, `Nie udało się odblokować nadania: ${tekst}`, { tytul: 'Nie udało się odblokować nadania', wroc: `/zamowienia/${id}?powrot=%2F%3Fszukaj%3DJan` });
  });

  it('domknij paczki nie do wyjaśnienia → 400', async () => {
    const { id, pid } = paczka();
    const r = await wyslij(`/zamowienia/${id}/przesylki/${pid}/domknij`);
    const tekst = blad(() => domknijPrzesylke(p.db, pid));
    stronaOms(r, 400, `Nie udało się domknąć przesyłki: ${tekst}`, { tytul: 'Nie udało się domknąć przesyłki', wroc: `/zamowienia/${id}` });
  });

  it('sprawa załatwiona bez sprawy → 400', async () => {
    const { id, pid } = paczka();
    const r = await wyslij(`/zamowienia/${id}/przesylki/${pid}/sprawa-zalatwiona`);
    const tekst = blad(() => zalatwPrzesylkeRecznie(p.db, pid));
    stronaOms(r, 400, `Nie udało się zdjąć sprawy: ${tekst}`, { tytul: 'Nie udało się zdjąć sprawy', wroc: `/zamowienia/${id}` });
  });

  it('ukryj jedynej paczki → 400', async () => {
    const { id, pid } = paczka();
    const r = await wyslij(`/zamowienia/${id}/przesylki/${pid}/ukryj`);
    const tekst = 'Paczki nr 1 nie da się ukryć: do tego zamówienia nie ma nadanej kolejnej paczki. '
      + 'Ukrywanie służy paczkom, które zastąpiła następna — a nie tej, która właśnie jedzie. '
      + 'Odśwież kartę zamówienia.';
    stronaOms(r, 400, tekst, { tytul: 'Nie udało się ukryć paczki', wroc: `/zamowienia/${id}` });
  });

  it('skasuj-reczna paczki nadanej przez kuriera → 400', async () => {
    const { id, pid } = paczka();
    const r = await wyslij(`/zamowienia/${id}/przesylki/${pid}/skasuj-reczna`);
    const tekst = blad(() => skasujPrzesylkeReczna(p.db, pid));
    stronaOms(r, 400, `Nie udało się skasować przesyłki: ${tekst}`, { tytul: 'Nie udało się skasować przesyłki', wroc: `/zamowienia/${id}` });
  });

  it('drukuj bez ZPL → 400', async () => {
    const { id, pid } = paczka();
    const r = await wyslij(`/zamowienia/${id}/przesylki/${pid}/drukuj`);
    stronaOms(r, 400, 'Brak etykiety ZPL dla tej przesyłki — nie ma czego wysłać do druku.', { tytul: 'Nie udało się dodać do kolejki druku', wroc: `/zamowienia/${id}` });
  });

  it('drukuj: awaria kolejki → 400', async () => {
    const { id, pid } = paczka({ zpl: 'plik' });
    p.db.exec('DROP TABLE kolejka_druku');
    const r = await wyslij(`/zamowienia/${id}/przesylki/${pid}/drukuj`);
    stronaOms(r, 400, 'Nie udało się dodać do kolejki druku: błąd techniczny panelu — szczegóły w logu zamówienia.', { tytul: 'Nie udało się dodać do kolejki druku', wroc: `/zamowienia/${id}` });
  });

  it('porzuć nieistniejącą pozycję kolejki → 400', async () => {
    const { id, pid } = paczka();
    const r = await wyslij(`/zamowienia/${id}/przesylki/${pid}/drukuj/999999/porzuc`);
    const tekst = blad(() => porzucPozycje(p.db, 999999));
    stronaOms(r, 400, `Nie udało się porzucić pozycji: ${tekst}`, { tytul: 'Nie udało się porzucić pozycji kolejki druku', wroc: `/zamowienia/${id}` });
  });

  it('etykieta PDF: brak w bazie → 404, brak pliku → 404', async () => {
    const a = paczka({ pdf: null });
    stronaOms(await get(p.app, `/zamowienia/${a.id}/przesylki/${a.pid}/etykieta`, BASIC), 404, 'Brak etykiety dla tej przesyłki.', { tytul: 'Nie udało się otworzyć etykiety', wroc: `/zamowienia/${a.id}` });
    const b = paczka({ pdf: 'brak' });
    stronaOms(await get(p.app, `/zamowienia/${b.id}/przesylki/${b.pid}/etykieta`, BASIC), 404, `Plik etykiety nie istnieje na dysku — pobierz etykietę z ${panelKuriera('dpd')} po numerze listu.`, { tytul: 'Nie udało się otworzyć etykiety', wroc: `/zamowienia/${b.id}` });
  });

  it('etykieta ZPL: brak w bazie → 404, brak pliku → 404', async () => {
    const a = paczka({ zpl: null });
    stronaOms(await get(p.app, `/zamowienia/${a.id}/przesylki/${a.pid}/etykieta-zpl`, BASIC), 404, 'Ta przesyłka nie ma etykiety ZPL — pobierz etykietę PDF.', { tytul: 'Nie udało się pobrać pliku ZPL', wroc: `/zamowienia/${a.id}` });
    const b = paczka({ zpl: 'brak' });
    stronaOms(await get(p.app, `/zamowienia/${b.id}/przesylki/${b.pid}/etykieta-zpl`, BASIC), 404, `Plik ZPL nie istnieje na dysku — pobierz etykietę z ${panelKuriera('dpd')} po numerze listu.`, { tytul: 'Nie udało się pobrać pliku ZPL', wroc: `/zamowienia/${b.id}` });
  });
});

describe('bez zmian', () => {
  it('etykieta PDF, gdy plik jest → application/pdf, bajty pliku', async () => {
    const { id, pid } = paczka({ pdf: 'plik' });
    const r = await get(p.app, `/zamowienia/${id}/przesylki/${pid}/etykieta`, BASIC);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.body).toBe('%PDF-1.4 zmyślona etykieta');
  });

  it('kolejka druku dla czuwacza (A) → goły tekst', async () => {
    const r1 = await get(p.app, '/kolejka-druku/999999/zpl', BASIC);
    expect(r1.statusCode).toBe(404);
    expect(r1.headers['content-type']).toMatch(/^text\/plain/);
    expect(r1.body).toBe('Brak pliku ZPL dla tej pozycji kolejki.');
    const r2 = await wyslij('/kolejka-druku/999999/wydrukowano');
    expect(r2.statusCode).toBe(404);
    expect(r2.headers['content-type']).toMatch(/^text\/plain/);
    expect(r2.body).not.toMatch(/<html/);
  });
});
