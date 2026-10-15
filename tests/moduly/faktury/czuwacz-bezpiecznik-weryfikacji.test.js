import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { stanWeryfikacji } from '../../../src/oms/db/stan-weryfikacji.js';
import { createCzuwaczKsef } from '../../../src/moduly/faktury/services/czuwacz-ksef.js';
import { PROG_PUSTYCH } from '../../../src/domena/bezpiecznik-weryfikacji.js';

// BEZPIECZNIK ODPYTYWANIA `GET /order/checkout-forms/{id}/invoices` (spec 2026-08-28).
//
// Powod: raport „Bledy techniczne" Allegro pokazal 6225 wywolan tego zasobu zakonczonych 400.
// Zasob jest dla nas niedostepny, a czuwacz pytal o kazda fakture CO GODZINE PRZEZ 30 DNI
// (720 razy), bo 400 nie rozstrzyga statusu i wiersz nie wychodzi z kolejki.
//
// ⚠️ TO NIE JEST WYLACZENIE ODPYTYWANIA. Intencja z 06.08 („gdy Allegro naprawi zasob, stan
// rozstrzygnie sie SAM") zostaje — zmienia sie wylacznie czestotliwosc sondy.

const GODZINA = 60 * 60 * 1000;
const START = new Date('2026-08-28T12:00:00Z');

let licznik = 0;

function zFaktura(db, { sklep = 'allegro_szkicownia', invoiceId } = {}) {
  licznik += 1;
  const id = zapiszZamowienie(db, sklep, {
    zrodlo_id: `${sklep}-${licznik}`,
    numer: String(4000 + licznik),
    klient: { first_name: 'Jan', last_name: 'Kowalski' },
    dostawa: {},
    metoda_wysylki: 'dpd',
    kwota_pobrania: null,
    chce_fakture: 1,
    nip: null,
    kwota_brutto: '100.00',
    koszt_dostawy_brutto: '0.00',
    status_woo: 'processing',
    oplacone_at: null,
    anulowane: 0,
    utworzone_at: '2026-08-05T09:00:00',
    pozycje: [],
  }, {});
  db.prepare(
    'INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, ksef_numer, allegro_invoice_id,'
    + ' allegro_wyslana_at, allegro_weryfikacja, utworzona_at) VALUES (?,?,?,?,?,?,?,?)',
  ).run(
    id, `u${licznik}`, `FV/${licznik}/2026`, `KS-${licznik}`, invoiceId ?? `INV-${licznik}`,
    new Date(Date.now() - GODZINA).toISOString(), 'WAITING', new Date(Date.now() - 2 * GODZINA).toISOString(),
  );
  return id;
}

// inFakt nie ma tu nic do roboty — kazda faktura ma juz numer KSeF, wiec wypada z pierwszej petli.
const infaktNieruszany = {
  pobierzFakture: async () => { throw new Error('pierwsza pętla nie ma tu o co pytać'); },
};

// Atrapa liczaca pytania. `odpowiedz` moze byc tablica albo funkcja (zrodloId) => tablica.
function kanaly(odpowiedz = [], kanal = 'allegro_szkicownia') {
  const pytania = [];
  return {
    pytania,
    klienci: {
      [kanal]: {
        pobierzFakturyZamowienia: async (zrodloId) => {
          pytania.push(zrodloId);
          return typeof odpowiedz === 'function' ? odpowiedz(zrodloId) : odpowiedz;
        },
      },
    },
  };
}

const wpis = (id, status = 'WAITING') => ({ id, file: { securityVerification: { status } } });
const pytanaAt = (db) => db.prepare('SELECT allegro_pytana_at FROM faktury ORDER BY id').all()
  .map((w) => w.allegro_pytana_at);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
  licznik = 0;
});
afterEach(() => { vi.useRealTimers(); });

