import { describe, it, expect } from 'vitest';
import { AUTH, POST, serwer, cialo } from '../faktury/_hurtem-pomocniki.js';
import { zapiszZamowienie, dodajPozycjeReczna } from '../../../src/oms/db/zamowienia.js';
import { SUFIT_SPECYFIKACJI_DRUKU } from '../../../src/domena/masowe.js';
import { PDFTOTEXT, pdfNaTekst } from './_pdf-tekst.js';

// „Lista produktów" — kartka do kompletowania: SAME produkty z iloscia. Zero danych klienta,
// zero cen i kwot, zero wysylki. Od PRZ-084 (właściciel 15.10) PDF otwierany w karcie (`inline`),
// a nie strona HTML — z karty dla jednego zamowienia i z listy ZBIORCZO dla zaznaczonych.
//
// Fixture celowo niesie wszystko, czego na kartce byc NIE MA: pelne dane klienta z adresem,
// ceny z charakterystycznymi groszami, koszt dostawy w kolumnie ORAZ wysylke przebrana za
// pozycje. Asercje `not` sa tu wazniejsze od pozytywnych.
function zamowienieDoListy(db, { numer = '4321', zrodlo = 1, pozycje = null } = {}) {
  return zapiszZamowienie(db, 'pro', {
    zrodlo_id: zrodlo,
    numer,
    klient: {
      first_name: 'Józef', last_name: 'Pstrokaty', email: 'hieronim@przyklad.test', phone: '600700800',
    },
    dostawa: {
      first_name: 'Józef', last_name: 'Pstrokaty', address_1: 'ul. Zmyślona 77', city: 'Bździszewo', postcode: '99-999',
    },
    metoda_wysylki: 'dpd',
    kwota_pobrania: null,
    chce_fakture: 0,
    nip: null,
    kwota_brutto: '504.35',
    koszt_dostawy_brutto: '15.00',
    status_woo: 'processing',
    oplacone_at: null,
    anulowane: 0,
    pozycje: pozycje ?? [
      {
        nazwa: 'Szablon Żółw 70x100', sku: 'ZOLW-70', ilosc: 3, cena_brutto: '123.45', brutto_linii: '370.35', vat: null,
      },
      {
        nazwa: 'Litery ąę 20 cm', sku: null, ilosc: 2, cena_brutto: '50.00', brutto_linii: '100.00', vat: null,
      },
      {
        nazwa: 'Wysyłka kurierem DPD', sku: 'psm-zam-placeholder', ilosc: 1, cena_brutto: '19.00', brutto_linii: '19.00', vat: null,
      },
    ],
  }, {});
}

const ZAKAZANE = [
  '123.45', '123,45', '370.35', '370,35', '50.00', '50,00', '504.35', '504,35', '15.00', '15,00', '19.00', '19,00',
  'zł', 'PLN',
  'Józef', 'Pstrokaty', 'przyklad.test', '600700800', 'Zmyślona', 'Bździszewo', '99-999',
  'Wysyłka', 'kurierem', 'DPD', 'psm-zam-placeholder',
];

