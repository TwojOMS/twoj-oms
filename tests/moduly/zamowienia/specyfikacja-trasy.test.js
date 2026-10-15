import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, writeFileSync, rmSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AUTH, POST, zamowienie, serwer, cialo, NIP, BDO,
} from '../faktury/_hurtem-pomocniki.js';
import { SUFIT_SPECYFIKACJI_DRUKU } from '../../../src/domena/masowe.js';

// Trasy pobrania „Specyfikacji zamowienia" — kartki wkladanej do KAZDEJ paczki (Zadanie 8):
// GET z karty (jedno zamowienie) i POST z listy (wiele zaznaczonych → jeden plik, w kolejnosci
// listy). Zadna z tras nie liczy niczego sama — sklada tylko dane (domain/specyfikacja.js,
// Zadanie 6) i rysowanie (pdf/specyfikacja-pdf.js, Zadanie 7).

// ─────────────────────────────────────────────────────────────────────────────
// Wykrycie poppera — SKOPIOWANE z tests/oms/specyfikacja-pdf.test.js. Testy tresci czytaja
// wygenerowany PDF `pdftotext`-em: to JEDYNY sposob dowiedzenia sie, co naprawde trafilo na
// strone (numer zamowienia z drugiej strony pliku, BDO sklada trasa — nie test jednostkowy).
// Brak binarki w kontenerze na NAS-ie ma POMINAC te testy z czytelnym komunikatem.
// ─────────────────────────────────────────────────────────────────────────────
const POPPLER_WINGET = path.join(
  process.env.LOCALAPPDATA ?? '',
  'Microsoft/WinGet/Packages/oschwartz10612.Poppler_Microsoft.Winget.Source_8wekyb3d8bbwe',
  'poppler-25.07.0/Library/bin/pdftotext.exe',
);

function znajdzPdftotext() {
  try {
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
    return 'pdftotext';
  } catch {
    // brak na PATH — probujemy instalacji winget wlasciciela
  }
  return process.env.LOCALAPPDATA && existsSync(POPPLER_WINGET) ? POPPLER_WINGET : null;
}

const PDFTOTEXT = znajdzPdftotext();
if (!PDFTOTEXT) {
  // eslint-disable-next-line no-console
  console.warn(
    '[specyfikacja-trasy] pdftotext (poppler) nie znaleziony — testy odczytu tekstu z PDF-a '
    + 'POMINIETE.',
  );
}

