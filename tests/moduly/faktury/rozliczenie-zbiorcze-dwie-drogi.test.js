import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { zapewnijOkres, pobierzOkres, zamowieniaOkresu } from '../../../src/oms/db/okresy.js';
import { pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { createFaktura } from '../../../src/moduly/faktury/services/faktura.js';
import { createFakturaOkresu } from '../../../src/moduly/faktury/services/faktura-okresu.js';
import { sprawyKarty } from '../../../src/domena/sprawy-karty.js';
import { STAN, kluczOkresu } from '../../../src/domena/okres-rozliczeniowy.js';
import { dopiszKlientaZbiorczego } from './_klient-zbiorczy-pomocniki.js';

// RECENZJA KONCOWA GALEZI `oms-rozliczenie-zbiorcze` (2026-08-03).
//
// Ten plik pilnuje JEDNEJ osi, ktorej nie widzialo zadne pojedyncze zadanie planu: zamowienie
// przypisane do okresu ma DWIE drogi do dokumentu w inFakcie — pojedyncza (z wlasnej karty)
// i zbiorcza (z ekranu okresu). Blokady zbudowane w Zadaniach 7 i 9 broniły wylacznie osi
// „drugi dokument za ten sam MIESIAC"; ta os byla otwarta na oscierz.
//
// Kazdy test tutaj byl NAJPIERW uruchomiony na kodzie sprzed poprawki i NAJPIERW przechodzil
// „na czerwono" (zmierzone: `infakt.wystaw` wywolany dwa razy, ta sama pozycja „STOP 70x100”
// na obu dokumentach).

const naglowek = {
  authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'),
  origin: 'http://localhost',
};

// ⚠️ Od 24.08.2026 klient zbiorczy jest WIERSZEM TABELY `klienci`, nie wpisem w konfiguracji.
const KLIENT = {
  klucz: 'zetaklient', nazwa: 'Zetaklient sp. z o.o.', nip: '1000001017',
  rabat_procent: 10, prog_darmowej_dostawy_gr: 30000,
  oplata_obslugi_gr: 400, oplata_kurierska_gr: 1900,
};
const config = { auth: { user: 'adam', pass: 'x' } };

const infaktUdany = () => ({
  znajdzKlientaPoNip: vi.fn().mockResolvedValue(77),
  zalozKlienta: vi.fn().mockResolvedValue(77),
  wystaw: vi.fn().mockResolvedValue({ uuid: 'u-1', numer: 'FV/1/2026', ksefStatus: null }),
  pobierzPdf: vi.fn(),
});

let db;
let okres;
let infakt;

/**
 * Zamowienie klienta zbiorczego — z NIP-em, z „chce fakture" i z pozycja rowna kwocie,
 * czyli DOKLADNIE takie, jakie operator zobaczy na karcie: zwykle zamowienie firmowe.
 * `okresId = null` daje ten sam ksztalt zamowienia POZA rozliczeniem zbiorczym.
 */
function dodajZamowienie({ numer, kwota = '100.00', okresId = okres.id, anulowane = 0 }) {
  db.prepare(
    'INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, nip, chce_fakture, klient_json,'
    + ' okres_rozliczeniowy_id, anulowane, utworzone_at)'
    + " VALUES ('reczne', ?, ?, ?, ?, 1, ?, ?, ?, '2026-07-10T10:00:00.000Z')",
  ).run(
    Number(String(numer).replace(/\D/g, '')), numer, kwota, KLIENT.nip,
    JSON.stringify({ company: KLIENT.nazwa, first_name: 'Jan', last_name: 'Kowalski' }),
    okresId, anulowane ? 1 : 0,
  );
  const id = db.prepare('SELECT id FROM zamowienia WHERE numer = ?').get(numer).id;
  db.prepare(
    'INSERT INTO pozycje (zamowienie_id, nazwa, ilosc, cena_brutto, brutto_linii, zrodlo)'
    + " VALUES (?, 'STOP 70x100', 1, ?, ?, 'reczna')",
  ).run(id, kwota, kwota);
  return id;
}

beforeEach(() => {
  db = openOmsDb();
  dopiszKlientaZbiorczego(db, KLIENT);
  okres = zapewnijOkres(db, { klientKlucz: 'zetaklient', rok: 2026, miesiac: 7 });
  infakt = infaktUdany();
});

describe('K1 — to samo zamowienie nie moze pojechac na fakture dwiema drogami', () => {
  it('faktura POJEDYNCZA odmawia zamowieniu nalezacemu do okresu i kieruje na ekran okresu', async () => {
    const zamId = dodajZamowienie({ numer: 'R/2026/001' });
    await expect(createFaktura({ db, infakt }).wystaw(zamId)).rejects.toThrow(/okres/i);
    // ⚠️ ODMOWA MA BYC PRZED WYWOLANIEM inFAKTU, nie po nim: dokument, ktory juz powstal,
    // kasuje sie w inFakcie recznie, a po wieczornej wysylce do KSeF zostaje tylko korekta.
    expect(infakt.wystaw).not.toHaveBeenCalled();
    // Bez wiersza w `faktury` nie ma tez rezerwacji blokujacej fakture zbiorcza.
    expect(db.prepare('SELECT COUNT(*) AS n FROM faktury').get().n).toBe(0);
  });

  it('komunikat odmowy niesie ADRES ekranu okresu — inaczej operator nie wie, gdzie kliknac', async () => {
    const zamId = dodajZamowienie({ numer: 'R/2026/001' });
    await expect(createFaktura({ db, infakt }).wystaw(zamId))
      .rejects.toThrow(new RegExp(`/okresy/${okres.id}`));
  });

  it('zamowienie POZA okresem dalej fakturuje sie pojedynczo — blokada nie moze byc szersza', async () => {
    const zamId = dodajZamowienie({ numer: 'R/2026/002', okresId: null });
    const w = await createFaktura({ db, infakt }).wystaw(zamId);
    expect(w.numer).toBe('FV/1/2026');
    expect(infakt.wystaw).toHaveBeenCalledTimes(1);
  });

  it('faktura ZBIORCZA odmawia, gdy ktorekolwiek zamowienie okresu ma juz wiersz w `faktury`', async () => {
    const zamId = dodajZamowienie({ numer: 'R/2026/001' });
    dodajZamowienie({ numer: 'R/2026/002' });
    // Wiersz faktury wstawiony WPROST — tak wyglada zamowienie zafakturowane pojedynczo
    // (albo z rezerwacja po zerwanej probie) w chwili, gdy trafia do okresu.
    db.prepare(
      "INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, ksef_status, utworzona_at)"
      + " VALUES (?, 'u-0', 'FV/0/2026', NULL, '2026-07-11T09:00:00.000Z')",
    ).run(zamId);

    await expect(createFakturaOkresu({ db, infakt }).wystaw(okres.id, KLIENT))
      .rejects.toThrow(/R\/2026\/001/);
    expect(infakt.wystaw).not.toHaveBeenCalled();
    // Okres ma zostac DOKLADNIE taki, jak byl: bez rezerwacji i otwarty.
    const po = pobierzOkres(db, okres.id);
    expect(po.ksef_status).toBe(null);
    expect(po.stan).toBe(STAN.OTWARTY);
  });

  it('OBIE DROGI OBOK SIEBIE: co by nie poszlo pierwsze, drugie sie odbija', async () => {
    const zamId = dodajZamowienie({ numer: 'R/2026/001' });
    const pojedyncza = createFaktura({ db, infakt });
    const zbiorcza = createFakturaOkresu({ db, infakt });

    // Droga 1 — z karty zamowienia. Odmowa.
    await expect(pojedyncza.wystaw(zamId)).rejects.toThrow(/okres/i);
    // Droga 2 — z ekranu okresu. Przechodzi i to ona jest jedyna wlasciwa.
    const wynik = await zbiorcza.wystaw(okres.id, KLIENT);
    expect(wynik.stan).toBe(STAN.ZAFAKTUROWANY);
    expect(infakt.wystaw).toHaveBeenCalledTimes(1);

    // ...a po fakturze zbiorczej droga 1 dalej odmawia — to samo zamowienie nie ma
    // ani jednej sciezki do drugiego dokumentu.
    await expect(pojedyncza.wystaw(zamId)).rejects.toThrow(/okres/i);
    expect(infakt.wystaw).toHaveBeenCalledTimes(1);
  });
});

describe('K1 — trasy i karta zamowienia', () => {
  let app;
  beforeEach(async () => {
    app = buildOmsServer({
      db, config, infakt, faktura: createFaktura({ db, infakt }), poller: null,
    });
    await app.ready();
  });

  const get = (url) => app.inject({ method: 'GET', url, headers: naglowek });
  const post = (url, payload) => app.inject({ method: 'POST', url, headers: naglowek, payload });

  it('POST /zamowienia/:id/faktura odbija sie od okresu (400), a inFakt nic nie widzi', async () => {
    const zamId = dodajZamowienie({ numer: 'R/2026/001' });
    const odp = await post(`/zamowienia/${zamId}/faktura`, {});
    expect(odp.statusCode).toBe(400);
    expect(odp.body).toMatch(/okres/i);
    expect(infakt.wystaw).not.toHaveBeenCalled();
  });

  it('karta MOWI o okresie i daje do niego link — bez tego operator nie ma zadnego sygnalu', async () => {
    const zamId = dodajZamowienie({ numer: 'R/2026/001' });
    const odp = await get(`/zamowienia/${zamId}`);
    expect(odp.statusCode).toBe(200);
    expect(odp.body).toMatch(new RegExp(`href="/okresy/${okres.id}"`));
    // ⚠️ OSOBNO O BELCE — bez tego mutacja kasujaca pole „Rozliczenie" przechodzila:
    // link do okresu jest na karcie takze w sekcji Faktura i w bloku salda, wiec sama
    // obecnosc `href` niczego o belce nie mowi. Belka jest jedynym miejscem widocznym
    // BEZ przewijania, wiec to ona odpowiada za „operator w ogole to zobaczy".
    expect(odp.body).toMatch(new RegExp(`Rozliczenie[\\s\\S]{0,200}href="/okresy/${okres.id}"`));
    // Miesiac nazwany po imieniu, nie „okres nr 1".
    expect(odp.body).toMatch(/faktura za lipiec 2026/);
  });

  it('karta NIE POKAZUJE przycisku „Wystaw fakturę" dla zamowienia w okresie', async () => {
    const zamId = dodajZamowienie({ numer: 'R/2026/001' });
    const odp = await get(`/zamowienia/${zamId}`);
    // Celujemy w FORMULARZ wystawienia, nie w cale cialo: slowo „faktura" jest na karcie
    // wszedzie (naglowek sekcji, dane do faktury), wiec asercja o nim niczego by nie znaczyla.
    expect(odp.body).not.toMatch(new RegExp(`action="/zamowienia/${zamId}/faktura"`));
  });

  it('...ale zamowienie POZA okresem dalej ma ten przycisk', async () => {
    const zamId = dodajZamowienie({ numer: 'R/2026/002', okresId: null });
    const odp = await get(`/zamowienia/${zamId}`);
    expect(odp.body).toMatch(new RegExp(`action="/zamowienia/${zamId}/faktura"`));
  });
});

describe('W2 — zamowienie zapisane w oknie `await` nie wpada do zafakturowanego miesiaca', () => {
  it('odmawia, gdy zbior zamowien okresu zmienil sie w trakcie wywolania inFaktu', async () => {
    dodajZamowienie({ numer: 'R/2026/001' });
    // DRUGI OPERATOR zapisuje zamowienie dokladnie w oknie `await znajdzKlientaPoNip`.
    // To nie jest egzotyka: okres zostaje OTWARTY przez cale to okno, wiec `przypiszDoOkresu`
    // przyjmie zamowienie bez mrugniecia.
    infakt.znajdzKlientaPoNip = vi.fn().mockImplementation(async () => {
      dodajZamowienie({ numer: 'R/2026/009', kwota: '40.00' });
      return 77;
    });

    await expect(createFakturaOkresu({ db, infakt }).wystaw(okres.id, KLIENT))
      .rejects.toThrow(/R\/2026\/009/);
    // ⚠️ ODMOWA PRZED `infakt.wystaw`: inaczej klient dostaje fakture na 100,00 zl za miesiac,
    // ktory dzis wart jest 140,00 — a wyjscia z tego nie ma zadnego.
    expect(infakt.wystaw).not.toHaveBeenCalled();
    // Okres MUSI wrocic do stanu sprzed proby, inaczej odmowa zostawia zamkniety miesiac
    // z wiszaca rezerwacja i wystawienie faktury staje sie niemozliwe.
    const po = pobierzOkres(db, okres.id);
    expect(po.ksef_status).toBe(null);
    expect(po.stan).toBe(STAN.OTWARTY);
    expect(po.zamkniety_at).toBe(null);
  });

  it('po odmowie faktura wystawia sie normalnie za PELNY, juz kompletny zbior', async () => {
    dodajZamowienie({ numer: 'R/2026/001' });
    let raz = false;
    infakt.znajdzKlientaPoNip = vi.fn().mockImplementation(async () => {
      if (!raz) { raz = true; dodajZamowienie({ numer: 'R/2026/009', kwota: '40.00' }); }
      return 77;
    });
    const usluga = createFakturaOkresu({ db, infakt });
    await expect(usluga.wystaw(okres.id, KLIENT)).rejects.toThrow();

    const wynik = await usluga.wystaw(okres.id, KLIENT);
    expect(wynik.stan).toBe(STAN.ZAFAKTUROWANY);
    expect(infakt.wystaw).toHaveBeenCalledTimes(1);
    const suma = infakt.wystaw.mock.calls[0][0].services.reduce((a, s) => a + s.gross_price, 0);
    expect(suma).toBe(14000);
  });

  it('niezmieniony zbior przechodzi — bariera nie moze blokowac normalnej faktury', async () => {
    dodajZamowienie({ numer: 'R/2026/001' });
    dodajZamowienie({ numer: 'R/2026/002', kwota: '40.00' });
    const wynik = await createFakturaOkresu({ db, infakt }).wystaw(okres.id, KLIENT);
    expect(wynik.stan).toBe(STAN.ZAFAKTUROWANY);
    expect(zamowieniaOkresu(db, okres.id)).toHaveLength(2);
  });
});

describe('W3 — zamowienie w okresie nie zglasza niedoplaty (pieniadze zyja na okresie)', () => {
  it('pasek spraw MILCZY o niedoplacie dla zamowienia nalezacego do okresu', () => {
    const zamId = dodajZamowienie({ numer: 'R/2026/001' });
    const sprawy = sprawyKarty(pobierzZamowienie(db, zamId));
    expect(sprawy.filter((s) => s.klucz === 'platnosci')).toHaveLength(0);
  });

  it('...ale zamowienie POZA okresem dalej krzyczy o niedoplacie', () => {
    const zamId = dodajZamowienie({ numer: 'R/2026/002', okresId: null });
    const sprawy = sprawyKarty(pobierzZamowienie(db, zamId));
    expect(sprawy.filter((s) => s.klucz === 'platnosci')).toHaveLength(1);
    expect(sprawy[0].tekst).toMatch(/Niedopłata/);
  });

  it('NADPLATA na zamowieniu w okresie zostaje sprawa — to sa pieniadze, ktore gdzies sa', () => {
    const zamId = dodajZamowienie({ numer: 'R/2026/003' });
    db.prepare(
      'INSERT INTO platnosci (zamowienie_id, kwota, data, zrodlo, utworzona_at)'
      + " VALUES (?, '150.00', '2026-07-12', 'reczna', '2026-07-12T08:00:00.000Z')",
    ).run(zamId);
    const sprawy = sprawyKarty(pobierzZamowienie(db, zamId));
    expect(sprawy.filter((s) => s.klucz === 'platnosci')).toHaveLength(1);
    expect(sprawy[0].tekst).toMatch(/Nadpłata/);
  });

  it('karta pokazuje odeslanie do okresu zamiast alarmu NIEDOPLATA', async () => {
    const zamId = dodajZamowienie({ numer: 'R/2026/001' });
    const app = buildOmsServer({
      db, config, infakt, faktura: createFaktura({ db, infakt }), poller: null,
    });
    await app.ready();
    const odp = await app.inject({ method: 'GET', url: `/zamowienia/${zamId}`, headers: naglowek });
    // Blok salda jest jedynym miejscem, w ktorym karta NAZYWA te pieniadze — asercja
    // o calym ciele lapalaby placeholdery formularza wplaty (ta sama pulapka, co
    // w okresy-trasy.test.js).
    const blok = odp.body.match(/<div class="saldo[^"]*">[\s\S]*?<\/div>/)[0];
    expect(blok).not.toMatch(/NIEDOPŁATA/);
    expect(blok).toMatch(/rozliczen/i);
  });
});

describe('D2 — indeks na zamowienia.okres_rozliczeniowy_id', () => {
  it('powstaje przy otwarciu bazy — takze na bazie, ktora kolumne dostala dopiero z `dolozKolumny`', () => {
    // ⚠️ `zamowienia.okres_rozliczeniowy_id` NIE MA w `CREATE TABLE zamowienia` w schema.sql —
    // kolumna dokłada się dopiero w `dolozKolumny` (db.js, DOLOZ). Indeks postawiony
    // w schema.sql odbilby sie wiec na STAREJ bazie o „no such column" jeszcze przed
    // migracja, czyli panel nie wstalby w ogole. Ten test pilnuje KOLEJNOSCI.
    const indeksy = db.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'zamowienia'",
    ).all();
    const nasz = indeksy.find((i) => (i.sql ?? '').includes('okres_rozliczeniowy_id'));
    expect(nasz, 'brak indeksu po okres_rozliczeniowy_id').toBeTruthy();
  });

  it('`zamowieniaOkresu` przestaje skanowac cala tabele', () => {
    // Bez indeksu plan brzmial „SCAN zamowienia", a `/okresy` wola `daneOkresu` dla KAZDEGO
    // okresu — czyli koszt rosl iloczynowo z kazdym kolejnym miesiacem.
    const plan = db.prepare(
      'EXPLAIN QUERY PLAN SELECT id FROM zamowienia WHERE okres_rozliczeniowy_id = ?'
      + ' ORDER BY utworzone_at, id',
    ).all(okres.id).map((w) => w.detail).join(' | ');
    expect(plan).toMatch(/USING INDEX/);
  });
});

