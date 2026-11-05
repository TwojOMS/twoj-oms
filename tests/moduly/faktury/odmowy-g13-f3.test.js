// PRZ-152.G13f3: odmowy 63–79, status i tekst bez zmian, bez połączeń z integracjami.
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { escapeXML } from 'ejs';
import { nowyPanel, BASIC, get, post } from '../../pomoc/konta-prz068.js';
import { bladOperatora } from '../../../src/domena/bledy.js';
import { przelaczModul } from '../../../src/oms/db/moduly-opcjonalne.js';

const katalog = mkdtempSync(join(tmpdir(), 'oms-g13f3-'));
const G = 'Klucz API inFaktu wpiszesz w Ustawienia → Integracje → inFakt (/ustawienia/integracje/infakt).';
const ZESTAWIENIE = 'Nie złożono zestawienia faktur';
const PDF = 'Nie udało się pobrać dokumentu';
const BLOKADA = 'Zestawienie faktur jest właśnie składane — poczekaj na pobranie pliku i spróbuj ponownie.';
const MIESIAC = '„<zły>&" to nie jest miesiąc w formacie RRRR-MM.';
const OPIS = 'Dokument <Półcień> & "próba" jest niedostępny.';
const PACZKA = '/faktury/paczka?miesiac=2026-10&czesc=sprzedaz';
let p;
beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Sieć zabroniona'); }); });
afterEach(async () => { await p?.app.close(); p?.db.close(); p = null; vi.restoreAllMocks(); });
afterAll(() => rmSync(katalog, { recursive: true, force: true }));

function panel(opcje = {}) {
  p = nowyPanel({ env: { OMS_PROFORMY_KATALOG: katalog, OMS_ETYKIETY_KATALOG: katalog }, ...opcje });
  return p;
}
function sprawdz(r, status, tekst, tytul = ZESTAWIENIE) {
  expect(r.statusCode).toBe(status);
  expect(r.headers['content-type']).toMatch(/^text\/html/);
  expect(r.body).toContain('<html');
  expect(r.body).toContain(`<p class="pasek-uwaga" role="alert">${escapeXML(tekst)}</p>`);
  expect(r.body).toContain(`<h1>${tytul}</h1>`);
  expect(r.body).toContain('<a class="btn" href="/faktury">Wróć do faktur</a>');
  expect(globalThis.fetch).not.toHaveBeenCalled();
}
const zadanie = (url, metoda = 'GET', payload = {}) => metoda === 'POST' ? post(p.app, url, BASIC, payload) : get(p.app, url, BASIC);

for (const [nr, url, metoda, tekst, tytul] of [
  [63, '/faktury/archiwum/uruchom', 'POST', 'Panel nie ma włączonego archiwum sprzedaży (brak INFAKT_ARCHIWUM).', 'Nie uruchomiono archiwum faktur'],
  [64, '/faktury/zestawienie-przychodow', 'GET', `Panel nie ma podpiętego inFaktu — nie ma z czego zbudować zestawienia przychodów. ${G}`, ZESTAWIENIE],
  [67, PACZKA, 'GET', `Panel nie ma podpiętego inFaktu — nie ma z czego złożyć zestawienia faktur. ${G}`, ZESTAWIENIE],
  [72, '/faktury/zestawienie-zaznaczonych', 'POST', `Panel nie ma podpiętego inFaktu — nie ma z czego złożyć zestawienia faktur. ${G}`, ZESTAWIENIE],
  [74, '/faktury/u/pdf?rodzaj=vat', 'GET', `Panel nie ma podpiętego inFaktu. ${G}`, PDF],
]) it(`${nr}: brak usługi`, async () => { panel(); sprawdz(await zadanie(url, metoda), 503, tekst, tytul); });

