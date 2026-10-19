import { wykonajWejscie, wykonajZegary, wykonajJednaFabrykeTokenow } from '../pomoc/odbior-bootstrap-030.ts';
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { zbudujOms, uruchomZegary, ODSTEP_CZUWACZA_MS } from '../pomoc/bootstrap-parytetu.ts';
import {
  POWOD_TRWA, POWOD_NIE_TA_PORA, SUFIT_STRON, BUDZET_ARCHIWUM_MS,
  NAJDLUZSZY_PRZEBIEG_KOSZTOW_MS,
} from '../../src/moduly/koszty/services/czuwacz-kosztow.js';
// ⚠️ DWA MODULY, DWIE STALE O TEJ SAMEJ NAZWIE — stad alias. `POWOD_TRWA` wyzej pochodzi
// z czuwacza KOSZTOW, ten z czuwacza ARCHIWUM SPRZEDAZY. Porownujemy do STALEJ, a nie do
// przepisanego zdania: literowka w tresci komunikatu zgasilaby log po cichu.
import {
  POWOD_TRWA as POWOD_TRWA_ARCHIWUM_SPRZEDAZY,
  POWOD_NIE_TA_PORA as POWOD_NIE_TA_PORA_ARCHIWUM_SPRZEDAZY,
  BUDZET_ARCHIWUM_SPRZEDAZY_MS, NAJDLUZSZY_PRZEBIEG_ARCHIWUM_SPRZEDAZY_MS,
} from '../../src/moduly/faktury/services/czuwacz-archiwum-sprzedazy.js';
import { LIMIT_ZADANIA_MS, NAJDLUZSZE_ODPYTYWANIE_MS } from '../../src/oms/ksef/client.js';
// ⚠️ DWA KLIENTY, DWIE STALE O TEJ SAMEJ NAZWIE — stad alias. `LIMIT_ZADANIA_MS` wyzej jest
// limitem zadania do KSeF, ten do inFaktu. Straznik archiwum sprzedazy liczy sie z TEGO.
import {
  LIMIT_ZADANIA_MS as LIMIT_ZADANIA_INFAKTU_MS, NAJDLUZSZA_LISTA_MS, SUFIT_STRON as SUFIT_STRON_INFAKTU,
  ROWNOLEGLE_STRON,
} from '../../src/oms/infakt/client.js';
import { ODSTEP_OKNA_POBRANIA_MS } from '../../src/domena/pora-pobrania.js';
import { zapewnijOkres } from '../../src/oms/db/okresy.js';
import { zapiszTokeny } from '../../src/oms/db/tokeny.js';
import { zapiszZamowienie } from '../../src/oms/db/zamowienia.js';

const katalogEtykiet = () => mkdtempSync(join(tmpdir(), 'oms-boot-'));

const PELNE = {
  OMS_AUTH_USER: 'adam', OMS_AUTH_PASS: 'x',
  OMS_DB_PATH: ':memory:',
  SHOP_PRO_URL: 'https://pro.szkicownia.test', SHOP_PRO_CK: 'ck', SHOP_PRO_CS: 'cs',
  DPD_URL: 'https://dpd/api', DPD_LOGIN: '99999999', DPD_PASSWORD: 'tajne', DPD_FID: '278216',
  DPD_NADAWCA_NAZWA: 'Lumina Marek Zywiecki', DPD_NADAWCA_ULICA: 'Fabryczna 7',
  DPD_NADAWCA_KOD: '00-650', DPD_NADAWCA_MIASTO: 'Pęki',
  DPD_INFO_URL: 'https://dpd/info', DPD_INFO_CHANNEL: '278216',
  INFAKT_API_KEY: 'SEKRET',
};

const env = (nad = {}) => ({ ...PELNE, OMS_ETYKIETY_DIR: katalogEtykiet(), ...nad });
// ⚠️ NIE MA GO W `PELNE`, i to jest cala tresc wymogu: `ALLEGRO_USER_AGENT` obowiazuje
// WYLACZNIE tam, gdzie skonfigurowano kanal Allegro. Panel bez kanalu (czyli `env()` bez
// nadpisan) ma wstawac dokladnie jak dotad — ten projekt polozyl juz usluge petla restartow
// przez jedna zmienna wymagana globalnie.
//
// Wartosc JAWNIE FIKCYJNA: prawdziwy naglowek dopiero powstanie i wejdzie konfiguracja.
const UA = 'PrzykladowyPanel/0.0.0 (+https://przyklad.invalid/panel)';
const atrapaDpd = () => vi.fn(() => ({ nadaj: vi.fn() }));

// I1. Cale okablowanie stalo w src/oms.js — pliku, ktory jest RODZENSTWEM katalogu
// src/oms/, wiec `git add src/oms` go nie lapie. Wypadl z commita juz trzy razy,
// za kazdym razem zostawiajac w HEAD usluge bez podpietych funkcji: `faktura` i `nadanie`
// byly `null`, wiec obie trasy oddawaly 503, a testy modulow i tak swiecily na zielono.
// Dlatego okablowanie mieszka teraz W KATALOGU i ma wlasny test.
describe('zbudujOms — okablowanie usługi', () => {
  it('przy komplecie konfiguracji podpina nadanie I fakturę', () => {
    const { app, nadanie, faktura, poller } = zbudujOms({ env: env(), createDpd: atrapaDpd() });
    expect(app).toBeTruthy();
    expect(nadanie).not.toBeNull();
    expect(faktura).not.toBeNull();
    expect(poller).not.toBeNull();
  });

  // Trasa /faktura ma oddawac 302, a nie 503 — czyli usluga musi realnie dojsc do serwera,
  // a nie tylko istniec w zwracanym obiekcie.
  it('podpięta faktura dociera do serwera HTTP (trasa nie oddaje 503)', async () => {
    const { app, db } = zbudujOms({ env: env(), createDpd: atrapaDpd() });
    db.prepare("INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, chce_fakture, utworzone_at) VALUES ('pro', 1, '1', '10.00', 1, '2026-07-29')").run();
    await app.ready();
    const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64') };
    const r = await app.inject({ method: 'POST', url: '/zamowienia/1/faktura', headers: naglowek });
    expect(r.statusCode).not.toBe(503);
  });

  // TEN SAM POWOD, CO WYZEJ, TYLKO DRUGA DROGA WYSTAWIANIA. `infakt` jedzie do
  // `buildOmsServer` OSOBNYM argumentem (trasy okresow skladaja `createFakturaOkresu`
  // u siebie), wiec `faktura` moze byc podpieta, a `infakt` i tak zgubiony po drodze.
  // Zmierzone przez recenzenta: po usunieciu `infakt` z wywolania `buildOmsServer`
  // 2207 testow OMS przeszlo — a na produkcji znikalby przycisk „Wystaw fakturę”
  // z karty okresu, a klikajacy dostawalby 503 bez wyjasnienia.
  it('podpięty inFakt dociera do tras OKRESÓW (trasa nie oddaje 503)', async () => {
    const { app, db } = zbudujOms({
      env: env({ OMS_KLIENCI_ZBIORCZY: 'przykladowa:Pracownia Przykładowa sp. z o.o.:1234500011:10:300:4:19' }),
      createDpd: atrapaDpd(),
    });
    const okres = zapewnijOkres(db, { klientKlucz: 'przykladowa', rok: 2026, miesiac: 7 });
    await app.ready();
    const naglowek = {
      authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'),
      origin: 'http://localhost',
    };
    const r = await app.inject({
      method: 'POST', url: `/okresy/${okres.id}/wystaw-fakture`, headers: naglowek,
    });
    expect(r.statusCode).not.toBe(503);
    // …i karta okresu ma pokazywac przycisk, a nie „inFakt nie jest skonfigurowany”.
    const karta = await app.inject({ method: 'GET', url: `/okresy/${okres.id}`, headers: naglowek });
    expect(karta.body).not.toMatch(/inFakt nie jest skonfigurowany/);
  });

  // ⚠️ TRZECIA DROGA TEJ SAMEJ DZIURY (recenzja Zadania 7, Finding 1). `fakturyWidok` jedzie
  // do `buildOmsServer` OSOBNYM argumentem (routes/faktury.js), dokladnie jak `infakt` i
  // `fakturaAllegro` wyzej — wystarczy zgubic JEDEN argument w bootstrap.js, zeby zakladka
  // /faktury zaczela pokazywac strone „pusta celowo" MIMO skonfigurowanego inFaktu, i zaden
  // inny test tego nie zlapie (trasa i tak oddaje 200, bo strona pusta celowo TEZ jest 200).
  //
  // ⚠️⚠️ TEN TEST MA ZABIC MUTACJE „usun `fakturyWidok` z wywolania buildOmsServer". Dlatego
  // asercja mierzy TRESC zywego ekranu (naglowek pasa nieoplaconych), a nie sam kod
  // odpowiedzi — 200 dostaje takze strona „pusta celowo".
  it('podpięty inFakt dociera do trasy /faktury (żywy ekran, nie strona „pusta celowo")', async () => {
    // Fetch stubowany na szybka odmowe: uslugom faktur nie chodzi tu o PRAWDZIWE dane
    // z inFaktu (te maja wlasne testy w services/faktury-widok.test.js), tylko o to, czy
    // usluga w ogole DOTARLA do trasy. Trasa i tak degraduje sie do komunikatu (patrz
    // Finding 2 nizej), wiec naglowek zywego ekranu zostaje widoczny.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400, json: async () => ({}) })));
    try {
      const { app } = zbudujOms({ env: env(), createDpd: atrapaDpd() });
      await app.ready();
      const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64') };
      const r = await app.inject({ method: 'GET', url: '/faktury', headers: naglowek });
      expect(r.statusCode).toBe(200);
      // Prawdziwy znacznik zywego ekranu (web/views/faktury.ejs) — NIE tresc strony
      // „pusta celowo" (routes/faktury.js: stala BEZ_INFAKTU).
      expect(r.body).toContain('Nieopłacone — termin płatności');
      expect(r.body).not.toContain('nie ma podpiętego inFaktu');
    } finally { vi.unstubAllGlobals(); }
  });

  // ⚠️ TA SAMA KLASA DZIURY, TERAZ PRZY MAGAZYNIE (Zadanie 9). `magazyn` (przebieg odczytu
  // katalogow) jedzie do `buildOmsServer` OSOBNYM argumentem — zgubiony w tym jednym
  // wywolaniu daje objaw nie do odroznienia od poprawnego trybu „panel bez sklepow":
  // zakladka pokazuje strone „pusta celowo", a CALA suite swieci na zielono, bo testy trasy
  // dostaja atrape uslugi wprost w `buildOmsServer`.
  it('skonfigurowany sklep dociera do trasy /magazyn (żywy ekran, nie strona „pusta celowo")', async () => {
    const { app } = zbudujOms({ env: env(), createDpd: atrapaDpd() });
    await app.ready();
    const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64') };
    const r = await app.inject({ method: 'GET', url: '/magazyn', headers: naglowek });

    expect(r.statusCode).toBe(200);
    // Znacznik ZYWEGO ekranu (web/views/magazyn-lista.ejs), a nie tresci strony „pusta
    // celowo" (routes/magazyn.js: stala BEZ_SKLEPOW).
    expect(r.body).toContain('Odczyt katalogów');
    expect(r.body).not.toContain('nie ma podpiętego żadnego sklepu');
  });

  // ⚠️ CZWARTA DROGA TEJ SAMEJ DZIURY (Zadanie 8). `infakt` jedzie do GET /faktury/:uuid/pdf
  // OSOBNYM argumentem `buildOmsServer` → `registerFakturyRoutes` (routes/faktury.js) —
  // wystarczy zgubic go w tym jednym wywolaniu, zeby przycisk „PDF" na liscie zaczal oddawac
  // 503 MIMO skonfigurowanego inFaktu, i zaden test modulu faktury.js tego nie zlapie (dostaje
  // wlasny atrapowy `infakt` wprost w konstruktorze).
  it('podpięty inFakt dociera do trasy GET /faktury/:uuid/pdf (trasa nie oddaje 503)', async () => {
    const PDF = Buffer.from('%PDF-1.4 test');
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      arrayBuffer: async () => PDF.buffer.slice(PDF.byteOffset, PDF.byteOffset + PDF.byteLength),
    })));
    try {
      const { app } = zbudujOms({ env: env(), createDpd: atrapaDpd() });
      await app.ready();
      const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64') };
      const r = await app.inject({ method: 'GET', url: '/faktury/u1/pdf?rodzaj=vat', headers: naglowek });
      expect(r.statusCode).not.toBe(503);
    } finally { vi.unstubAllGlobals(); }
  });

  // ⚠️⚠️ PIATA DROGA TEJ SAMEJ DZIURY (Zadanie 9) — I NAJDROZSZA. `wysylkaKsef` jedzie do
  // `buildOmsServer` OSOBNYM argumentem, dokladnie jak `fakturyWidok` i `infakt` wyzej.
  // Zgubiona w tym jednym wywolaniu daje objaw, ktorego zaden test modulu nie zlapie:
  // ekran podgladu wysylki oddaje 503 MIMO skonfigurowanego inFaktu, a testy trasy swieca
  // na zielono, bo buduja serwer same, z wlasna atrapa uslugi. Za tym ekranem stoi jedyna
  // operacja w calym module, ktorej NIE DA SIE COFNAC (dokumentu w KSeF nie kasuje sie,
  // tylko koryguje) — wiec droga do niego ma byc zmierzona CALA: env → zbudujOms →
  // buildOmsServer → trasa → usluga → HTTP do inFaktu → HTML.
  it('podpięty inFakt dociera do trasy POST /faktury/ksef/podglad (żywy ekran, nie 503)', async () => {
    // Jedna faktura VAT bez numeru KSeF w odpowiedzi inFaktu; korekt brak (inny zasob).
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const pusto = String(url).includes('corrective_invoices');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          entities: pusto ? [] : [{
            uuid: 'u1', number: '1/08/2026', ksef_number: null, gross_price: 12300,
            left_to_pay: 0, client_company_name: 'Firma X', invoice_date: '2026-08-06',
            // ⚠️ NIP JEST TU NOŚNY OD 28.08.2026, a nie ozdobny. Dokument bez
            // `client_tax_code` jest dla panelu fakturą KONSUMENCKĄ i odbija się od bariery
            // (`czyKonsumencka` w domain/wysylka-ksef.js), więc ekran podglądu pokazałby go
            // w „pominiętych" i BEZ przycisku zatwierdzenia — a ten test sprawdza okablowanie
            // (czy inFakt dociera do trasy), nie regułę NIP-u. Atrapa firmy bez NIP-u była
            // po prostu nierealistyczna: na 169 prawdziwych faktur VI–VIII.2026 numer miało 168.
            client_tax_code: '1234563218',
          }],
          metainfo: { total_count: pusto ? 0 : 1 },
        }),
      };
    }));
    try {
      const { app } = zbudujOms({ env: env(), createDpd: atrapaDpd() });
      await app.ready();
      const naglowek = {
        authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'),
        origin: 'http://localhost',
      };
      const r = await app.inject({
        method: 'POST', url: '/faktury/ksef/podglad', headers: naglowek,
        payload: { uuid: 'u1', miesiac: '2026-08', pole: 'invoice_date' },
      });

      expect(r.statusCode).toBe(200);
      // Prawdziwe znaczniki zywego ekranu (web/views/ksef-podglad.ejs), a nie sam kod
      // odpowiedzi: dokument z inFaktu naprawde doszedl do podsumowania i stoi tam
      // przycisk zatwierdzenia. Bez okablowania trasa oddalaby 503 i tresci by nie bylo.
      expect(r.body).toContain('1/08/2026');
      expect(r.body).toContain('Firma X');
      expect(r.body).toContain('name="potwierdzam"');
      expect(r.body).not.toContain('nie ma podpiętego inFaktu');
    } finally { vi.unstubAllGlobals(); }
  });

  // ⚠️⚠️ SIODMA DROGA TEJ SAMEJ DZIURY (Zadanie 8). `korekta` (services/korekta.js) jedzie do
  // `buildOmsServer` OSOBNYM argumentem, dokladnie jak `fakturyWidok` i `wysylkaKsef` wyzej.
  // Zgubiona w tym jednym wywolaniu daje objaw, ktorego zaden test modulu nie zlapie: trasa
  // POST .../korekta (routes/zwroty.js) oddaje 503 MIMO skonfigurowanego inFaktu, a
  // tests/oms/korekta-service.test.js swieci na zielono, bo wstrzykuje `infakt` WPROST,
  // nie przez bootstrap. Droga jest zmierzona CALA: env → zbudujOms → buildOmsServer →
  // trasa → usluga → dwa wywolania HTTP do inFaktu (odczyt faktury, zlecenie korekty) → zapis.
  it('podpięty inFakt dociera do trasy POST .../korekta (przebieg naprawdę się odbył, nie 503)', async () => {
    // ⚠️ STUB PRZED `zbudujOms`, NIE PO — `createInfaktClient` chwyta `fetch` jako domyslny
    // parametr W CHWILI WYWOLANIA (wewnatrz zbudujOms), wiec pozniejszy `vi.stubGlobal` nie
    // dosiegnalby juz zamknietego klienta. Ten sam porzadek, co w tescie „POST
    // /faktury/ksef/podglad" wyzej.
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/v3/invoices/')) {
        return {
          ok: true, status: 200,
          json: async () => ({
            number: 'FV 1/08/2026', invoice_date: '2026-08-01', uuid: 'uuid-fv',
            services: [{ name: 'Kot 70x100', quantity: 2, gross_price: 19800, tax_symbol: '23' }],
          }),
        };
      }
      return {
        ok: true, status: 201,
        json: async () => ({ invoice_task_reference_number: 'REF-1', uuid: null, number: null }),
      };
    }));
    try {
      const { app, db } = zbudujOms({ env: env(), createDpd: atrapaDpd() });
      db.prepare(
        "INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, chce_fakture, utworzone_at)"
        + " VALUES ('pro', 1, '1', '198.00', 1, '2026-08-01')",
      ).run();
      db.prepare(
        'INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (1, ?, ?, ?)',
      ).run('uuid-fv', 'FV 1/08/2026', '2026-08-01T10:00:00Z');
      db.prepare(
        'INSERT INTO zwroty (zamowienie_id, data, kwota, utworzony_at) VALUES (1, ?, ?, ?)',
      ).run('2026-08-14', '99.00', '2026-08-14T00:00:00Z');
      db.prepare(
        'INSERT INTO zwroty_pozycje (zwrot_id, klucz_pozycji, nazwa, ilosc, kwota) VALUES (1, ?, ?, ?, ?)',
      ).run('s77', 'Kot 70x100', 1, '99.00');

      await app.ready();
      const naglowek = {
        authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'),
        origin: 'http://localhost',
      };
      const r = await app.inject({
        method: 'POST', url: '/zamowienia/1/zwroty/1/korekta', headers: naglowek,
      });
      expect(r.statusCode).not.toBe(503);
      expect(r.statusCode).toBe(302);
      // ⚠️ PRZEBIEG NAPRAWDE SIE ODBYL — rezerwacja i referencja stoja w bazie, nie tylko
      // kod odpowiedzi jest poprawny (redirect wygladalby tak samo, gdyby trasa nic nie zrobila).
      const w = db.prepare('SELECT * FROM zwroty WHERE id = 1').get();
      expect(w.korekta_zlecona_at).not.toBeNull();
      expect(w.korekta_referencja).toBe('REF-1');
    } finally { vi.unstubAllGlobals(); }
  });

  it('bez INFAKT_API_KEY korekta zostaje nieskonfigurowana (trasa odmawia 503, nie 500)', async () => {
    const { app, db, korekta } = zbudujOms({ env: env({ INFAKT_API_KEY: undefined }), createDpd: atrapaDpd() });
    expect(korekta).toBeNull();
    db.prepare(
      "INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, chce_fakture, utworzone_at)"
      + " VALUES ('pro', 1, '1', '198.00', 1, '2026-08-01')",
    ).run();
    db.prepare(
      'INSERT INTO zwroty (zamowienie_id, data, kwota, utworzony_at) VALUES (1, ?, ?, ?)',
    ).run('2026-08-14', '99.00', '2026-08-14T00:00:00Z');
    await app.ready();
    const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
    const r = await app.inject({ method: 'POST', url: '/zamowienia/1/zwroty/1/korekta', headers: naglowek });
    expect(r.statusCode).toBe(503);
  });

  // ⚠️⚠️ SZOSTA DROGA TEJ SAMEJ DZIURY (Zadanie 10). `czuwaczKosztow` powstaje w bootstrapie
  // dla ZEGARA (nocne pobranie kosztow), ale przycisk „Odśwież teraz" na zakladce KOSZTY wola
  // ten sam obiekt PRZEZ SERWER — osobnym argumentem `buildOmsServer`. Zgubiony w tym jednym
  // wywolaniu daje objaw, ktorego nie zlapie ani test trasy (buduje serwer sam, z atrapa
  // czuwacza), ani test czuwacza (dostaje klienta i sesje wprost): przycisk oddaje 503 MIMO
  // skonfigurowanego KSeF, a cala suite swieci na zielono.
  //
  // Czuwacz jest tu WSTRZYKNIETY (`createCzuwaczKosztow`) dokladnie z tego powodu, dla ktorego
  // bootstrap w ogole na to pozwala: inaczej ten test musialby dotknac sieci — pelnego
  // logowania do KSeF — czyli by nie istnial.
  it('podpięty KSeF dociera do trasy POST /koszty/odswiez (żywy przebieg, nie 503)', async () => {
    const przebieg = vi.fn(async () => ({ nowych: 7 }));
    const { app } = zbudujOms({
      env: env({ KSEF_TOKEN: 'SEKRET', KSEF_NIP: '1234563218' }),
      createDpd: atrapaDpd(),
      createKsefKlient: () => ({}),
      createCzuwaczKosztow: () => ({ przebieg }),
    });
    await app.ready();
    const naglowek = {
      authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'),
      origin: 'http://localhost',
    };
    const r = await app.inject({
      method: 'POST', url: '/koszty/odswiez', headers: naglowek, payload: { miesiac: '2026-06' },
    });

    expect(r.statusCode).toBe(200);
    // ⚠️ PRZEBIEG NAPRAWDE SIE ODBYL, i to WYMUSZONY — sam kod odpowiedzi bylby taki sam,
    // gdyby trasa tylko przerysowala ekran.
    expect(przebieg).toHaveBeenCalledWith({ wymuszony: true });
    expect(r.body).toContain('Pobrano nowych dokumentów: 7');
    expect(r.body).not.toContain('nie ma podpiętego KSeF');
  });

  it('bez INFAKT_API_KEY faktura zostaje nieskonfigurowana', () => {
    const { faktura } = zbudujOms({ env: env({ INFAKT_API_KEY: undefined }), createDpd: atrapaDpd() });
    expect(faktura).toBeNull();
  });

  it('bez DPD_URL nadanie zostaje nieskonfigurowane', () => {
    const { nadanie, dpd } = zbudujOms({ env: env({ DPD_URL: undefined }), createDpd: atrapaDpd() });
    expect(dpd).toBeNull();
    expect(nadanie).toBeNull();
  });

  // ⚠️ DOKLADNIE TA SAMA KLASA DZIURY, CO PRZY `infakt` WYZEJ (Zadanie 9). Kurierzy byli
  // skladani w mape w bootstrap.js, ale do `buildOmsServer` szedl SAM `dpd` — wiec karta
  // zamowienia odswiezala status kazdej przesylki DPD, takze paczkomatowej. Testy modulow
  // swiecilyby na zielono, bo klient InPostu istnieje i dziala; gubi go OKABLOWANIE.
  const zInpostem = (nad = {}) => env({
    INPOST_TOKEN: 'eyJTESTOWY.TOKEN', INPOST_ORGANIZACJA: '13235', INPOST_URL: 'https://shipx.test/v1', ...nad,
  });

  it('podpięty InPost dociera do karty zamówienia (status paczkomatu jest odpytywany)', async () => {
    const statusPrzesylki = vi.fn().mockResolvedValue({ opis: 'Gotowa do odbioru w paczkomacie', at: '2026-07-30T09:00:00+02:00' });
    const { app, db } = zbudujOms({
      env: zInpostem(),
      createDpd: atrapaDpd(),
      createInpost: vi.fn(() => ({ nadaj: vi.fn(), statusPrzesylki })),
    });
    db.prepare("INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, utworzone_at) VALUES ('pro', 1, '1', '10.00', '2026-07-29')").run();
    db.prepare(
      'INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, kolejnosc, utworzona_at)'
      + " VALUES (1, 'inpost', 'nadana', '520000123456789012345678', 1, '2026-07-29')",
    ).run();
    await app.ready();
    const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64') };
    const r = await app.inject({ method: 'GET', url: '/zamowienia/1', headers: naglowek });

    expect(r.statusCode).toBe(200);
    expect(statusPrzesylki).toHaveBeenCalledWith('520000123456789012345678', expect.any(Object));
    expect(r.body).toContain('Gotowa do odbioru w paczkomacie');
  });

  // ⚠️⚠️ SIODMA DROGA TEJ SAMEJ DZIURY (recenzja Zadania 5, W2). `infakt` jedzie do
  // `createCzuwaczPrzesylek` OSOBNYM argumentem — dokladnie jak `infakt` do `buildOmsServer`
  // i `fakturyWidok` wyzej. Zgubiony w tym JEDNYM wywolaniu daje objaw, ktorego nie zlapie
  // ani test skanu (dostaje atrape klienta WPROST), ani test czuwacza (tak samo): doreczone
  // pobrania przestaja domykac sie w ksiegowosci, w inFakcie rosnie falszywy dlug, a cala
  // suite swieci na zielono. To ta sama klasa awarii, co „gubi go OKABLOWANIE" wyzej.
  //
  // ⚠️ TEN TEST MA ZABIC MUTACJE „usun `infakt` z wywolania createCzuwaczPrzesylek": asercja
  // mierzy ZADANIE, ktore poszlo do inFaktu (`POST /paid.json`), a nie sam ksztalt obiektu
  // zwracanego przez `zbudujOms`.
  it('podpięty inFakt dociera do czuwacza przesyłek (doręczone pobranie zleca oznaczenie zapłaty)', async () => {
    // Atrapa klienta inFaktu na poziomie HTTP — `createInfaktClient` nie jest wstrzykiwalny,
    // a chodzi tu wylacznie o to, czy klient ZBUDOWANY PRZEZ BOOTSTRAP dotarl do czuwacza.
    const zadania = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opcje) => {
      const adres = String(url);
      zadania.push({ adres, metoda: opcje?.method });
      if (adres.endsWith('/paid.json')) {
        return { ok: true, status: 201, json: async () => ({ invoice_task_reference_number: 'ref-1' }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          uuid: 'u-cod-boot', number: 'F/1', invoice_date: '2026-08-20',
          status: 'sent', left_to_pay: 12300,
        }),
      };
    }));
    try {
      const { db, czuwaczPrzesylek } = zbudujOms({ env: env(), createDpd: atrapaDpd() });
      expect(czuwaczPrzesylek).not.toBeNull();
      db.prepare(
        'INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, chce_fakture, pobranie, kwota_pobrania, utworzone_at)'
        + " VALUES ('pro', 1, '1', '123.00', 1, 1, '123.00', '2026-08-20')",
      ).run();
      db.prepare('INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?,?,?,?)')
        .run(1, 'u-cod-boot', 'F/1', '2026-08-20T08:00:00.000Z');
      // Paczka JUZ doreczona — wypada z odpytywania kurierow (etap koncowy), wiec przebieg
      // dotyka wylacznie tej sciezki, o ktora chodzi: rozliczania pobran.
      db.prepare(
        'INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, kolejnosc, utworzona_at, status_kuriera, status_kuriera_at)'
        + " VALUES (1, 'dpd', 'nadana', 'N1', 1, '2026-08-25', 'Przesyłka doręczona', '2026-08-25T14:00:00.000')",
      ).run();

      const wynik = await czuwaczPrzesylek.przebieg();

      expect(wynik.pobrania).toMatchObject({ kandydatow: 1, zlecone: 1, bledy: 0 });
      const oznaczenie = zadania.find((z) => z.adres.endsWith('/paid.json'));
      expect(oznaczenie).toMatchObject({ metoda: 'POST' });
      expect(oznaczenie.adres).toContain('u-cod-boot');
      // …i zostal po tym slad w bazie, a nie tylko w liczniku przebiegu.
      expect(db.prepare('SELECT * FROM oznaczenia_zaplaty WHERE uuid = ?').get('u-cod-boot'))
        .toMatchObject({ powod: 'pobranie_doreczone', data_zaplaty: '2026-08-25' });
    } finally { vi.unstubAllGlobals(); }
  });

  // Brak sekcji INPOST_* to TRYB POPRAWNY: panel wstaje i obsluguje reszte.
  it('bez INPOST_TOKEN panel wstaje, a paczkomat po prostu nie jest odpytywany', async () => {
    const { app, db, inpost } = zbudujOms({ env: env(), createDpd: atrapaDpd() });
    expect(inpost).toBeNull();
    db.prepare("INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, utworzone_at) VALUES ('pro', 1, '1', '10.00', '2026-07-29')").run();
    db.prepare(
      'INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, kolejnosc, utworzona_at)'
      + " VALUES (1, 'inpost', 'nadana', '520000123456789012345678', 1, '2026-07-29')",
    ).run();
    await app.ready();
    const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64') };
    const r = await app.inject({ method: 'GET', url: '/zamowienia/1', headers: naglowek });

    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('520000123456789012345678');
    expect(r.body).not.toContain('status niedostępny');
  });
});

