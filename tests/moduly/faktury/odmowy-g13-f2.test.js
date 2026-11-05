import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zapiszProforme, uniewaznijPoprzednie } from '../../../src/moduly/faktury/db/proformy.js';

// PRZ-152.G13f2: odmowy druku faktur (src/moduly/faktury/trasy/druk.js) — strona w układzie OMS
// zamiast gołego text/plain. Status i tekst bez zmian; powrót na kartę zamówienia (jedyny wołający:
// link „PDF” w nowej karcie i formularze „Drukuj” / „Porzuć wydruk” na karcie). Kolejka druku
// (czuwacz, kategoria A) zostaje bez zmian.
const headers = { authorization: `Basic ${Buffer.from('operator:x').toString('base64')}`, origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' };
const config = () => ({ auth: { user: 'operator', pass: 'x' }, sklepy: {}, kanaly: {}, definicje: [] });
const poller = { stan: () => ({}) };
const PDF = Buffer.from('%PDF-1.4 zmyślony dokument');
let db, server;

beforeEach(() => {
  db = openOmsDb(':memory:');
  // Żadnego wyjścia do inFaktu: każda próba sieci kończy się wyjątkiem.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('test: sieć zabroniona'); });
});
afterEach(async () => { await server?.close(); db?.close(); server = db = null; vi.restoreAllMocks(); });

const zbuduj = (opcje = {}) => { server = buildOmsServer({ db, config: config(), poller, ...opcje }); return server; };

function zamowienie(n = 1) {
  return zapiszZamowienie(db, 'testowy', {
    zrodlo_id: n, numer: `TEST-${n}`, klient: {}, dostawa: {}, kwota_brutto: '10.00', pozycje: [],
    metoda_wysylki: 'odbior', kwota_pobrania: null, chce_fakture: 1, nip: null,
    status_woo: 'processing', oplacone_at: null, anulowane: 0,
  }, {});
}
const faktura = (id, uuid = null) => db.prepare(
  "INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?, ?, ?, '2026-10-29T07:27:00Z')",
).run(id, uuid, uuid ? '7/10/2026' : null);

function odmowa(r, status, tekst, tytul, wroc, napisWroc = 'Wróć do zamówienia') {
  expect(r.statusCode, r.body.slice(0, 300)).toBe(status);
  expect(r.headers['content-type']).toMatch(/^text\/html/);
  expect(r.body).toContain('<html');
  expect(r.body).toContain(`<p class="pasek-uwaga" role="alert">${tekst}</p>`);
  expect(r.body).toContain(`<h1>${tytul}</h1>`);
  expect(r.body).toContain(`<a class="btn" href="${wroc}">${napisWroc}</a>`);
}

const pdf = (id) => server.inject({ method: 'GET', url: `/zamowienia/${id}/faktura/pdf`, headers });
const post = (id, akcja, payload = '') => server.inject({ method: 'POST', url: `/zamowienia/${id}/faktura/${akcja}`, headers, payload });
const fakturaPdf = (pdfImpl) => ({ wystaw: vi.fn(), pdf: pdfImpl });

it('GET faktura/pdf: brak zamówienia (37) → 404, powrót na listę (karta nie istnieje)', async () => {
  zbuduj({ faktura: fakturaPdf(vi.fn()) });
  odmowa(await pdf(9999), 404, 'Nie ma takiego zamówienia', 'Nie udało się pobrać faktury', '/', 'Wróć do listy zamówień');
  odmowa(await pdf('a%20b'), 404, 'Nie ma takiego zamówienia', 'Nie udało się pobrać faktury', '/', 'Wróć do listy zamówień');
});

it('GET faktura/pdf: bez programu fakturowego (38) → 503', async () => {
  zbuduj();
  const id = zamowienie(2);
  odmowa(await pdf(id), 503, 'Panel nie ma podpiętego inFaktu.', 'Nie udało się pobrać faktury', `/zamowienia/${id}#faktura`);
});

it('GET faktura/pdf: czeka na KSeF (45) → 409', async () => {
  const blad = Object.assign(new Error('Faktura czeka na numer KSeF — spróbuj za chwilę.'), { czekaNaKsef: true, dlaOperatora: true });
  zbuduj({ faktura: fakturaPdf(vi.fn().mockRejectedValue(blad)) });
  const id = zamowienie(3);
  odmowa(await pdf(id), 409, 'Faktura czeka na numer KSeF — spróbuj za chwilę.', 'Nie udało się pobrać faktury', `/zamowienia/${id}#faktura`);
});

it('GET faktura/pdf: błąd pobrania (47) → 400 z tym samym zdaniem', async () => {
  const blad = Object.assign(new Error('To zamówienie nie ma jeszcze faktury.'), { dlaOperatora: true });
  zbuduj({ faktura: fakturaPdf(vi.fn().mockRejectedValue(blad)) });
  const id = zamowienie(4);
  odmowa(await pdf(id), 400, 'Nie udało się pobrać faktury: To zamówienie nie ma jeszcze faktury.', 'Nie udało się pobrać faktury', `/zamowienia/${id}#faktura`);
});

it('GET faktura/pdf: gdy plik jest — odpowiedź binarna PDF bez zmian', async () => {
  zbuduj({ faktura: fakturaPdf(vi.fn().mockResolvedValue({ bajty: PDF, numer: '7/10/2026' })) });
  const id = zamowienie(5);
  const r = await pdf(id);
  expect(r.statusCode).toBe(200);
  expect(r.headers['content-type']).toContain('application/pdf');
  expect(r.headers['content-disposition']).toBe('attachment; filename="faktura-7_10_2026.pdf"');
  expect(Buffer.compare(r.rawPayload, PDF)).toBe(0);
});

it('POST faktura/drukuj: brak zamówienia (60) → 404, powrót na listę z formularza', async () => {
  zbuduj();
  odmowa(await post(9999, 'drukuj', 'powrot=%2F%3Fszukaj%3Dtest'), 404, 'Nie ma takiego zamówienia', 'Nie udało się wysłać faktury do druku',
    '/?szukaj=test', 'Wróć do listy zamówień');
});

it('POST faktura/drukuj: faktura bez dokumentu (65) → 400', async () => {
  zbuduj();
  const id = zamowienie(6);
  faktura(id);
  odmowa(await post(id, 'drukuj'), 400, 'Ta faktura nie ma jeszcze dokumentu w inFakcie — nie ma czego drukować.', 'Nie udało się wysłać faktury do druku',
    `/zamowienia/${id}#faktura`);
});

it('POST faktura/druk-porzuc: brak zamówienia (78) → 404 „Nie ma takiej faktury”, powrót na listę', async () => {
  zbuduj();
  odmowa(await post(9999, 'druk-porzuc', 'powrot=%2F%3Fszukaj%3Dtest'), 404, 'Nie ma takiej faktury', 'Nie udało się porzucić wydruku',
    '/?szukaj=test', 'Wróć do listy zamówień');
});

it('POST faktura/druk-porzuc: zamówienie bez faktury (78) → 404, powrót na kartę', async () => {
  zbuduj();
  const id = zamowienie(7);
  odmowa(await post(id, 'druk-porzuc', 'powrot=%2F%3Fszukaj%3Dtest'), 404, 'Nie ma takiej faktury', 'Nie udało się porzucić wydruku',
    `/zamowienia/${id}?powrot=%2F%3Fszukaj%3Dtest#faktura`);
});

it('POST faktura/druk-porzuc: faktura nie czeka w kolejce (80) → 404', async () => {
  zbuduj();
  const id = zamowienie(8);
  faktura(id, 'dok-8');
  odmowa(await post(id, 'druk-porzuc'), 404, 'Ta faktura nie czeka w kolejce druku.', 'Nie udało się porzucić wydruku', `/zamowienia/${id}#faktura`);
});

// Proformy (uwaga kierownika): te same formularze „Drukuj” / „Porzuć wydruk”, :id to id PROFORMY — powrót
// na kartę jej zamówienia; nieznana proforma → zamówienie nieznane, powrót na listę (z ?powrot, jeśli jest).
const zProforma = (id, plik = '/tmp/zmyslona-proforma.pdf') => {
  const p = zapiszProforme(db, id, { kwotaBrutto: '10.00', rok: 2026, miesiac: 11, utworzonaAt: '2026-11-03T10:00:00.000Z' });
  if (plik) db.prepare('UPDATE proformy SET plik_sciezka = ? WHERE id = ?').run(plik, p.id);
  expect(p.id, 'id proformy musi różnić się od id zamówienia').not.toBe(id);
  return p;
};
// Zamówienie zastępcze przed właściwym: właściwe dostaje id 2, a jego proforma id 1.
const zamowienieProformy = (n) => { zamowienie(90 + n); return zamowienie(n); };
const postPf = (id, akcja, payload = '') => server.inject({ method: 'POST', url: `/proformy/${id}/${akcja}`, headers, payload });

it('POST proformy/drukuj: nieznana proforma → 404, powrót na listę zamówień', async () => {
  zbuduj();
  odmowa(await postPf(999, 'drukuj', 'powrot=%2F%3Fszukaj%3Dtest'), 404, 'Nie ma takiej proformy.', 'Nie udało się wysłać proformy do druku',
    '/?szukaj=test', 'Wróć do listy zamówień');
});

it('POST proformy/drukuj: unieważniona → 400, powrót na kartę zamówienia proformy', async () => {
  zbuduj();
  const id = zamowienieProformy(11);
  const p = zProforma(id);
  uniewaznijPoprzednie(db, id);
  odmowa(await postPf(p.id, 'drukuj'), 400, `Proforma ${p.numer} jest unieważniona — nie drukujemy dokumentu, który nie obowiązuje.`,
    'Nie udało się wysłać proformy do druku', `/zamowienia/${id}#faktura`);
});

it('POST proformy/drukuj: bez pliku PDF → 400', async () => {
  zbuduj();
  const id = zamowienieProformy(12);
  const p = zProforma(id, null);
  odmowa(await postPf(p.id, 'drukuj', 'powrot=%2F%3Fszukaj%3Dtest'), 400, `Proforma ${p.numer} nie ma zapisanego pliku PDF — nie ma czego drukować.`,
    'Nie udało się wysłać proformy do druku', `/zamowienia/${id}?powrot=%2F%3Fszukaj%3Dtest#faktura`);
});

it('POST proformy/druk-porzuc: nieznana proforma → 404, powrót na listę', async () => {
  zbuduj();
  odmowa(await postPf(999, 'druk-porzuc'), 404, 'Nie ma takiej proformy.', 'Nie udało się porzucić wydruku', '/', 'Wróć do listy zamówień');
});

it('POST proformy/druk-porzuc: proforma nie czeka w kolejce → 404, powrót na kartę', async () => {
  zbuduj();
  const id = zamowienieProformy(13);
  const p = zProforma(id);
  odmowa(await postPf(p.id, 'druk-porzuc'), 404, 'Ta proforma nie czeka w kolejce druku.', 'Nie udało się porzucić wydruku', `/zamowienia/${id}#faktura`);
});
