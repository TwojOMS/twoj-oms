import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { escapeXML } from 'ejs';
import { nowyPanel, BASIC, post } from '../../pomoc/konta-prz068.js';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import * as zwroty from '../../../src/oms/db/zwroty.js';
import { bladOperatora } from '../../../src/domena/bledy.js';
import { GDZIE_KLUCZ_INFAKTU } from '../../../src/domena/konfiguracja-infakt.js';

let p, id, w, body;
const komunikat = 'Odmowa dla Pracowni Półcień <korekta> & "zwrot".';
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Sieć zabroniona'); });
});
afterEach(async () => {
  await p?.app.close(); p?.db.close(); p = null;
  vi.restoreAllMocks();
});

function przygotuj(korekta = { wystaw: async () => { throw bladOperatora(komunikat); } }) {
  p = nowyPanel({ korekta, env: { OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir() } });
  id = zapiszZamowienie(p.db, 'test', {
    zrodlo_id: 1, numer: 'TEST-1', klient: { nazwa: 'Pracownia Półcień' }, dostawa: {},
    metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null,
    status_woo: 'processing', oplacone_at: null,
    kwota_brutto: '20.00', koszt_dostawy_brutto: '0.00', anulowane: 0,
    utworzone_at: '2026-08-01T12:00:00',
    pozycje: [{ zrodlo_id: 1, nazwa: 'Produkt próbny', sku: 'TEST', ilosc: 2, cena_brutto: '10.00', cena_netto: null, vat: null, brutto_linii: '20.00' }],
  }, {});
  const klucz = pobierzZamowienie(p.db, id).pozycje[0].klucz;
  body = { data: '2026-08-02', kwota: '10.00', klucz, nazwa: 'Produkt próbny', ilosc: '1', pozycja_kwota: '10.00' };
  w = zwroty.dodajZwrot(p.db, id, { data: '2026-08-03', kwota: '10.00', pozycje: [{ klucz_pozycji: klucz, nazwa: 'Produkt próbny', ilosc: 1, kwota: '10.00' }] });
}

async function sprawdz(sciezka, status, tekst, { lista = false, tytul = 'Nie udało się obsłużyć zwrotu', payload = {} } = {}) {
  const r = await post(p.app, sciezka, { ...BASIC, referer: 'https://obca.example/' }, { powrot: '//obca.example', ...payload });
  expect(r.statusCode).toBe(status);
  expect(r.headers['content-type']).toMatch(/^text\/html/);
  expect(r.body).toContain('<html');
  expect(r.body).toContain(`<p class="pasek-uwaga" role="alert">${escapeXML(tekst)}</p>`);
  expect(r.body).toContain(`<h1>${tytul}</h1>`);
  expect(r.body).toContain(`<a class="btn" href="${lista ? '/' : `/zamowienia/${id}/zwrot`}">Wróć do ${lista ? 'listy zamówień' : 'ekranu zwrotu'}</a>`);
  expect(globalThis.fetch).not.toHaveBeenCalled();
  return r;
}
const adres = (akcja, zwrotId = w.id) => `/zamowienia/${id}/zwroty/${zwrotId}/${akcja}`;
const awaria = (metoda) => vi.spyOn(zwroty, metoda).mockImplementation(() => { throw bladOperatora(komunikat); });