// ⚠️ KATALOG PROFORM NIE MA PRAWA POLOZYC CALEGO OMS-U. Kontener chodzi z `read_only: true`
// (deploy/nas/compose.yaml), wiec zapisywalne sa wylacznie `/tmp` i wolumen `/data-oms`.
// Zakladanie katalogu przy BUDOWIE uslugi znaczylo, ze brak `OMS_PROFORMY_KATALOG` w
// `.env.oms` konczy sie EROFS przy starcie → `zbudujOms` rzuca → kontener wpada w petle
// restartow (`restart: unless-stopped`) i przestaje dzialac WSZYSTKO: zamowienia, nadania,
// faktury. Awaria jednego katalogu ma kosztowac jedna funkcje, nie caly panel.
describe('zbudujOms — katalog proform nie kładzie usługi', () => {
  // Sciezka, ktorej system plikow nie zalozy: jej rodzicem jest PLIK. To ta sama klasa
  // awarii, co katalog tylko do odczytu na produkcji, tylko odtwarzalna na kazdym systemie.
  const niezapisywalny = () => {
    const plik = join(mkdtempSync(join(tmpdir(), 'oms-proformy-boot-')), 'nie-katalog');
    writeFileSync(plik, 'to jest plik, nie katalog');
    return join(plik, 'proformy');
  };

  const naglowek = {
    authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'),
    origin: 'http://localhost',
  };

  it('niezapisywalny katalog proform nie wywraca budowy całej usługi', () => {
    expect(() => zbudujOms({
      env: env({ OMS_PROFORMY_KATALOG: niezapisywalny() }),
      createDpd: atrapaDpd(),
    })).not.toThrow();
  });

  it('karta zamówienia otwiera się mimo niezapisywalnego katalogu proform', async () => {
    const { app, db } = zbudujOms({
      env: env({ OMS_PROFORMY_KATALOG: niezapisywalny() }),
      createDpd: atrapaDpd(),
    });
    db.prepare("INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, utworzone_at) VALUES ('pro', 1, '1', '10.00', '2026-08-04')").run();
    await app.ready();
    const r = await app.inject({ method: 'GET', url: '/zamowienia/1', headers: naglowek });
    expect(r.statusCode).toBe(200);
  });

  // Odmowa ma przyjsc DO OPERATORA (czytelny komunikat, kod 4xx), a nie jako 500 ani cichy
  // wiersz w bazie: numer z serii nie ma prawa zuzyc sie na dokument, ktorego nie ma gdzie
  // zapisac — dlatego zalozenie katalogu stoi PRZED nadaniem numeru.
  it('próba wystawienia proformy odmawia czytelnie i nie zużywa numeru z serii', async () => {
    const { app, db } = zbudujOms({
      env: env({ OMS_PROFORMY_KATALOG: niezapisywalny() }),
      createDpd: atrapaDpd(),
    });
    db.prepare(
      "INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, koszt_dostawy_brutto, utworzone_at)"
      + " VALUES ('pro', 1, '1', '10.00', '0.00', '2026-08-04')",
    ).run();
    db.prepare(
      "INSERT INTO pozycje (zamowienie_id, nazwa, ilosc, cena_brutto, brutto_linii, zrodlo) VALUES (1, 'Szablon', 1, '10.00', '10.00', 'sklep')",
    ).run();
    await app.ready();
    const r = await app.inject({ method: 'POST', url: '/zamowienia/1/proforma', headers: naglowek });

    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/katalog/i);
    expect(db.prepare('SELECT COUNT(*) c FROM proformy').get().c).toBe(0);
  });
});

// ⚠️ Data startowa musi PRZEJSC z konfiguracji do pollera. Sam config.js moze ja czytac
// bez zarzutu, a poller ja rozumiec — i pierwszy przebieg i tak przeczyta cala historie
// sklepu, jesli okablowanie jej nie przekaze. To dokladnie ta klasa dziury, przez ktora
// panel wciagnal 8866 zamowien z szkicownia.pl (01.08.2026).
describe('zbudujOms — data startowa dociera do pollera', () => {
  it('poller pyta sklep od daty z konfiguracji, a nie od początku historii', async () => {
    const zapytania = [];
    const fetchAtrapa = vi.fn(async (url) => {
      zapytania.push(String(url));
      return { ok: true, status: 200, json: async () => [], headers: { get: () => '1' } };
    });
    vi.stubGlobal('fetch', fetchAtrapa);
    try {
      const { poller } = zbudujOms({ env: env({ SHOP_PRO_OD: '2026-07-01' }), createDpd: atrapaDpd() });
      await poller.przebieg();
    } finally { vi.unstubAllGlobals(); }

    expect(zapytania).toHaveLength(1);
    expect(zapytania[0]).toContain('modified_after=2026-07-01T00%3A00%3A00');
  });

  it('bez daty startowej poller nie zawęża okna wcale', async () => {
    const zapytania = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      zapytania.push(String(url));
      return { ok: true, status: 200, json: async () => [], headers: { get: () => '1' } };
    }));
    try {
      const { poller } = zbudujOms({ env: env(), createDpd: atrapaDpd() });
      await poller.przebieg();
    } finally { vi.unstubAllGlobals(); }

    expect(zapytania[0]).not.toContain('modified_after');
  });
});

