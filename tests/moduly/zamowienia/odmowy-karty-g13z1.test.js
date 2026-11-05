// PRZ-152.G13z1: odmowy tras karty zamówienia (karta.js, kontekst.js, scalanie.js) w układzie OMS
// zamiast gołego text/plain. Status i tekst znak w znak — zmienia się tylko opakowanie.
// Spis miejsc: docs/plany/PRZ-152-G13-odmowy.md, „### zamowienia” (nr 223–239, 259–262).
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import * as zamowienia from '../../../src/oms/db/zamowienia.js';
import * as platnosci from '../../../src/oms/db/platnosci.js';
import * as scalenia from '../../../src/oms/db/scalenia.js';
import * as rabat from '../../../src/moduly/zamowienia/services/rabat.js';
import * as wysylka from '../../../src/domena/wysylka.js';
import * as domenaScalania from '../../../src/domena/scalanie.js';
import { bladOperatora } from '../../../src/domena/bledy.js';

const headers = { authorization: `Basic ${Buffer.from('operator:x').toString('base64')}`, origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' };
const BLAD = 'Próbny błąd Pracowni Półcień.';
let db, server, id;
beforeEach(() => {
  // Żadnych połączeń z siecią: każda próba kończy test błędem.
  vi.stubGlobal('fetch', () => { throw new Error('fetch zabroniony w teście'); });
  db = openOmsDb(':memory:');
  server = buildOmsServer({ db, config: {
    auth: { user: 'operator', pass: 'x' }, sklepy: {}, kanaly: {}, definicje: [],
    nadawca: { nazwa: 'Pracownia Półcień', ulica: 'Cienista 3', kod: '00-000', miasto: 'Testowo', kraj: 'PL' },
  }, poller: { stan: () => ({}) } });
  // Dwa zamówienia: drugi numer id wyłapuje powrót zawsze do pierwszego.
  zamowienie(1);
  id = zamowienie(2);
});
afterEach(async () => { await server?.close(); db?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function zamowienie(n) {
  return zamowienia.zapiszZamowienie(db, 'testowy', {
    zrodlo_id: n, numer: `POL-${n}`, klient: {}, dostawa: {}, kwota_brutto: '10.00', pozycje: [],
    metoda_wysylki: 'odbior', kwota_pobrania: null, chce_fakture: 0, nip: null,
    status_woo: 'processing', oplacone_at: null, anulowane: 0,
  }, {});
}

const ucieczka = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&#34;').replace(/'/g, '&#39;');
const post = (url, payload = {}) => server.inject({ method: 'POST', url, headers, payload: new URLSearchParams(payload).toString() });

function ekran(r, status, tekst, powrot) {
  expect(r.statusCode).toBe(status);
  expect(r.headers['content-type']).toMatch(/^text\/html/);
  expect(r.body).toContain('<html');
  expect(r.body).toContain('class="oms-sidebar');
  expect(r.body).toContain(`<div class="pas-uprzedzenie" role="alert"><p>${ucieczka(tekst)}</p></div>`);
  // 404: zamówienia nie ma, więc powrót na jego kartę dałby znowu 404 — wtedy lista zamówień.
  if (status === 404) expect(r.body).toContain('<a href="/">Wróć do listy zamówień</a>');
  else expect(r.body).toContain(`<a href="${powrot}">Wróć do zamówienia</a>`);
}

// ——— karta.js ———
it('GET /zamowienia/:id bez zamówienia (223)', async () => {
  ekran(await server.inject({ url: '/zamowienia/999', headers }), 404, 'Nie ma takiego zamówienia');
});

it('ustalenia: brak zamówienia (224) i błąd zapisu (225)', async () => {
  ekran(await post('/zamowienia/999/ustalenia'), 404, 'Nie ma takiego zamówienia');
  vi.spyOn(rabat, 'zmienUstalenia').mockImplementation(() => { throw bladOperatora(BLAD); });
  ekran(await post(`/zamowienia/${id}/ustalenia`, { powrot: '/?szukaj=pol' }), 400,
    `Nie udało się zapisać ustaleń: ${BLAD}`, `/zamowienia/${id}?powrot=%2F%3Fszukaj%3Dpol#szczegoly`);
});

it('wysyłka/metoda: brak zamówienia (226), błędny formularz (227), pobranie grupy (228), błąd zapisu (229)', async () => {
  ekran(await post('/zamowienia/999/wysylka/metoda'), 404, 'Nie ma takiego zamówienia');
  const sprawdz = vi.spyOn(wysylka, 'sprawdzZmianeMetody').mockReturnValue({ nadpisanie: null, blad: 'Wybierz metodę "Kurier" z listy & zapisz.' });
  ekran(await post(`/zamowienia/${id}/wysylka/metoda`), 400, 'Wybierz metodę "Kurier" z listy & zapisz.', `/zamowienia/${id}`);
  sprawdz.mockReturnValue({ nadpisanie: { metoda: 'dpd', pobranie: true, kwota_pobrania: '10.00' }, blad: null });
  vi.spyOn(domenaScalania, 'powodOdmowyPobraniaGrupy').mockReturnValue('Próbna odmowa pobrania grupy.');
  ekran(await post(`/zamowienia/${id}/wysylka/metoda`), 400, 'Próbna odmowa pobrania grupy.', `/zamowienia/${id}`);
  sprawdz.mockReturnValue({ nadpisanie: { metoda: 'dpd', pobranie: false }, blad: null });
  vi.spyOn(zamowienia, 'zapiszNadpisanieWysylki').mockImplementation(() => { throw bladOperatora(BLAD); });
  ekran(await post(`/zamowienia/${id}/wysylka/metoda`), 400, `Nie udało się zmienić metody wysyłki: ${BLAD}`, `/zamowienia/${id}`);
});

it('wysyłka/przywróć: brak zamówienia (230), pobranie grupy (231), błąd zapisu (232)', async () => {
  ekran(await post('/zamowienia/999/wysylka/przywroc'), 404, 'Nie ma takiego zamówienia');
  const zeSklepu = vi.spyOn(wysylka, 'pobranieZeSklepu').mockReturnValue(true);
  vi.spyOn(domenaScalania, 'powodOdmowyPobraniaGrupy').mockReturnValue('Próbna odmowa pobrania grupy.');
  ekran(await post(`/zamowienia/${id}/wysylka/przywroc`), 400, 'Próbna odmowa pobrania grupy.', `/zamowienia/${id}`);
  zeSklepu.mockReturnValue(false);
  vi.spyOn(zamowienia, 'przywrocMetodeWysylkiZeSklepu').mockImplementation(() => { throw bladOperatora(BLAD); });
  ekran(await post(`/zamowienia/${id}/wysylka/przywroc`), 400, `Nie udało się przywrócić metody: ${BLAD}`, `/zamowienia/${id}`);
});

it('płatności: brak zamówienia przy dodaniu (235)', async () => {
  ekran(await post('/zamowienia/999/platnosci', { kwota: '10.00', data: '2026-11-05' }), 404, 'Nie ma takiego zamówienia');
});

it('płatności/usuń: brak zamówienia (236) i odmowa usunięcia (237), wpłaty bez zmian', async () => {
  ekran(await post('/zamowienia/999/platnosci/1/usun'), 404, 'Nie ma takiego zamówienia');
  // Wpłata nieistniejąca: odmowa z bazy (prawdziwa, bez atrapy).
  const r = await post(`/zamowienia/${id}/platnosci/424242/usun`);
  expect(r.statusCode).toBe(400);
  let tekst;
  try { platnosci.usunWplateReczna(db, id, 424242); } catch (e) { tekst = (await import('../../../src/domena/bledy.js')).komunikatDlaOperatora(e); }
  expect(tekst).toBeTruthy();
  ekran(r, 400, tekst, `/zamowienia/${id}`);
});

// ——— kontekst.js: pozycjaZadania (trasy pozycji z reczne.js, formaction= na karcie) ———
it('pozycja: brak zamówienia (238) i brak pozycji (239)', async () => {
  ekran(await post('/zamowienia/999/pozycje/k1/usun'), 404, 'Nie ma takiego zamówienia');
  ekran(await post(`/zamowienia/${id}/pozycje/brak-takiej/przywroc`), 404, 'To zamówienie nie ma takiej pozycji — odśwież kartę.');
});

// ——— scalanie.js ———
it('odłącz anulowane: brak zamówienia (259) i błąd (260)', async () => {
  ekran(await post('/zamowienia/999/odlacz-anulowane'), 404, 'Nie ma takiego zamówienia');
  vi.spyOn(scalenia, 'odlaczAnulowane').mockImplementation(() => { throw bladOperatora(BLAD); });
  ekran(await post(`/zamowienia/${id}/odlacz-anulowane`, { powrot: '/?szukaj=pol' }), 400,
    `Nie udało się odłączyć: ${BLAD}`, `/zamowienia/${id}?powrot=%2F%3Fszukaj%3Dpol`);
});

it('rozdziel: brak zamówienia (261) i błąd (262)', async () => {
  ekran(await post('/zamowienia/999/rozdziel'), 404, 'Nie ma takiego zamówienia');
  vi.spyOn(scalenia, 'rozdzielZamowienia').mockImplementation(() => { throw bladOperatora(BLAD); });
  ekran(await post(`/zamowienia/${id}/rozdziel`), 400, `Nie udało się rozdzielić: ${BLAD}`, `/zamowienia/${id}`);
});
