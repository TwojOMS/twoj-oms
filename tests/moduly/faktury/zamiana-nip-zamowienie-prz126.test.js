// PRZ-126 C09f — zły NIP: przepięcie zamówienia na fakturę zastępczą i macierz stanów Allegro (plan C09, Z10).
//
// Baza `:memory:` z migracjami rdzenia, klient Allegro i program fakturowy to atrapy — zero sieci.
// Dane zmyślone („Pracownia Półcień”).
import {
  describe, it, expect, vi, beforeAll, afterAll,
} from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import {
  przepnijNaZastepcza, stanAllegroWiersza, zapiszNumerKsef, zajmijWysylkeDoAllegro, PROG_ZAJECIA_WYSYLKI_MS,
} from '../../../src/moduly/faktury/db/faktury.js';
import { wolnoWyslacDoAllegro, WARUNEK_WERYFIKACJA_NIEROZSTRZYGNIETA_SQL } from '../../../src/domena/allegro-faktura.js';
import { createFakturaAllegro } from '../../../src/moduly/faktury/services/faktura-allegro.js';
import { createCzuwaczKsef } from '../../../src/moduly/faktury/services/czuwacz-ksef.js';
import { createDoczytanieKsef } from '../../../src/moduly/faktury/services/ksef-doczytanie.js';

const PDF = Buffer.concat([Buffer.from('%PDF-1.4'), Buffer.alloc(64)]);
const SKLEP = 'allegro_polcien';
const STARY_DOK = 'tf-dok-0007';
const NOWY_DOK = 'tf-dok-0012';
const STARY_NUMER = 'FV/2026/10/0007';
const NOWY_NUMER = 'FV/2026/10/0012';
const STARE_ZGLOSZENIE = 'INV-STARE-1';
const NOWE_ZGLOSZENIE = 'INV-NOWE-2';
const TERAZ = Date.parse('2026-10-29T12:00:00.000Z');
const minutTemu = (n) => new Date(TERAZ - n * 60 * 1000).toISOString();
const WYSLANA = '2026-10-20T09:00:00.000Z';

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('PRZ-126 C09f: sieć zabroniona w teście'); }));
});
afterAll(() => vi.unstubAllGlobals());