// ⚠️ KANAL ALLEGRO WCHODZI DO TEJ SAMEJ TABLICY POLLEROW, CO SKLEPY (Zadanie 9). To nie jest
// kosmetyka: zbiorczy `przebieg()` wyzej wola kazdy poller osobno i ZBIERA bledy, wiec awaria
// jednego kanalu nie zatrzymuje pozostalych. Druga sciezka przebiegu — wlasna petla dla
// kanalow — musialaby powtorzyc te regule, a jej kopia rozjechalaby sie po cichu.
//
// Testy nizej celuja w awarie CICHE, bo tylko takie sa tu grozne: kanal, ktory sie nie zbudowal,
// i kanal, ktory sie zbudowal, ale o nic nie pyta, wygladaja z zewnatrz identycznie jak
// spokojny dzien bez nowych zamowien (niezmiennik 4.9).
describe('zbudujOms — kanał Allegro w pollerze', () => {
  const KANAL = {
    ALLEGRO_SZKICOWNIA_CLIENT_ID: 'id', ALLEGRO_SZKICOWNIA_CLIENT_SECRET: 'sekret',
    ALLEGRO_SZKICOWNIA_OD: '2026-07-01', ALLEGRO_SZKICOWNIA_API: 'https://api.allegro.test',
    ALLEGRO_USER_AGENT: UA,
  };
  const DRUGI_KANAL = {
    ALLEGRO_AMARKA_CLIENT_ID: 'id2', ALLEGRO_AMARKA_CLIENT_SECRET: 'sekret2',
    ALLEGRO_AMARKA_OD: '2026-07-01', ALLEGRO_AMARKA_API: 'https://api2.allegro.test',
  };

  const zamowienieAllegro = (id, { boughtAt = '2026-08-03T09:13:41.325Z' } = {}) => ({
    id,
    updatedAt: '2026-08-04T07:17:35.018Z',
    status: 'READY_FOR_PROCESSING',
    lineItems: [{
      id: `${id}-1`,
      offer: { name: 'Szablon' },
      quantity: 1,
      price: { amount: '129.00', currency: 'PLN' },
      boughtAt,
    }],
    delivery: { method: { id: '03f26351-f683-4db2-8895-f2c599280e3c', name: 'Allegro Kurier DPD (AD)' }, cost: { amount: '0.00' } },
    payment: { type: 'ONLINE', finishedAt: '2026-08-03T09:14:00.000Z' },
    summary: { totalToPay: { amount: '129.00', currency: 'PLN' } },
  });

  // Zywy access token w bazie — inaczej klient poszedlby najpierw odswiezac tokeny.
  const polaczKanal = (db, kanal) => zapiszTokeny(db, kanal, {
    accessToken: 'ACCESS',
    refreshToken: 'REFRESH',
    wygasaAt: new Date(Date.now() + 3600_000).toISOString(),
    refreshWygasaAt: new Date(Date.now() + 80 * 86400_000).toISOString(),
  });

  // Jedna atrapa `fetch` na oba swiaty: sklep Woo oddaje pusta liste, Allegro — zamowienia
  // przypisane do swojego adresu API (kazdy kanal ma tu inny, wiec widac, KTORY pytal).
  const atrapaSieci = (zamowieniaKanalu = {}) => {
    const zapytania = [];
    return {
      zapytania,
      fetchImpl: vi.fn(async (url) => {
        const adres = String(url);
        zapytania.push(adres);
        const kanal = Object.keys(zamowieniaKanalu).find((api) => adres.startsWith(api));
        if (kanal) {
          const lista = zamowieniaKanalu[kanal];
          return { ok: true, status: 200, json: async () => ({ checkoutForms: lista, totalCount: lista.length }) };
        }
        return { ok: true, status: 200, json: async () => [], headers: { get: () => '1' } };
      }),
    };
  };

  it('bez zmiennych ALLEGRO_* panel wstaje normalnie i nie udaje, że widzi kanał', () => {
    const { app, poller } = zbudujOms({ env: env(), createDpd: atrapaDpd() });
    expect(app).toBeTruthy();
    expect(poller.stany().map((s) => s.sklep)).toEqual(['pro']);
  });

  // ⚠️⚠️ OKABLOWANIE ŚLEDZENIA KANAŁU ALLEGRO (25.08.2026). Klient zbudowany, ale NIEWPIĘTY
  // w mapę kurierów, wygląda z zewnątrz identycznie jak jego brak: `sledzeniePrzesylki`
  // oddaje `null`, paczka nie jest odpytywana, `status_kuriera` zostaje NULL — czyli
  // dokładnie stan sprzed całej zmiany, tyle że po cichu.
  //
  // ⚠️ TEN TEST POWSTAŁ PO MUTACJI, KTÓRA PRZEŻYŁA: skasowanie wpisu `allegro` z mapy
  // nie wywalało niczego w całej suicie.
  it('kanał Allegro wpina klienta ŚLEDZENIA do mapy kurierów', () => {
    const { kurierzy } = zbudujOms({ env: env(KANAL), createDpd: atrapaDpd() });
    expect(typeof kurierzy.allegro?.statusPrzesylki).toBe('function');
    // Flaga `bezSledzenia` w tym miejscu uciszyłaby kanał tak samo skutecznie, jak brak wpisu.
    expect(kurierzy.allegro.bezSledzenia).toBeFalsy();
  });

  it('bez kanału Allegro nie ma w mapie kuriera „allegro" — nie ma kogo pytać', () => {
    const { kurierzy } = zbudujOms({ env: env(), createDpd: atrapaDpd() });
    expect(kurierzy.allegro).toBeUndefined();
  });

  // ⚠️⚠️ NAGLOWEK ZGODNOSCI CALA DROGA: `.env` → config → klient → PRAWDZIWE zadanie pollera.
  // Testy klienta i tokenow mierza naglowek na wstrzyknietych `ustawieniach`; ten mierzy, ze
  // wartosc ze ZMIENNEJ SRODOWISKOWEJ naprawde dolatuje do zadania, ktore panel wysyla sam
  // z siebie co dwie minuty. Rozpiecie okablowania (kanal budowany bez `userAgent`) byloby
  // stad niewidoczne — zadania wychodza, zamowienia przychodza, a niezgodnosc widac tylko
  // w panelu zgodnosci Allegro.
  it('żądanie, które panel naprawdę wysyła, niesie User-Agent ze zmiennej środowiskowej', async () => {
    const wywolania = [];
    const fetchImpl = vi.fn(async (url, opcje = {}) => {
      wywolania.push({ url: String(url), opcje });
      if (String(url).startsWith('https://api.allegro.test')) {
        return { ok: true, status: 200, json: async () => ({ checkoutForms: [], totalCount: 0 }) };
      }
      return { ok: true, status: 200, json: async () => [], headers: { get: () => '1' } };
    });
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const { poller, db } = zbudujOms({ env: env(KANAL), createDpd: atrapaDpd() });
      polaczKanal(db, 'allegro_szkicownia');
      await poller.przebieg();

      const doAllegro = wywolania.filter((w) => w.url.startsWith('https://api.allegro.test'));
      expect(doAllegro).toHaveLength(1);
      expect(doAllegro[0].opcje.headers['User-Agent']).toBe(UA);
    } finally { vi.unstubAllGlobals(); }
  });

  // ⚠️ Kanal skonfigurowany BEZ naglowka ma wywalic start CALEJ uslugi — cicha niezgodnosc
  // jest dokladnie tym, co przelezalo tydzien. Bramka siedzi w config.js, ale sprawdzamy ja
  // TU, przez `zbudujOms`, bo to okablowanie decyduje, czy wyjatek naprawde zatrzyma usluge.
  it('kanał Allegro BEZ ALLEGRO_USER_AGENT nie pozwala usłudze wstać', () => {
    const bezUa = { ...KANAL };
    delete bezUa.ALLEGRO_USER_AGENT;
    expect(() => zbudujOms({ env: env(bezUa), createDpd: atrapaDpd() })).toThrow(/ALLEGRO_USER_AGENT/);
  });

  it('kanał Allegro z NIEPOPRAWNYM nagłówkiem też nie pozwala wstać (cicha niezgodność = awaria)', () => {
    expect(() => zbudujOms({
      env: env({ ...KANAL, ALLEGRO_USER_AGENT: 'PrzykladowyPanel' }),
      createDpd: atrapaDpd(),
    })).toThrow(/ALLEGRO_USER_AGENT/);
  });

  it('kanał Allegro dokłada się do TEJ SAMEJ listy pollerów, nie do drugiej ścieżki', () => {
    const { poller } = zbudujOms({ env: env(KANAL), createDpd: atrapaDpd() });
    const sklepy = poller.stany().map((s) => s.sklep);
    expect(sklepy).toContain('pro');
    expect(sklepy).toContain('allegro_szkicownia');
  });

  // ⚠️ SAMA OBECNOSC W `stany()` NIC NIE DOWODZI: `stan()` oddaje wiersz zastepczy dla KAZDEJ
  // nazwy, wiec kanal zbudowany z atrapa zamiast klienta, z pomylonym kluczem tokenow albo
  // bez podlogi wygladalby tam identycznie. Ten test idzie do konca: przebieg ma naprawde
  // wyjsc do Allegro, z podloga z konfiguracji, i zapisac zamowienie POD KLUCZEM KANALU.
  it('przebieg pyta Allegro podłogą z konfiguracji i zapisuje zamówienie pod kluczem kanału', async () => {
    const { zapytania, fetchImpl } = atrapaSieci({ 'https://api.allegro.test': [zamowienieAllegro('ALG-1')] });
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const { poller, db } = zbudujOms({ env: env(KANAL), createDpd: atrapaDpd() });
      polaczKanal(db, 'allegro_szkicownia');
      await poller.przebieg();

      const doAllegro = zapytania.filter((a) => a.startsWith('https://api.allegro.test'));
      expect(doAllegro).toHaveLength(1);
      expect(doAllegro[0]).toContain('/order/checkout-forms?');
      // Podloga z `ALLEGRO_SZKICOWNIA_OD` MUSI doleciec do zapytania — bez niej pierwszy
      // przebieg czyta cale archiwum konta (775 zamowien w chwili rozpoznania).
      expect(doAllegro[0]).toContain('lineItems.boughtAt.gte=2026-07-01T00%3A00%3A00Z');
      // …i sklep dalej jest odpytywany tym samym przebiegiem.
      expect(zapytania.some((a) => a.startsWith('https://pro.szkicownia.test'))).toBe(true);

      const wiersz = db.prepare('SELECT sklep, numer, metoda_wysylki FROM zamowienia').get();
      expect(wiersz).toMatchObject({ sklep: 'allegro_szkicownia', numer: 'ALG-1', metoda_wysylki: 'allegro_dpd' });
      // Kursor kanalu idzie za `updatedAt`, czyli poller dostal adapter Allegro, a nie Woo.
      expect(poller.stany().find((s) => s.sklep === 'allegro_szkicownia').zsynchronizowane_do)
        .toBe('2026-08-04T07:17:35.018Z');
    } finally { vi.unstubAllGlobals(); }
  });

  // ⚠️⚠️ PODLOGA NA DRUGIM PRZEBIEGU — DOKLADNIE TRYB AWARII Z 8866 WCIAGNIETYCH ZAMOWIEN.
  // Test wyzej dowodzi podlogi na PIERWSZYM przebiegu (pusty stan → zapytanie z
  // `lineItems.boughtAt.gte`), a to jest INNA sciezka: przy ZAPISANYM kursorze klient pyta po
  // `updatedAt.gte`, wiec podloga po dacie ZLOZENIA nie jedzie juz w zapytaniu w ogole —
  // musi zadzialac PO STRONIE POLLERA, przy zapisie (`zeStarego`). To jest ta sama sytuacja,
  // ktora 01.08.2026 wciagnela 500 zamowien z 2019, 2020 i 2024: zrodlo masowo dotknelo
  // archiwum, filtr po dacie MODYFIKACJI je oddal, a jedyna obrona byla podloga po dacie
  // ZLOZENIA. Poziom adaptera i poller maja na to wlasne testy — ten przechodzi CALA droge
  // (env → bootstrap → poller → adapter → klient → baza), bo zgubione ogniwo jest po drodze
  // i wyglada z zewnatrz jak spokojny dzien: zero bledow, zero wierszy, kursor idzie dalej.
  it('drugi przebieg: zamówienie sprzed podłogi NIE ZOSTAJE ZAPISANE, mimo świeżej modyfikacji', async () => {
    const stare = zamowienieAllegro('ALG-STARE', { boughtAt: '2019-11-02T10:00:00.000Z' });
    const { zapytania, fetchImpl } = atrapaSieci({ 'https://api.allegro.test': [stare] });
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const { poller, db } = zbudujOms({ env: env(KANAL), createDpd: atrapaDpd() });
      polaczKanal(db, 'allegro_szkicownia');
      // ZAPISANY kursor = kanal ma juz za soba udany przebieg. To on przestawia klienta
      // z galezi podlogi na galaz `updatedAt.gte`.
      db.prepare(
        'INSERT INTO stan_pollera (sklep, zsynchronizowane_do, ostatni_przebieg_at, ostatni_blad)'
        + " VALUES ('allegro_szkicownia', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', NULL)",
      ).run();

      await poller.przebieg();

      const doAllegro = zapytania.filter((a) => a.startsWith('https://api.allegro.test'));
      // Dowod, ze to naprawde DRUGI przebieg: pytanie poszlo po dacie MODYFIKACJI, a podlogi
      // w zapytaniu NIE MA. Gdyby ten warunek nie byl spelniony, brak wiersza nizej niczego
      // by nie dowodzil — odsialoby go samo Allegro.
      expect(doAllegro).toHaveLength(1);
      expect(doAllegro[0]).toContain('updatedAt.gte=2026-08-01T00%3A00%3A00.000Z');
      expect(doAllegro[0]).not.toContain('boughtAt.gte');

      // ⚠️ ISTOTA TESTU: zamowienie zlozone w 2019 i dotkniete wczoraj NIE ma wiersza.
      expect(db.prepare("SELECT COUNT(*) c FROM zamowienia WHERE sklep = 'allegro_szkicownia'").get().c).toBe(0);
      // …a kursor mimo to idzie do przodu — inaczej kazdy nastepny przebieg czytalby
      // to samo archiwum w kolko i nigdy nie dogonil terazniejszosci.
      expect(poller.stany().find((s) => s.sklep === 'allegro_szkicownia').zsynchronizowane_do)
        .toBe('2026-08-04T07:17:35.018Z');
    } finally { vi.unstubAllGlobals(); }
  });

  // ⚠️ AWARIA JEDNEGO KANALU NIE MA PRAWA ZATRZYMAC POZOSTALYCH. Kanal niepolaczony rzuca
  // przy pierwszym zapytaniu (brak refresh tokenu) — i to jest stan NORMALNY: tak wyglada
  // kanal przed device flow i po wygasnieciu tokenu. Gdyby kanaly jechaly wlasna petla bez
  // zbierania bledow, drugie konto i sklep przestalyby sie synchronizowac po cichu.
  it('niepołączony kanał nie zatrzymuje drugiego kanału ani sklepu', async () => {
    const { zapytania, fetchImpl } = atrapaSieci({ 'https://api2.allegro.test': [zamowienieAllegro('ALG-2')] });
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const { poller, db } = zbudujOms({ env: env({ ...KANAL, ...DRUGI_KANAL }), createDpd: atrapaDpd() });
      // Polaczony jest WYLACZNIE drugi kanal — pierwszy wywali sie w polowie przebiegu.
      polaczKanal(db, 'allegro_amarka');

      await expect(poller.przebieg()).rejects.toThrow(/nie jest połączony/);

      expect(zapytania.some((a) => a.startsWith('https://api2.allegro.test'))).toBe(true);
      expect(zapytania.some((a) => a.startsWith('https://pro.szkicownia.test'))).toBe(true);
      expect(db.prepare("SELECT COUNT(*) c FROM zamowienia WHERE sklep = 'allegro_amarka'").get().c).toBe(1);
      // Blad zostaje zapisany przy TYM kanale, ktorego dotyczy — a nie przy sklepie.
      const stany = Object.fromEntries(poller.stany().map((s) => [s.sklep, s.ostatni_blad]));
      expect(stany.allegro_szkicownia).toMatch(/nie jest połączony/);
      expect(stany.allegro_amarka).toBeNull();
      expect(stany.pro).toBeNull();
    } finally { vi.unstubAllGlobals(); }
  });
});

// ⚠️⚠️ MUST-FIX 1 (recenzja calej galezi): BLAD KANALU MA BYC WIDOCZNY.
//
// `stan()` karmi pasek na liscie zamowien (web/views/lista.ejs) — JEDYNE miejsce w calym
// panelu, w ktorym widac stan synchronizacji. Do 04.08.2026 oddawal `pollery[0].stan()`,
// czyli stan PIERWSZEGO SKLEPU, wiec blad kanalu Allegro nie docieral do czlowieka NIGDY:
// ladowal do `stan_pollera` pod kluczem `allegro_*`, ktorego nikt nie czytal, a jedynym
// sladem zostawal `console.error` w kontenerze. Refresh token Allegro wygasa raz na 3
// miesiace i wygasniecie objawialoby sie WYLACZNIE brakiem nowych zamowien — czyli tak samo
// jak spokojny dzien. To ono zamieniało pozostale usterki kanalu w niewidzialne.
describe('zbudujOms — stan pollera pokazuje BŁĄD, a nie zawsze pierwszy sklep', () => {
  const KANAL = {
    ALLEGRO_SZKICOWNIA_CLIENT_ID: 'id', ALLEGRO_SZKICOWNIA_CLIENT_SECRET: 'sekret',
    ALLEGRO_SZKICOWNIA_OD: '2026-07-01', ALLEGRO_SZKICOWNIA_API: 'https://api.allegro.test',
    ALLEGRO_USER_AGENT: UA,
  };

  const sklepPusty = () => vi.fn(async () => ({
    ok: true, status: 200, json: async () => [], headers: { get: () => '1' },
  }));

  it('bez żadnego błędu oddaje pierwszy sklep — pasek działa dokładnie jak dotąd', async () => {
    vi.stubGlobal('fetch', sklepPusty());
    try {
      const { poller } = zbudujOms({ env: env(KANAL), createDpd: atrapaDpd() });
      expect(poller.stan().sklep).toBe('pro');
    } finally { vi.unstubAllGlobals(); }
  });

  // Kanal bez refresh tokenu (dokladnie ten stan, w ktory wpada konto po wygasnieciu zgody)
  // rzuca w przebiegu i zapisuje blad przy SWOIM kluczu. Sklep konczy przebieg czysto.
  it('błąd KANAŁU wypiera z paska czysty stan sklepu', async () => {
    vi.stubGlobal('fetch', sklepPusty());
    try {
      const { poller } = zbudujOms({ env: env(KANAL), createDpd: atrapaDpd() });
      await expect(poller.przebieg()).rejects.toThrow(/nie jest połączony/);

      expect(poller.stan().sklep).toBe('allegro_szkicownia');
      expect(poller.stan().ostatni_blad).toMatch(/nie jest połączony/);
      // …a komplet dalej jest w `stany()` — pasek pokazuje jeden wiersz, nie kasuje reszty.
      expect(poller.stany().map((s) => s.sklep)).toEqual(['pro', 'allegro_szkicownia']);
    } finally { vi.unstubAllGlobals(); }
  });

  // Blad SKLEPU ma dalej dzialac tak samo — poprawka nie moze przeslonic awarii, ktora
  // pasek pokazywal do tej pory.
  it('błąd sklepu dalej trafia na pasek', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 500, text: async () => 'padło', headers: { get: () => '1' },
    })));
    try {
      const { poller } = zbudujOms({ env: env(), createDpd: atrapaDpd() });
      await expect(poller.przebieg()).rejects.toThrow();
      expect(poller.stan().sklep).toBe('pro');
      expect(poller.stan().ostatni_blad).toBeTruthy();
    } finally { vi.unstubAllGlobals(); }
  });
});

// ⚠️⚠️ C-2 (recenzja calej galezi) CALA DROGA: env → bootstrap → poller → adapter Allegro →
// mapowanie → baza. Testy pollera mierza izolacje na atrapie kanalu; ten mierzy ja na
// PRAWDZIWYM mapowaniu Allegro i na prawdziwym ksztalcie odpowiedzi API — bo to wlasnie
// `mapujZamowienieAllegro` jest jedynym mapowaniem w tym repo, ktore w ogole rzuca.
describe('zbudujOms — jedno złe zamówienie z Allegro nie zabija kanału', () => {
  const KANAL = {
    ALLEGRO_SZKICOWNIA_CLIENT_ID: 'id', ALLEGRO_SZKICOWNIA_CLIENT_SECRET: 'sekret',
    ALLEGRO_SZKICOWNIA_OD: '2026-07-01', ALLEGRO_SZKICOWNIA_API: 'https://api.allegro.test',
    ALLEGRO_USER_AGENT: UA,
  };
  const dobre = (id, updatedAt) => ({
    id,
    updatedAt,
    status: 'READY_FOR_PROCESSING',
    lineItems: [{
      id: `${id}-1`, offer: { name: 'Szablon' }, quantity: 1,
      price: { amount: '129.00', currency: 'PLN' }, boughtAt: '2026-08-03T09:13:41.325Z',
    }],
    delivery: { method: { id: '03f26351-f683-4db2-8895-f2c599280e3c', name: 'Allegro Kurier DPD (AD)' }, cost: { amount: '0.00' } },
    payment: { type: 'ONLINE', finishedAt: '2026-08-03T09:14:00.000Z' },
    summary: { totalToPay: { amount: '129.00', currency: 'PLN' } },
  });
  // Pobranie na 0,00 zl — sprzecznosc, na ktorej mapowanie CELOWO rzuca (to sa pieniadze,
  // ktore kurier ma zainkasowac od klienta).
  const zle = (id, updatedAt) => ({
    ...dobre(id, updatedAt),
    payment: { type: 'CASH_ON_DELIVERY' },
    summary: { totalToPay: { amount: '0.00', currency: 'PLN' } },
  });

  it('przebieg kończy się normalnie, pozostałe zamówienia wchodzą, kursor idzie dalej', async () => {
    const lista = [
      dobre('ALG-1', '2026-08-04T07:00:00.000Z'),
      zle('ALG-ZLE', '2026-08-04T08:00:00.000Z'),
      dobre('ALG-2', '2026-08-04T09:00:00.000Z'),
    ];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).startsWith('https://api.allegro.test')) {
        return { ok: true, status: 200, json: async () => ({ checkoutForms: lista, totalCount: lista.length }) };
      }
      return { ok: true, status: 200, json: async () => [], headers: { get: () => '1' } };
    }));
    try {
      const { poller, db } = zbudujOms({ env: env(KANAL), createDpd: atrapaDpd() });
      zapiszTokeny(db, 'allegro_szkicownia', {
        accessToken: 'ACCESS',
        refreshToken: 'REFRESH',
        wygasaAt: new Date(Date.now() + 3600_000).toISOString(),
        refreshWygasaAt: new Date(Date.now() + 80 * 86400_000).toISOString(),
      });

      // ⚠️ ZBIORCZY PRZEBIEG NIE RZUCA. Przed poprawka leciał tu wyjatek z mapowania —
      // i wracalby przy KAZDYM nastepnym tyknieciu, bo kursor zostawal przed zlym
      // zamowieniem. Kanal stal na zawsze.
      await expect(poller.przebieg()).resolves.toBeUndefined();

      const numery = db.prepare("SELECT numer FROM zamowienia WHERE sklep = 'allegro_szkicownia' ORDER BY numer").all();
      expect(numery.map((w) => w.numer)).toEqual(['ALG-1', 'ALG-2']);

      const stan = poller.stany().find((s) => s.sklep === 'allegro_szkicownia');
      // Kursor PONAD zlym zamowieniem — inaczej nastepny przebieg czytalby te sama strone.
      expect(stan.zsynchronizowane_do).toBe('2026-08-04T09:00:00.000Z');
      // …a powod pominiecia jest zapisany i widoczny na pasku (patrz `stan()` wyzej).
      expect(stan.ostatni_blad).toMatch(/Pominięto 1 zamówienie/);
      expect(stan.ostatni_blad).toContain('ALG-ZLE');
      expect(poller.stan().sklep).toBe('allegro_szkicownia');
    } finally { vi.unstubAllGlobals(); }
  });
});

