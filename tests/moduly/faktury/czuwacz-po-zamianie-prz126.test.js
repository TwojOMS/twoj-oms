// PRZ-126 C09g — spóźnione zapisy czuwacza po zamianie faktury (zły NIP). Między odczytem kolejki a zapisem czuwacz
// czeka na sieć; zamiana może w tym czasie przepiąć wiersz `faktury` na nową fakturę. Odpowiedź dotyczy wtedy STAREJ
// i nie ma prawa trafić do wiersza, który wskazuje nową: ani nieudany odczyt KSeF, ani wynik weryfikacji Allegro.
//
// Baza `:memory:` z migracjami rdzenia, program fakturowy i klient Allegro to atrapy — zero sieci.
// Dane zmyślone („Pracownia Półcień”).
import {
  describe, it, expect, vi, beforeAll, afterAll,
} from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import {
  przepnijNaZastepcza, zapiszNieudanyOdczytKsef, zapiszWeryfikacjeAllegro,
} from '../../../src/moduly/faktury/db/faktury.js';
import { createCzuwaczKsef } from '../../../src/moduly/faktury/services/czuwacz-ksef.js';
import { createDoczytanieKsef } from '../../../src/moduly/faktury/services/ksef-doczytanie.js';
import { sprawyKarty } from '../../../src/domena/sprawy-karty.js';

const SKLEP = 'allegro_polcien';
const STARY_DOK = 'tf-dok-0031';
const NOWY_DOK = 'tf-dok-0035';
const STARY_NUMER = 'FV/2026/10/0031';
const NOWY_NUMER = 'FV/2026/10/0035';
const STARE_ZGLOSZENIE = 'INV-STARE-31';
const GODZINA = 60 * 60 * 1000;
// Względem zegara, nie z kalendarza: czuwacz liczy podłogę weryfikacji od `Date.now()`.
const przedGodzinami = (h) => new Date(Date.now() - h * GODZINA).toISOString();
const SPRAWDZONA = '2026-10-29T12:05:00.000Z';

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('PRZ-126 C09g: sieć zabroniona w teście'); }));
});
afterAll(() => vi.unstubAllGlobals());

