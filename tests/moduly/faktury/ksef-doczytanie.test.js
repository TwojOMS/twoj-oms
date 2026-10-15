import { describe, it, expect } from 'vitest';
import { czyDoczytacKsef, PROG_DOCZYTANIA_KSEF_MS } from '../../../src/domena/ksef-doczytanie.js';
import { createDoczytanieKsef } from '../../../src/moduly/faktury/services/ksef-doczytanie.js';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { zapiszZamowienie, pobierzZamowienie, ostatniWpisLogu } from '../../../src/oms/db/zamowienia.js';
import { rozpocznijFakture, zakonczFakture } from '../../../src/moduly/faktury/db/faktury.js';

/** Faktura zamowienia — przez publiczne wejscie, bo `fakturaZamowienia` jest prywatne. */
const fakturaZ = (db, id) => pobierzZamowienie(db, id).faktura;

const TERAZ = Date.parse('2026-08-12T10:00:00.000Z');
const fak = (n) => ({ id: 1, infakt_uuid: 'u1', ksef_numer: null, ksef_sprawdzona_at: null, ...n });

describe('czy doczytac numer KSeF', () => {
  it('pyta o fakture bez numeru, o ktora nigdy nie pytano', () => {
    expect(czyDoczytacKsef(fak(), TERAZ)).toBe(true);
  });

  // ⚠️ Numer raz zapisany jest jedynym dowodem, ze dokument jest w KSeF, i nic go nie
  // unicestwia — pytanie drugi raz nie moze przyniesc nowej informacji.
  it('nie pyta, gdy numer juz jest', () => {
    expect(czyDoczytacKsef(fak({ ksef_numer: '1234563218-20260812-ABC-01' }), TERAZ)).toBe(false);
  });

  it('nie pyta bez uuid ani o brak faktury', () => {
    expect(czyDoczytacKsef(fak({ infakt_uuid: null }), TERAZ)).toBe(false);
    expect(czyDoczytacKsef(null, TERAZ)).toBe(false);
    expect(czyDoczytacKsef(undefined, TERAZ)).toBe(false);
  });

  // ⚠️ SEDNO DLAWIKA: dwadziescia razy F5 w minute ma dac JEDNO zapytanie do inFaktu.
  it('nie pyta ponownie przed uplywem progu, pyta po nim', () => {
    const chwileTemu = new Date(TERAZ - 30_000).toISOString();
    expect(czyDoczytacKsef(fak({ ksef_sprawdzona_at: chwileTemu }), TERAZ)).toBe(false);

    const dawno = new Date(TERAZ - PROG_DOCZYTANIA_KSEF_MS - 1).toISOString();
    expect(czyDoczytacKsef(fak({ ksef_sprawdzona_at: dawno }), TERAZ)).toBe(true);
  });

  it('na granicy progu pyta', () => {
    const rowno = new Date(TERAZ - PROG_DOCZYTANIA_KSEF_MS).toISOString();
    expect(czyDoczytacKsef(fak({ ksef_sprawdzona_at: rowno }), TERAZ)).toBe(true);
  });

  // Brak informacji nie jest powodem do milczenia — ta sama zasada, co przy stanie faktury.
  it('uszkodzony stempel traktuje jak brak pytania', () => {
    expect(czyDoczytacKsef(fak({ ksef_sprawdzona_at: 'bzdura' }), TERAZ)).toBe(true);
  });
});

function baza() {
  const db = openOmsDb(':memory:');
  const id = zapiszZamowienie(db, 'pro', {
    zrodlo_id: 1, numer: '3001', klient: { first_name: 'Jan' }, dostawa: {},
    metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: null,
    kwota_brutto: '123.00', status_woo: 'processing', oplacone_at: null, anulowane: 0,
  }, {});
  const f = rozpocznijFakture(db, id);
  zakonczFakture(db, f.id, { uuid: 'u1', numer: '1/08/2026', ksefStatus: null });
  return { db, id };
}