it('65: błędny miesiąc przychodów', async () => {
  const zbuduj = vi.fn(); panel({ paczkaDlaBiura: { zbudujZestawieniePrzychodow: zbuduj } });
  sprawdz(await zadanie('/faktury/zestawienie-przychodow?miesiac=' + encodeURIComponent('<zły>&')), 400, MIESIAC);
  expect(zbuduj).not.toHaveBeenCalled();
});
it('66: odmowa usługi przychodów', async () => {
  panel({ paczkaDlaBiura: { zbudujZestawieniePrzychodow: async () => { throw bladOperatora(OPIS); } } });
  sprawdz(await zadanie('/faktury/zestawienie-przychodow?miesiac=2026-10'), 400, OPIS);
});
for (const [nr, query, tekst, koszty] of [
  [69, 'miesiac=' + encodeURIComponent('<zły>&') + '&czesc=sprzedaz', MIESIAC],
  [70, 'miesiac=2026-10&czesc=' + encodeURIComponent('<zły>&'), '„<zły>&" to nie jest część zestawienia faktur — panel składa dwa pliki: sprzedaz, koszty.'],
  [71, 'miesiac=2026-10&czesc=koszty', 'Moduł Koszty jest wyłączony — zestawienie faktur kosztowych niedostępne. Włączysz go w Ustawienia → Moduły; zestawienie faktur sprzedaży działa bez zmian.', true],
]) it(`${nr}: walidacja paczki`, async () => {
  const zbuduj = vi.fn(); panel({ paczkaDlaBiura: { zbuduj } });
  if (koszty) przelaczModul(p.db, { modul: 'koszty', wlacz: false });
  sprawdz(await zadanie('/faktury/paczka?' + query), koszty ? 409 : 400, tekst);
  expect(zbuduj).not.toHaveBeenCalled();
});
for (const [nr, url, metoda] of [[68, PACZKA, 'GET'], [73, '/faktury/zestawienie-zaznaczonych', 'POST']]) {
  it(`${nr}: wspólna blokada składania`, async () => {
    let zwolnij;
    const wynik = new Promise(resolve => { zwolnij = resolve; });
    let wystartowal;
    const start = new Promise(resolve => { wystartowal = resolve; });
    panel({ paczkaDlaBiura: { zbuduj: () => { wystartowal(); return wynik; }, zbudujZaznaczone: vi.fn() } });
    const pierwsze = zadanie(PACZKA).then(r => r);
    await start;
    try { sprawdz(await zadanie(url, metoda), 409, BLOKADA); }
    finally { zwolnij({ bajty: Buffer.from('%PDF-próba'), nazwa: 'proba.pdf' }); await pierwsze; }
  });
}

const program = (metody = {}) => ({ opis: { id: 'twojefaktury', wbudowany: true,
  limity: { rownolegleStron: 2, zadanieMs: 100, sufitStron: 2 } }, przygotujNabywce: vi.fn(), ...metody });
it('75: nieznany rodzaj PDF', async () => {
  panel({ infakt: program() });
  sprawdz(await zadanie('/faktury/u/pdf?rodzaj=' + encodeURIComponent('<zły>&')), 400,
    '„<zły>&" to nie jest rodzaj dokumentu, który panel potrafi pobrać — zna tylko: vat, korekta.', PDF);
});
for (const [nr, blad, status, tekst] of [
  [76, bladOperatora(OPIS, { czekaNaKsef: true }), 409, OPIS],
  [77, bladOperatora(OPIS), 400, `Nie udało się pobrać dokumentu: ${OPIS}`],
  [77, new Error('Szczegóły techniczne'), 400, 'Nie udało się pobrać dokumentu: błąd techniczny panelu — szczegóły w logu zamówienia.'],
]) it(`${nr}: odmowa pobrania PDF (${status}, ${tekst})`, async () => {
  panel({ infakt: program({ pobierzPdf: async () => { throw blad; } }) });
  sprawdz(await zadanie('/faktury/u/pdf?rodzaj=vat'), status, tekst, PDF);
});
it('78: brak podglądu PDF', async () => {
  panel(); sprawdz(await zadanie('/faktury/twojefaktury/1/podglad.pdf'), 404, 'Podgląd PDF jest tylko dla faktur programu wbudowanego.', PDF);
});
for (const status of [undefined, 404, 409]) it(`79: odmowa podglądu, status ${status ?? 'domyślny'}`, async () => {
  panel({ infakt: program({ podgladPdf: async () => { throw bladOperatora(OPIS, { status }); } }) });
  sprawdz(await zadanie('/faktury/twojefaktury/1/podglad.pdf'), status ?? 400, OPIS, PDF);
});