// ⚠️ USLUGA NUMEROW LISTOW Z ALLEGRO (Zadanie 11). Sama w sobie niczego nie pokazuje —
// bez podpiecia w okablowaniu numery nadanych paczek nie pojawilyby sie w panelu NIGDY,
// a testy modulu swiecilyby na zielono. Dokladnie ta cicha awaria, dla ktorej ten plik
// w ogole powstal (I1).
describe('zbudujOms — numery listow z Allegro', () => {
  const KANAL = {
    ALLEGRO_SZKICOWNIA_CLIENT_ID: 'id', ALLEGRO_SZKICOWNIA_CLIENT_SECRET: 'sekret',
    ALLEGRO_SZKICOWNIA_OD: '2026-07-01', ALLEGRO_SZKICOWNIA_API: 'https://api.allegro.test',
    ALLEGRO_USER_AGENT: UA,
  };

  it('bez kanalow uslugi po prostu NIE MA — panel wstaje jak dotad', () => {
    const { przesylkiAllegro } = zbudujOms({ env: env(), createDpd: atrapaDpd() });
    expect(przesylkiAllegro).toBeNull();
  });

  it('z kanalem usluga jest podpieta i zna klucz kanalu', () => {
    const { przesylkiAllegro, klienciKanalow } = zbudujOms({ env: env(KANAL), createDpd: atrapaDpd() });
    expect(przesylkiAllegro).not.toBeNull();
    expect(Object.keys(klienciKanalow)).toEqual(['allegro_szkicownia']);
  });

  // ⚠️ JEDEN klient na kanal, wspolny z pollerem. Druga instancja znaczylaby druga pare
  // tokenow w pamieci procesu i dwa niezalezne odswiezenia TEGO SAMEGO refresh tokenu —
  // a Allegro uniewaznia poprzedni przy kazdym odswiezeniu.
  // ⚠️⚠️ TEN TEST ISTNIEJE, BO MUTACJA GO ZNALAZLA. Skasowanie `przesylkiAllegro` z wywolania
  // `buildOmsServer` w bootstrap.js przechodzilo na ZIELONO przez cala suite: usluga byla
  // zbudowana (test wyzej), trasa umiala jej uzyc (tests/oms/przesylki-allegro-karta.test.js
  // buduje serwer sama), a mimo to w prawdziwym panelu numery listow z Allegro nie pojawilyby
  // sie NIGDY. Dokladnie tryb awarii, dla ktorego ten plik powstal (I1) — dlatego pomiar musi
  // przejsc CALA droge: env → zbudujOms → serwer → karta → Allegro → HTML.
  it('otwarcie karty zamowienia z Allegro naprawde dociaga numer listu', async () => {
    const zapytania = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const adres = String(url);
      zapytania.push(adres);
      if (adres.endsWith('/shipments')) {
        return { ok: true, status: 200, json: async () => ({ shipments: [{ waybill: 'AD0LK57DLG0756H4H', carrierId: 'ALLEGRO' }] }) };
      }
      return { ok: true, status: 200, json: async () => ({ checkoutForms: [], totalCount: 0 }), headers: { get: () => '1' } };
    }));
    try {
      const { app, db } = zbudujOms({ env: env(KANAL), createDpd: atrapaDpd() });
      zapiszTokeny(db, 'allegro_szkicownia', {
        accessToken: 'ACCESS',
        refreshToken: 'REFRESH',
        wygasaAt: new Date(Date.now() + 3600_000).toISOString(),
        refreshWygasaAt: new Date(Date.now() + 80 * 86400_000).toISOString(),
      });
      const id = zapiszZamowienie(db, 'allegro_szkicownia', {
        zrodlo_id: 'e2a1', numer: 'e2a1', klient: { first_name: 'Jan', email: 'j@k.pl' },
        dostawa: { city: 'Pęki' }, metoda_wysylki: 'allegro_dpd', kwota_pobrania: null, chce_fakture: 0,
        nip: null, kwota_brutto: '99.00', status_woo: null, oplacone_at: '2026-08-04T09:00:00',
        anulowane: 0, utworzone_at: '2026-08-04T08:00:00',
        pozycje: [{ nazwa: 'Szablon', sku: 'X', ilosc: 1, cena_brutto: '99.00', vat: null }],
      }, {});

      await app.ready();
      const odp = await app.inject({
        method: 'GET',
        url: `/zamowienia/${id}`,
        headers: { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64') },
      });

      expect(odp.statusCode).toBe(200);
      expect(zapytania).toContain('https://api.allegro.test/order/checkout-forms/e2a1/shipments');
      expect(odp.body).toContain('AD0LK57DLG0756H4H');
      expect(db.prepare('SELECT kurier FROM przesylki WHERE zamowienie_id = ?').get(id).kurier).toBe('allegro');
    } finally { vi.unstubAllGlobals(); }
  });

  it('klient kanalu pyta Allegro o przesylki TEGO zamowienia', async () => {
    const zapytania = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      zapytania.push(String(url));
      return { ok: true, status: 200, json: async () => ({ shipments: [] }) };
    }));
    try {
      const { klienciKanalow, db } = zbudujOms({ env: env(KANAL), createDpd: atrapaDpd() });
      zapiszTokeny(db, 'allegro_szkicownia', {
        accessToken: 'ACCESS',
        refreshToken: 'REFRESH',
        wygasaAt: new Date(Date.now() + 3600_000).toISOString(),
        refreshWygasaAt: new Date(Date.now() + 80 * 86400_000).toISOString(),
      });
      await klienciKanalow.allegro_szkicownia.pobierzPrzesylki('e2a1');
      expect(zapytania).toContain('https://api.allegro.test/order/checkout-forms/e2a1/shipments');
    } finally { vi.unstubAllGlobals(); }
  });
});

