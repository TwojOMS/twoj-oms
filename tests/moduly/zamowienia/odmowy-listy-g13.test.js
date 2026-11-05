import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { bladOperatora } from '../../../src/domena/bledy.js';
import * as specyfikacje from '../../../src/moduly/zamowienia/pdf/specyfikacja-pdf.js';
import * as wydruki from '../../../src/moduly/zamowienia/pdf/wydruki-pdf.js';

const headers = { authorization: `Basic ${Buffer.from('operator:x').toString('base64')}`, origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' };
let db, server;
beforeEach(() => {
  db = openOmsDb(':memory:');
  server = buildOmsServer({ db, config: {
    auth: { user: 'operator', pass: 'x' }, sklepy: {}, kanaly: {}, definicje: [],
    nadawca: { nazwa: 'Próbna Pracownia', ulica: 'Przykładowa 7', kod: '00-000', miasto: 'Testowo', kraj: 'PL' },
    proforma: { nip: '1234563218' },
  }, poller: { stan: () => ({}) } });
});
afterEach(async () => { await server?.close(); db?.close(); vi.restoreAllMocks(); });

function zamowienie(n = 1) {
  return zapiszZamowienie(db, 'testowy', {
    zrodlo_id: n, numer: `TEST-${n}`, klient: {}, dostawa: {}, kwota_brutto: '10.00', pozycje: [],
    metoda_wysylki: 'odbior', kwota_pobrania: null, chce_fakture: 0, nip: null,
    status_woo: 'processing', oplacone_at: null, anulowane: 0,
  }, {});
}

function odmowa(r, status, tekst, tytul, wroc, karta = false) {
  expect(r.statusCode).toBe(status);
  expect(r.headers['content-type']).toMatch(/^text\/html/);
  expect(r.body).toContain('<html');
  expect(r.body).toContain(`<p class="pasek-uwaga" role="alert">${tekst}</p>`);
  expect(r.body).toContain(`<h1>${tytul}</h1>`);
  expect(r.body).toContain(`<a class="btn" href="${wroc}">Wróć do ${karta ? 'zamówienia' : 'listy zamówień'}</a>`);
}

const rodzaje = [
  { pojedyncza: 'specyfikacja', zbiorcza: 'specyfikacje', co: 'specyfikacji', tytul: 'Nie udało się przygotować specyfikacji', modul: specyfikacje, jedna: 'zbudujSpecyfikacjePdf', wiele: 'zbudujSpecyfikacjeWieluPdf' },
  { pojedyncza: 'lista-produktow', zbiorcza: 'lista-produktow', co: 'listy produktów', tytul: 'Nie udało się przygotować wydruku', modul: wydruki, jedna: 'zbudujListeProduktowPdf', wiele: 'zbudujListeProduktowPdf' },
  { pojedyncza: 'zestawienie', zbiorcza: 'zestawienie', co: 'zestawienia zamówień', tytul: 'Nie udało się przygotować wydruku', modul: wydruki, jedna: 'zbudujZestawieniePdf', wiele: 'zbudujZestawieniePdf' },
];

for (const r of rodzaje) {
  it(`${r.pojedyncza}: brak zamówienia (241, 243), powrót na kartę z filtrem`, async () => {
    const response = await server.inject({ url: `/zamowienia/999/${r.pojedyncza}.pdf?powrot=${encodeURIComponent('/?szukaj=test')}`, headers });
    odmowa(response, 404, 'Nie ma takiego zamówienia', r.tytul, '/zamowienia/999?powrot=%2F%3Fszukaj%3Dtest', true);
  });

  it(`${r.zbiorcza}: puste zaznaczenie (245, 248), powrót na listę z filtrem`, async () => {
    const response = await server.inject({ method: 'POST', url: `/zamowienia/${r.zbiorcza}.pdf`, headers, payload: new URLSearchParams({ powrot: '/?szukaj=test' }).toString() });
    odmowa(response, 400, 'Nie zaznaczono żadnego zamówienia.', r.tytul, '/?szukaj=test');
  });

  it(`${r.zbiorcza}: limit zaznaczeń (246, 249)`, async () => {
    const payload = new URLSearchParams();
    for (let n = 1; n <= 101; n++) payload.append('id', String(zamowienie(n)));
    const response = await server.inject({ method: 'POST', url: `/zamowienia/${r.zbiorcza}.pdf`, headers, payload: payload.toString() });
    odmowa(response, 400, `Zaznaczono 101 zamówień, a panel drukuje najwyżej 100 zamówień w jednym wydruku ${r.co}. Nie wydrukowano niczego — zaznacz mniej i powtórz.`, r.tytul, '/');
  });

  for (const masowo of [false, true]) {
    it(`${r.pojedyncza}: błąd PDF ${masowo ? 'zbiorczy' : 'pojedynczy'} (242, 244, 247, 250)`, async () => {
      const id = zamowienie();
      // Awaria generatora bez drukowania i bez połączeń z integracjami.
      vi.spyOn(r.modul, masowo ? r.wiele : r.jedna).mockRejectedValue(bladOperatora('Próbny błąd wydruku.'));
      const response = await server.inject({ method: masowo ? 'POST' : 'GET', url: masowo ? `/zamowienia/${r.zbiorcza}.pdf` : `/zamowienia/${id}/${r.pojedyncza}.pdf`, headers, ...(masowo ? { payload: `id=${id}` } : {}) });
      odmowa(response, 400, `Nie udało się przygotować ${r.co}: Próbny błąd wydruku.`, r.tytul, masowo ? '/' : `/zamowienia/${id}`, !masowo);
    });
  }
}