let licznik = 0;
/** Zamówienie z Allegro z fakturą TwojeFaktury; `k` nadpisuje kolumny wiersza `faktury`. */
function zamowienieZFaktura(db, k = {}) {
  licznik += 1;
  const id = zapiszZamowienie(db, SKLEP, {
    zrodlo_id: `PC-CF-${licznik}`, numer: `PC-${700 + licznik}`, kwota_brutto: '258.00', chce_fakture: 1, pozycje: [],
    klient: { company: 'Pracownia Półcień sp. z o.o.', email: 'biuro@polcien.invalid' }, dostawa: { city: 'Warszawa' },
    metoda_wysylki: 'allegro_dpd', kwota_pobrania: null, nip: '1234563218', status_woo: null,
    oplacone_at: '2026-10-10T09:00:00Z', anulowane: 0, utworzone_at: '2026-10-10T08:00:00Z',
  }, {});
  const w = {
    program: 'twojefaktury', dokument_id: STARY_DOK, numer: STARY_NUMER, ksef_status: 'przyjeta',
    ksef_numer: '1234563218-20261010-0A1B2C3D4E5F-01', ksef_sprawdzona_at: '2026-10-11T08:00:00.000Z',
    ksef_odczyt: 'ok', blad_opis: 'stary opis błędu', allegro_invoice_id: null, allegro_wyslana_at: null,
    allegro_weryfikacja: null, allegro_zgloszenie_at: null, allegro_pytana_at: null, ...k,
  };
  db.prepare(`INSERT INTO faktury (zamowienie_id, program, dokument_id, numer, ksef_status, ksef_numer,
    ksef_sprawdzona_at, ksef_odczyt, blad_opis, allegro_invoice_id, allegro_wyslana_at, allegro_weryfikacja,
    allegro_zgloszenie_at, allegro_pytana_at, utworzona_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, w.program, w.dokument_id, w.numer, w.ksef_status, w.ksef_numer, w.ksef_sprawdzona_at, w.ksef_odczyt,
      w.blad_opis, w.allegro_invoice_id, w.allegro_wyslana_at, w.allegro_weryfikacja, w.allegro_zgloszenie_at,
      w.allegro_pytana_at, '2026-10-10T10:00:00.000Z');
  return id;
}

const wierszFaktury = (db, id) => ({ ...db.prepare('SELECT * FROM faktury WHERE zamowienie_id = ?').get(id) });

const przepnij = (db, id, dodatki = {}) => przepnijNaZastepcza(db, {
  zamowienieId: id, staryDokumentId: STARY_DOK, nowyDokumentId: NOWY_DOK, numer: NOWY_NUMER, teraz: TERAZ, ...dodatki,
});

const czuwaczPyta = (db, id) => db.prepare(
  `SELECT f.id FROM faktury f WHERE ${WARUNEK_WERYFIKACJA_NIEROZSTRZYGNIETA_SQL} AND f.zamowienie_id = ?`,
).all(id);

/** Program TwojeFaktury — sam PDF; zapamiętuje, o który dokument pytano. */
function programTf() {
  return {
    opis: {
      id: 'twojefaktury',
      nazwa: { mianownik: 'TwojeFaktury', dopelniacz: 'TwojeFaktury', miejscownik: 'TwojeFaktury', narzednik: 'TwojeFaktury' },
    },
    przygotujNabywce: () => null,
    pobierzPdf: vi.fn(async () => PDF),
  };
}

/** Klient Allegro: lista zgłoszeń niesie STARE puste zgłoszenie (ze starym numerem) — nie wolno go przyjąć. */
function klientAllegro({ stareNaLiscie = true } = {}) {
  const wywolania = [];
  return {
    wywolania,
    pobierzFakturyZamowienia: vi.fn(async (cf) => {
      wywolania.push(['lista', cf]);
      return stareNaLiscie ? [{ id: STARE_ZGLOSZENIE, invoiceNumber: STARY_NUMER }] : [];
    }),
    zglosFakture: vi.fn(async (cf, dane) => { wywolania.push(['zglos', cf, dane]); return { id: NOWE_ZGLOSZENIE }; }),
    wyslijPlikFaktury: vi.fn(async (cf, inv, bajty) => {
      wywolania.push(['plik', cf, inv, bajty.length]);
      return { file: { securityVerification: { status: 'WAITING' } } };
    }),
  };
}

/** Pełna droga po przepięciu: automat po numerze KSeF nowej → wysyłka do Allegro z atrapą. */
async function nowaDoAllegro(db, id, { stareNaLiscie = true } = {}) {
  const f = pobierzZamowienie(db, id).faktura;
  zapiszNumerKsef(db, f.id, { ksefNumer: '1234563218-20261029-0F0E0D0C0B0A-02', sprawdzonaAt: '2026-10-29T12:30:00.000Z' });
  const klient = klientAllegro({ stareNaLiscie });
  const program = programTf();
  const usluga = createFakturaAllegro({ db, program, klienciKanalow: { [SKLEP]: klient } });
  const wynik = await usluga.wyslij(id);
  return { klient, program, wynik };
}

function sprawdzWyslanoNowa({ klient, program, wynik }, db, id) {
  expect(klient.zglosFakture).toHaveBeenCalledTimes(1);
  expect(klient.zglosFakture.mock.calls[0][1].numerFaktury).toBe(NOWY_NUMER);
  expect(klient.wyslijPlikFaktury).toHaveBeenCalledTimes(1);
  expect(klient.wyslijPlikFaktury.mock.calls[0][1]).toBe(NOWE_ZGLOSZENIE);
  // Stare zgłoszenie i stary numer nie pojawiają się w ŻADNYM wywołaniu zapisującym do Allegro.
  const zapisy = JSON.stringify(klient.wywolania.filter((w) => w[0] !== 'lista'));
  expect(zapisy).not.toContain(STARE_ZGLOSZENIE);
  expect(zapisy).not.toContain(STARY_NUMER);
  expect(program.pobierzPdf).toHaveBeenCalledWith(NOWY_DOK);
  expect(wynik.invoiceId).toBe(NOWE_ZGLOSZENIE);
  const f = wierszFaktury(db, id);
  expect(f.allegro_invoice_id).toBe(NOWE_ZGLOSZENIE);
  expect(f.allegro_wyslana_at).not.toBeNull();
  expect(f.allegro_weryfikacja).toBe('WAITING');
}

describe('stanAllegroWiersza — czysta macierz Z10', () => {
  const s = (f) => stanAllegroWiersza(f, { teraz: TERAZ });
  it('rozpoznaje każdy stan', () => {
    expect(s({})).toBe('brak');
    expect(s({ allegro_invoice_id: STARE_ZGLOSZENIE })).toBe('zgloszona');
    expect(s({ allegro_invoice_id: STARE_ZGLOSZENIE, allegro_wyslana_at: WYSLANA, allegro_weryfikacja: 'REJECTED' })).toBe('odrzucona');
    for (const weryfikacja of ['WAITING', 'ACCEPTED', null, 'NIEZNANY_STATUS']) {
      expect(s({ allegro_invoice_id: STARE_ZGLOSZENIE, allegro_wyslana_at: WYSLANA, allegro_weryfikacja: weryfikacja })).toBe('u-kupujacego');
    }
    expect(s({ allegro_zgloszenie_at: minutTemu(5), allegro_wyslana_at: WYSLANA })).toBe('w-toku');
  });
  it('dzierżawa: świeża i równo na progu = w toku, starsza = sierota', () => {
    expect(s({ allegro_zgloszenie_at: minutTemu(10) })).toBe('w-toku');
    expect(s({ allegro_zgloszenie_at: new Date(TERAZ - PROG_ZAJECIA_WYSYLKI_MS - 1).toISOString() })).toBe('brak');
    expect(s({ allegro_zgloszenie_at: minutTemu(11), allegro_invoice_id: STARE_ZGLOSZENIE })).toBe('zgloszona');
  });
  it('próg i zegar z parametrów; zegar przyjmuje też datę ISO', () => {
    expect(stanAllegroWiersza({ allegro_zgloszenie_at: minutTemu(3) }, { teraz: TERAZ, prog: 2 * 60 * 1000 })).toBe('brak');
    expect(stanAllegroWiersza({ allegro_zgloszenie_at: minutTemu(3) }, { teraz: new Date(TERAZ).toISOString() })).toBe('w-toku');
  });
});

describe('przepnijNaZastepcza — wiersze macierzy Z10', () => {
  it('A brak: przepina dokument i numer, nic do zerowania w Allegro; inne zamówienie nietknięte', () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db);
    const obok = zamowienieZFaktura(db);
    const przedObok = wierszFaktury(db, obok);

    expect(przepnij(db, id)).toEqual({ stanAllegro: 'brak', staryAllegroInvoiceId: null });

    const f = wierszFaktury(db, id);
    expect(f).toMatchObject({
      program: 'twojefaktury', dokument_id: NOWY_DOK, numer: NOWY_NUMER,
      allegro_invoice_id: null, allegro_wyslana_at: null, allegro_weryfikacja: null,
      allegro_zgloszenie_at: null, allegro_pytana_at: null,
    });
    expect(wierszFaktury(db, obok)).toEqual(przedObok);
  });

  it('ksef_status, ksef_numer, ksef_sprawdzona_at, ksef_odczyt i blad_opis wyzerowane', () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db);
    przepnij(db, id);
    expect(wierszFaktury(db, id)).toMatchObject({
      ksef_status: null, ksef_numer: null, ksef_sprawdzona_at: null, ksef_odczyt: null, blad_opis: null,
    });
    // Numer KSeF starej nie udaje numeru nowej: automat po numerze KSeF czeka na numer nowej.
    expect(wolnoWyslacDoAllegro(pobierzZamowienie(db, id))).toMatchObject({ wolno: false, powod: expect.stringMatching(/KSeF/) });
  });

  it('B zgłoszona bez pliku: zeruje allegro_invoice_id, oddaje stare id', () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db, { allegro_invoice_id: STARE_ZGLOSZENIE });
    expect(przepnij(db, id)).toEqual({ stanAllegro: 'zgloszona', staryAllegroInvoiceId: STARE_ZGLOSZENIE });
    expect(wierszFaktury(db, id)).toMatchObject({
      dokument_id: NOWY_DOK, numer: NOWY_NUMER, allegro_invoice_id: null, allegro_wyslana_at: null, allegro_weryfikacja: null,
    });
  });

  it('C odrzucona: zeruje id, datę wysłania, weryfikację i datę pytania', () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db, {
      allegro_invoice_id: STARE_ZGLOSZENIE, allegro_wyslana_at: WYSLANA, allegro_weryfikacja: 'REJECTED',
      allegro_pytana_at: '2026-10-21T09:00:00.000Z',
    });
    expect(przepnij(db, id)).toEqual({ stanAllegro: 'odrzucona', staryAllegroInvoiceId: STARE_ZGLOSZENIE });
    expect(wierszFaktury(db, id)).toMatchObject({
      allegro_invoice_id: null, allegro_wyslana_at: null, allegro_weryfikacja: null, allegro_pytana_at: null,
    });
  });

  for (const weryfikacja of ['WAITING', 'ACCEPTED', null, 'NIEZNANY_STATUS']) {
    it(`D u kupującego (${weryfikacja ?? 'pusto'}): zeruje id i datę pytania, data wysłania i weryfikacja zostają`, () => {
      const db = openOmsDb(':memory:');
      const id = zamowienieZFaktura(db, {
        allegro_invoice_id: STARE_ZGLOSZENIE, allegro_wyslana_at: WYSLANA, allegro_weryfikacja: weryfikacja,
        allegro_pytana_at: '2026-10-21T09:00:00.000Z',
      });
      expect(przepnij(db, id)).toEqual({ stanAllegro: 'u-kupujacego', staryAllegroInvoiceId: STARE_ZGLOSZENIE });
      expect(wierszFaktury(db, id)).toMatchObject({
        dokument_id: NOWY_DOK, numer: NOWY_NUMER,
        allegro_invoice_id: null, allegro_pytana_at: null, allegro_wyslana_at: WYSLANA, allegro_weryfikacja: weryfikacja,
      });
    });
  }

  it('w toku (dzierżawa sprzed 5 min): 409 wysylka-allegro, wiersz bez zmian', () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db, { allegro_invoice_id: STARE_ZGLOSZENIE, allegro_zgloszenie_at: minutTemu(5) });
    const przed = wierszFaktury(db, id);
    let blad = null;
    try { przepnij(db, id); } catch (e) { blad = e; }
    expect(blad).toMatchObject({ dlaOperatora: true, status: 409, kod: 'wysylka-allegro' });
    expect(blad.message).toMatch(/Trwa wysyłka faktury do Allegro/);
    expect(wierszFaktury(db, id)).toEqual(przed);
  });

  it('sierota (dzierżawa sprzed 11 min): przepięcie przechodzi, dzierżawa zdjęta', () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db, { allegro_invoice_id: STARE_ZGLOSZENIE, allegro_zgloszenie_at: minutTemu(11) });
    expect(przepnij(db, id)).toEqual({ stanAllegro: 'zgloszona', staryAllegroInvoiceId: STARE_ZGLOSZENIE });
    expect(wierszFaktury(db, id)).toMatchObject({ dokument_id: NOWY_DOK, allegro_zgloszenie_at: null, allegro_invoice_id: null });
  });

  // Odmowy dla operatora (`bladOperatora`), nie goły wyjątek: trasa zamiany oddałaby inaczej 500.
  it('zły staryDokumentId albo brak wiersza → odmowa zamiana-zamowienie, wiersz bez zmian', () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db);
    const przed = wierszFaktury(db, id);
    expect(() => przepnij(db, id, { staryDokumentId: 'tf-dok-inny' })).toThrow(expect.objectContaining({
      dlaOperatora: true, status: 409, kod: 'zamiana-zamowienie', message: expect.stringMatching(/odśwież kartę/),
    }));
    expect(wierszFaktury(db, id)).toEqual(przed);
    expect(() => przepnij(db, 999999)).toThrow(expect.objectContaining({
      dlaOperatora: true, status: 404, kod: 'zamiana-zamowienie', message: expect.stringMatching(/nie ma faktury/),
    }));
  });

  it('nie otwiera własnej transakcji: ROLLBACK wołającego cofa przepięcie', () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db, { allegro_invoice_id: STARE_ZGLOSZENIE });
    const przed = wierszFaktury(db, id);
    db.exec('BEGIN IMMEDIATE');
    przepnij(db, id);
    expect(wierszFaktury(db, id).dokument_id).toBe(NOWY_DOK);
    db.exec('ROLLBACK');
    expect(wierszFaktury(db, id)).toEqual(przed);
  });
});

// Warunki w `WHERE`, nie w `if`-ie nad nim: stan zmieniony MIĘDZY odczytem a zapisem (wysyłka zajęła dzierżawę,
// inna zamiana przepięła wiersz) nie może przejść. Atrapa podmienia stan zaraz po pierwszym SELECT-cie.
function poOdczycie(db, zmiana) {
  let zrobione = false;
  return new Proxy(db, {
    get(cel, klucz) {
      if (klucz === 'prepare') {
        return (sql) => {
          const st = cel.prepare(sql);
          if (zrobione || !/^\s*SELECT/i.test(sql)) return st;
          return { get: (...a) => { const w = st.get(...a); zrobione = true; zmiana(cel); return w; } };
        };
      }
      const v = cel[klucz];
      return typeof v === 'function' ? v.bind(cel) : v;
    },
  });
}

describe('przepnijNaZastepcza — warunki w WHERE', () => {
  it('dzierżawa zajęta między odczytem a zapisem → 409 wysylka-allegro, nic nie przepięte', () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db, { allegro_invoice_id: STARE_ZGLOSZENIE });
    const fid = wierszFaktury(db, id).id;
    const wyscig = poOdczycie(db, (cel) => expect(zajmijWysylkeDoAllegro(cel, fid, { teraz: TERAZ })).toBe(true));
    expect(() => przepnij(wyscig, id)).toThrow(expect.objectContaining({ status: 409, kod: 'wysylka-allegro' }));
    expect(wierszFaktury(db, id)).toMatchObject({
      dokument_id: STARY_DOK, numer: STARY_NUMER, allegro_invoice_id: STARE_ZGLOSZENIE, allegro_zgloszenie_at: new Date(TERAZ).toISOString(),
    });
  });

  it('wiersz przepięty na inny dokument między odczytem a zapisem → odmowa zamiana-zamowienie, cudzy dokument zostaje', () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db);
    const wyscig = poOdczycie(db, (cel) => cel.prepare("UPDATE faktury SET dokument_id = 'tf-dok-obcy', numer = 'FV/2026/10/0099' WHERE zamowienie_id = ?").run(id));
    expect(() => przepnij(wyscig, id)).toThrow(expect.objectContaining({ dlaOperatora: true, status: 409, kod: 'zamiana-zamowienie' }));
    expect(wierszFaktury(db, id)).toMatchObject({ dokument_id: 'tf-dok-obcy', numer: 'FV/2026/10/0099' });
  });
});

describe('end-to-end: przepięcie → numer KSeF nowej → wysyłka do Allegro (atrapa)', () => {
  it('A brak: zgłasza nową fakturę z nowym numerem', async () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db);
    przepnij(db, id);
    sprawdzWyslanoNowa(await nowaDoAllegro(db, id, { stareNaLiscie: false }), db, id);
  });

  it('B zgłoszona bez pliku: nowe zgłoszenie z nowym numerem, plik do nowego id, nigdy do starego', async () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db, { allegro_invoice_id: STARE_ZGLOSZENIE });
    przepnij(db, id);
    sprawdzWyslanoNowa(await nowaDoAllegro(db, id), db, id);
  });

  it('C odrzucona: automat przepuszcza po numerze KSeF nowej; nowe zgłoszenie, plik do nowego id', async () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db, {
      allegro_invoice_id: STARE_ZGLOSZENIE, allegro_wyslana_at: WYSLANA, allegro_weryfikacja: 'REJECTED',
      allegro_pytana_at: '2026-10-21T09:00:00.000Z',
    });
    przepnij(db, id);
    const f = pobierzZamowienie(db, id).faktura;
    zapiszNumerKsef(db, f.id, { ksefNumer: '1234563218-20261029-0F0E0D0C0B0A-02', sprawdzonaAt: '2026-10-29T12:30:00.000Z' });
    expect(wolnoWyslacDoAllegro(pobierzZamowienie(db, id))).toEqual({ wolno: true, powod: null });
    sprawdzWyslanoNowa(await nowaDoAllegro(db, id), db, id);
  });

  for (const weryfikacja of ['WAITING', 'ACCEPTED', null]) {
    it(`D u kupującego (${weryfikacja ?? 'pusto'}): automat odmawia, czuwacz nie pyta, nic nie idzie do Allegro`, async () => {
      const db = openOmsDb(':memory:');
      const id = zamowienieZFaktura(db, {
        allegro_invoice_id: STARE_ZGLOSZENIE, allegro_wyslana_at: WYSLANA, allegro_weryfikacja: weryfikacja,
      });
      if (weryfikacja !== 'ACCEPTED') expect(czuwaczPyta(db, id)).toHaveLength(1);
      przepnij(db, id);
      expect(czuwaczPyta(db, id)).toEqual([]);
      const f = pobierzZamowienie(db, id).faktura;
      zapiszNumerKsef(db, f.id, { ksefNumer: '1234563218-20261029-0F0E0D0C0B0A-02', sprawdzonaAt: '2026-10-29T12:30:00.000Z' });
      expect(wolnoWyslacDoAllegro(pobierzZamowienie(db, id)).wolno).toBe(false);
      const klient = klientAllegro();
      const usluga = createFakturaAllegro({ db, program: programTf(), klienciKanalow: { [SKLEP]: klient } });
      await expect(usluga.wyslij(id)).rejects.toMatchObject({ dlaOperatora: true });
      expect(klient.wywolania).toEqual([]);
      expect(wierszFaktury(db, id)).toMatchObject({ allegro_wyslana_at: WYSLANA, allegro_weryfikacja: weryfikacja, allegro_invoice_id: null });
    });
  }
});

// Wyścig odczytu numeru KSeF z przepięciem: czuwacz i doczytanie na karcie pytają program o dokument, a w tym czasie
// zamiana przepina wiersz na nową fakturę. Odpowiedź dotyczy STAREJ — jej numer KSeF nie może trafić do wiersza, który
// wskazuje już nową (Allegro dostałoby nową fakturę „po numerze KSeF” starej). Zapis z identyfikatorem dokumentu.
const STARY_KSEF = '1234563218-20261010-0A1B2C3D4E5F-01';
const LOG_KSEF = 'dokument jest w KSeF';
const bezNumeruKsef = { ksef_status: null, ksef_numer: null, ksef_sprawdzona_at: null, ksef_odczyt: null };
const logZ = (db, id) => db.prepare('SELECT akcja, wynik FROM log WHERE zamowienie_id = ?').all(id);
const swiezaDlaCzuwacza = (db, id) => db.prepare('UPDATE faktury SET utworzona_at = ? WHERE zamowienie_id = ?')
  .run(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), id);

/** Program, który w trakcie pytania o dokument „widzi” przepięcie wiersza i odpowiada o STAREJ fakturze. */
function programPrzepinajacyWTrakcie(db, id) {
  return {
    ...programTf(),
    pobierzFakture: vi.fn(async (dok) => {
      expect(dok).toBe(STARY_DOK);
      przepnij(db, id);
      return { numer: STARY_NUMER, ksefNumer: STARY_KSEF };
    }),
  };
}

describe('zapis numeru KSeF z identyfikatorem dokumentu (wyścig z przepięciem)', () => {
  it('wiersz przepięty po odczycie: zapis ze starym dokumentem nic nie zmienia', () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db, bezNumeruKsef);
    const odczyt = wierszFaktury(db, id);
    przepnij(db, id);
    expect(zapiszNumerKsef(db, odczyt.id, { ksefNumer: STARY_KSEF, sprawdzonaAt: '2026-10-29T12:05:00.000Z', dokumentId: odczyt.dokument_id }))
      .toBe(false);
    expect(wierszFaktury(db, id)).toMatchObject({ dokument_id: NOWY_DOK, ksef_numer: null, ksef_sprawdzona_at: null, ksef_odczyt: null });
  });

  it('zgodny dokument zapisuje; bez dokumentu zapis jak dotąd; stary wiersz inFaktu (sam infakt_uuid) też zapisuje', () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db, bezNumeruKsef);
    const f = wierszFaktury(db, id);
    expect(zapiszNumerKsef(db, f.id, { ksefNumer: STARY_KSEF, sprawdzonaAt: '2026-10-29T12:05:00.000Z', dokumentId: STARY_DOK })).toBe(true);
    expect(wierszFaktury(db, id).ksef_numer).toBe(STARY_KSEF);

    const id2 = zamowienieZFaktura(db, { ...bezNumeruKsef, program: null, dokument_id: null });
    db.prepare("UPDATE faktury SET infakt_uuid = 'inf-0001' WHERE zamowienie_id = ?").run(id2);
    const f2 = wierszFaktury(db, id2);
    expect(zapiszNumerKsef(db, f2.id, { ksefNumer: 'KS-INF-1', sprawdzonaAt: '2026-10-29T12:05:00.000Z', dokumentId: 'inf-0001' })).toBe(true);
    expect(wierszFaktury(db, id2).ksef_numer).toBe('KS-INF-1');

    const id3 = zamowienieZFaktura(db, bezNumeruKsef);
    const f3 = wierszFaktury(db, id3);
    expect(zapiszNumerKsef(db, f3.id, { ksefNumer: 'KS-3', sprawdzonaAt: '2026-10-29T12:05:00.000Z' })).toBe(true);
    expect(wierszFaktury(db, id3).ksef_numer).toBe('KS-3');
  });

  it('czuwacz: przepięcie w trakcie pytania → numer starej nie trafia do wiersza, brak wpisu „jest w KSeF”', async () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db, bezNumeruKsef);
    swiezaDlaCzuwacza(db, id);
    const program = programPrzepinajacyWTrakcie(db, id);
    const wynik = await createCzuwaczKsef({ db, program, log: () => {} }).przebieg();
    expect(program.pobierzFakture).toHaveBeenCalledTimes(1);
    expect(wynik).toMatchObject({ sprawdzone: 1, znalezione: 0 });
    expect(wierszFaktury(db, id)).toMatchObject({ dokument_id: NOWY_DOK, numer: NOWY_NUMER, ksef_numer: null });
    expect(JSON.stringify(logZ(db, id))).not.toContain(LOG_KSEF);
  });

  it('doczytanie na karcie: przepięcie w trakcie pytania → false, numer starej nie trafia do wiersza', async () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db, bezNumeruKsef);
    const program = programPrzepinajacyWTrakcie(db, id);
    const doczytanie = createDoczytanieKsef({ db, program, teraz: () => '2026-10-29T12:05:00.000Z' });
    expect(await doczytanie.dlaFaktury(pobierzZamowienie(db, id).faktura, id)).toBe(false);
    expect(program.pobierzFakture).toHaveBeenCalledTimes(1);
    expect(wierszFaktury(db, id)).toMatchObject({ dokument_id: NOWY_DOK, ksef_numer: null });
    expect(JSON.stringify(logZ(db, id))).not.toContain(LOG_KSEF);
  });
});

// Stan D (u kupującego): stara faktura zostaje u kupującego, nowa idzie do Allegro tylko ręcznie. Wiersz zachowuje
// `allegro_wyslana_at`, więc wspólny warunek czuwacza (`allegro_wyslana_at IS NULL`) go wyklucza — czuwacz nie pyta
// o nową fakturę i nie wpisuje jej numeru KSeF. Utrwalone, bo zmiana tego warunku zmienia zachowanie zamiany.
describe('stan D: czuwacz nie wpisuje numeru KSeF nowej faktury', () => {
  for (const weryfikacja of ['WAITING', 'ACCEPTED']) {
    it(`D (${weryfikacja}): po przepięciu czuwacz o nową nie pyta, ksef_numer zostaje pusty`, async () => {
      const db = openOmsDb(':memory:');
      const id = zamowienieZFaktura(db, {
        allegro_invoice_id: STARE_ZGLOSZENIE, allegro_wyslana_at: WYSLANA, allegro_weryfikacja: weryfikacja,
      });
      swiezaDlaCzuwacza(db, id);
      przepnij(db, id);
      const program = { ...programTf(), pobierzFakture: vi.fn(async () => ({ numer: NOWY_NUMER, ksefNumer: 'KS-NOWA-D' })) };
      await createCzuwaczKsef({ db, program, log: () => {} }).przebieg();
      expect(program.pobierzFakture).not.toHaveBeenCalled();
      expect(wierszFaktury(db, id)).toMatchObject({ dokument_id: NOWY_DOK, ksef_numer: null, allegro_wyslana_at: WYSLANA });
    });
  }

  it('kontrola: ten sam wiersz bez allegro_wyslana_at czuwacz pyta i numer wpisuje', async () => {
    const db = openOmsDb(':memory:');
    const id = zamowienieZFaktura(db, { allegro_invoice_id: STARE_ZGLOSZENIE });
    swiezaDlaCzuwacza(db, id);
    przepnij(db, id);
    const program = { ...programTf(), pobierzFakture: vi.fn(async () => ({ numer: NOWY_NUMER, ksefNumer: 'KS-NOWA-B' })) };
    await createCzuwaczKsef({ db, program, log: () => {} }).przebieg();
    expect(program.pobierzFakture).toHaveBeenCalledWith(NOWY_DOK);
    expect(wierszFaktury(db, id).ksef_numer).toBe('KS-NOWA-B');
  });
});