let licznik = 0;
/** Zamówienie z Allegro z fakturą TwojeFaktury; `k` nadpisuje kolumny wiersza `faktury`. */
function zamowienieZFaktura(db, k = {}) {
  licznik += 1;
  const id = zapiszZamowienie(db, SKLEP, {
    zrodlo_id: `PC-CG-${licznik}`, numer: `PC-${900 + licznik}`, kwota_brutto: '144.00', chce_fakture: 1, pozycje: [],
    klient: { company: 'Pracownia Półcień sp. z o.o.', email: 'biuro@polcien.invalid' }, dostawa: { city: 'Warszawa' },
    metoda_wysylki: 'allegro_dpd', kwota_pobrania: null, nip: '1234563218', status_woo: null,
    oplacone_at: '2026-10-10T09:00:00Z', anulowane: 0, utworzone_at: '2026-10-10T08:00:00Z',
  }, {});
  const w = {
    program: 'twojefaktury', dokument_id: STARY_DOK, numer: STARY_NUMER, ksef_status: null, ksef_numer: null,
    ksef_sprawdzona_at: null, ksef_odczyt: null, allegro_invoice_id: null, allegro_wyslana_at: null,
    allegro_weryfikacja: null, ...k,
  };
  db.prepare(`INSERT INTO faktury (zamowienie_id, program, dokument_id, numer, ksef_status, ksef_numer,
    ksef_sprawdzona_at, ksef_odczyt, allegro_invoice_id, allegro_wyslana_at, allegro_weryfikacja, utworzona_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, w.program, w.dokument_id, w.numer, w.ksef_status, w.ksef_numer, w.ksef_sprawdzona_at, w.ksef_odczyt,
      w.allegro_invoice_id, w.allegro_wyslana_at, w.allegro_weryfikacja, przedGodzinami(30));
  return id;
}

const wierszFaktury = (db, id) => ({ ...db.prepare('SELECT * FROM faktury WHERE zamowienie_id = ?').get(id) });
const logZ = (db, id) => db.prepare('SELECT akcja, wynik FROM log WHERE zamowienie_id = ?').all(id);
const zrodloZ = (db, id) => db.prepare('SELECT zrodlo_id FROM zamowienia WHERE id = ?').get(id).zrodlo_id;
const przepnij = (db, id) => przepnijNaZastepcza(db, {
  zamowienieId: id, staryDokumentId: STARY_DOK, nowyDokumentId: NOWY_DOK, numer: NOWY_NUMER, teraz: Date.now(),
});

/** Program, który w trakcie pytania o starą fakturę „widzi” zamianę, a potem odpowiada błędem. */
function programPadajacyPoPrzepieciu(db, id, blad = Object.assign(new Error('TwojeFaktury: przerwa'), { status: 503 })) {
  return {
    opis: { id: 'twojefaktury' },
    pobierzFakture: vi.fn(async (dok) => {
      expect(dok).toBe(STARY_DOK);
      przepnij(db, id);
      throw blad;
    }),
  };
}

describe('nieudany odczyt KSeF z identyfikatorem dokumentu', () => {
  it('wiersz przepięty po odczycie: zapis ze starym dokumentem nic nie zmienia i zwraca false', () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db);
    const odczyt = wierszFaktury(db, id);
    przepnij(db, id);
    expect(zapiszNieudanyOdczytKsef(db, odczyt.id, { sprawdzonaAt: SPRAWDZONA, odczyt: 'nieznana', dokumentId: STARY_DOK }))
      .toBe(false);
    expect(wierszFaktury(db, id)).toMatchObject({ dokument_id: NOWY_DOK, ksef_sprawdzona_at: null, ksef_odczyt: null });
  });

  it('bez zamiany: zgodny dokument, stary wiersz inFaktu (sam infakt_uuid) i brak dokumentu zapisują jak dotąd', () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db);
    const f = wierszFaktury(db, id);
    expect(zapiszNieudanyOdczytKsef(db, f.id, { sprawdzonaAt: SPRAWDZONA, dokumentId: STARY_DOK })).toBe(true);
    expect(wierszFaktury(db, id)).toMatchObject({ ksef_sprawdzona_at: SPRAWDZONA, ksef_odczyt: 'blad' });

    const id2 = zamowienieZFaktura(db, { program: null, dokument_id: null });
    db.prepare("UPDATE faktury SET infakt_uuid = 'inf-0031' WHERE zamowienie_id = ?").run(id2);
    expect(zapiszNieudanyOdczytKsef(db, wierszFaktury(db, id2).id, { sprawdzonaAt: SPRAWDZONA, odczyt: 'nieznana', dokumentId: 'inf-0031' }))
      .toBe(true);
    expect(wierszFaktury(db, id2)).toMatchObject({ ksef_sprawdzona_at: SPRAWDZONA, ksef_odczyt: 'nieznana' });

    const id3 = zamowienieZFaktura(db);
    expect(zapiszNieudanyOdczytKsef(db, wierszFaktury(db, id3).id, { sprawdzonaAt: SPRAWDZONA })).toBe(true);
    expect(wierszFaktury(db, id3).ksef_odczyt).toBe('blad');
  });

  it('czuwacz: przepięcie w trakcie pytania i błąd odczytu → nowy wiersz bez stempla, bez wpisu „BŁĄD odczytu”', async () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db);
    const program = programPadajacyPoPrzepieciu(db, id, Object.assign(new Error('nie ma takiego dokumentu'), { status: 404 }));
    await createCzuwaczKsef({ db, program, log: () => {} }).przebieg();
    expect(program.pobierzFakture).toHaveBeenCalledTimes(1);
    expect(wierszFaktury(db, id)).toMatchObject({ dokument_id: NOWY_DOK, ksef_sprawdzona_at: null, ksef_odczyt: null });
    expect(JSON.stringify(logZ(db, id))).not.toContain('BŁĄD odczytu');
  });

  it('czuwacz bez zamiany: błąd odczytu dalej stempluje wiersz i zostawia wpis w logu', async () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db);
    const program = {
      opis: { id: 'twojefaktury' },
      pobierzFakture: vi.fn(async () => { throw Object.assign(new Error('nie ma takiego dokumentu'), { status: 404 }); }),
    };
    await createCzuwaczKsef({ db, program, log: () => {} }).przebieg();
    expect(wierszFaktury(db, id)).toMatchObject({ dokument_id: STARY_DOK, ksef_odczyt: 'nieznana' });
    expect(wierszFaktury(db, id).ksef_sprawdzona_at).not.toBeNull();
    expect(JSON.stringify(logZ(db, id))).toContain('BŁĄD odczytu');
  });

  it('doczytanie na karcie: przepięcie w trakcie pytania i błąd → nowy wiersz bez stempla', async () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db);
    const program = programPadajacyPoPrzepieciu(db, id);
    const doczytanie = createDoczytanieKsef({ db, program, teraz: () => SPRAWDZONA });
    expect(await doczytanie.dlaFaktury(pobierzZamowienie(db, id).faktura, id)).toBe(false);
    expect(program.pobierzFakture).toHaveBeenCalledTimes(1);
    expect(wierszFaktury(db, id)).toMatchObject({ dokument_id: NOWY_DOK, ksef_sprawdzona_at: null, ksef_odczyt: null });
  });
});

describe('weryfikacja Allegro z identyfikatorem zgłoszenia', () => {
  // Stan D: plik starej faktury był u kupującego (WAITING) — przepięcie zostawia `allegro_wyslana_at` i WAITING,
  // a `allegro_invoice_id` zeruje. Spóźnione REJECTED dotyczy starego zgłoszenia, nie nowej faktury.
  const stanD = () => ({
    ksef_numer: '1234563218-20261010-0A1B2C3D4E5F-31', allegro_invoice_id: STARE_ZGLOSZENIE,
    allegro_wyslana_at: przedGodzinami(2), allegro_weryfikacja: 'WAITING',
  });
  const programNieruszany = {
    opis: { id: 'twojefaktury' },
    pobierzFakture: vi.fn(async () => { throw new Error('pierwsza pętla nie ma tu o co pytać'); }),
  };
  const sprawaAllegro = (db, id) => sprawyKarty(pobierzZamowienie(db, id), Date.now())
    .find((s) => s.klucz === 'faktura-allegro');

  it('zapis z innym zgłoszeniem niż w wierszu nic nie zmienia i zwraca false; zgodny zapisuje', () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db, stanD());
    const f = wierszFaktury(db, id);
    expect(zapiszWeryfikacjeAllegro(db, f.id, 'REJECTED', 'INV-INNE-9')).toBe(false);
    expect(wierszFaktury(db, id).allegro_weryfikacja).toBe('WAITING');
    expect(zapiszWeryfikacjeAllegro(db, f.id, 'ACCEPTED', STARE_ZGLOSZENIE)).toBe(true);
    expect(wierszFaktury(db, id).allegro_weryfikacja).toBe('ACCEPTED');
    expect(zapiszWeryfikacjeAllegro(db, f.id, null, STARE_ZGLOSZENIE)).toBe(false);
    expect(wierszFaktury(db, id).allegro_weryfikacja).toBe('ACCEPTED');
  });

  it('stan D: przepięcie w trakcie pytania, spóźnione REJECTED → bez zapisu, bez logu, bez sprawy', async () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db, stanD());
    const klient = {
      pobierzFakturyZamowienia: vi.fn(async (cf) => {
        expect(cf).toBe(zrodloZ(db, id));
        przepnij(db, id);
        expect(wierszFaktury(db, id)).toMatchObject({ dokument_id: NOWY_DOK, allegro_invoice_id: null });
        return [{ id: STARE_ZGLOSZENIE, file: { securityVerification: { status: 'REJECTED' } } }];
      }),
    };
    await createCzuwaczKsef({ db, program: programNieruszany, klienciKanalow: { [SKLEP]: klient }, log: () => {} }).przebieg();
    expect(klient.pobierzFakturyZamowienia).toHaveBeenCalledTimes(1);
    expect(wierszFaktury(db, id)).toMatchObject({ dokument_id: NOWY_DOK, numer: NOWY_NUMER, allegro_weryfikacja: 'WAITING' });
    expect(JSON.stringify(logZ(db, id))).not.toContain('weryfikacja Allegro: REJECTED');
    expect(sprawaAllegro(db, id)).toBeUndefined();
  });

  it('bez zamiany: REJECTED zapisane, w logu i jako sprawa na karcie (jak dotąd)', async () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db, stanD());
    const klient = {
      pobierzFakturyZamowienia: vi.fn(async () => [
        { id: STARE_ZGLOSZENIE, file: { securityVerification: { status: 'REJECTED' } } },
      ]),
    };
    await createCzuwaczKsef({ db, program: programNieruszany, klienciKanalow: { [SKLEP]: klient }, log: () => {} }).przebieg();
    expect(wierszFaktury(db, id).allegro_weryfikacja).toBe('REJECTED');
    expect(JSON.stringify(logZ(db, id))).toContain('weryfikacja Allegro: REJECTED');
    expect(sprawaAllegro(db, id)).toBeDefined();
  });
});
