// Gość wchodzący do demo widzi u góry listy trzy ustalone zamówienia — Allegro One Kurier, sklep z DPD i fakturą,
// ERLI z paczkomatem — niezależnie od godziny resetu. Generator i atrapa ERLI liczą czas od jednej kotwicy
// (ostatnia chwila dnia demo), a nie każdy od innego zegara.
import { afterEach, expect, it, vi } from 'vitest';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { zbudujAplikacje } from '../../src/core/aplikacja.ts';
import { modulyPiaskownicy, nadpisaniaPiaskownicy } from '../../deploy/proba/atrapy/index.mjs';
import { createAtrapaErli } from '../../deploy/proba/atrapy/erli.mjs';
import { ENV_DEMO, KANALY_DEMO, wygenerujDaneDemo } from '../../scripts/demo-dane.mjs';
import { MODULY_KANALOW, ustawRejestrKanalow } from '../../src/domena/moduly-kanalow.ts';
import { indeksListy } from '../../src/oms/db/indeks-listy.js';
import { drogaErliDlaZamowienia } from '../../src/moduly/kanaly/services/kanal-erli.ts';

const DZIS = '2026-11-11';
const ERLI = 'erli_polcien';

let db, aplikacja;
afterEach(async () => {
  await aplikacja?.app.close();
  aplikacja = null;
  db?.close();
  db = null;
  ustawRejestrKanalow(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Chwile zasiewu atrapy (czas w Polsce, listopad = UTC+1): tuż po północy, rano o „teraz” demo i wieczorem.
it.each([
  ['00:20', '2026-11-10T23:20:00Z'],
  ['06:30', '2026-11-11T05:30:00Z'],
  ['21:02', '2026-11-11T20:02:00Z'],
])(
  'reset demo o %s: góra listy to Allegro One Kurier, sklep DPD z fakturą, ERLI z paczkomatem',
  async (_, chwila) => {
    const zegar = new Date(chwila);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(zegar);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Test: sieć zabroniona'));
    const env = { ...ENV_DEMO };
    const moduly = modulyPiaskownicy(env, { baza: () => db });
    db = openOmsDb(':memory:', { moduly });
    wygenerujDaneDemo(db, { dzis: DZIS, env });
    // Zasiew atrapy ERLI ze wstrzykniętym zegarem — tak, jak zrobi to piaskownica po resecie.
    createAtrapaErli({ db, kanal: ERLI, env, teraz: () => zegar, demoZmiany: true });
    aplikacja = await zbudujAplikacje({
      db,
      env,
      moduly: moduly.filter((m) => ['rdzen', 'kanaly'].includes(m.nazwa)),
      nadpisania: nadpisaniaPiaskownicy({ db, env, log: () => {} }),
      teraz: () => zegar,
      log: () => {},
    });
    ustawRejestrKanalow((k) => (k === ERLI ? 'erli' : null), MODULY_KANALOW);
    await aplikacja.usluga('kanaly', 'rejestrKanalow').przebiegZamowien();
    expect(db.prepare('SELECT COUNT(*) AS n FROM zamowienia WHERE sklep = ?').get(ERLI).n).toBeGreaterThan(0);

    // To samo zapytanie, którym lista otwiera domyślny widok („Do zrobienia”, bez filtrów).
    const indeks = indeksListy(db);
    const terazMs = zegar.getTime();
    await indeks.odswiez(terazMs);
    const { ids } = indeks.strona({
      zakladka: { rodzaj: 'robocze' },
      filtry: {},
      szukaj: '',
      offset: 0,
      limit: 3,
      teraz: terazMs,
    });
    const gora = ids.map((id) => db.prepare('SELECT * FROM zamowienia WHERE id = ?').get(id));
    const opis = gora.map((z) => `${z.sklep} | ${z.metoda_wysylki} | ${z.metoda_wysylki_nazwa} | ${z.utworzone_at}`);
    const sklep = KANALY_DEMO.find((k) => k.typ === 'woo').klucz;

    expect(gora, opis.join('\n')).toHaveLength(3);
    expect(gora[0].sklep, opis[0]).toBe('allegro');
    expect(gora[0].metoda_wysylki_nazwa, opis[0]).toBe('Allegro One Kurier');
    expect(gora[1].sklep, opis[1]).toBe(sklep);
    expect(gora[1].metoda_wysylki_nazwa, opis[1]).toBe('Kurier DPD');
    expect(gora[1].chce_fakture, opis[1]).toBe(1);
    expect(gora[2].sklep, opis[2]).toBe(ERLI);
    // Lista rozpoznaje drogę ERLI tak samo (turkusowa plakietka ERLI), a punkt odbioru robi z niej paczkomat.
    const dostawaErli = JSON.parse(gora[2].surowe_json).delivery;
    expect(dostawaErli.typeId, opis[2]).toBe('erliPaczkomat');
    expect(dostawaErli.pickupPlace?.externalId, opis[2]).toBeTruthy();
    expect(drogaErliDlaZamowienia(db, gora[2])?.droga, opis[2]).toBe('przesylki_erli');
    // Wszystkie trzy „Nowe” i opłacone — gość od razu nada paczkę, a przy sklepie wystawi fakturę.
    for (const [i, z] of gora.entries()) {
      expect(z.oplacone_at, opis[i]).toBeTruthy();
    }
    const statusy = db
      .prepare(`SELECT status FROM lista_stan WHERE zamowienie_id IN (${ids.join(',')}) ORDER BY utworzone_at DESC`)
      .all()
      .map((w) => w.status);
    expect(statusy).toEqual(['nowe', 'nowe', 'nowe']);

    // Reszta generatora jest starsza niż trzy minuty przed końcem dnia demo — nic nie wciśnie się między górę listy.
    const koniecDnia = Date.parse(gora[0].utworzone_at) + 60000;
    const mlodsze = db
      .prepare('SELECT numer, utworzone_at FROM zamowienia WHERE sklep != ? AND id NOT IN (?, ?)')
      .all(ERLI, gora[0].id, gora[1].id)
      .filter((z) => Date.parse(z.utworzone_at) >= koniecDnia - 5 * 60000);
    expect(mlodsze).toEqual([]);
  },
  120_000,
);
