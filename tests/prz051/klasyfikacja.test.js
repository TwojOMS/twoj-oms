// PRZ-051 — klasyfikacja wiersza listy: jedna reguła (funkcje domeny), czas jako parametr,
// chwile przejścia zamiast przeliczania całej tabeli przy każdym otwarciu listy.
import { describe, it, expect, beforeAll } from 'vitest';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { zamowieniaPoId } from '../../src/oms/db/zamowienia.js';
import { doZrobienia, wyliczStatus } from '../../src/domena/status.js';
import { wiekZamowienia } from '../../src/domena/wiek-zamowienia.js';
import { pasujeDoFiltrow, pasujaKlucze } from '../../src/domena/filtry-listy.js';
import { pasujeDoSzukania, pasujePola } from '../../src/domena/szukanie.js';
import { klasyfikacjaListy, pierwszaChwila, HORYZONT_KLASYFIKACJI_MS } from '../../src/domena/klasyfikacja-listy.js';
import { wstawMieszane } from './pomoc.js';

const DZIEN = 86400000;
const T0 = Date.parse('2026-10-01T09:30:00Z');
// Chwile próbne: gęsto na początku (progi minutowe faktury/nadania), potem co kilka godzin
// przez cały horyzont, plus granice północy i 12:00 w Warszawie.
const PROBY = [0, 1, 1000, 4 * 60000, 5 * 60000 - 1, 5 * 60000, 5 * 60000 + 1, 3600000,
  ...Array.from({ length: 200 }, (_, i) => Math.round((i + 1) * (HORYZONT_KLASYFIKACJI_MS / 201))),
  ...Array.from({ length: 30 }, (_, i) => Date.parse('2026-10-01T22:00:00Z') - T0 + i * DZIEN),
  ...Array.from({ length: 30 }, (_, i) => Date.parse('2026-10-01T10:00:00Z') - T0 + i * DZIEN)];

let zamowienia; let rodzaje;
beforeAll(() => {
  const db = openOmsDb(':memory:');
  const wstawione = wstawMieszane(db, { powtorzen: 2 });
  rodzaje = new Map(wstawione.map((w) => [w.id, w.rodzaj]));
  // PRZ-104: DRUGA kopia każdego rodzaju dostaje ręczną datę wysyłki (przeszłą, bliską, daleką,
  // także weekendową) — reguła z ręczną datą też musi być monotoniczna, inaczej indeks kłamie.
  // Pierwsza kopia zostaje bez daty: na niej stoi test gałęzi standardowego terminu niżej
  // (tam `find` pomija zamówienia z ręczną datą — lista nie idzie w kolejności wstawiania).
  const daty = ['2026-09-28', '2026-10-02', '2026-10-03', '2026-10-09', '2026-11-20'];
  const widziane = new Set();
  let n = 0;
  for (const w of wstawione) {
    if (!widziane.has(w.rodzaj)) { widziane.add(w.rodzaj); continue; }
    db.prepare('UPDATE zamowienia SET termin_wysylki_reczny = ? WHERE id = ?').run(daty[n % daty.length], w.id);
    n += 1;
  }
  zamowienia = zamowieniaPoId(db, db.prepare('SELECT id FROM zamowienia').all().map((w) => w.id), { bezSurowych: true });
  db.close();
});

const poTerminieW = (z, t) => wiekZamowienia(z, new Date(t))?.poTerminie === true;