it('264: odmowa oznaczenia pieniędzy', async () => {
  przygotuj(); awaria('oznaczPieniadzeOddane');
  await sprawdz(adres('pieniadze'), 400, komunikat);
});
it('264: brak zwrotu przy oznaczeniu pieniędzy wraca na listę', async () => {
  przygotuj();
  await sprawdz(adres('pieniadze', 99999), 400, 'Nie ma takiego zwrotu przy tym zamówieniu.');
});
for (const akcja of ['usun', 'korekta/odblokuj', 'korekta/reczna']) {
  it(`265/270/273: brak zwrotu: ${akcja}`, async () => {
    przygotuj();
    await sprawdz(adres(akcja, 99999), 404, 'Nie ma takiego zwrotu przy tym zamówieniu.');
  });
}
it('266: reguła usunięcia', async () => {
  przygotuj(); zwroty.oznaczPieniadzeOddane(p.db, id, w.id);
  await sprawdz(adres('usun'), 400, 'Do tego zwrotu pieniądze zostały już oddane — skasowanie zostawiłoby wypłatę bez podstawy.');
});
it('267: błąd zapisu usunięcia', async () => {
  przygotuj(); awaria('usunZwrot'); await sprawdz(adres('usun'), 400, komunikat);
});
it('268: brak programu korekt', async () => {
  przygotuj(null);
  await sprawdz(adres('korekta'), 503, `Wystawianie korekt nie jest skonfigurowane (brak inFaktu). ${GDZIE_KLUCZ_INFAKTU}`);
});
it('269: odmowa usługi korekt', async () => {
  przygotuj(); await sprawdz(adres('korekta'), 400, komunikat);
});
it('271: reguła odblokowania', async () => {
  przygotuj(); await sprawdz(adres('korekta/odblokuj'), 400, 'Do tego zwrotu nie ma zleconej korekty — nie ma czego odblokowywać.');
});
it('272: błąd zapisu odblokowania', async () => {
  przygotuj(); zwroty.zarezerwujKorekte(p.db, id, w.id, '2026-08-03T12:00:00'); awaria('odblokujKorekte');
  await sprawdz(adres('korekta/odblokuj'), 400, `Nie udało się odblokować korekty: ${komunikat}`);
});
it('274: walidacja numeru ręcznej korekty', async () => {
  przygotuj(); await sprawdz(adres('korekta/reczna'), 400, 'Podaj numer korekty z inFaktu — bez niego nie ma czego odnotować.');
});
it('275: błąd zapisu numeru ręcznej korekty', async () => {
  przygotuj(); awaria('zapiszRecznyNumerKorekty');
  await sprawdz(adres('korekta/reczna'), 400, `Nie udało się zapisać numeru korekty: ${komunikat}`, { payload: { numer: 'KOR-TEST' } });
});
it('276: brak zamówienia przy rejestracji', async () => {
  przygotuj(); await sprawdz('/zamowienia/99999/zwrot', 404, 'Nie ma takiego zamówienia', { lista: true });
});
it('277: walidacja rejestracji', async () => {
  przygotuj(); await sprawdz(`/zamowienia/${id}/zwrot`, 400, 'Podaj datę zwrotu w formacie RRRR-MM-DD.');
});
it('278: błąd zapisu rejestracji', async () => {
  przygotuj(); awaria('dodajZwrot');
  await sprawdz(`/zamowienia/${id}/zwrot`, 400, komunikat, { payload: body });
});
for (const sciezka of ['zwrot/podglad', 'zwrot/popraw', 'zwroty/1/pieniadze', 'zwroty/1/usun', 'zwroty/1/korekta', 'zwroty/1/korekta/odblokuj', 'zwroty/1/korekta/reczna']) {
  it(`279: wspólne 404: ${sciezka}`, async () => {
    przygotuj(); await sprawdz(`/zamowienia/99999/${sciezka}`, 404, 'Nie ma takiego zamówienia', { lista: true });
  });
}
it('279: wspólne 404 linku GET', async () => {
  przygotuj();
  const r = await p.app.inject({ method: 'GET', url: '/zamowienia/99999/zwrot', headers: BASIC });
  expect(r.statusCode).toBe(404);
  expect(r.headers['content-type']).toMatch(/^text\/html/);
  expect(r.body).toContain('<html');
  expect(r.body).toContain('<p class="pasek-uwaga" role="alert">Nie ma takiego zamówienia</p>');
  expect(r.body).toContain('href="/"');
});