describe('bezpiecznik odpytywania zasobu faktur Allegro w czuwaczu', () => {
  it('martwy zasób: jeden przebieg pyta najwyżej trzy razy, a nie o każdą fakturę', async () => {
    const db = openOmsDb(':memory:');
    for (let i = 0; i < 6; i += 1) zFaktura(db);
    const k = kanaly([]); // pusta lista = zasob martwy

    await createCzuwaczKsef({ db, infakt: infaktNieruszany, klienciKanalow: k.klienci }).przebieg();

    // ⚠️ LICZBA WPROST, nie `PROG_PUSTYCH` — i to jest decyzja. Asercja przez sama stala jest
    // TAUTOLOGIA: zmiana progu z 3 na 2 przechodzila przez CALA suite na zielono (zmierzone
    // mutacja 28.08). Prog jest zachowaniem widocznym dla Allegro, wiec ma byc przypiety
    // liczba, a jego zmiana ma ten test ZŁAMAĆ i kazac komus swiadomie ja potwierdzic.
    expect(k.pytania).toHaveLength(3);
    expect(PROG_PUSTYCH).toBe(3);
  });

  it('po progu pustych bezpiecznik zapisuje się jako OTWARTY', async () => {
    const db = openOmsDb(':memory:');
    for (let i = 0; i < 4; i += 1) zFaktura(db);
    const k = kanaly([]);

    await createCzuwaczKsef({ db, infakt: infaktNieruszany, klienciKanalow: k.klienci }).przebieg();

    expect(stanWeryfikacji(db, 'allegro_szkicownia').bezpiecznik_od).toBe(START.toISOString());
  });

  it('przebieg godzinę później NIE pyta ani razu', async () => {
    const db = openOmsDb(':memory:');
    for (let i = 0; i < 4; i += 1) zFaktura(db);
    const k = kanaly([]);
    const czuwacz = createCzuwaczKsef({ db, infakt: infaktNieruszany, klienciKanalow: k.klienci });

    await czuwacz.przebieg();
    const poPierwszym = k.pytania.length;
    vi.setSystemTime(new Date(START.getTime() + GODZINA));
    await czuwacz.przebieg();

    expect(k.pytania).toHaveLength(poPierwszym);
  });

  it('po dobie leci DOKŁADNIE JEDNA sonda, a nie cała kolejka', async () => {
    const db = openOmsDb(':memory:');
    for (let i = 0; i < 6; i += 1) zFaktura(db);
    const k = kanaly([]);
    const czuwacz = createCzuwaczKsef({ db, infakt: infaktNieruszany, klienciKanalow: k.klienci });

    await czuwacz.przebieg();
    const poPierwszym = k.pytania.length;
    vi.setSystemTime(new Date(START.getTime() + 25 * GODZINA));
    await czuwacz.przebieg();

    expect(k.pytania.length - poPierwszym).toBe(1);
  });

  it('sonda z NIEPUSTĄ odpowiedzią zamyka bezpiecznik i przywraca pełne odpytywanie', async () => {
    const db = openOmsDb(':memory:');
    for (let i = 0; i < 5; i += 1) zFaktura(db);
    let zasobZyje = false;
    const k = kanaly(() => (zasobZyje ? [wpis('INV-1')] : []));
    const czuwacz = createCzuwaczKsef({ db, infakt: infaktNieruszany, klienciKanalow: k.klienci });

    await czuwacz.przebieg();                                   // otwiera bezpiecznik
    zasobZyje = true;                                           // Allegro naprawilo zasob
    vi.setSystemTime(new Date(START.getTime() + 25 * GODZINA));
    await czuwacz.przebieg();                                   // sonda -> zamyka

    expect(stanWeryfikacji(db, 'allegro_szkicownia').bezpiecznik_od).toBe(null);

    const przedTrzecim = k.pytania.length;
    vi.setSystemTime(new Date(START.getTime() + 26 * GODZINA));
    await czuwacz.przebieg();                                   // pelne odpytywanie wraca
    expect(k.pytania.length - przedTrzecim).toBe(5);
  });

  it('wiersze POMINIĘTE nie dostają stempla — kolejka się nie zatrzymuje na tym samym', async () => {
    const db = openOmsDb(':memory:');
    for (let i = 0; i < 6; i += 1) zFaktura(db);
    const k = kanaly([]);

    await createCzuwaczKsef({ db, infakt: infaktNieruszany, klienciKanalow: k.klienci }).przebieg();

    const stemple = pytanaAt(db);
    expect(stemple.filter(Boolean)).toHaveLength(3);
    expect(stemple.filter((s) => s === null)).toHaveLength(3);
  });

  it('bezpiecznik jednego kanału NIE zamyka odpytywania drugiego', async () => {
    const db = openOmsDb(':memory:');
    for (let i = 0; i < 4; i += 1) zFaktura(db, { sklep: 'allegro_szkicownia' });
    for (let i = 0; i < 2; i += 1) zFaktura(db, { sklep: 'allegro_amarka' });

    const pytaniaDrugiego = [];
    const klienci = {
      ...kanaly([]).klienci,
      allegro_amarka: {
        pobierzFakturyZamowienia: async (z) => { pytaniaDrugiego.push(z); return [wpis('INV-X')]; },
      },
    };

    await createCzuwaczKsef({ db, infakt: infaktNieruszany, klienciKanalow: klienci }).przebieg();

    expect(pytaniaDrugiego).toHaveLength(2);
    expect(stanWeryfikacji(db, 'allegro_amarka').bezpiecznik_od).toBe(null);
  });

  it('RZUT nie otwiera bezpiecznika — to błąd inny niż 400 i nie dowodzi, że zasób jest martwy', async () => {
    // ⚠️ `pobierzFakturyZamowienia` ulaskawia 400 i oddaje `[]`, więc do `catch` trafia
    // WYŁĄCZNIE coś innego: zerwana sieć, 5xx, timeout. Liczenie tego jako „pustka" otwierałoby
    // bezpiecznik z niewłaściwego powodu i uciszało odpytywanie przy chwilowej awarii łącza.
    const db = openOmsDb(':memory:');
    for (let i = 0; i < 4; i += 1) zFaktura(db);
    const pytania = [];
    const klienci = {
      allegro_szkicownia: {
        pobierzFakturyZamowienia: async (z) => {
          pytania.push(z);
          throw new Error('Allegro: HTTP 503 przy /order/checkout-forms/x/invoices');
        },
      },
    };

    await createCzuwaczKsef({ db, infakt: infaktNieruszany, klienciKanalow: klienci }).przebieg();

    expect(pytania).toHaveLength(4);
    expect(stanWeryfikacji(db, 'allegro_szkicownia')).toBeUndefined();
  });

  it('działający zasób: bezpiecznik się nie otwiera i zachowanie jest dokładnie jak dotąd', async () => {
    const db = openOmsDb(':memory:');
    for (let i = 0; i < 6; i += 1) zFaktura(db);
    const k = kanaly([wpis('INV-1')]);

    await createCzuwaczKsef({ db, infakt: infaktNieruszany, klienciKanalow: k.klienci }).przebieg();

    expect(k.pytania).toHaveLength(6);
    expect(stanWeryfikacji(db, 'allegro_szkicownia').bezpiecznik_od).toBe(null);
  });
});