/** PDF → tekst. Zapis do pliku, bo pdftotext czyta plik, nie stdin. */
function pdfNaTekst(buf) {
  const kat = mkdtempSync(path.join(tmpdir(), 'specyfikacja-trasy-'));
  try {
    const plik = path.join(kat, 'p.pdf');
    writeFileSync(plik, buf);
    return execFileSync(PDFTOTEXT, ['-layout', '-enc', 'UTF-8', plik, '-'], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
  } finally {
    rmSync(kat, { recursive: true, force: true });
  }
}

const POZYCJA = {
  nazwa: 'STOP 70x100', sku: 'STOP-70', ilosc: 1, cena_brutto: '100.00', brutto_linii: '100.00', vat: null,
};

describe('trasa pojedyncza: GET /zamowienia/:id/specyfikacja.pdf', () => {
  it('oddaje PDF jednego zamowienia z naglowkiem application/pdf', async () => {
    const { app, db } = serwer();
    const a = zamowienie(db, {
      numer: '3001', zrodlo: 1, oplacone: true, pozycje: [POZYCJA],
    });
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${a}/specyfikacja.pdf`, headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    // Podpis pliku PDF — dowod, ze to naprawde dokument, a nie wyrenderowany blad.
    expect(r.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('nazwa pliku niesie numer zamowienia', async () => {
    const { app, db } = serwer();
    const a = zamowienie(db, { numer: '3001', zrodlo: 1, oplacone: true });
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${a}/specyfikacja.pdf`, headers: AUTH });
    expect(r.headers['content-disposition']).toContain('3001');
  });

  it('nie ma takiego zamowienia — 404, a nie pusty dokument', async () => {
    const { app } = serwer();
    const r = await app.inject({ method: 'GET', url: '/zamowienia/9999/specyfikacja.pdf', headers: AUTH });
    expect(r.statusCode).toBe(404);
  });

  it('wymaga logowania', async () => {
    const { app, db } = serwer();
    const a = zamowienie(db, { numer: '3001', zrodlo: 1, oplacone: true });
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${a}/specyfikacja.pdf` });
    expect(r.statusCode).toBe(401);
  });

  it.skipIf(!PDFTOTEXT)('sklada sprzedawce z config.nadawca + NIP + BDO — dowod, ze skladanie dziala przez TRASE, nie tylko w tescie jednostkowym', async () => {
    const { app, db } = serwer();
    const a = zamowienie(db, {
      numer: '3001', zrodlo: 1, oplacone: true, pozycje: [POZYCJA],
    });
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${a}/specyfikacja.pdf`, headers: AUTH });
    const tekst = pdfNaTekst(r.rawPayload);
    expect(tekst).toContain('Lumina Marek Zywiecki');
    expect(tekst).toContain('1 Maja 5');
    // ⚠️ NIP dolozony do skladu 12.08.2026 (recenzja): przy zamowieniach firmowych ta kartka
    // ZASTEPUJE wydruk faktury, wiec dokument bez NIP-u wystawcy byl widoczna dziura.
    expect(tekst).toContain(NIP);
    expect(tekst).toContain(BDO);
  });

  // ⚠️ SPOSOB DOSTAWY I STAN PLATNOSCI NA KARTCE DLA KLIENTA (recenzja 12.08.2026). Do tej
  // poprawki na dokument szedl WEWNETRZNY KOD metody (`dpd`, `inpost_paczkomat`, a w
  // najgorszym razie „Sposób dostawy: nieznana") i sama metoda platnosci, bez slowa o tym,
  // czy pieniadze wplynely. Kartka idzie do KAZDEJ paczki i przy firmach zastepuje wydruk
  // faktury.
  //
  // Asercja idzie PRZEZ TRASE i przez ODCZYT POWROTNY PDF-a, bo tylko tak widac, co naprawde
  // wyladowalo na papierze: zamowienie w bazie ma `metoda_wysylki = 'dpd'` (fixture), a na
  // kartce ma stac „DPD". `not.toMatch` na goly kod pilnuje, ze stary napis NIE wraca —
  // sama obecnosc „DPD" przechodzilaby takze wtedy, gdyby obok stalo `dpd`.
  it.skipIf(!PDFTOTEXT)('drukuje nazwe dostawy dla czlowieka („Kurier DPD"), nie kod metody („dpd"), i stan platnosci', async () => {
    const { app, db } = serwer();
    const a = zamowienie(db, {
      numer: '3001', zrodlo: 1, oplacone: true, pozycje: [POZYCJA],
    });
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${a}/specyfikacja.pdf`, headers: AUTH });
    const tekst = pdfNaTekst(r.rawPayload);
    expect(tekst).toMatch(/Sposób dostawy:\s*Kurier DPD/);
    expect(tekst).not.toMatch(/Sposób dostawy:\s*dpd/);
    // Fixture ma pelne pokrycie wplat, wiec kartka ma o tym powiedziec.
    expect(tekst).toMatch(/Płatność:[^\n]*opłacone/);
  });

  // ⚠️ BEZ `skipIf(!PDFTOTEXT)` — ten test NIE CZYTA PDF-a (sprawdza naglowek i tresc
  // komunikatu odmowy), wiec nie ma powodu znikac na maszynie bez poppler. Na kontenerze
  // produkcyjnym (NAS) poppler nie jest zainstalowany — bez tej poprawki test odmowy przy
  // braku adresu sprzedawcy nigdy by sie tam nie uruchomil.
  it('bez adresu sprzedawcy odmawia czytelnie, zamiast oddac dokument bez wystawcy', async () => {
    const { app, db } = serwer({ config: { nadawca: null } });
    const a = zamowienie(db, { numer: '3001', zrodlo: 1, oplacone: true });
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${a}/specyfikacja.pdf`, headers: AUTH });
    expect(r.headers['content-type']).not.toContain('application/pdf');
    expect(r.body).toMatch(/sprzedawc/i);
  });
});