describe('doczytanie numeru KSeF przy otwarciu karty', () => {
  it('zapisuje numer i melduje zmiane, gdy inFakt go ma', async () => {
    const { db, id } = baza();
    const usluga = createDoczytanieKsef({
      db, infakt: { pobierzFakture: async () => ({ ksefNumer: 'KSEF-1' }) },
    });
    expect(await usluga.dlaFaktury(fakturaZ(db, id), id)).toBe(true);
    expect(fakturaZ(db, id).ksef_numer).toBe('KSEF-1');
    // Fakt trafia do historii zamowienia — inaczej nikt sie nie dowie, skad numer.
    expect(String(ostatniWpisLogu(db, id, "ksef")?.wynik).includes("KSEF-1")).toBe(true);
  });

  // ⚠️ ZAPIS STEMPLA TAKZE PRZY PUSTEJ ODPOWIEDZI — bez niego dlawik nie dziala i kazde
  // odswiezenie karty bije do inFaktu od nowa.
  it('bez numeru nie melduje zmiany, ale odnotowuje pytanie', async () => {
    const { db, id } = baza();
    const usluga = createDoczytanieKsef({
      db, infakt: { pobierzFakture: async () => ({ ksefNumer: null }) },
    });
    expect(await usluga.dlaFaktury(fakturaZ(db, id), id)).toBe(false);
    expect(fakturaZ(db, id).ksef_sprawdzona_at).toBeTruthy();
    expect(fakturaZ(db, id).ksef_numer).toBeNull();
  });

  // ⚠️ KARTA MA SIE OTWORZYC, CHOCBY inFAKT LEZAL. Usluga nie rzuca nigdy.
  it('awaria inFaktu nie rzuca i zostawia slad pytania', async () => {
    const { db, id } = baza();
    const usluga = createDoczytanieKsef({
      db, infakt: { pobierzFakture: async () => { throw new Error('inFakt lezy'); } },
    });
    await expect(usluga.dlaFaktury(fakturaZ(db, id), id)).resolves.toBe(false);
    expect(fakturaZ(db, id).ksef_sprawdzona_at).toBeTruthy();
    expect(fakturaZ(db, id).ksef_odczyt).toBe('blad');
  });

  it('nie pyta w ogole, gdy numer juz jest', async () => {
    const { db, id } = baza();
    let wolane = 0;
    const usluga = createDoczytanieKsef({
      db, infakt: { pobierzFakture: async () => { wolane += 1; return { ksefNumer: 'X' }; } },
    });
    await usluga.dlaFaktury({ ...fakturaZ(db, id), ksef_numer: 'JUZ-JEST' }, id);
    expect(wolane).toBe(0);
  });

  it('bez klienta inFaktu odpuszcza zamiast wywalac karte', async () => {
    const { db, id } = baza();
    const usluga = createDoczytanieKsef({ db, infakt: null });
    await expect(usluga.dlaFaktury(fakturaZ(db, id), id)).resolves.toBe(false);
  });

  // ⚠️⚠️ REGRESJA Z PRODUKCJI, 14.08.2026 — „faktury nie wysylaja sie do Allegro".
  //
  // Czuwacz szuka faktur po warunku `ksef_numer IS NULL` (domain/ksef-oczekiwanie.js) i to ON
  // po znalezieniu numeru wysyla dokument kupujacemu na Allegro. Ta sciezka zapisywala numer
  // i NIE ROBILA NIC DALEJ — czyli ZABIERALA czuwaczowi robote, nie wykonujac jej. Faktura
  // wypadala z jego kolejki NA ZAWSZE i nie szla do kupujacego nigdy.
  //
  // Trafialo za kazdym razem, bo naturalna kolejnosc ruchow operatora to dokladnie: zlec
  // wysylke do KSeF w zakladce FAKTURY, potem zajrzyj na karte. Zmierzone na zamowieniu 1167.
  //
  // ⚠️ KAZDY, KTO ZAPISUJE `ksef_numer`, MUSI URUCHOMIC TO SAMO. Dlatego nastepstwo mieszka
  // w jednym miejscu (services/po-numerze-ksef.js), a nie w dwoch kopiach.
  it('po zapisaniu numeru uruchamia nastepstwo — inaczej faktura nie pojdzie do Allegro', async () => {
    const { db, id } = baza();
    const wolane = [];
    const usluga = createDoczytanieKsef({
      db,
      infakt: { pobierzFakture: async () => ({ ksefNumer: 'KSEF-1' }) },
      poNumerzeKsef: { wyslijDoAllegroJesliWolno: async (zid) => { wolane.push(zid); } },
    });
    await usluga.dlaFaktury(fakturaZ(db, id), id);
    expect(wolane).toEqual([id]);
  });

  it('gdy numeru nie ma, nie uruchamia nastepstwa', async () => {
    const { db, id } = baza();
    let wolane = 0;
    const usluga = createDoczytanieKsef({
      db,
      infakt: { pobierzFakture: async () => ({ ksefNumer: null }) },
      poNumerzeKsef: { wyslijDoAllegroJesliWolno: async () => { wolane += 1; } },
    });
    await usluga.dlaFaktury(fakturaZ(db, id), id);
    expect(wolane).toBe(0);
  });

  // Awaria nastepstwa nie ma prawa cofnac zapisanego numeru ani wywalic karty.
  it('awaria nastepstwa nie psuje zapisu numeru', async () => {
    const { db, id } = baza();
    const usluga = createDoczytanieKsef({
      db,
      infakt: { pobierzFakture: async () => ({ ksefNumer: 'KSEF-1' }) },
      poNumerzeKsef: { wyslijDoAllegroJesliWolno: async () => { throw new Error('Allegro lezy'); } },
    });
    await expect(usluga.dlaFaktury(fakturaZ(db, id), id)).resolves.toBe(true);
    expect(fakturaZ(db, id).ksef_numer).toBe('KSEF-1');
  });
});