// ⚠️⚠️ WYSLANIE FAKTURY NA KONTO KUPUJACEGO W ALLEGRO (Plan B, Zadanie 9).
//
// Usluga zbudowana w bootstrap.js i ZGUBIONA po drodze do tras to dokladnie ta cicha awaria,
// ktora w Partii 1 i 2 PRZEZYLA cala suite (4442 i 4506 testow na zielono) przy usludze, ktora
// na produkcji nigdy by sie nie uruchomila — i ktora mutacja zlapala juz raz przy
// `przesylkiAllegro`. Tutaj stawka jest najwyzsza w calym panelu: to jedyna operacja, ktorej
// NIE DA SIE COFNAC (dokument laduje u kupujacego). Dlatego pomiar idzie CALA droga:
// env → zbudujOms → buildOmsServer → trasa → usluga → HTTP do Allegro → nasza baza.
describe('zbudujOms — faktura na konto kupującego w Allegro', () => {
  const KANAL = {
    ALLEGRO_SZKICOWNIA_CLIENT_ID: 'id', ALLEGRO_SZKICOWNIA_CLIENT_SECRET: 'sekret',
    ALLEGRO_SZKICOWNIA_OD: '2026-07-01', ALLEGRO_SZKICOWNIA_API: 'https://api.allegro.test',
    ALLEGRO_USER_AGENT: UA,
  };
  const PDF = Buffer.concat([Buffer.from('%PDF-1.4'), Buffer.alloc(64)]);
  const naglowek = {
    authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'),
    origin: 'http://localhost',
  };

  const zamowienieZFaktura = (db) => {
    zapiszTokeny(db, 'allegro_szkicownia', {
      accessToken: 'ACCESS',
      refreshToken: 'REFRESH',
      wygasaAt: new Date(Date.now() + 3600_000).toISOString(),
      refreshWygasaAt: new Date(Date.now() + 80 * 86400_000).toISOString(),
    });
    const id = zapiszZamowienie(db, 'allegro_szkicownia', {
      zrodlo_id: 'CF-1', numer: 'CF-1', klient: { first_name: 'Jan', email: 'j@k.pl' },
      dostawa: { city: 'Pęki' }, metoda_wysylki: 'allegro_dpd', kwota_pobrania: null, chce_fakture: 1,
      nip: null, kwota_brutto: '99.00', status_woo: null, oplacone_at: '2026-08-05T09:00:00',
      anulowane: 0, utworzone_at: '2026-08-05T08:00:00',
      pozycje: [{ nazwa: 'Szablon', sku: 'X', ilosc: 1, cena_brutto: '99.00', vat: null }],
    }, {});
    db.prepare(`INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, ksef_numer, utworzona_at)
      VALUES (?,?,?,?,?)`).run(id, 'u1', '12/08/2026', 'KS-1', '2026-08-05T10:00:00Z');
    return id;
  };

  it('bez kanałów usługi po prostu NIE MA — panel wstaje jak dotąd', () => {
    const { fakturaAllegro } = zbudujOms({ env: env(), createDpd: atrapaDpd() });
    expect(fakturaAllegro).toBeNull();
  });

  it('bez inFaktu usługi NIE MA, choć kanał jest — nie ma skąd wziąć dokumentu', () => {
    const { fakturaAllegro } = zbudujOms({
      env: env({ ...KANAL, INFAKT_API_KEY: undefined }), createDpd: atrapaDpd(),
    });
    expect(fakturaAllegro).toBeNull();
  });

  // ⚠️⚠️ TEN TEST MA ZABIC MUTACJE „usun `fakturaAllegro` z wywolania buildOmsServer".
  // Sama obecnosc uslugi w zwracanym obiekcie NICZEGO nie dowodzi — trasa dostaje ja OSOBNA
  // droga (bootstrap → buildOmsServer → registerZamowieniaRoutes) i to wlasnie tam gubila sie
  // juz raz. Dlatego mierzymy PO SKUTKU: prawdziwe zadania do Allegro i slad w bazie.
  it('przycisk na karcie NAPRAWDĘ wysyła dokument — env → trasa → Allegro → baza', async () => {
    const zapytania = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opcje = {}) => {
      const adres = String(url);
      zapytania.push(`${opcje.method ?? 'GET'} ${adres}`);
      // PDF na swiezo z inFaktu — panel nie trzyma kopii dokumentu.
      if (adres.includes('/v3/invoices/u1/pdf.json')) {
        return { ok: true, status: 200, arrayBuffer: async () => PDF };
      }
      // ⚠️ Zdalna lista faktur oddaje na produkcji 400 (zmierzone 05.08.2026) — atrapa oddaje
      // to samo, zeby test mierzyl RZECZYWISTOSC, a nie zasob, ktorego dzis nie ma.
      if (adres.endsWith('/invoices') && (opcje.method ?? 'GET') === 'GET') {
        return { ok: false, status: 400, json: async () => ({}) };
      }
      if (adres.endsWith('/invoices') && opcje.method === 'POST') {
        return { ok: true, status: 201, json: async () => ({ id: 'INV-1' }) };
      }
      if (adres.endsWith('/invoices/INV-1/file') && opcje.method === 'PUT') {
        return { ok: true, status: 200, json: async () => ({ file: { securityVerification: { status: 'WAITING' } } }) };
      }
      return { ok: true, status: 200, json: async () => ({ checkoutForms: [], totalCount: 0 }) };
    }));
    try {
      const { app, db } = zbudujOms({ env: env(KANAL), createDpd: atrapaDpd() });
      const id = zamowienieZFaktura(db);
      await app.ready();

      // Najpierw karta: przycisk ma tam BYC, inaczej nikt tej trasy nie kliknie.
      const karta = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
      expect(karta.statusCode).toBe(200);
      expect(karta.body).toContain(`/zamowienia/${id}/faktura-allegro`);

      const odp = await app.inject({
        method: 'POST', url: `/zamowienia/${id}/faktura-allegro`, headers: naglowek,
      });

      expect(odp.statusCode).toBe(302);
      expect(zapytania).toContain('POST https://api.allegro.test/order/checkout-forms/CF-1/invoices');
      expect(zapytania).toContain('PUT https://api.allegro.test/order/checkout-forms/CF-1/invoices/INV-1/file');
      const f = db.prepare('SELECT * FROM faktury WHERE zamowienie_id = ?').get(id);
      expect(f.allegro_invoice_id).toBe('INV-1');
      expect(f.allegro_wyslana_at).not.toBeNull();
      expect(f.allegro_weryfikacja).toBe('WAITING');
    } finally { vi.unstubAllGlobals(); }
  });

  // ⚠️⚠️ FURTKA „BEZ NUMERU KSEF" ZNIKNELA 01.09.2026 (decyzja właściciela) — a wraz z nia jej
  // okablowanie. Zostaje asercja odwrotna do tamtej: trasy ma NIE BYC w zbudowanym panelu.
  // Zostawiona w routerze po usunieciu z widoku dalej wysylalaby dokument kupujacemu ze
  // starej karty albo z `curl`, i nikt by tego nie zobaczyl.
  it('trasy „bez numeru KSeF" w zbudowanym panelu NIE MA', async () => {
    const { app, db } = zbudujOms({ env: env(KANAL), createDpd: atrapaDpd() });
    const id = zamowienieZFaktura(db);
    db.prepare('UPDATE faktury SET ksef_numer = NULL, utworzona_at = ? WHERE zamowienie_id = ?')
      .run(new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(), id);
    await app.ready();

    const karta = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(karta.statusCode).toBe(200);
    expect(karta.body).not.toContain('faktura-allegro-bez-ksef');

    const odp = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/faktura-allegro-bez-ksef`, headers: naglowek,
    });
    expect(odp.statusCode).toBe(404);
    const f = db.prepare('SELECT * FROM faktury WHERE zamowienie_id = ?').get(id);
    expect(f.allegro_wyslana_at).toBeNull();
  });

  // ⚠️ WYSYLKA JEST RECZNA (Zadanie 9). Automat to Zadanie 12 i ma wejsc DOPIERO po tym, jak
  // pierwszy dokument pojdzie pod okiem wlasciciela. Podpiecie tej uslugi do zegara „przy
  // okazji" zdjeloby czlowieka z petli przy operacji nieodwracalnej — bez ani jednej decyzji.
  it('NIE dostaje własnego zegara — pierwszy dokument idzie ręcznie', () => {
    const zarejestrowane = [];
    const { poller, czuwaczKsef } = zbudujOms({ env: env(KANAL), createDpd: atrapaDpd() });
    uruchomZegary({
      poller, czuwaczKsef, ustawInterwal: (fn, ms) => { zarejestrowane.push(ms); return zarejestrowane.length; },
    });
    expect(zarejestrowane).toEqual([2 * 60 * 1000, 60 * 60 * 1000]);
  });
});

// I2. Wersja sprzed poprawki doklejala do konfiguracji DPD drugi obiekt `nadawca`,
// zlozony z NIEPREFIKSOWANYCH zmiennych NADAWCA_* z domyslnymi '' — i PRZESLANIALA nim
// zwalidowany adres z DPD_NADAWCA_*. Puste stringi przechodzily przez `if (!nadawca)`,
// wiec KAZDA paczka jechalaby z pusta ulica, kodem i miastem nadawcy.
describe('zbudujOms — adres nadawcy', () => {
  it('przekazuje do DPD zwalidowany adres z DPD_NADAWCA_*', () => {
    const createDpd = atrapaDpd();
    zbudujOms({ env: env(), createDpd });
    expect(createDpd.mock.calls[0][0].nadawca).toEqual({
      // `phone` i `email` sa PUSTE, bo DPD ich nie wymaga — a InPost owszem i dlatego
      // odmawia nadania do paczkomatu, gdy ich brak (usterka 05.08.2026, zam. 28173).
      // Ten test pilnuje KSZTALTU adresu firmy: nowe pole ma sie tu pojawic swiadomie.
      nazwa: 'Lumina Marek Zywiecki', ulica: 'Fabryczna 7', kod: '00-650', miasto: 'Pęki', kraj: 'PL', phone: '', email: '',
    });
  });

  // Nieprefiksowane NADAWCA_* nie moga miec zadnego wplywu — ani gdy sa puste
  // (przesloniecie pustka), ani gdy sa ustawione (drugie, nieuzgodnione zrodlo prawdy).
  it('nieprefiksowane NADAWCA_* są ignorowane, także gdy są puste', () => {
    const createDpd = atrapaDpd();
    zbudujOms({
      env: env({ NADAWCA_ULICA: '', NADAWCA_KOD: '', NADAWCA_MIASTO: '', NADAWCA_NAZWA: 'Ktoś inny' }),
      createDpd,
    });
    const n = createDpd.mock.calls[0][0].nadawca;
    expect(n.ulica).toBe('Fabryczna 7');
    expect(n.kod).toBe('00-650');
    expect(n.miasto).toBe('Pęki');
    expect(n.nazwa).toBe('Lumina Marek Zywiecki');
  });

  // Bez atrapy: prawdziwy createDpdClient ma odrzucic pusty adres. Gdyby okablowanie
  // znow zaczelo przesylaniac nadawce pustka, start uslugi wywali sie glosno.
  it('z prawdziwym klientem DPD komplet konfiguracji wstaje bez wyjątku', () => {
    expect(() => zbudujOms({ env: env() })).not.toThrow();
  });
});

// Ostatnia linia obrony przed czwartym wypadnieciem src/oms.js z commita: skoro w tym
// pliku ma nie byc juz zadnej logiki, to sprawdzamy, ze jej tam nie ma. Gdyby ktos
// dopisal tam okablowanie z powrotem, ten test to pokaze zanim plik znow zginie.
describe('src/oms.js pozostaje cienkim punktem wejścia', () => {
  it('deleguje budowę do bootstrap.js i nie okablowuje nic sam', async () => {
    const sciezka = fileURLToPath(new URL('../../src/oms.js', import.meta.url));
    const zrodlo = readFileSync(sciezka, 'utf8');
    expect(await wykonajWejscie()).toEqual([
      ['/ustawienia/zamowienia-i-wysylka', 200, 'Paczki i koszty dostawy'],
      ['/faktury', 200, 'Faktury'], ['/magazyn', 200, 'Magazyn'], ['/raporty', 200, 'Raporty'], ['/wiadomosci', 200, 'Wiadomości'],
    ]);
    for (const zakazane of ['createDpdClient', 'createInfaktClient', 'createNadanie', 'createFaktura', 'buildOmsServer']) {
      expect(zrodlo).not.toContain(zakazane);
    }
  });

  // ⚠️⚠️ ZEGARY SA WOLANE Z TEGO PLIKU, ALE MIESZKAJA W `uruchomZegary` (bootstrap.js) —
  // poprawka z recenzji Partii 2 (K2). Do 06.08.2026 stal tu `setInterval` wprost, a jedynym
  // testem zegara byl GREP PO ZRODLE — a grep nie widzi OSIAGALNOSCI galezi: recenzent zmienil
  // `if (czuwaczKsef)` na `if (false && czuwaczKsef)` i 4506/4506 testow przeszlo. To ta sama
  // awaria, co „device flow zbudowany, przetestowany i bez ani jednego wywolania".
  //
  // Zostaje tu wylacznie sprawdzenie, ze punkt wejscia NAPRAWDE te funkcje wola — reszta
  // (czy zegar powstaje, z jakim odstepem i czy awaria go nie kladzie) jest jednostkowa nizej.
  it('deleguje uruchomienie zegarów do uruchomZegary', async () => {
    const sciezka = fileURLToPath(new URL('../../src/oms.js', import.meta.url));
    const zrodlo = readFileSync(sciezka, 'utf8');
    const wynik = await wykonajZegary();
    expect(wynik.nazwy).toEqual([
      ['poller', 120000], ['czuwaczKsef', 3600000], ['czuwaczArchiwumSprzedazy', 3600000],
      ['pollerWiadomosci', 300000], ['czuwaczFormulki', 120000], ['czuwaczPrzesylek', 3600000],
      ['czuwaczPodjazdow', 600000], ['czuwaczKosztow', 3600000], ['czuwaczOstrzezen', 3600000],
      ['czuwaczReklam', 3600000],
    ].sort());
    expect(wynik.liczba).toBe(10);
    expect(zrodlo).not.toMatch(/setInterval/);
  });
});

// ⚠️⚠️ K2: NIKT BY NIE ZAUWAZYL, GDYBY ZEGAR NIGDY NIE WYSTARTOWAL.
// Zegar bez testu jednostkowego to usluga, ktora „jest w kodzie" i nie chodzi ani razu —
// dokladnie tak, jak przez trzy tygodnie nie chodzilo odsylanie statusu do kanalu (W2a).
describe('uruchomZegary', () => {
  // Sztuczny zegar: zbiera zarejestrowane wywolania i pozwala je odpalic RECZNIE. Prawdziwy
  // `setInterval` znaczylby test czekajacy godzine albo — z podmiana globalnego zegara —
  // test zalezny od kolejnosci plikow w suicie.
  const sztucznyZegar = () => {
    const zarejestrowane = [];
    const ustaw = (fn, ms) => { zarejestrowane.push({ fn, ms }); return zarejestrowane.length; };
    const tyknij = (ms) => zarejestrowane.filter((z) => z.ms === ms).forEach((z) => z.fn());
    return { zarejestrowane, ustaw, tyknij };
  };
  const GODZINA = 60 * 60 * 1000;
  const DWIE_MINUTY = 2 * 60 * 1000;

  it('po godzinie woła przebieg czuwacza DOKŁADNIE raz', async () => {
    const zegar = sztucznyZegar();
    const czuwaczKsef = { przebieg: vi.fn().mockResolvedValue({ sprawdzone: 0, znalezione: 0 }) };

    uruchomZegary({ poller: null, czuwaczKsef, ustawInterwal: zegar.ustaw });
    zegar.tyknij(GODZINA);
    await Promise.resolve();

    expect(czuwaczKsef.przebieg).toHaveBeenCalledTimes(1);
  });

  it('poller chodzi co dwie minuty, czuwacz co godzinę — osobnymi zegarami', () => {
    const zegar = sztucznyZegar();
    const poller = { przebieg: vi.fn().mockResolvedValue({}) };
    const czuwaczKsef = { przebieg: vi.fn().mockResolvedValue({}) };

    uruchomZegary({ poller, czuwaczKsef, ustawInterwal: zegar.ustaw });

    expect(zegar.zarejestrowane.map((z) => z.ms)).toEqual([DWIE_MINUTY, GODZINA]);
    zegar.tyknij(GODZINA);
    expect(poller.przebieg).not.toHaveBeenCalled();
    expect(czuwaczKsef.przebieg).toHaveBeenCalledTimes(1);
  });

  // ⚠️ ODRZUCONA OBIETNICA W `setInterval` TO `unhandled rejection`, KTORE KLADZIE CALY PROCES
  // OMS-u — w srodku nocy, z powodu jednej faktury.
  it('awaria przebiegu nie kładzie procesu, tylko ląduje w logu', async () => {
    const zegar = sztucznyZegar();
    const log = vi.fn();
    const czuwaczKsef = { przebieg: vi.fn().mockRejectedValue(new Error('inFakt nieosiągalny')) };

    uruchomZegary({ poller: null, czuwaczKsef, ustawInterwal: zegar.ustaw, log });
    expect(() => zegar.tyknij(GODZINA)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/czuwacz KSeF/), 'inFakt nieosiągalny');
  });

  // ⚠️⚠️ W5 (recenzja Partii 3): PRZEKROCZENIE GODZINY BYLO CALKOWICIE CICHE.
  // `przebieg()` oddaje `{ pominiety: true }`, gdy poprzedni jeszcze trwa — a `uruchomZegary`
  // ten wynik WYRZUCAL. `.catch` nic nie lapal, bo przebieg wcale nie odrzuca. Czuwacz
  // zaczynal chodzic co DWIE godziny bez ani jednego wpisu — dosłownie awaria, przed ktora
  // ostrzega komentarz nad straznikiem „jeden przebieg naraz" w services/czuwacz-ksef.js.
  //
  // Skutek na produkcji: faktury czekaja na numer KSeF dwa razy dluzej, a wyglada to
  // DOKLADNIE tak samo jak poprawne dzialanie (brak numerow KSeF = dzien bez wysylki).
  it('pominięty przebieg czuwacza ZOSTAWIA ŚLAD w logu', async () => {
    const zegar = sztucznyZegar();
    const log = vi.fn();
    const czuwaczKsef = { przebieg: vi.fn().mockResolvedValue({ sprawdzone: 0, znalezione: 0, pominiety: true }) };

    uruchomZegary({ poller: null, czuwaczKsef, ustawInterwal: zegar.ustaw, log });
    zegar.tyknij(GODZINA);
    await Promise.resolve();
    await Promise.resolve();

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/czuwacz KSeF/));
    expect(log.mock.calls[0][0]).toMatch(/pomini|trwa/i);
  });

  // Druga polowa: przebieg NORMALNY nie ma prawa nic logowac. Log rosnacy od PRZEBIEGOW,
  // a nie od ZDARZEN, to 24 wiersze na dobe, w ktorych utonie prawdziwa awaria — ta sama
  // zasada, ktora rzadzi dlawieniem powtorzen w samym czuwaczu.
  it('normalny przebieg NIE loguje niczego', async () => {
    const zegar = sztucznyZegar();
    const log = vi.fn();
    const czuwaczKsef = { przebieg: vi.fn().mockResolvedValue({ sprawdzone: 3, znalezione: 1 }) };

    uruchomZegary({ poller: null, czuwaczKsef, ustawInterwal: zegar.ustaw, log });
    zegar.tyknij(GODZINA);
    await Promise.resolve();
    await Promise.resolve();

    expect(log).not.toHaveBeenCalled();
  });

  it('bez czuwacza (brak kanału Allegro albo inFaktu) zegar czuwacza NIE powstaje', () => {
    const zegar = sztucznyZegar();

    uruchomZegary({ poller: { przebieg: vi.fn() }, czuwaczKsef: null, ustawInterwal: zegar.ustaw });

    expect(zegar.zarejestrowane.map((z) => z.ms)).toEqual([DWIE_MINUTY]);
  });

  it('bez pollera i bez czuwacza nie powstaje ani jeden zegar', () => {
    const zegar = sztucznyZegar();
    uruchomZegary({ poller: null, czuwaczKsef: null, ustawInterwal: zegar.ustaw });
    expect(zegar.zarejestrowane).toEqual([]);
  });

  // ZEGAR #6 — czuwacz ostrzeżeń (2026-08-29): lustra tabelki strony głównej (luki KSeF
  // + terminy płatności). Ten sam wzorzec, co czuwacz KSeF: godzina, pominięty zostawia
  // ślad, sukces bije puls (jedyny ślad tego zegara dla /health).
  it('czuwacz ostrzeżeń chodzi co godzinę i bije puls po sukcesie', async () => {
    const zegar = sztucznyZegar();
    const puls = { ok: vi.fn(), blad: vi.fn() };
    const czuwaczOstrzezen = { przebieg: vi.fn().mockResolvedValue({ pominiety: false }) };

    uruchomZegary({
      poller: null, czuwaczKsef: null, czuwaczOstrzezen, ustawInterwal: zegar.ustaw, puls,
    });
    zegar.tyknij(GODZINA);
    await Promise.resolve();
    await Promise.resolve();

    expect(czuwaczOstrzezen.przebieg).toHaveBeenCalledTimes(1);
    expect(puls.ok).toHaveBeenCalledWith('czuwaczOstrzezen');
  });

  it('pominięty przebieg ostrzeżeń NIE bije pulsu i zostawia ślad w logu', async () => {
    const zegar = sztucznyZegar();
    const log = vi.fn();
    const puls = { ok: vi.fn(), blad: vi.fn() };
    const czuwaczOstrzezen = { przebieg: vi.fn().mockResolvedValue({ pominiety: true }) };

    uruchomZegary({
      poller: null, czuwaczKsef: null, czuwaczOstrzezen, ustawInterwal: zegar.ustaw, log, puls,
    });
    zegar.tyknij(GODZINA);
    await Promise.resolve();
    await Promise.resolve();

    expect(puls.ok).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/ostrzeżeń/));
  });

  it('awaria przebiegu ostrzeżeń bije puls błędu i ląduje w logu, nie kładzie procesu', async () => {
    const zegar = sztucznyZegar();
    const log = vi.fn();
    const puls = { ok: vi.fn(), blad: vi.fn() };
    const czuwaczOstrzezen = { przebieg: vi.fn().mockRejectedValue(new Error('inFakt 500')) };

    uruchomZegary({
      poller: null, czuwaczKsef: null, czuwaczOstrzezen, ustawInterwal: zegar.ustaw, log, puls,
    });
    expect(() => zegar.tyknij(GODZINA)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(puls.blad).toHaveBeenCalledWith('czuwaczOstrzezen', expect.any(Error));
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/ostrzeżeń/), 'inFakt 500');
  });
});

describe('zbudujOms — czuwacz ostrzeżeń (lustra tabelki strony głównej)', () => {
  it('przy inFakcie wstaje i jest oddany na zewnątrz', () => {
    const { czuwaczOstrzezen } = zbudujOms({ env: env(), createDpd: atrapaDpd() });
    expect(typeof czuwaczOstrzezen?.przebieg).toBe('function');
  });

  it('bez inFaktu czuwacza ostrzeżeń NIE MA', () => {
    const { czuwaczOstrzezen } = zbudujOms({ env: env({ INFAKT_API_KEY: undefined }), createDpd: atrapaDpd() });
    expect(czuwaczOstrzezen).toBeNull();
  });

  // Zgubione TUTAJ = czujka ślepa na stęchłe lustra: /health mówiłby „zdrowo" przy
  // czuwaczu, który nie przebiegł ani razu (ta sama klasa, co puls czuwacza KSeF).
  it('zdrowie zna zegar ostrzeżeń', () => {
    const { zdrowie } = zbudujOms({ env: env(), createDpd: atrapaDpd() });
    expect(zdrowie().czuwaczOstrzezen.wlaczony).toBe(true);
  });

  it('src/oms.js przekazuje czuwacza ostrzeżeń do zegarów', async () => { await wykonajZegary('czuwaczOstrzezen'); });
});

// ⚠️⚠️ W2a (recenzja Partii 1 Planu B): OKABLOWANIE ODSYLANIA STATUSU DO KANALU.
// Zmierzone przez recenzenta: usuniecie `klienciKanalow` z wywolania `createSyncSklep`
// w bootstrap.js zostawialo 4442/4442 testow na zielono. Na produkcji znaczyloby to, ze
// ZADEN status allegrowy nigdy nie jedzie — bez jednego bledu, bez jednego sladu, nie do
// odroznienia od poprawnego dzialania (usluga bez kanalow po prostu milczy, i to celowo,
// patrz komentarz przy `znaKanaly` w services/sync-sklep.js).
//
// Dokladnie ta cicha awaria, dla ktorej ten plik w ogole powstal (I1) — tyle ze o jeden
// argument glebiej. Dlatego test mierzy RUCH W SIECI, a nie ksztalt zwroconego obiektu.
describe('zbudujOms — status jedzie do KANAŁU (nie tylko do sklepu)', () => {
  const KANAL = {
    ALLEGRO_SZKICOWNIA_CLIENT_ID: 'id', ALLEGRO_SZKICOWNIA_CLIENT_SECRET: 'sekret',
    ALLEGRO_SZKICOWNIA_OD: '2026-07-01', ALLEGRO_SZKICOWNIA_API: 'https://api.allegro.test',
    ALLEGRO_USER_AGENT: UA,
  };

  // Allegro oddaje stan realizacji „NEW", wiec zamowienie oznaczone w panelu jako wyslane
  // MA doprowadzic do zapisu (PUT .../fulfillment). Wszystko inne (sklep Woo) — pusto.
  const atrapaAllegro = () => {
    const zapytania = [];
    return {
      zapytania,
      fetchImpl: vi.fn(async (url, opcje = {}) => {
        zapytania.push({ url: String(url), metoda: opcje.method ?? 'GET' });
        if (String(url).startsWith('https://api.allegro.test')) {
          return { ok: true, status: 200, json: async () => ({ fulfillment: { status: 'NEW' } }) };
        }
        return { ok: true, status: 200, json: async () => [], headers: { get: () => '1' } };
      }),
    };
  };

  const zamowienieZKanalu = (db) => {
    db.prepare(
      "INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, utworzone_at, wyslane_at)"
      + " VALUES ('allegro_szkicownia', 'CF-77', 'ALG-77', '129.00', '2026-08-05T09:00:00', '2026-08-05T12:00:00')",
    ).run();
    return db.prepare("SELECT id FROM zamowienia WHERE zrodlo_id = 'CF-77'").get().id;
  };

  const zTokenami = (db) => zapiszTokeny(db, 'allegro_szkicownia', {
    accessToken: 'ACCESS',
    refreshToken: 'REFRESH',
    wygasaAt: new Date(Date.now() + 3600_000).toISOString(),
    refreshWygasaAt: new Date(Date.now() + 80 * 86400_000).toISOString(),
  });

  it('usługa sync dostaje klientów kanałów — status naprawdę leci do Allegro', async () => {
    const { zapytania, fetchImpl } = atrapaAllegro();
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const { db, syncSklep } = zbudujOms({ env: env(KANAL), createDpd: atrapaDpd() });
      zTokenami(db);
      const id = zamowienieZKanalu(db);

      const wynik = await syncSklep.odeslijStatus(id);

      expect(wynik.wyslany).toBe('SENT');
      const zapis = zapytania.find((z) => z.metoda === 'PUT');
      expect(zapis).toBeTruthy();
      expect(zapis.url).toBe('https://api.allegro.test/order/checkout-forms/CF-77/fulfillment');
    } finally { vi.unstubAllGlobals(); }
  });

  // ⚠️ SAME KANALY, BEZ ANI JEDNEGO SKLEPU. Do Planu B usluga powstawala wylacznie przy
  // `jestSklep`, wiec panel z samym Allegro dostawalby `null` i status nie jechalby NIGDZIE.
  // Warunek w bootstrap.js obejmuje teraz kanaly — i to jest test dokladnie na to.
  it('panel z samym Allegro (zero sklepów) też odsyła status', async () => {
    const { zapytania, fetchImpl } = atrapaAllegro();
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const bezSklepu = env(KANAL);
      delete bezSklepu.SHOP_PRO_URL;
      delete bezSklepu.SHOP_PRO_CK;
      delete bezSklepu.SHOP_PRO_CS;

      const { db, syncSklep } = zbudujOms({ env: bezSklepu, createDpd: atrapaDpd() });
      expect(syncSklep).not.toBeNull();
      zTokenami(db);
      const id = zamowienieZKanalu(db);

      expect((await syncSklep.odeslijStatus(id)).wyslany).toBe('SENT');
      expect(zapytania.some((z) => z.metoda === 'PUT')).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
});

// Czuwacz KSeF (Plan B, Zadanie 7). Chodzi CO GODZINE, CALA DOBE — wiec panel, ktory nie ma
// go po co uruchamiac, nie ma prawa dostac tego zegara wcale. `null` znaczy „nie ma czuwacza",
// a nie „czuwacz bez roboty": bez kanalu Allegro nie ma po co pytac, bez inFaktu nie ma czego.
describe('zbudujOms — czuwacz KSeF', () => {
  const KANAL_KSEF = {
    ALLEGRO_SZKICOWNIA_CLIENT_ID: 'id', ALLEGRO_SZKICOWNIA_CLIENT_SECRET: 'sekret',
    ALLEGRO_SZKICOWNIA_OD: '2026-07-01', ALLEGRO_SZKICOWNIA_API: 'https://api.allegro.test',
    ALLEGRO_USER_AGENT: UA,
  };

  it('przy kanale Allegro i inFakcie czuwacz wstaje', () => {
    const { czuwaczKsef } = zbudujOms({ env: env(KANAL_KSEF), createDpd: atrapaDpd() });
    expect(czuwaczKsef).not.toBeNull();
    expect(typeof czuwaczKsef.przebieg).toBe('function');
  });

  // Panel bez zmiennych ALLEGRO_* ma wstawac DOKLADNIE tak jak dotad — ani jednego
  // dodatkowego zegara w tle.
  it('bez kanału Allegro czuwacza NIE MA', () => {
    expect(zbudujOms({ env: env(), createDpd: atrapaDpd() }).czuwaczKsef).toBeNull();
  });

  it('bez inFaktu czuwacza NIE MA', () => {
    const bezInfaktu = env(KANAL_KSEF);
    delete bezInfaktu.INFAKT_API_KEY;
    expect(zbudujOms({ env: bezInfaktu, createDpd: atrapaDpd() }).czuwaczKsef).toBeNull();
  });

  // ⚠️⚠️ OKABLOWANIE DRUGIEJ PETLI (Zadanie 10). Czuwacz dostal drugi krok — odczyt wyniku
  // weryfikacji pliku po stronie Allegro — a ten krok potrzebuje KLIENTOW KANALOW. Bez nich
  // petla wykonuje sie w calosci i nie robi NIC: `klienciKanalow[f.sklep]` jest `undefined`,
  // wiec kazda faktura wypada na `continue`. Zadna suita jednostkowa tego nie zlapie (tam
  // klienci sa wstrzykiwani wprost), a na produkcji REJECTED nie zapalilby sie NIGDY —
  // czyli panel twierdzilby, ze kupujacy ma fakture, ktorej nie ma. To ta sama klasa awarii,
  // co I1 na gorze tego pliku: modul zbudowany, przetestowany i bez ani jednego wywolania.
  //
  // Podmieniamy metode NA ZWROCONYM KLIENCIE: jesli czuwacz dostal TEN OBIEKT, podmiana go
  // dosiegnie. Jesli nie dostal nic — kolumna zostanie nietknieta i test padnie.
  it('czuwacz dostaje klientów kanałów — inaczej druga pętla nie ma kogo zapytać', async () => {
    const {
      czuwaczKsef, klienciKanalow, db, infakt,
    } = zbudujOms({
      env: env(KANAL_KSEF), createDpd: atrapaDpd(),
    });
    klienciKanalow.allegro_szkicownia.pobierzFakturyZamowienia = async () => [
      { id: 'INV-1', file: { securityVerification: { status: 'REJECTED' } } },
    ];
    // ⚠️ Krok 3 przebiegu (lustro luk KSeF, 2026-08-29) woła `listaFaktur` przy KAŻDYM
    // przebiegu — stub trzyma ten test z dala od sieci, tak samo jak stub wyżej trzyma
    // drugą pętlę z dala od Allegro.
    infakt.listaFaktur = async () => [];
    const id = zapiszZamowienie(db, 'allegro_szkicownia', {
      zrodlo_id: 'CF-WERYF', numer: '4100', klient: { first_name: 'Jan' }, dostawa: {}, pozycje: [],
      metoda_wysylki: 'dpd', kwota_pobrania: null, nip: null, koszt_dostawy_brutto: '0.00',
      status_woo: 'processing', oplacone_at: null, anulowane: 0,
      kwota_brutto: '100.00', chce_fakture: 1, utworzone_at: '2026-08-05T09:00:00',
    }, {});
    // ⚠️ `ksef_numer` WYPELNIONY i `allegro_wyslana_at` WYPELNIONE — czyli faktura wypada
    // z PIERWSZEJ petli. Bez tego przebieg poszedlby do prawdziwego inFaktu przez siec.
    db.prepare(
      'INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, ksef_numer, allegro_invoice_id,'
      + ' allegro_wyslana_at, allegro_weryfikacja, utworzona_at) VALUES (?,?,?,?,?,?,?,?)',
    ).run(id, 'u1', 'FV/9/2026', 'KS-1', 'INV-1', new Date().toISOString(), 'WAITING', new Date().toISOString());

    await czuwaczKsef.przebieg();

    expect(db.prepare('SELECT allegro_weryfikacja FROM faktury WHERE zamowienie_id = ?').get(id)
      .allegro_weryfikacja).toBe('REJECTED');
  });
});

// ⚠️⚠️ AUTOMAT MUSI BYĆ OKABLOWANY, A NIE TYLKO NAPISANY (Partia 4, 2026-08-07).
//
// Testy jednostkowe czuwacza wstrzykują usługę wysyłki WPROST, więc przechodzą nawet wtedy,
// gdy bootstrap jej nie podaje — czyli gdy automat na produkcji nie odpala się NIGDY. To ta
// sama klasa błędu, którą recenzja Planu A złapała przy device flow: kod zbudowany,
// przetestowany i bez ani jednego wywołania.
describe('zbudujOms — okablowanie automatu wysyłki faktury do Allegro', () => {
  const KANAL = {
    ALLEGRO_SZKICOWNIA_CLIENT_ID: 'id', ALLEGRO_SZKICOWNIA_CLIENT_SECRET: 'sekret',
    ALLEGRO_SZKICOWNIA_OD: '2026-07-01', ALLEGRO_SZKICOWNIA_API: 'https://api.allegro.test',
    ALLEGRO_USER_AGENT: UA,
  };

  it('czuwacz dostaje TĘ SAMĄ usługę wysyłki, którą panel wystawia na karcie', () => {
    let dostal = 'NIE-ZBUDOWANO';
    const oms = zbudujOms({
      env: env(KANAL),
      createDpd: atrapaDpd(),
      createCzuwacz: (args) => { dostal = args.fakturaAllegro; return { przebieg: async () => ({}) }; },
    });
    expect(dostal).not.toBe('NIE-ZBUDOWANO');
    // ⚠️ TA SAMA INSTANCJA, nie „jakaś usługa": przycisk na karcie i automat mają iść jedną
    // ścieżką, razem z jej zamkiem na duplikat. Druga instancja miałaby własny stan.
    expect(dostal).toBe(oms.fakturaAllegro);
    expect(typeof dostal.wyslij).toBe('function');
  });

  // Panel bez kanału Allegro nie dostaje ani czuwacza, ani usługi — i to nie jest brak,
  // tylko poprawna odpowiedź: faktura ze sklepu nie ma dokąd pojechać.
  it('bez kanału Allegro nie ma ani czuwacza, ani usługi wysyłki', () => {
    const oms = zbudujOms({ env: env(), createDpd: atrapaDpd() });
    expect(oms.czuwaczKsef).toBeNull();
    expect(oms.fakturaAllegro).toBeNull();
  });
});

// ⚠️⚠️ OKABLOWANIE KURIERA „Wysyłam z Allegro" (11.08.2026). Osobny opis, bo mutacja
// kasująca podpięcie `allegro_wza` do mapy kurierów PRZEŻYŁA pełną suitę 5235 testów —
// dokładnie ta klasa błędu, która w tym projekcie przeszła już dwa razy (device flow bez
// ani jednego wywołania, zegar czuwacza w martwej gałęzi). Testy samego adaptera niczego
// tu nie dowodzą: wstrzykują go wprost.
describe('zbudujOms — kurier Wysyłam z Allegro', () => {
  const KANAL_WZA = {
    ALLEGRO_SZKICOWNIA_CLIENT_ID: 'id', ALLEGRO_SZKICOWNIA_CLIENT_SECRET: 'sekret',
    ALLEGRO_SZKICOWNIA_OD: '2026-07-01', ALLEGRO_SZKICOWNIA_API: 'https://api.allegro.test',
    ALLEGRO_USER_AGENT: UA,
  };

  it('przy kanale Allegro podpina kuriera allegro_wza do mapy kurierów', () => {
    const utworzone = [];
    const { nadanie } = zbudujOms({
      env: env(KANAL_WZA),
      createDpd: atrapaDpd(),
      createAllegroWza: (opcje) => { utworzone.push(opcje); return { nadaj: vi.fn(), sprawdzPrzesylke: vi.fn() }; },
    });
    expect(nadanie).not.toBeNull();
    expect(utworzone).toHaveLength(1);
    // Nadanie dostaje mapę kurierów w domknięciu, więc pytamy przez zachowanie: metoda
    // `allegro_dpd` ma NIE odbić się od „kurier nie jest skonfigurowany".
    expect(utworzone[0].allegroDla).toBeTypeOf('function');
    expect(utworzone[0].metodaZywa).toBeTypeOf('function');
  });

  // ⚠️⚠️ TEN TEST JEST TU DLATEGO, ŻE POPRZEDNI NIE WYSTARCZYŁ. Mutacja kasująca wpis
  // `allegro_wza` w mapie kurierów przeżyła i jego, i całą suitę: fabryka była wołana,
  // tylko jej wynik szedł do kosza. Pytamy więc o ZACHOWANIE — czy nadanie allegrowego
  // zamówienia naprawdę trafia do tego kuriera.
  it('kurier allegro_wza jest w mapie — nadanie allegro_dpd trafia do NIEGO', async () => {
    const nadajWza = vi.fn().mockResolvedValue({
      shipmentId: 'cmd-1', numerListu: 'AD0TEST', wTrakcieTworzenia: false,
      etykietaPdf: Buffer.from('%PDF-1.4'), etykietaZpl: null, surowa: null,
    });
    const { db, nadanie } = zbudujOms({
      env: env(KANAL_WZA),
      createDpd: atrapaDpd(),
      createAllegroWza: () => ({ nadaj: nadajWza, sprawdzPrzesylke: vi.fn() }),
    });
    const id = zapiszZamowienie(db, 'allegro_szkicownia', {
      zrodlo_id: 'ord-1', numer: 'A-1', klient: { first_name: 'Jan', email: 'j@k.pl' },
      dostawa: { city: 'Pęki' }, pozycje: [], metoda_wysylki: 'allegro_dpd',
      kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '99.00',
      status_woo: null, oplacone_at: null, anulowane: 0, utworzone_at: '2026-08-11T08:00:00',
    }, {});
    await nadanie.nadaj(id, { waga: 1, dlugosc: 10, szerokosc: 10, wysokosc: 10 });
    expect(nadajWza).toHaveBeenCalledTimes(1);
  });

  // Bez kanału Allegro kuriera nie ma — i to jest poprawne: nie ma konta, na którym
  // miałby cokolwiek kupić. Odmowa pada wtedy przy konkretnym zamówieniu, głośno.
  it('bez kanału Allegro kuriera nie tworzy w ogóle', () => {
    const utworzone = [];
    zbudujOms({
      env: env(),
      createDpd: atrapaDpd(),
      createAllegroWza: (o) => { utworzone.push(o); return {}; },
    });
    expect(utworzone).toHaveLength(0);
  });

  // ⚠️ KONTO PER KANAŁ. Kanały Allegro to osobne konta — jeden klient na całą usługę
  // znaczyłby paczkę kupioną na cudzej umowie, a etykieta i tak by powstała.
  it('allegroDla wybiera klienta po kanale zamówienia, a nie pierwszego z brzegu', () => {
    const utworzone = [];
    zbudujOms({
      env: env({
        ...KANAL_WZA,
        ALLEGRO_AMARKA_CLIENT_ID: 'id2', ALLEGRO_AMARKA_CLIENT_SECRET: 'sekret2',
        ALLEGRO_AMARKA_OD: '2026-07-01', ALLEGRO_AMARKA_API: 'https://api2.allegro.test',
      }),
      createDpd: atrapaDpd(),
      createAllegroWza: (o) => { utworzone.push(o); return {}; },
    });
    const { allegroDla } = utworzone[0];
    const a = allegroDla({ sklep: 'allegro_szkicownia' });
    const b = allegroDla({ sklep: 'allegro_amarka' });
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
    // Kanał nieznany to ODMOWA, nie cicha podmiana konta.
    expect(() => allegroDla({ sklep: 'pro' })).toThrow(/nie jest podpięty/i);
  });
});

// ⚠️⚠️ OKABLOWANIE CZUWACZA KOSZTOW (zakladka KOSZTY, faktury z KSeF, na ktorych jestesmy
// NABYWCA). Ten test jest OBOWIAZKOWY i nie jest powtorzeniem testow jednostkowych czuwacza:
// tamte wstrzykuja klienta i sesje WPROST, wiec przeszlyby co do jednego takze wtedy, gdyby
// bootstrap w ogole tego czuwacza nie zbudowal albo zbudowal go bez sesji. To ta sama klasa
// bledu, ktora recenzja Planu A zlapala przy device flow (kod zbudowany, przetestowany i bez
// ani jednego wywolania) i ktora w tym pliku ma juz trzy wlasne opisy.
//
// ⚠️ TO NIE JEST `czuwaczKsef` WYZEJ. Tamten pyta inFakt o numer KSeF NASZEJ faktury
// sprzedazowej; ten pobiera z KSeF faktury KOSZTOWE. Dwa czuwacze, dwa zrodla, dwa kierunki.
describe('zbudujOms — czuwacz kosztów (KSeF)', () => {
  const KSEF = { KSEF_TOKEN: 'TOKEN-KSEF', KSEF_NIP: '1234563218' };

  it('przy sekcji ksef czuwacz kosztów wstaje', () => {
    const { czuwaczKosztow } = zbudujOms({ env: env(KSEF), createDpd: atrapaDpd() });
    expect(czuwaczKosztow).not.toBeNull();
    expect(typeof czuwaczKosztow.przebieg).toBe('function');
  });

  // Panel bez KSEF_TOKEN ma wstawać DOKŁADNIE jak dotąd — ani jednego dodatkowego zegara.
  it('bez KSEF_TOKEN czuwacza kosztów NIE MA', () => {
    expect(zbudujOms({ env: env(), createDpd: atrapaDpd() }).czuwaczKosztow).toBeNull();
  });

  it('czuwacz kosztów dostaje sesję I klienta KSeF, a nie samą bazę', () => {
    let dostal = null;
    const oms = zbudujOms({
      env: env(KSEF),
      createDpd: atrapaDpd(),
      createCzuwaczKosztow: (args) => { dostal = args; return { przebieg: async () => ({}) }; },
    });
    expect(dostal).not.toBeNull();
    expect(dostal.db).toBe(oms.db);
    // Bez klienta nie ma czego pytać, bez sesji nie ma czym — a brak KTÓREJKOLWIEK z tych
    // dwóch rzeczy objawia się dopiero w nocy, jako pusta zakładka kosztów.
    expect(typeof dostal.klient.pobierzMetadane).toBe('function');
    expect(typeof dostal.sesja.accessToken).toBe('function');
  });

  // ⚠️⚠️ JEDEN KLIENT NA CAŁĄ USŁUGĘ. Sesja i czuwacz mają dzielić TĘ SAMĄ instancję: drugi
  // klient znaczyłby drugie pełne logowanie, a `/auth/token/redeem` działa TYLKO RAZ —
  // spalenie go na drugiej instancji zostawia panel bez dostępu do KSeF aż do ręcznej
  // interwencji. Ta sama lekcja, co przy parze tokenów Allegro (jeden `createTokeny` na kanał).
  it('klient KSeF powstaje RAZ i tę samą instancję dostaje czuwacz', () => {
    const utworzone = [];
    let dostal = null;
    zbudujOms({
      env: env(KSEF),
      createDpd: atrapaDpd(),
      createKsefKlient: (opcje) => {
        const k = {
          opcje, zaloguj: async () => ({}), odswiez: async () => ({}), pobierzMetadane: async () => ({}),
        };
        utworzone.push(k);
        return k;
      },
      createCzuwaczKosztow: (args) => { dostal = args; return { przebieg: async () => ({}) }; },
    });
    expect(utworzone).toHaveLength(1);
    expect(dostal.klient).toBe(utworzone[0]);
    expect(utworzone[0].opcje).toMatchObject({
      token: 'TOKEN-KSEF', nip: '1234563218', baseUrl: 'https://api.ksef.mf.gov.pl/v2',
    });
  });

  // ⚠️⚠️ ÓSMA DROGA TEJ SAMEJ DZIURY (Zadanie 12). `services/wizualizacja-kosztu.js` powstałby
  // zbudowany, przetestowany i BEZ ANI JEDNEGO WOŁAJĄCEGO w `src/`, gdyby zabrakło jednej
  // linijki w bootstrapie albo jednego argumentu `buildOmsServer` — objaw: przycisk „PDF"
  // na zakładce KOSZTY oddaje 503 MIMO skonfigurowanego KSeF, a cała suita świeci na zielono.
  it('podpięty KSeF dociera do trasy GET /koszty/:ksef/pdf (żywy dokument, nie 503)', async () => {
    const { app } = zbudujOms({
      env: env(KSEF),
      createDpd: atrapaDpd(),
      createKsefKlient: () => ({}),
      createCzuwaczKosztow: () => ({ przebieg: async () => ({}) }),
      createWizualizacjaKosztuFn: () => ({
        pdf: async () => ({ wiersz: { numer_dokumentu: 'FV/1' }, bajty: Buffer.from('%PDF-1.3 tresc') }),
      }),
    });
    await app.ready();
    const r = await app.inject({
      method: 'GET',
      url: '/koszty/K-1/pdf',
      headers: { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64') },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
  });

  // ⚠️⚠️ JEDNA SESJA NA CAŁY PANEL. Czuwacz i wizualizacja na żądanie mają dzielić TĘ SAMĄ
  // sesję: druga instancja to druga para tokenów w pamięci procesu i DWA niezależne
  // odświeżenia tego samego, jednorazowego refresh tokenu — czyli panel bez dostępu do KSeF
  // do ręcznej interwencji. Ta sama lekcja, co przy kliencie wyżej.
  it('wizualizacja kosztu dostaje TĘ SAMĄ sesję i tego samego klienta, co czuwacz', () => {
    let uCzuwacza = null;
    let uWizualizacji = null;
    const oms = zbudujOms({
      env: env(KSEF),
      createDpd: atrapaDpd(),
      createCzuwaczKosztow: (args) => { uCzuwacza = args; return { przebieg: async () => ({}) }; },
      createWizualizacjaKosztuFn: (args) => { uWizualizacji = args; return { pdf: async () => ({}) }; },
    });
    expect(uWizualizacji).not.toBeNull();
    expect(uWizualizacji.db).toBe(oms.db);
    expect(uWizualizacji.klient).toBe(uCzuwacza.klient);
    expect(uWizualizacji.sesja).toBe(uCzuwacza.sesja);
  });

  // Panel bez sekcji KSEF_* wstaje dokładnie jak dotąd — przycisku „PDF" wtedy nie ma.
  it('bez KSEF_TOKEN wizualizacji kosztu NIE MA', () => {
    expect(zbudujOms({ env: env(), createDpd: atrapaDpd() }).wizualizacjaKosztu).toBeNull();
  });

  // ⚠️⚠️ ARCHIWUM XML MA WOŁAJĄCEGO — I TEN TEST JEST JEDYNYM MIEJSCEM, KTÓRE TEGO PILNUJE.
  // `services/archiwum-kosztow.js` powstał przetestowany i przez cały Etap bez ANI JEDNEGO
  // wołającego w `src/` — dokładnie ta klasa cichej dziury, którą to repo złapało już
  // sześciokrotnie (device flow, `fakturaAllegro`, `fakturyWidok`, `sklepy` u magazynu,
  // `czuwaczKosztow` u serwera). Testy jednostkowe czuwacza wstrzykują katalog i atrapę
  // archiwum WPROST, więc przeszłyby co do jednego także wtedy, gdyby bootstrap nigdy nie
  // podał czuwaczowi ścieżki — objawem byłoby puste archiwum na NAS-ie przy zielonej suicie.
  it('czuwacz kosztów dostaje ścieżkę archiwum z KSEF_ARCHIWUM', () => {
    let dostal = null;
    zbudujOms({
      env: env({ ...KSEF, KSEF_ARCHIWUM: '/data-oms/faktury-kosztowe' }),
      createDpd: atrapaDpd(),
      createCzuwaczKosztow: (args) => { dostal = args; return { przebieg: async () => ({}) }; },
    });
    expect(dostal.katalogArchiwum).toBe('/data-oms/faktury-kosztowe');
  });

  // ⚠️ BRAK ŚCIEŻKI NIE MA PRAWA NICZEGO ZATRZYMAĆ. Archiwum XML jest DODATKIEM do lustra
  // w bazie, a nie źródłem prawdy panelu: bez `KSEF_ARCHIWUM` czuwacz wstaje, pobiera koszty
  // i po prostu nie zapisuje plików.
  it('bez KSEF_ARCHIWUM czuwacz kosztów wstaje i dostaje pustą ścieżkę', () => {
    let dostal = null;
    const { czuwaczKosztow } = zbudujOms({
      env: env(KSEF),
      createDpd: atrapaDpd(),
      createCzuwaczKosztow: (args) => { dostal = args; return { przebieg: async () => ({}) }; },
    });
    expect(czuwaczKosztow).not.toBeNull();
    expect(dostal.katalogArchiwum).toBeNull();
  });

  // ⚠️ TEST PO ŹRÓDLE, I WIEM, CO O NICH MÓWI RESZTA TEGO PLIKU — grep nie widzi osiągalności
  // gałęzi. Tutaj nie ma jednak czego wykonać: `src/oms.js` woła `app.listen`, więc jego
  // uruchomienie w suicie znaczyłoby otwarty port. Sprawdzenie jest za to ostre: czuwacz
  // zbudowany w `zbudujOms` i NIEPRZEKAZANY do `uruchomZegary` to usługa, która nie chodzi
  // ani razu — dokładnie awaria, którą ten projekt zaliczył już przy device flow.
  it('punkt wejścia przekazuje czuwacza kosztów do zegarów', async () => { await wykonajZegary('czuwaczKosztow'); });
});

// ⚠️⚠️ ZEGAR CZUWACZA KOSZTOW. Chodzi na TYM SAMYM zegarze godzinowym, co czuwacz KSeF —
// bo o porze decyduje sam czuwacz (domain/pora-pobrania.js), a okno godzinowe w bootstrapie
// byloby DRUGIM miejscem liczacym czas Warszawy.
describe('uruchomZegary — czuwacz kosztów', () => {
  const sztucznyZegar = () => {
    const zarejestrowane = [];
    const ustaw = (fn, ms) => { zarejestrowane.push({ fn, ms }); return zarejestrowane.length; };
    const tyknij = (ms) => zarejestrowane.filter((z) => z.ms === ms).forEach((z) => z.fn());
    return { zarejestrowane, ustaw, tyknij };
  };
  const GODZINA = 60 * 60 * 1000;
  const odczekaj = async () => {
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  };

  it('po godzinie woła przebieg czuwacza kosztów DOKŁADNIE raz', async () => {
    const zegar = sztucznyZegar();
    const czuwaczKosztow = { przebieg: vi.fn().mockResolvedValue({ nowych: 0, przeczytanych: 0, okien: 1 }) };

    uruchomZegary({
      poller: null, czuwaczKsef: null, czuwaczKosztow, ustawInterwal: zegar.ustaw,
    });
    zegar.tyknij(GODZINA);
    await odczekaj();

    expect(zegar.zarejestrowane.map((z) => z.ms)).toEqual([GODZINA]);
    expect(czuwaczKosztow.przebieg).toHaveBeenCalledTimes(1);
  });

  it('bez sekcji ksef zegar czuwacza kosztów NIE powstaje', () => {
    const zegar = sztucznyZegar();
    uruchomZegary({
      poller: null, czuwaczKsef: null, czuwaczKosztow: null, ustawInterwal: zegar.ustaw,
    });
    expect(zegar.zarejestrowane).toEqual([]);
  });

  // ⚠️ ODRZUCONA OBIETNICA W `setInterval` KŁADZIE CAŁY PROCES OMS-u — w środku nocy,
  // z powodu jednej odmowy KSeF.
  it('awaria pobrania nie kładzie procesu, tylko ląduje w logu', async () => {
    const zegar = sztucznyZegar();
    const log = vi.fn();
    const czuwaczKosztow = { przebieg: vi.fn().mockRejectedValue(new Error('KSeF odmówił')) };

    uruchomZegary({
      poller: null, czuwaczKsef: null, czuwaczKosztow, ustawInterwal: zegar.ustaw, log,
    });
    expect(() => zegar.tyknij(GODZINA)).not.toThrow();
    await odczekaj();

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/koszt/i), 'KSeF odmówił');
  });

  // ⚠️⚠️ POMINIECIE „POPRZEDNI PRZEBIEG TRWA" MUSI ZOSTAWIC SLAD — to ta sama awaria (W5),
  // co przy czuwaczu KSeF: przebieg NIE ODRZUCA, więc `.catch` nic nie łapie, a czuwacz po
  // cichu przestaje chodzić. Tutaj stawka jest wyższa: okno pobrania jest raz na dobę, więc
  // zgubione tyknięcie to CAŁA DOBA bez kosztów.
  it('pominięcie „poprzedni przebieg trwa" ZOSTAWIA ŚLAD w logu', async () => {
    const zegar = sztucznyZegar();
    const log = vi.fn();
    const czuwaczKosztow = { przebieg: vi.fn().mockResolvedValue({ pominiety: true, powod: POWOD_TRWA }) };

    uruchomZegary({
      poller: null, czuwaczKsef: null, czuwaczKosztow, ustawInterwal: zegar.ustaw, log,
    });
    zegar.tyknij(GODZINA);
    await odczekaj();

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/koszt/i));
  });

  // ⚠️⚠️ DRUGA POLOWA, I TO ONA JEST TU WAZNIEJSZA: pominięcie „NIE TA PORA" zdarza się
  // 23 RAZY NA DOBĘ i JEST STANEM POPRAWNYM. Logowanie go dałoby 23 wiersze dziennie,
  // w których utonęłaby prawdziwa awaria — log rośnie od ZDARZEŃ, nie od PRZEBIEGÓW.
  it('pominięcie „nie ta pora" NIE loguje niczego', async () => {
    const zegar = sztucznyZegar();
    const log = vi.fn();
    const czuwaczKosztow = { przebieg: vi.fn().mockResolvedValue({ pominiety: true, powod: POWOD_NIE_TA_PORA }) };

    uruchomZegary({
      poller: null, czuwaczKsef: null, czuwaczKosztow, ustawInterwal: zegar.ustaw, log,
    });
    zegar.tyknij(GODZINA);
    await odczekaj();

    expect(log).not.toHaveBeenCalled();
  });

  it('udane pobranie bez odrzuceń NIE loguje niczego', async () => {
    const zegar = sztucznyZegar();
    const log = vi.fn();
    const czuwaczKosztow = {
      przebieg: vi.fn().mockResolvedValue({
        nowych: 3, przeczytanych: 9, odrzuconych: 0, okien: 2,
      }),
    };

    uruchomZegary({
      poller: null, czuwaczKsef: null, czuwaczKosztow, ustawInterwal: zegar.ustaw, log,
    });
    zegar.tyknij(GODZINA);
    await odczekaj();

    expect(log).not.toHaveBeenCalled();
  });

  // ⚠️ ODRZUCONY DOKUMENT TO ZDARZENIE, A NIE PRZEBIEG — i jedyne, o którym warto krzyknąć
  // z zegara. Trwały ślad leży w tabeli `koszty_odrzucone`, ale wpis w logu kontenera jest
  // tym, co w ogóle każe komuś tam zajrzeć.
  it('odrzucony dokument ZOSTAWIA ŚLAD w logu', async () => {
    const zegar = sztucznyZegar();
    const log = vi.fn();
    const czuwaczKosztow = {
      przebieg: vi.fn().mockResolvedValue({
        nowych: 2, przeczytanych: 3, odrzuconych: 1, okien: 1,
      }),
    };

    uruchomZegary({
      poller: null, czuwaczKsef: null, czuwaczKosztow, ustawInterwal: zegar.ustaw, log,
    });
    zegar.tyknij(GODZINA);
    await odczekaj();

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/odrzuc/i));
  });

  // Przebieg przerwany na suficie stron nic nie gubi (kursor stoi na ostatnim przeczytanym
  // dokumencie), ale znaczy, że suma miesiąca jest jeszcze NIEPEŁNA — czyli że następny
  // przebieg jest potrzebny, a nie rutynowy. To zdarzenie, nie przebieg.
  it('niedokończone pobranie ZOSTAWIA ŚLAD w logu', async () => {
    const zegar = sztucznyZegar();
    const log = vi.fn();
    const czuwaczKosztow = {
      przebieg: vi.fn().mockResolvedValue({
        nowych: 50, przeczytanych: 50, odrzuconych: 0, niedokonczone: true, okien: 3,
      }),
    };

    uruchomZegary({
      poller: null, czuwaczKsef: null, czuwaczKosztow, ustawInterwal: zegar.ustaw, log,
    });
    zegar.tyknij(GODZINA);
    await odczekaj();

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/NIEDOKOŃCZONE/));
  });
});

// ⚠️⚠️ DZIEWIATA DROGA TEJ SAMEJ DZIURY. `services/czuwacz-archiwum-sprzedazy.js` powstal
// przetestowany jednostkowo i — jak `archiwum-kosztow.js` przed nim — bez ANI JEDNEGO
// wolajacego w `src/`. Testy czuwacza wstrzykuja `db`, `infakt` i `katalogArchiwum` WPROST,
// wiec przeszlyby co do jednego takze wtedy, gdyby bootstrap nigdy go nie zbudowal albo
// zbudowal i nie podal zegarom. Objawem bylby PUSTY katalog na NAS-ie przy zielonej suicie —
// czyli nie do odroznienia od „jeszcze nie bylo sprzedazy".
describe('zbudujOms — czuwacz archiwum sprzedazy (inFakt)', () => {
  it('z INFAKT_ARCHIWUM czuwacz archiwum sprzedazy powstaje i dostaje katalog oraz klienta inFaktu', () => {
    let dostal = null;
    const { czuwaczArchiwumSprzedazy } = zbudujOms({
      env: env({ INFAKT_ARCHIWUM: '/faktury' }),
      createDpd: atrapaDpd(),
      createCzuwaczArchiwumSprzedazy: (args) => { dostal = args; return { przebieg: async () => ({}) }; },
    });
    expect(czuwaczArchiwumSprzedazy).not.toBeNull();
    expect(dostal.katalogArchiwum).toBe('/faktury');
    expect(dostal.db).toBeDefined();
    expect(typeof dostal.infakt.pobierzPdf).toBe('function');
  });

  // Brak `INFAKT_ARCHIWUM` to tryb POPRAWNY, a nie awaria: bez katalogu nie ma czego
  // archiwizowac, wiec czuwacz nie powstaje wcale (i zegar sie nie rejestruje).
  it('bez INFAKT_ARCHIWUM czuwacz archiwum sprzedazy NIE powstaje', () => {
    const { czuwaczArchiwumSprzedazy } = zbudujOms({ env: env(), createDpd: atrapaDpd() });
    expect(czuwaczArchiwumSprzedazy).toBeNull();
  });
});

// ⚠️⚠️ ZEGAR #7 — czuwacz archiwum sprzedazy. Ten sam zegar godzinowy, co przy czuwaczu
// kosztow, i z dokladnie tego samego powodu: o porze decyduje SAM czuwacz
// (`GODZINA_ARCHIWUM_SPRZEDAZY`), a okno zbudowane tutaj byloby DRUGIM miejscem w kodzie
// liczacym czas Warszawy.
describe('uruchomZegary — czuwacz archiwum sprzedazy', () => {
  // ⚠️ CIALO ZEGARA NIE ODDAJE OBIETNICY (i nie ma oddawac — `setInterval` i tak by jej nie
  // czekal), wiec samo `await fn()` przepuszcza JEDEN takt mikrozadan. Sciezka bledu ma dwa
  // ogniwa (`.then` pomija, `.catch` lapie), stad jawne przemielenie kolejki — ta sama
  // sztuczka, co `odczekaj()` przy czuwaczu kosztow wyzej.
  const przemiel = async () => {
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  };

  it('uruchomZegary rejestruje zegar archiwum sprzedazy co godzine i wola przebieg', async () => {
    const interwaly = [];
    let wolan = 0;
    uruchomZegary({
      czuwaczArchiwumSprzedazy: { przebieg: async () => { wolan += 1; return {}; } },
      ustawInterwal: (fn, ms) => { interwaly.push({ fn, ms }); return 0; },
      log: () => {},
    });
    const z = interwaly.find((i) => i.ms === ODSTEP_CZUWACZA_MS);
    expect(z).toBeDefined();
    await z.fn();
    expect(wolan).toBe(1);
  });

  // ⚠️ POMINIECIE NIE ODRZUCA — oddaje `{ pominiety: true }`, wiec `.catch` nic tu nie lapie.
  // To jest awaria W5 z czuwacza KSeF, tylko drozsza: okno archiwizacji jest raz na dobe,
  // wiec zgubione tykniecie to CALA DOBA bez PDF-ow. Logujemy WYLACZNIE `POWOD_TRWA`:
  // „nie ta pora" zdarza sie 23 razy na dobe i jest stanem poprawnym.
  it('pominiecie „poprzedni przebieg jeszcze trwa" zostawia slad w logu', async () => {
    const interwaly = [];
    const log = vi.fn();
    uruchomZegary({
      czuwaczArchiwumSprzedazy: {
        przebieg: async () => ({ pominiety: true, powod: POWOD_TRWA_ARCHIWUM_SPRZEDAZY }),
      },
      ustawInterwal: (fn, ms) => { interwaly.push({ fn, ms }); return 0; },
      log,
    });
    interwaly.find((i) => i.ms === ODSTEP_CZUWACZA_MS).fn();
    await przemiel();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/archiwum sprzedaży/), expect.anything());
  });

  // ⚠️⚠️ BEZ TEGO TESTU POPRZEDNI JEST FALSZYWA ZIELENIA: przeszedlby tak samo, gdyby zegar
  // logowal KAZDE pominiecie. „Nie ta pora" zdarza sie 23 razy na dobe i jest stanem
  // POPRAWNYM — 23 wiersze dziennie w logu kontenera to miejsce, w ktorym utonie ta jedna
  // linia, ktora naprawde znaczy awarie.
  it('⚠️ pominiecie „nie ta pora" NIE trafia do logu (23 razy na dobe, stan poprawny)', async () => {
    const interwaly = [];
    const log = vi.fn();
    uruchomZegary({
      czuwaczArchiwumSprzedazy: {
        przebieg: async () => ({ pominiety: true, powod: POWOD_NIE_TA_PORA_ARCHIWUM_SPRZEDAZY }),
      },
      ustawInterwal: (fn, ms) => { interwaly.push({ fn, ms }); return 0; },
      log,
    });
    interwaly.find((i) => i.ms === ODSTEP_CZUWACZA_MS).fn();
    await przemiel();
    expect(log).not.toHaveBeenCalled();
  });

  // ⚠️ ODRZUCONA OBIETNICA W `setInterval` TO NIEOBSLUZONE ODRZUCENIE, KTORE W NODE 24
  // KLADZIE PROCES — czyli caly panel, nie tylko archiwum. Niedostepny NAS albo padniety
  // inFakt ma zostawic linie w logu, a nie wywalic zamowien i nadan.
  it('⚠️ awaria przebiegu laduje w logu, a nie jako nieobsluzone odrzucenie', async () => {
    const interwaly = [];
    const log = vi.fn();
    uruchomZegary({
      czuwaczArchiwumSprzedazy: { przebieg: async () => { throw new Error('NAS nie odpowiada'); } },
      ustawInterwal: (fn, ms) => { interwaly.push({ fn, ms }); return 0; },
      log,
    });
    interwaly.find((i) => i.ms === ODSTEP_CZUWACZA_MS).fn();
    await przemiel();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/archiwum sprzedaży/), 'NAS nie odpowiada');
  });

  // Zegary bez czuwacza maja sie po prostu nie rejestrowac — panel bez `INFAKT_ARCHIWUM`
  // wstaje dokladnie jak dotad.
  it('bez czuwacza archiwum sprzedazy zegar #7 sie nie rejestruje', () => {
    const interwaly = [];
    uruchomZegary({ ustawInterwal: (fn, ms) => { interwaly.push({ fn, ms }); return 0; }, log: () => {} });
    expect(interwaly).toHaveLength(0);
  });

  // ⚠️ TEST PO ZRODLE, ta sama zasada i to samo uzasadnienie, co przy czuwaczu kosztow wyzej:
  // `src/oms.js` wola `app.listen`, wiec jego uruchomienie w suicie znaczyloby otwarty port.
  // Czuwacz zbudowany w `zbudujOms` i NIEPRZEKAZANY do `uruchomZegary` nie chodzi ani razu.
  it('punkt wejscia przekazuje czuwacza archiwum sprzedazy do zegarow', async () => { await wykonajZegary('czuwaczArchiwumSprzedazy'); });
});

// ⚠️⚠️ DZIESIATA DROGA TEJ SAMEJ DZIURY — `services/paczka-dla-biura.js` ma komplet wlasnych
// testow, ale KAZDY z nich wstrzykuje `db`, `infakt` i oba katalogi WPROST. Przeszlyby co do
// jednego takze wtedy, gdyby bootstrap uslugi nie zbudowal albo zbudowal ja bez wizualizacji
// kosztu i bez katalogow archiwum. Objaw na produkcji: przycisk „Paczka dla biura" oddajacy
// 503 mimo skonfigurowanego inFaktu — albo, gorzej, paczka sciagajaca WSZYSTKO z sieci mimo
// pelnego archiwum na NAS-ie (kilkadziesiat zapytan zamiast odczytu z dysku), bez ani jednego
// bledu i bez sladu.
describe('zbudujOms — paczka dla biura rachunkowego', () => {
  it('paczka dla biura dostaje inFakt, wizualizacje kosztu i OBA katalogi archiwum', () => {
    let dostal = null;
    zbudujOms({
      env: env({
        INFAKT_ARCHIWUM: '/faktury', KSEF_TOKEN: 'T', KSEF_NIP: '1234563218', KSEF_ARCHIWUM: '/faktury',
      }),
      createDpd: atrapaDpd(),
      createPaczkaDlaBiuraFn: (args) => { dostal = args; return { zbuduj: async () => ({}) }; },
    });
    expect(dostal.katalogSprzedazy).toBe('/faktury');
    expect(dostal.katalogKosztow).toBe('/faktury');
    // ⚠️ BEZ WIZUALIZACJI KOSZTU paczka nie ma jak narysowac faktury kosztowej, ktorej nie ma
    // na dysku — a wtedy „wszystko albo nic" konczy sie odmowa przy pierwszym takim koszcie.
    expect(dostal.wizualizacjaKosztu).not.toBeNull();
    expect(typeof dostal.infakt.listaFaktur).toBe('function');
  });

  // ⚠️⚠️ TEN TEST PILNUJE OSTATNIEJ LINIJKI DROGI — argumentu `paczkaDlaBiura` w wywolaniu
  // `buildOmsServer`. Bez niego usluga powstaje, wraca z `zbudujOms` i test wyzej swieci na
  // zielono, a trasa MIMO TO oddaje 503 i oba przyciski znikaja z ekranow. Sprawdzone
  // mutacja: skasowanie samego argumentu przezylo cala suite, dopoki tego testu nie bylo.
  it('podpiety inFakt dociera do trasy GET /faktury/paczka (zywy PDF, nie 503)', async () => {
    const { app } = zbudujOms({
      env: env(),
      createDpd: atrapaDpd(),
      createPaczkaDlaBiuraFn: () => ({
        zbuduj: async (m, czesc) => ({
          bajty: Buffer.from('%PDF-1.4 p'), nazwa: `paczka-dla-biura-${m}-${czesc}.pdf`, dokumentow: 1, stron: 2,
        }),
      }),
    });
    await app.ready();
    const r = await app.inject({
      method: 'GET',
      url: '/faktury/paczka?miesiac=2026-08&czesc=sprzedaz',
      headers: { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64') },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.headers['content-disposition']).toContain('paczka-dla-biura-2026-08-sprzedaz.pdf');
  });

  // Panel bez inFaktu to tryb POPRAWNY (zakladka faktur jest wtedy pusta celowo) — a bez
  // dokumentow sprzedazowych nie ma z czego zlozyc paczki. `null` znaczy „przycisku nie ma",
  // a nie „przycisk oddaje piecsetke".
  it('bez inFaktu paczki nie ma', () => {
    const e = env();
    delete e.INFAKT_API_KEY;
    expect(zbudujOms({ env: e, createDpd: atrapaDpd() }).paczkaDlaBiura).toBeNull();
  });
});

// ⚠️⚠️ STRAZNIK CZASU PRZEBIEGU DLA CZUWACZA KOSZTOW (recenzja calej galezi, W4).
//
// `bootstrap.js` pilnowal `NAJDLUZSZY_PRZEBIEG_MS < ODSTEP_CZUWACZA_MS` WYLACZNIE dla czuwacza
// KSeF. Czuwacz kosztow wisi na tym samym zegarze godzinowym i ma wlasny, znacznie dluzszy
// najgorszy przypadek (pelne logowanie do KSeF + strony metadanych + budzet archiwum) — a nie
// mial ani jednej arytmetyki, ktora by go policzyla.
//
// ⚠️ MIARA JEST INNA NIZ U CZUWACZA KSeF, I TO JEST ROZSTRZYGNIECIE, A NIE NIEDBALOSC.
// Tamten pracuje przy KAZDYM tyknieciu, wiec przekroczenie ODSTEPU gubi mu prace. Ten pracuje
// w JEDNYM oknie na dobe (`czyPoraPobrania`, 03:00–03:59 czasu Warszawy) — tykniecia o 04:00
// czy 05:00 i tak oddaja „nie ta pora", wiec przebieg dluzszy niz godzina nie kosztuje NIC.
// Kosztuje dopiero przebieg dluzszy niz DOBA: on zjada nastepne okno pobrania. Porownanie
// z odstepem godzinowym byloby tu klamstwem nie do spelnienia — sam sufit stron
// (200 × 60 s limitu zadania) to ponad trzy godziny.
describe('straznik czasu przebiegu czuwacza kosztow', () => {
  it('⚠️ najgorszy przebieg LICZY SIE z prawdziwych stalych, a nie z komentarza', () => {
    // Trzy skladniki, kazdy z modulu, ktory go naprawde narzuca. Suma ma je wszystkie
    // objac — inaczej „najgorszy przypadek" jest liczba wziela znikad.
    expect(NAJDLUZSZY_PRZEBIEG_KOSZTOW_MS)
      .toBeGreaterThanOrEqual(NAJDLUZSZE_ODPYTYWANIE_MS + SUFIT_STRON * LIMIT_ZADANIA_MS + BUDZET_ARCHIWUM_MS);
  });

  it('⚠️ najgorszy przebieg miesci sie w oknie pobrania (raz na dobe)', () => {
    expect(NAJDLUZSZY_PRZEBIEG_KOSZTOW_MS).toBeLessThan(ODSTEP_OKNA_POBRANIA_MS);
  });

  // Straznik ma POLOZYC PANEL PRZY STARCIE, a nie po cichu rozjechac zegar na produkcji —
  // dokladnie tak, jak robi to `NAJDLUZSZY_PRZEBIEG_MS` czuwacza KSeF. Sprawdzamy sam warunek,
  // bo `zbudujOms` wykonuje sie dopiero po wczytaniu modulu (a wtedy straznik juz przeszedl).
  it('⚠️ podniesienie sufitu stron ponad dobe zlamaloby warunek straznika', () => {
    const sufitZabojczy = Math.ceil(ODSTEP_OKNA_POBRANIA_MS / LIMIT_ZADANIA_MS);
    expect(NAJDLUZSZE_ODPYTYWANIE_MS + sufitZabojczy * LIMIT_ZADANIA_MS + BUDZET_ARCHIWUM_MS)
      .toBeGreaterThanOrEqual(ODSTEP_OKNA_POBRANIA_MS);
  });
});

// ⚠️⚠️ STRAZNIK CZASU PRZEBIEGU DLA CZUWACZA ARCHIWUM SPRZEDAZY (recenzja calej galezi).
// Zegar #7 wisi na tym samym tyknieciu godzinowym, co czuwacz KSeF, i do tej pory nie mial ani
// jednej arytmetyki, ktora by policzyla jego najgorszy przypadek.
//
// ⚠️ MIARA TO ODSTEP ZEGARA, A NIE OKNO POBRANIA — inaczej niz u czuwacza kosztow wyzej.
// Ten czuwacz ma DRUGIE wejscie poza pora: przycisk „Odśwież teraz" na /faktury. Przebieg
// dluzszy od godziny odbijalby recznie wciskany przycisk komunikatem „poprzedni przebieg
// jeszcze trwa" przez cala noc — a nocne tykniecia gubilby bez sladu.
describe('straznik czasu przebiegu czuwacza archiwum sprzedazy', () => {
  it('⚠️ najgorszy przebieg LICZY SIE z prawdziwych stalych, a nie z komentarza', () => {
    expect(NAJDLUZSZY_PRZEBIEG_ARCHIWUM_SPRZEDAZY_MS)
      .toBeGreaterThanOrEqual(BUDZET_ARCHIWUM_SPRZEDAZY_MS + NAJDLUZSZA_LISTA_MS + LIMIT_ZADANIA_INFAKTU_MS);
  });

  // ⚠️ SAMA `NAJDLUZSZA_LISTA_MS` TEZ MA BYC LICZONA, a nie wpisana z palca: `wszystkieStrony`
  // bierze strone zerowa osobno, a reszte partiami po `ROWNOLEGLE_STRON`.
  it('⚠️ najdluzsza lista liczy sie z sufitu stron i rownoleglosci klienta inFaktu', () => {
    const rundy = 1 + Math.ceil((SUFIT_STRON_INFAKTU - 1) / ROWNOLEGLE_STRON);
    expect(NAJDLUZSZA_LISTA_MS).toBe(rundy * LIMIT_ZADANIA_INFAKTU_MS);
  });

  it('⚠️ najgorszy przebieg miesci sie miedzy tyknieciami zegara czuwaczy', () => {
    expect(NAJDLUZSZY_PRZEBIEG_ARCHIWUM_SPRZEDAZY_MS).toBeLessThan(ODSTEP_CZUWACZA_MS);
  });

  // Straznik ma POLOZYC PANEL PRZY STARCIE, a nie po cichu rozjechac zegar na produkcji.
  // Sprawdzamy sam warunek, bo `zbudujOms` wykonuje sie dopiero po wczytaniu modulu
  // (a wtedy straznik juz przeszedl) — tak samo, jak przy czuwaczu kosztow wyzej.
  it('⚠️ budzet KROTSZY od godziny JUZ lamie warunek straznika', () => {
    // Podniesienie budzetu „bezpiecznie, bo dalej ponizej godziny" jest wlasnie ta pomylka,
    // przed ktora straznik ma chronic: listy miesiaca i ostatnie pobranie dokladaja swoje.
    const budzetZabojczy = ODSTEP_CZUWACZA_MS - NAJDLUZSZA_LISTA_MS;
    expect(budzetZabojczy).toBeLessThan(ODSTEP_CZUWACZA_MS);
    expect(budzetZabojczy + NAJDLUZSZA_LISTA_MS + LIMIT_ZADANIA_INFAKTU_MS)
      .toBeGreaterThanOrEqual(ODSTEP_CZUWACZA_MS);
  });
});

// ⚠️⚠️ OKABLOWANIE STANU KANALOW (14.08.2026). Testy widoku i reguly niczego tu nie dowodza:
// pierwsze czytaja PLIK, druga dostaje dane wprost. Gdyby `stanyKanalow` nie doszlo z
// bootstrapu do trasy, pas po prostu NIGDY by sie nie pokazal — bez bledu i bez sladu,
// nie do odroznienia od „wszystkie kanaly zdrowe". To ta sama klasa awarii, co device flow
// bez ani jednego wywolania i zegar czuwacza w martwej galezi.
describe('zbudujOms — stan kanałów dla paska ostrzeżenia', () => {
  const KANAL = {
    ALLEGRO_SZKICOWNIA_CLIENT_ID: 'id', ALLEGRO_SZKICOWNIA_CLIENT_SECRET: 'sekret',
    ALLEGRO_SZKICOWNIA_OD: '2026-07-01', ALLEGRO_SZKICOWNIA_API: 'https://api.allegro.test',
    ALLEGRO_USER_AGENT: UA,
  };

  it('kanał NIEPOŁĄCZONY woła o pomoc i wolno go wiązać', () => {
    const { stanyKanalow } = zbudujOms({ env: env(KANAL), createDpd: atrapaDpd() });
    expect(stanyKanalow).toBeTypeOf('function');
    const stany = stanyKanalow();
    expect(stany).toHaveLength(1);
    expect(stany[0]).toMatchObject({ kanal: 'allegro_szkicownia', pilne: true, wolnoWiazac: true });
  });

  // ⚠️ ZAPISANY BLAD MA DOJSC AZ NA EKRAN — to jest cala tresc awarii z 14.08.
  it('zapisany błąd tokenu dociera z bazy do stanu ekranu', () => {
    const { db, stanyKanalow } = zbudujOms({ env: env(KANAL), createDpd: atrapaDpd() });
    zapiszTokeny(db, 'allegro_szkicownia', {
      accessToken: 'a', refreshToken: 'r',
      wygasaAt: '2026-12-01T00:00:00.000Z', refreshWygasaAt: '2026-12-01T00:00:00.000Z',
    });
    db.prepare("UPDATE tokeny_kanalu SET ostatni_blad = ? WHERE kanal = 'allegro_szkicownia'")
      .run('Odświeżenie tokenu odrzucone (HTTP 400, invalid_grant)');
    const s = stanyKanalow()[0];
    expect(s.pilne).toBe(true);
    expect(s.zyje).toBe(false);
    expect(s.powod).toMatch(/zamówień/i);
  });

  // ⚠️ NIGDY POSWIADCZEN POZA WARSTWE TOKENOW (4.10).
  it('stan kanału NIE NIESIE tokenów', () => {
    const { db, stanyKanalow } = zbudujOms({ env: env(KANAL), createDpd: atrapaDpd() });
    zapiszTokeny(db, 'allegro_szkicownia', {
      accessToken: 'TAJNY-ACCESS', refreshToken: 'TAJNY-REFRESH',
      wygasaAt: '2026-12-01T00:00:00.000Z', refreshWygasaAt: '2026-12-01T00:00:00.000Z',
    });
    const tekst = JSON.stringify(stanyKanalow());
    expect(tekst).not.toContain('TAJNY-ACCESS');
    expect(tekst).not.toContain('TAJNY-REFRESH');
  });

  it('panel bez kanałów Allegro oddaje pustą listę, nie wywala się', () => {
    const { stanyKanalow } = zbudujOms({ env: env(), createDpd: atrapaDpd() });
    expect(stanyKanalow()).toEqual([]);
  });
});

// ⚠️⚠️ JEDNA INSTANCJA TOKENÓW NA KANAŁ — to nie jest porządek, tylko OCHRONA PRZED
// SPALENIEM REFRESH TOKENA. Deduplikacja odświeżania siedzi w `WeakMap` modułu
// `allegro/tokeny.js`, więc chroni w obrębie JEDNEJ instancji. Druga instancja nad tą samą
// bazą to druga mapa, czyli dwa równoległe odświeżenia tym samym (jednorazowym!) refresh
// tokenem — a Allegro unieważnia wtedy całą rodzinę. Dokładnie to zabiło kanał
// `allegro_szkicownia` w nocy 13/14.08.2026 (`HTTP 400, invalid_grant` przy 89 dniach ważności).
//
// Test czyta ŹRÓDŁO, bo instancji nie da się porównać z zewnątrz — `createAllegroClient`
// zamyka ją w domknięciu. Asercja jest wąska celowo: liczy wywołania fabryki.
describe('zbudujOms — jedna instancja tokenów na kanał', () => {
  it('createTokeny wołane DOKŁADNIE RAZ, nie osobno dla klienta i dla ekranu', async () => { expect(await wykonajJednaFabrykeTokenow()).toBe(1); });
});

// ⚠️⚠️ TEN OPIS POWSTAŁ, BO MUTACJA PRZEŻYŁA. Wszystkie testy wyżej sprawdzały, że
// `zbudujOms` ODDAJE `stanyKanalow` — żaden nie sprawdzał, czy ta wartość DOCHODZI DO TRASY.
// Usunięcie jej z wywołania `buildOmsServer` przechodziło całą suitę, a na produkcji pas
// ostrzeżenia po prostu nigdy by się nie pokazał: bez błędu, bez śladu i nie do odróżnienia
// od „wszystkie kanały zdrowe". To ta sama klasa awarii, co device flow bez ani jednego
// wywołania i zegar czuwacza w martwej gałęzi — tu złapana po raz czwarty.
describe('pas kanału dociera aż na stronę listy', () => {
  const naglowek = { authorization: `Basic ${Buffer.from('adam:x').toString('base64')}` };
  const KANAL = {
    ALLEGRO_SZKICOWNIA_CLIENT_ID: 'id', ALLEGRO_SZKICOWNIA_CLIENT_SECRET: 'sekret',
    ALLEGRO_SZKICOWNIA_OD: '2026-07-01', ALLEGRO_SZKICOWNIA_API: 'https://api.allegro.test',
    ALLEGRO_USER_AGENT: UA,
  };

  it('martwy kanał JEST WIDOCZNY w HTML-u listy zamówień', async () => {
    const { app, db } = zbudujOms({ env: env(KANAL), createDpd: atrapaDpd() });
    zapiszTokeny(db, 'allegro_szkicownia', {
      accessToken: 'a', refreshToken: 'r',
      wygasaAt: '2026-12-01T00:00:00.000Z', refreshWygasaAt: '2026-12-01T00:00:00.000Z',
    });
    db.prepare("UPDATE tokeny_kanalu SET ostatni_blad = 'invalid_grant' WHERE kanal = 'allegro_szkicownia'").run();
    await app.ready();
    const r = await app.inject({ method: 'GET', url: '/', headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/Kanał nie działa/);
    expect(r.body).toContain('allegro_szkicownia');
    // Wyjście musi stać przy ostrzeżeniu (4.9).
    expect(r.body).toMatch(/Naprawa:/);
  });

  it('kanał zdrowy NIE zostawia pasa — ostrzeżenie widziane codziennie przestaje działać', async () => {
    const { app, db } = zbudujOms({ env: env(KANAL), createDpd: atrapaDpd() });
    zapiszTokeny(db, 'allegro_szkicownia', {
      accessToken: 'a', refreshToken: 'r',
      wygasaAt: '2026-12-01T00:00:00.000Z', refreshWygasaAt: '2026-12-01T00:00:00.000Z',
    });
    await app.ready();
    const r = await app.inject({ method: 'GET', url: '/', headers: naglowek });
    expect(r.statusCode).toBe(200);
    // ⚠️ NIE po nazwie klasy: ona stoi TAKZE w arkuszu stylow w layoucie, wiec `toContain`
    // lapaloby definicje CSS zamiast pasa. Pytamy o TRESC, ktora widzi czlowiek.
    expect(r.body).not.toMatch(/Kanał nie działa/);
    expect(r.body).not.toMatch(/Kanał wkrótce przestanie działać/);
  });
});

// ⚠️⚠️ OD RAZU END-TO-END, po nauce z Zadania 2. Tam mutacja „nie podaje stanu do serwera"
// przeżyła całą suitę, bo wszystkie testy sprawdzały, że bootstrap ODDAJE wartość — żaden,
// czy dochodzi NA EKRAN. Przycisk, który nigdy się nie renderuje, wygląda dokładnie tak
// samo jak „kanał zdrowy, nie ma co naprawiać".
describe('przycisk „Połącz z Allegro" w ustawieniach', () => {
  const naglowek = { authorization: `Basic ${Buffer.from('adam:x').toString('base64')}` };
  const KANAL = {
    ALLEGRO_SZKICOWNIA_CLIENT_ID: 'id', ALLEGRO_SZKICOWNIA_CLIENT_SECRET: 'sekret',
    ALLEGRO_SZKICOWNIA_OD: '2026-07-01', ALLEGRO_SZKICOWNIA_API: 'https://api.allegro.test',
    ALLEGRO_USER_AGENT: UA,
  };
  const zepsuty = (db) => {
    zapiszTokeny(db, 'allegro_szkicownia', {
      accessToken: 'a', refreshToken: 'r',
      wygasaAt: '2026-12-01T00:00:00.000Z', refreshWygasaAt: '2026-12-01T00:00:00.000Z',
    });
    db.prepare("UPDATE tokeny_kanalu SET ostatni_blad = 'invalid_grant' WHERE kanal = 'allegro_szkicownia'").run();
  };

  it('martwy kanał DOSTAJE przycisk na stronie ustawień', async () => {
    const { app, db } = zbudujOms({ env: env(KANAL), createDpd: atrapaDpd() });
    zepsuty(db);
    await app.ready();
    const r = await app.inject({ method: 'GET', url: '/ustawienia/integracje', headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Połącz z Allegro');
    expect(r.body).toContain('/ustawienia/kanaly/allegro_szkicownia/wiazanie');
  });

  // ⚠️ BARIERA: ponowne wiazanie NADPISUJE dzialajaca pare i uniewaznia ja po stronie
  // Allegro. Przycisk przy zdrowym kanale zaprasza do klikniecia „na wszelki wypadek".
  it('zdrowy kanał NIE DOSTAJE przycisku', async () => {
    const { app, db } = zbudujOms({ env: env(KANAL), createDpd: atrapaDpd() });
    zapiszTokeny(db, 'allegro_szkicownia', {
      accessToken: 'a', refreshToken: 'r',
      wygasaAt: '2026-12-01T00:00:00.000Z', refreshWygasaAt: '2026-12-01T00:00:00.000Z',
    });
    await app.ready();
    const r = await app.inject({ method: 'GET', url: '/ustawienia/integracje', headers: naglowek });
    expect(r.body).not.toContain('Połącz z Allegro');
  });

  // ⚠️ EKRAN NIE JEST BARIERA. Zadanie moze przyjsc z reki albo ze starej, otwartej karty,
  // na ktorej kanal byl jeszcze zepsuty — a wtedy klikniecie zabiloby dzialajacy kanal.
  it('POST dla kanału ZDROWEGO odbija się od domeny, nie od widoku', async () => {
    const { app, db } = zbudujOms({ env: env(KANAL), createDpd: atrapaDpd() });
    zapiszTokeny(db, 'allegro_szkicownia', {
      accessToken: 'a', refreshToken: 'r',
      wygasaAt: '2026-12-01T00:00:00.000Z', refreshWygasaAt: '2026-12-01T00:00:00.000Z',
    });
    await app.ready();
    const r = await app.inject({
      method: 'POST',
      url: '/ustawienia/kanaly/allegro_szkicownia/wiazanie',
      // Niezmiennik 4.11: POST bez `origin` odbija sie od ochrony CSRF (403).
      headers: { ...naglowek, origin: 'http://localhost' },
      payload: {},
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/działa/i);
  });

  it('POST dla nieznanego kanału też odmawia', async () => {
    const { app, db } = zbudujOms({ env: env(KANAL), createDpd: atrapaDpd() });
    zepsuty(db);
    await app.ready();
    const r = await app.inject({
      method: 'POST',
      url: '/ustawienia/kanaly/nie_ma/wiazanie',
      headers: { ...naglowek, origin: 'http://localhost' },
      payload: {},
    });
    expect(r.statusCode).toBe(400);
  });
});