describe('trasa: GET /zamowienia/:id/lista-produktow.pdf', () => {
  it('oddaje PDF do otwarcia w karcie (inline), nie plik do pobrania', async () => {
    const { app, db } = serwer();
    const id = zamowienieDoListy(db);
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/lista-produktow.pdf`, headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.headers['content-disposition']).toBe('inline; filename="lista-produktow-4321.pdf"');
    expect(r.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it.skipIf(!PDFTOTEXT)('niesie produkty z iloscia i SKU, a NIE ceny, dane klienta ani wysylke', async () => {
    const { app, db } = serwer();
    const id = zamowienieDoListy(db);
    dodajPozycjeReczna(db, id, {
      nazwa: 'Wałek gąbkowy', sku: 'WAL-1', ilosc: 4, cena_brutto: '9.99', brutto_linii: '39.96',
    });
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/lista-produktow.pdf`, headers: AUTH });
    const tekst = pdfNaTekst(r.rawPayload, { uklad: true });
    expect(tekst).toContain('Lista produktów');
    expect(tekst).toContain('Zamówienie nr 4321');
    expect(tekst).toMatch(/3\s+Szablon Żółw 70x100\s+ZOLW-70/);
    expect(tekst).toMatch(/2\s+Litery ąę 20 cm/);
    expect(tekst).toMatch(/4\s+Wałek gąbkowy\s+WAL-1/);
    expect(tekst).toContain('Razem pozycji: 3 · sztuk: 9');
    // Jedno zamowienie — bez kolumny „W zamówieniach".
    expect(tekst).not.toContain('W zamówieniach');
    for (const zakazane of [...ZAKAZANE, '9.99', '9,99']) {
      expect(tekst, `na liscie produktow nie ma prawa stac: ${zakazane}`).not.toContain(zakazane);
    }
  });

  it('nie ma takiego zamowienia — 404; bez logowania — 401', async () => {
    const { app, db } = serwer();
    expect((await app.inject({ method: 'GET', url: '/zamowienia/9999/lista-produktow.pdf', headers: AUTH })).statusCode).toBe(404);
    const id = zamowienieDoListy(db);
    expect((await app.inject({ method: 'GET', url: `/zamowienia/${id}/lista-produktow.pdf` })).statusCode).toBe(401);
  });

  it('stary adres strony HTML juz nie odpowiada lista', async () => {
    const { app, db } = serwer();
    const id = zamowienieDoListy(db);
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/lista-produktow`, headers: AUTH });
    expect(r.headers['content-type'] ?? '').not.toContain('application/pdf');
    expect(r.body).not.toContain('Szablon Żółw');
  });
});

describe('trasa zbiorcza: POST /zamowienia/lista-produktow.pdf', () => {
  function dwaZamowienia(db) {
    const a = zamowienieDoListy(db, { numer: 'A-100', zrodlo: 1 });
    const b = zamowienieDoListy(db, {
      numer: 'B-200',
      zrodlo: 2,
      pozycje: [
        { nazwa: 'Szablon Żółw 70x100 (Allegro)', sku: 'ZOLW-70', ilosc: 1, cena_brutto: '123.45', brutto_linii: '123.45', vat: null },
        { nazwa: 'Litery ąę 20 cm', sku: null, ilosc: 1, cena_brutto: '50.00', brutto_linii: '50.00', vat: null },
        { nazwa: 'Kurier DPD (darmowa wysyłka)', sku: null, ilosc: 1, cena_brutto: '0.00', brutto_linii: '0.00', vat: null },
      ],
    });
    return [a, b];
  }

  it('jeden PDF inline dla wszystkich zaznaczonych', async () => {
    const { app, db } = serwer();
    const ids = dwaZamowienia(db);
    const r = await app.inject({ method: 'POST', url: '/zamowienia/lista-produktow.pdf', headers: POST, payload: cialo(ids) });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.headers['content-disposition']).toBe('inline; filename="lista-produktow-2-zamowien.pdf"');
  });

  it.skipIf(!PDFTOTEXT)('scala po SKU i po nazwie, przy wierszu numery zamowien z krotnoscia, bez danych i cen', async () => {
    const { app, db } = serwer();
    const ids = dwaZamowienia(db);
    const r = await app.inject({ method: 'POST', url: '/zamowienia/lista-produktow.pdf', headers: POST, payload: cialo(ids) });
    const tekst = pdfNaTekst(r.rawPayload, { uklad: true });
    expect(tekst).toContain('W zamówieniach');
    expect(tekst).toMatch(/Zamówienia \(2\): (A-100, B-200|B-200, A-100)/);
    // Wiersz scalony po SKU niesie nazwe z PIERWSZEGO zamowienia na liscie — tu ta z Allegro.
    expect(tekst).toMatch(/4\s+Szablon Żółw 70x100( \(Allegro\))?\s+ZOLW-70\s+(A-100 ×3, B-200|B-200, A-100 ×3)/);
    expect(tekst).toMatch(/3\s+Litery ąę 20 cm\s+(A-100 ×2, B-200|B-200, A-100 ×2)/);
    expect(tekst).toContain('Razem pozycji: 2 · sztuk: 7');
    for (const zakazane of ZAKAZANE) {
      expect(tekst, `na liscie zbiorczej nie ma prawa stac: ${zakazane}`).not.toContain(zakazane);
    }
  });

  it('bez zaznaczenia — czytelna odmowa 400', async () => {
    const { app } = serwer();
    const r = await app.inject({ method: 'POST', url: '/zamowienia/lista-produktow.pdf', headers: POST, payload: '' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toBe('Nie zaznaczono żadnego zamówienia.');
  });

  it('ponad sufit partii druku — odmowa nazywa wydruk, nic nie rysuje', async () => {
    const { app, db } = serwer();
    const ids = Array.from({ length: SUFIT_SPECYFIKACJI_DRUKU + 1 }, (_, i) => zamowienieDoListy(db, { numer: `N-${i}`, zrodlo: 1000 + i }));
    const r = await app.inject({ method: 'POST', url: '/zamowienia/lista-produktow.pdf', headers: POST, payload: cialo(ids) });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('listy produktów');
    expect(r.body).toContain('Nie wydrukowano niczego');
  });
});