// ⚠️ TEST WPIECIA, nie samej uslugi: idzie prawdziwa usluga z atrapa inFaktu, przez
// `buildOmsServer` i trase karty. Bez niego numer moglby ladowac w bazie, a karta pokazywac
// stan sprzed odczytu — to jest dokladnie ta pulapka, ktora przy przesylkach Allegro
// wymusila ponowny odczyt zamowienia po zapisie.
describe('karta zamowienia dociaga numer KSeF przy otwarciu', () => {
  const AUTH = { authorization: `Basic ${Buffer.from('t:h').toString('base64')}` };

  function serwer(infakt) {
    const { db, id } = baza();
    const app = buildOmsServer({
      db,
      config: { auth: { user: 't', pass: 'h' } },
      doczytanieKsef: createDoczytanieKsef({ db, infakt }),
    });
    return { app, db, id };
  }

  it('pokazuje numer od razu po otwarciu, bez czekania na czuwacza', async () => {
    const { app, id } = serwer({ pobierzFakture: async () => ({ ksefNumer: 'KSEF-Z-KARTY' }) });
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('KSEF-Z-KARTY');
  });

  it('nie pyta drugi raz przy odswiezeniu — dlawik dziala przez trase', async () => {
    let wolane = 0;
    const { app, id } = serwer({
      pobierzFakture: async () => { wolane += 1; return { ksefNumer: null }; },
    });
    await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: AUTH });
    await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: AUTH });
    await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: AUTH });
    expect(wolane).toBe(1);
  });

  // ⚠️ Karta ma sie otworzyc takze wtedy, gdy inFakt lezy — inaczej awaria cudzego API
  // zabiera operatorowi dostep do zamowienia.
  it('awaria inFaktu nie wywala karty', async () => {
    const { app, id } = serwer({ pobierzFakture: async () => { throw new Error('inFakt lezy'); } });
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('1/08/2026');
  });
});