describe('D4 — jeden odczyt zegara przy zakladaniu zamowienia', () => {
  const PRAWDZIWY_DATE = Date;

  afterEach(() => { vi.unstubAllGlobals(); });

  it('na przelomie miesiaca okres zgadza sie z data zlozenia zamowienia', async () => {
    // ⚠️ ZEGAR PRZESKAKUJE MIEDZY PIERWSZYM A DRUGIM ODCZYTEM — dokladnie tak, jak potrafi
    // to zrobic prawdziwy zegar o polnocy 31 lipca. Do 2026-08-03 trasa liczyla okres
    // z WLASNEGO `new Date().toISOString()`, a `utworzZamowienieReczne` wpisywalo
    // `utworzone_at` z WLASNEGO `teraz()` — dwa niezalezne odczyty, wiec zamowienie trafialo
    // do LIPCOWEGO okresu z SIERPNIOWA data zlozenia (albo odwrotnie).
    let pierwszy = true;
    vi.stubGlobal('Date', class extends PRAWDZIWY_DATE {
      constructor(...args) {
        if (args.length === 0) {
          // ⚠️ GRANICA MIESIACA LICZY SIE W WARSZAWIE (domain/okres-rozliczeniowy.js),
          // nie w UTC: 1 sierpnia 00:00 czasu warszawskiego to 31 lipca 22:00 UTC.
          // Pierwszy odczyt pada tuz PRZED ta granica, kazdy nastepny tuz PO niej.
          super(pierwszy ? '2026-07-31T21:59:59.500Z' : '2026-07-31T22:00:00.500Z');
          pierwszy = false;
        } else super(...args);
      }
      static now() { return new PRAWDZIWY_DATE().getTime(); }
    });

    const app = buildOmsServer({ db, config, infakt, poller: null });
    await app.ready();
    const odp = await app.inject({
      method: 'POST',
      url: '/zamowienia/nowe',
      headers: naglowek,
      payload: {
        f_nip: KLIENT.nip, f_firma: KLIENT.nazwa, w_nazwa: 'Jan Kowalski',
        poz_nazwa: ['STOP 70x100'], poz_sku: [''], poz_ilosc: ['1'],
        poz_cena_netto: [''], poz_cena_brutto: ['100,00'],
      },
    });
    expect(odp.statusCode).toBe(302);

    const z = db.prepare("SELECT * FROM zamowienia WHERE sklep = 'reczne' ORDER BY id DESC").get();
    expect(z.okres_rozliczeniowy_id, 'zamowienie nie trafilo do zadnego okresu').toBeTruthy();
    const o = pobierzOkres(db, z.okres_rozliczeniowy_id);
    // MIESIAC OKRESU MUSI ZGADZAC SIE Z DATA ZLOZENIA ZAPISANA NA ZAMOWIENIU — to jest
    // cala tresc tej poprawki. Porownujemy TA SAMA funkcja domenowa, ktora rozstrzyga
    // przypisanie (`kluczOkresu`), zeby test nie mial wlasnej, drugiej definicji granicy
    // miesiaca. Przed poprawka: okres lipcowy, `utworzone_at` juz sierpniowe.
    expect({ rok: o.rok, miesiac: o.miesiac }).toEqual(kluczOkresu(z.utworzone_at));
  });
});