describe('trasa zbiorcza: POST /zamowienia/specyfikacje.pdf', () => {
  it('zaznaczenie wielu daje JEDEN plik', async () => {
    const { app, db } = serwer();
    const a = zamowienie(db, {
      numer: '3001', zrodlo: 1, oplacone: true, pozycje: [POZYCJA],
    });
    const b = zamowienie(db, {
      numer: '3002', zrodlo: 2, oplacone: true, pozycje: [POZYCJA],
    });
    const r = await app.inject({
      method: 'POST', url: '/zamowienia/specyfikacje.pdf', headers: POST, payload: cialo([a, b]),
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });

  // ⚠️ SEDNO: naglowek PDF-a NIE DOWODZI, ze w srodku jest to, co zaznaczono. Bez tego testu
  // trasa mogla oddawac dokument JEDNEGO zamowienia (albo pusty szkielet PDF-a) i nadal
  // przechodzic na samym podpisie pliku.
  it.skipIf(!PDFTOTEXT)('plik niesie TRESC obu zaznaczonych zamowien, w kolejnosci listy', async () => {
    const { app, db } = serwer();
    // `utworzoneAt` PODANE WPROST (nie zegar): listaZamowien() sortuje `ORDER BY
    // utworzone_at DESC`, wiec „a" (data POZNIEJSZA) ma stac PIERWSZE na liscie — dokladnie
    // odwrotnie niz kolejnosc zaznaczenia w formularzu ponizej. Test odroznia w ten sposob
    // „kolejnosc listy" (wymagana przez brief) od „kolejnosc zaznaczenia" (ktorej trasa
    // NIE MA prawa uzyc).
    const b = zamowienie(db, {
      numer: '3002', zrodlo: 2, oplacone: true, pozycje: [POZYCJA], utworzoneAt: '2026-08-05T09:00:00.000Z',
    });
    const a = zamowienie(db, {
      numer: '3001', zrodlo: 1, oplacone: true, pozycje: [POZYCJA], utworzoneAt: '2026-08-05T10:00:00.000Z',
    });
    // Zaznaczenie w formularzu CELOWO w odwrotnej kolejnosci — [b, a] — zeby test naprawde
    // odroznial „kolejnosc listy" od „kolejnosc zaznaczenia": gdyby trasa uzyla tej drugiej,
    // strona 3002 wypadlaby PIERWSZA, a asercja ponizej by upadla.
    const r = await app.inject({
      method: 'POST', url: '/zamowienia/specyfikacje.pdf', headers: POST, payload: cialo([b, a]),
    });
    const tekst = pdfNaTekst(r.rawPayload);
    expect(tekst).toContain('3001');
    expect(tekst).toContain('3002');
    // `pdftotext` rozdziela strony znakiem wysuwu strony (\f).
    const strony = tekst.split('\f').filter((s) => s.trim());
    expect(strony).toHaveLength(2);
    expect(strony[0]).toContain('3001');
    expect(strony[1]).toContain('3002');
  });

  // ⚠️ SEDNO AKCJI MASOWEJ (recenzja 12.08.2026). Bez tego testu trasa mogla po cichu
  // zignorowac zaznaczenie i wziac `wczytajListe()` w calosci — oba testy powyzej zaznaczaja
  // WSZYSTKIE istniejace zamowienia, wiec taka mutacja i tak dawalaby poprawny wynik. Test
  // trzyma w bazie TRZY zamowienia i zaznacza JEDNO — operator ma dostac dokument z
  // DOKLADNIE tego, co zaznaczyl, nie z calej listy.
  it.skipIf(!PDFTOTEXT)('zaznaczenie JEDNEGO z trzech istniejacych daje dokument WYLACZNIE tego zamowienia', async () => {
    const { app, db } = serwer();
    zamowienie(db, {
      numer: '4001', zrodlo: 1, oplacone: true, pozycje: [POZYCJA],
    });
    const b = zamowienie(db, {
      numer: '4002', zrodlo: 2, oplacone: true, pozycje: [POZYCJA],
    });
    zamowienie(db, {
      numer: '4003', zrodlo: 3, oplacone: true, pozycje: [POZYCJA],
    });
    const r = await app.inject({
      method: 'POST', url: '/zamowienia/specyfikacje.pdf', headers: POST, payload: cialo([b]),
    });
    expect(r.statusCode).toBe(200);
    const tekst = pdfNaTekst(r.rawPayload);
    const strony = tekst.split('\f').filter((s) => s.trim());
    expect(strony).toHaveLength(1);
    expect(tekst).toContain('4002');
    expect(tekst).not.toContain('4001');
    expect(tekst).not.toContain('4003');
  });

  // ⚠️ Pusty PDF wyglada jak plik, ktory sie udal — a przy wydruku do paczki znaczy paczke
  // bez dokumentu. Odmowa jest tu tansza niz cisza.
  it('bez zaznaczenia odmawia, zamiast oddawac pusty PDF', async () => {
    const { app } = serwer();
    const r = await app.inject({
      method: 'POST', url: '/zamowienia/specyfikacje.pdf', headers: POST, payload: '',
    });
    expect(r.headers['content-type']).not.toContain('application/pdf');
    expect(r.body).toMatch(/nie zaznaczono/i);
  });

  // ⚠️ ODROZNIA „PUSTE ZAZNACZENIE" OD „PUSTEJ BAZY" (recenzja 12.08.2026). Test wyzej
  // odmawia na bazie bez ani jednego zamowienia — co dowodzi tylko, ze pusta baza daje pusty
  // wynik, nie ze pusty FORMULARZ daje odmowe. Tutaj w bazie SA zamowienia (operator mial co
  // zaznaczyc), a mimo to nic nie zaznaczyl — to jest prawdziwy przypadek z briefu.
  it('zamowienia istnieja w bazie, ale formularz nie zaznaczyl zadnego — wciaz odmowa', async () => {
    const { app, db } = serwer();
    zamowienie(db, { numer: '4001', zrodlo: 1, oplacone: true });
    zamowienie(db, { numer: '4002', zrodlo: 2, oplacone: true });
    const r = await app.inject({
      method: 'POST', url: '/zamowienia/specyfikacje.pdf', headers: POST, payload: '',
    });
    expect(r.headers['content-type']).not.toContain('application/pdf');
    expect(r.body).toMatch(/nie zaznaczono/i);
  });

  it('wymaga logowania', async () => {
    const { app, db } = serwer();
    const a = zamowienie(db, { numer: '3001', zrodlo: 1, oplacone: true });
    const r = await app.inject({
      method: 'POST', url: '/zamowienia/specyfikacje.pdf', payload: cialo([a]),
    });
    expect(r.statusCode).toBe(401);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // SUFIT PARTII DRUKU (recenzja 12.08.2026). Do tego dnia trasa nie miala go wcale —
  // uznano, ze jest niepotrzebny, bo rysowanie jest lokalne. Bledne z powodow niewidocznych
  // z poziomu tej trasy: `listaZamowien` nie ma `LIMIT`, „zaznacz wszystkie" to odnosnik
  // `?zaznacz=1` zaznaczajacy KAZDY wyrenderowany wiersz, a `zbudujSpecyfikacjeWieluPdf`
  // rysuje SYNCHRONICZNIE na watku petli zdarzen. Jedno pomylkowe klikniecie = panel nie
  // odpowiada nikomu, dopoki nie narysuje tylu stron, ile zamowien jest w bazie.
  //
  // Testy ida PRZEZ TRASE i przez PRAWDZIWE zaznaczenie, bo to zlozenie „brak stronicowania
  // + zaznacz wszystkie" jest cala usterka — test samej funkcji domenowej (masowe-faktury
  // .test.js) tego nie dotyka.
  // ─────────────────────────────────────────────────────────────────────────────
  it(`odmawia zaznaczeniu ponad sufit (${SUFIT_SPECYFIKACJI_DRUKU + 1}) i nie oddaje ani jednego PDF-a`, async () => {
    const { app, db } = serwer();
    const ids = Array.from({ length: SUFIT_SPECYFIKACJI_DRUKU + 1 }, (_, i) => zamowienie(db, {
      numer: String(5000 + i), zrodlo: 5000 + i, oplacone: true, pozycje: [POZYCJA],
    }));
    const r = await app.inject({
      method: 'POST', url: '/zamowienia/specyfikacje.pdf', headers: POST, payload: cialo(ids),
    });
    expect(r.statusCode).toBe(400);
    expect(r.headers['content-type']).not.toContain('application/pdf');
    expect(r.body).toContain(String(SUFIT_SPECYFIKACJI_DRUKU));
    expect(r.body).toMatch(/Nie wydrukowano niczego/);
  });

  // GRANICA, nie „duzo/malo": sufit ma przepuscic DOKLADNIE tyle, ile obiecuje. Bez tego
  // testu zamiana `<=` na `<` w `powodZaDuzegoDruku` przeszlaby niezauwazona, a operator
  // dostawalby odmowe przy zaznaczeniu, ktore komunikat sam nazywa dozwolonym.
  it(`przepuszcza zaznaczenie dokladnie na granicy (${SUFIT_SPECYFIKACJI_DRUKU})`, async () => {
    const { app, db } = serwer();
    const ids = Array.from({ length: SUFIT_SPECYFIKACJI_DRUKU }, (_, i) => zamowienie(db, {
      numer: String(6000 + i), zrodlo: 6000 + i, oplacone: true, pozycje: [POZYCJA],
    }));
    const r = await app.inject({
      method: 'POST', url: '/zamowienia/specyfikacje.pdf', headers: POST, payload: cialo(ids),
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });
});

describe('przyciski na ekranach', () => {
  it('karta zamowienia ma przycisk pobrania specyfikacji', async () => {
    const { app, db } = serwer();
    const a = zamowienie(db, { numer: '3001', zrodlo: 1, oplacone: true });
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${a}`, headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(`/zamowienia/${a}/specyfikacja.pdf`);
    expect(r.body).toMatch(/Specyfikacja do paczki/);
  });

  it('lista ma przycisk akcji zbiorczej', async () => {
    const { app } = serwer();
    const r = await app.inject({ method: 'GET', url: '/', headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('formaction="/zamowienia/specyfikacje.pdf"');
    expect(r.body).toMatch(/Specyfikacje do paczek/);
  });
});