describe('PRZ-051 reguły listy w czasie', () => {
  it('doZrobienia przyjmuje chwilę: faktura w toku staje się sprawą po 5 minutach', () => {
    const z = { anulowane: 0, wyslane_at: '2026-09-25T10:00:00Z', przesylki: [], zwroty: [],
      faktura: { ksef_status: 'w_toku', utworzona_at: '2026-10-01T09:30:00Z' } };
    expect(doZrobienia(z, T0 + 4 * 60000)).toBe(false);
    expect(doZrobienia(z, T0 + 5 * 60000)).toBe(true);
  });

  it('obie reguły są monotoniczne w czasie (raz prawda — prawda do końca horyzontu)', () => {
    for (const z of zamowienia) {
      let rob = false; let termin = false;
      for (const dt of [...PROBY].sort((a, b) => a - b)) {
        const r = doZrobienia(z, T0 + dt); const p = poTerminieW(z, T0 + dt);
        expect(!rob || r, `doZrobienia ${z.numer} cofnęło się w ${dt}`).toBe(true);
        expect(!termin || p, `poTerminie ${z.numer} cofnęło się w ${dt}`).toBe(true);
        rob = r; termin = p;
      }
    }
  });

  it('pierwszaChwila znajduje pierwszą milisekundę prawdy, null gdy jej nie ma', () => {
    expect(pierwszaChwila((t) => t >= 1234567, 0, 10 ** 9)).toBe(1234567);
    expect(pierwszaChwila(() => true, 500, 10 ** 9)).toBe(500);
    expect(pierwszaChwila(() => false, 0, 10 ** 9)).toBe(null);
  });

  it('klasyfikacja = reguły domeny w KAŻDEJ chwili horyzontu (status, zakładki, filtry, fraza)', () => {
    const filtry = [{}, { od: '2026-09-15' }, { do: '2026-09-15' }, { wysylka: 'dpd' }, { wysylka: 'nieznana' },
      { platnosc: 'blik' }, { platnosc: 'Przelew tradycyjny' }, { kanal: 'kanal_b' }, { kanal: 'indywidualne' },
      { od: '2026-09-12', do: '2026-09-20', kanal: 'kanal_a', wysylka: 'inpost_paczkomat' }];
    const frazy = ['kowalski', 'peki', 'PĘKI', 'zazolc1', 'M-1', 'produkt 3', 'l1', 'sku-2 kowalski', '000', 'brak-takiego'];
    let sprawdzone = 0;
    for (const z of zamowienia) {
      const k = klasyfikacjaListy(z, T0);
      expect(k.status).toBe(wyliczStatus(z));
      expect(k.wazne_do).toBe(T0 + HORYZONT_KLASYFIKACJI_MS);
      for (const dt of PROBY) {
        const t = T0 + dt;
        expect(k.robocze_od !== null && k.robocze_od <= t, `robocze ${z.numer} @${dt}`).toBe(doZrobienia(z, t));
        expect(k.po_terminie_od !== null && k.po_terminie_od <= t, `termin ${z.numer} @${dt}`).toBe(poTerminieW(z, t));
        sprawdzone++;
      }
      for (const f of filtry) expect(pasujaKlucze(k.filtr, f), JSON.stringify(f)).toBe(pasujeDoFiltrow(z, f));
      for (const fr of frazy) expect(pasujePola(k.szukaj, fr), fr).toBe(pasujeDoSzukania(z, fr));
    }
    expect(sprawdzone).toBeGreaterThan(5000);
    // Zestaw ma przejścia w horyzoncie — inaczej test niczego by nie dowodził.
    expect(zamowienia.some((z) => { const k = klasyfikacjaListy(z, T0); return k.robocze_od > T0; })).toBe(true);
    expect(zamowienia.some((z) => { const k = klasyfikacjaListy(z, T0); return k.po_terminie_od > T0; })).toBe(true);
    // …także wśród zamówień z ręczną datą (PRZ-104).
    expect(zamowienia.some((z) => z.termin_wysylki_reczny && klasyfikacjaListy(z, T0).po_terminie_od > T0)).toBe(true);
  });

  it('każda gałąź reguł zależna od czasu ma w zestawie zamówienie, które przechodzi w horyzoncie', () => {
    const przejscia = {
      'allegro-przed-12': 'po_terminie_od', 'pobranie-swieze': 'po_terminie_od', 'b2b-swieze': 'po_terminie_od',
      'ekspres-oplacone': 'po_terminie_od', 'indywidualne-oplacone': 'po_terminie_od', 'oplacone-swiezo': 'po_terminie_od',
      'paczka-w-trakcie': 'robocze_od', 'paczka-stanie': 'robocze_od', 'faktura-swiezo-w-toku': 'robocze_od',
    };
    for (const [rodzaj, pole] of Object.entries(przejscia)) {
      const z = zamowienia.find((x) => rodzaje.get(x.id) === rodzaj && !x.termin_wysylki_reczny);
      const k = klasyfikacjaListy(z, T0);
      expect(k[pole], rodzaj).toBeGreaterThan(T0);
      expect(k[pole], rodzaj).toBeLessThan(T0 + HORYZONT_KLASYFIKACJI_MS);
    }
    // Różne limity terminu dają ROSNĄCE chwile (0 < 1 < 2 < 7 dni roboczych) — inaczej te
    // przypadki mierzyłyby jedną gałąź.
    const termin = (r) => klasyfikacjaListy(zamowienia.find((x) => rodzaje.get(x.id) === r && !x.termin_wysylki_reczny), T0).po_terminie_od;
    const kolejne = ['allegro-przed-12', 'oplacone-swiezo', 'ekspres-oplacone', 'indywidualne-oplacone'].map(termin);
    for (let k = 1; k < kolejne.length; k++) expect(kolejne[k]).toBeGreaterThan(kolejne[k - 1]);
  });
});
