import { describe, it, expect } from 'vitest';
import { SUFIT_FAKTUR_HURTEM } from '../../../src/domena/masowe.js';
import {
  AUTH, POST, zamowienie, serwer, cialo,
} from './_hurtem-pomocniki.js';

/**
 * Identyfikatory, ktore ekran podgladu poda do zatwierdzenia — W KOLEJNOSCI RENDEROWANIA.
 * Czytamy je z ukrytych pol formularza zatwierdzajacego, bo to JEDYNA rzecz, ktora podglad
 * naprawde obiecuje operatorowi. `name="id"` wystepuje w widokach panelu wylacznie w polach
 * zaznaczenia listy i w tym formularzu, wiec na tym ekranie nie ma z czym tego pomylic.
 */
const idZPodgladu = (body) => [...body.matchAll(/name="id" value="(\d+)"/g)].map((m) => Number(m[1]));

const logZ = (db, id) => db.prepare('SELECT akcja, wynik FROM log WHERE zamowienie_id = ? ORDER BY id').all(id);

/**
 * Numer zamowienia zlozony WYLACZNIE z liter (A, B, … Z, AA, …).
 *
 * ⚠️ Zadnej cyfry w numerze — i to nie jest kaprys. Test sufitu szuka w tresci ekranu liczby
 * z komunikatu; numer w rodzaju „Z25" wstawialby te sama liczbe na ekran NIEZALEZNIE od tego,
 * czy komunikat w ogole powstal, i asercja przechodzilaby przypadkiem.
 */
const literami = (i) => {
  let s = '';
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
};

/** Fragment komunikatu o suficie — TRESC, nie sama liczba, ktora trafia sie na ekranie i tak. */
const KOMUNIKAT_SUFITU = new RegExp(`najwyżej ${SUFIT_FAKTUR_HURTEM} faktur`);

/** Zaznaczenie o JEDNO zamowienie ponad sufit — same zdatne do fakturowania. */
function ponadSufit(db) {
  const ids = [];
  for (let i = 0; i < SUFIT_FAKTUR_HURTEM + 1; i += 1) {
    ids.push(zamowienie(db, { numer: literami(i), zrodlo: 100 + i, oplacone: true }));
  }
  return ids;
}

describe('trasy faktur hurtem', () => {
  // ⚠️ TEN TEST JEST CALYM POWODEM ISTNIENIA EKRANU PODGLADU. Podglad i wykonanie musza
  // wolac TE SAMA `podzielDoFaktury` na tej samej `wczytajListe()`. Rozjazd miedzy nimi
  // znaczy, ze czlowiek zatwierdza co innego, niz zobaczyl — na ekranie o dokumentach
  // ksiegowych.
  //
  // ⚠️ Porownujemy DWIE KONKRETNE LISTY, a nie „obie sa niepuste": zbior identyfikatorow
  // obiecany przez podglad musi byc rowny (co do skladu I KOLEJNOSCI) temu, ktory dostala
  // usluga wystawiajaca. Test upada, gdy ktorakolwiek z tras policzy podzial sama, zapyta
  // baze osobno po identyfikatorach albo przestawi kolejnosc (a ta wyznacza numeracje faktur).
  it('podglad obiecuje dokladnie te zamowienia, ktore dostaje usluga wystawiajaca', async () => {
    let dostane = null;
    const { app, db } = serwer({
      wystawWiele: async (lista) => {
        dostane = lista.map((z) => ({ id: z.id, numer: z.numer }));
        return { wystawione: lista.map((z) => ({ id: z.id, numer: z.numer, numerFaktury: 'F' })), bledy: [], nietkniete: [] };
      },
    });
    const a = zamowienie(db, { numer: 'A', zrodlo: 1, oplacone: true });
    const b = zamowienie(db, { numer: 'B', zrodlo: 2, oplacone: false });
    const c = zamowienie(db, { numer: 'C', zrodlo: 3, oplacone: true });

    const podglad = await app.inject({
      method: 'POST', url: '/zamowienia/faktury-hurtem/podglad', headers: POST, payload: cialo([a, b, c]),
    });
    expect(podglad.statusCode).toBe(200);
    expect(idZPodgladu(podglad.body)).toEqual([a, c]);
    // ⚠️⚠️ PODGLAD NIE DOTYKA inFAKTU — I TO JEST CALY POWOD, DLA KTOREGO TEN EKRAN
    // ISTNIEJE. Bez tej asercji trasa podgladu moglaby wystawiac PRAWDZIWE faktury,
    // a suita swiecilaby na zielono: szpieg ustawiony przy podgladzie i tak zostaje
    // zaraz nadpisany przez wywolanie wykonania. Sprawdzamy go WLASNIE TU, przed nim.
    expect(dostane).toBeNull();
    // Pominiete ma byc wymienione RAZEM Z POWODEM, a nie sama liczba — i powod ma stac
    // PRZY SWOIM numerze, a nie gdziekolwiek na stronie (sama litera „B" trafia sie
    // w szablonie ukladu).
    expect(podglad.body).toMatch(/<b>B<\/b> — [^<]*wpłat/i);

    const wynik = await app.inject({
      method: 'POST', url: '/zamowienia/faktury-hurtem', headers: POST, payload: cialo([a, b, c]),
    });
    expect(wynik.statusCode).toBe(200);
    expect(dostane).toEqual([{ id: a, numer: 'A' }, { id: c, numer: 'C' }]);
    // Ta sama obietnica z drugiej strony: identyfikatory z podgladu === identyfikatory,
    // ktore poszly do wystawienia.
    expect(dostane.map((z) => z.id)).toEqual(idZPodgladu(podglad.body));
  });

  // ⚠️ BARIERA ARYTMETYCZNA W PODGLADZIE (recenzja 12.08.2026). Do tego dnia zamowienie
  // z rozjechana suma stawalo w sekcji „Pójdzie do inFaktu", operator je zatwierdzal, a ono
  // ladowalo w „Nie udało się" — bo prawdziwa bariera (`sprawdzSumeDokumentu` w `wystaw()`)
  // odmawiala dopiero tam. Zaden dokument nie powstawal, ale EKRAN OBIECYWAL COS, CZEGO
  // TRASA NA PEWNO NIE ZROBI.
  //
  // Test idzie PRZEZ TRASE, bo tylko tu widac obie strony naraz: czego podglad nie obiecal
  // i czego usluga nie dostala. Zamowienie ma DWIE pozycje — jedna poprawna i jedna psujaca
  // sume — zeby blad siedzial w sumowaniu, a nie w pojedynczej wartosci.
  it('zamowienie z rozjechana suma nie trafia ani na podglad, ani do uslugi — a powod stoi przy jego numerze', async () => {
    let dostane = null;
    const { app, db } = serwer({
      wystawWiele: async (lista) => {
        dostane = lista.map((z) => ({ id: z.id, numer: z.numer }));
        return { wystawione: [], bledy: [], nietkniete: [] };
      },
    });
    const dobre = zamowienie(db, { numer: 'A', zrodlo: 1, oplacone: true });
    // `kwota_brutto` fixture'u to 100.00, a pozycje sumuja sie do 140.00 — rozjazd o 40 zl.
    const rozjazd = zamowienie(db, {
      numer: 'B',
      zrodlo: 2,
      oplacone: true,
      pozycje: [
        {
          nazwa: 'STOP 70x100', sku: 'S1', ilosc: 1, cena_brutto: '100.00', brutto_linii: '100.00', vat: null,
        },
        {
          nazwa: 'Dopisek', sku: 'S2', ilosc: 1, cena_brutto: '40.00', brutto_linii: '40.00', vat: null,
        },
      ],
    });

    const podglad = await app.inject({
      method: 'POST', url: '/zamowienia/faktury-hurtem/podglad', headers: POST, payload: cialo([dobre, rozjazd]),
    });
    expect(idZPodgladu(podglad.body)).toEqual([dobre]);
    expect(podglad.body).toMatch(/<b>B<\/b> — [^<]*sumują się/i);

    const wynik = await app.inject({
      method: 'POST', url: '/zamowienia/faktury-hurtem', headers: POST, payload: cialo([dobre, rozjazd]),
    });
    expect(wynik.statusCode).toBe(200);
    expect(dostane).toEqual([{ id: dobre, numer: 'A' }]);
  });

  // ⚠️ Budzet czasu (services/faktura-hurtem.js) ma obejmowac TAKZE odczyt bazy i podzial,
  // bo liczy sie od przyjscia zadania — czekanie czlowieka zaczyna sie od klikniecia, nie od
  // pierwszej faktury. `start` inny niz liczba (brak, `null`, napis ISO) usluga przelyka po
  // cichu — dlatego pilnuje tego test trasy, a nie usluga.
  it('podaje uslugowe `start` jako liczbe milisekund z chwili przyjscia zadania', async () => {
    let start;
    const { app, db } = serwer({
      wystawWiele: async (lista, opcje) => {
        start = opcje?.start;
        return { wystawione: [], bledy: [], nietkniete: lista.map((z) => ({ id: z.id, numer: z.numer })) };
      },
    });
    const a = zamowienie(db, { numer: 'A', zrodlo: 1, oplacone: true });

    const przed = Date.now();
    const r = await app.inject({ method: 'POST', url: '/zamowienia/faktury-hurtem', headers: POST, payload: cialo([a]) });
    const po = Date.now();

    expect(r.statusCode).toBe(200);
    expect(typeof start).toBe('number');
    expect(Number.isFinite(start)).toBe(true);
    expect(start).toBeGreaterThanOrEqual(przed);
    expect(start).toBeLessThanOrEqual(po);
  });

  // Kazda proba — udana i nieudana — ma zostawic slad w logu zamowienia. To najgrozniejsza
  // akcja w panelu; „nie wiadomo, czy panel probowal" jest tu stanem niedopuszczalnym.
  it('zapisuje log przy wystawionej fakturze I przy bledzie', async () => {
    const { app, db } = serwer({
      wystawWiele: async (lista) => ({
        wystawione: [{ id: lista[0].id, numer: lista[0].numer, numerFaktury: 'FV/1/2026' }],
        bledy: [{ id: lista[1].id, numer: lista[1].numer, powod: 'inFakt odmowil' }],
        nietkniete: [],
      }),
    });
    const a = zamowienie(db, { numer: 'A', zrodlo: 1, oplacone: true });
    const b = zamowienie(db, { numer: 'B', zrodlo: 2, oplacone: true });

    await app.inject({ method: 'POST', url: '/zamowienia/faktury-hurtem', headers: POST, payload: cialo([a, b]) });

    expect(logZ(db, a)).toEqual([{ akcja: 'faktura.masowa', wynik: expect.stringContaining('FV/1/2026') }]);
    const logB = logZ(db, b);
    expect(logB).toHaveLength(1);
    expect(logB[0].akcja).toBe('faktura.masowa');
    expect(logB[0].wynik).toContain('inFakt odmowil');
    expect(logB[0].wynik).toMatch(/BŁĄD/);
  });

  // ⚠️ ODMOWA JEST TWARDA NA TRASIE WYKONANIA, a nie samym ukryciem przycisku na podgladzie:
  // miedzy podgladem a zatwierdzeniem operator mogl otworzyc druga zakladke.
  it('odmawia partii ponad sufit i nie wystawia niczego', async () => {
    let wolane = false;
    const { app, db } = serwer({ wystawWiele: async () => { wolane = true; return { wystawione: [], bledy: [], nietkniete: [] }; } });
    const ids = ponadSufit(db);
    const r = await app.inject({ method: 'POST', url: '/zamowienia/faktury-hurtem', headers: POST, payload: cialo(ids) });
    expect(r.statusCode).toBe(200);
    // TRESC komunikatu, nie sama liczba: liczba trafia sie na ekranie takze z innych powodow.
    expect(r.body).toMatch(KOMUNIKAT_SUFITU);
    expect(wolane).toBe(false);
  });

  // Ta sama odmowa musi byc WIDOCZNA juz na podgladzie — inaczej operator klika w ekran,
  // ktory i tak odmowi.
  it('podglad tez mowi o przekroczonym suficie, nie oferuje zatwierdzenia i nic nie wystawia', async () => {
    let wolane = false;
    const { app, db } = serwer({ wystawWiele: async () => { wolane = true; return { wystawione: [], bledy: [], nietkniete: [] }; } });
    const ids = ponadSufit(db);
    const r = await app.inject({ method: 'POST', url: '/zamowienia/faktury-hurtem/podglad', headers: POST, payload: cialo(ids) });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(KOMUNIKAT_SUFITU);
    expect(idZPodgladu(r.body)).toEqual([]);
    expect(wolane).toBe(false);
  });

  // Panel bez inFaktu — druga strona tej samej odmowy, co 503 nizej: podglad ma powiedziec
  // wprost, ze nie ma czym wystawiac, i NIE MA PRAWA oferowac zatwierdzenia.
  it('podglad bez podpietego inFaktu nie oferuje zatwierdzenia', async () => {
    const { app, db } = serwer({ fakturaHurtem: null });
    const a = zamowienie(db, { numer: 'A', zrodlo: 1, oplacone: true });
    const r = await app.inject({ method: 'POST', url: '/zamowienia/faktury-hurtem/podglad', headers: POST, payload: cialo([a]) });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/nie jest skonfigurowane/i);
    expect(idZPodgladu(r.body)).toEqual([]);
  });

  it('bez zaznaczenia niczego nie wystawia', async () => {
    let wolane = false;
    const { app } = serwer({ wystawWiele: async () => { wolane = true; return { wystawione: [], bledy: [], nietkniete: [] }; } });
    const r = await app.inject({ method: 'POST', url: '/zamowienia/faktury-hurtem', headers: POST, payload: '' });
    expect(r.statusCode).toBe(200);
    expect(wolane).toBe(false);
  });

  // Panel bez inFaktu to tryb POPRAWNY (ta sama zasada, co przy nadaniu bez DPD): trasa ma
  // odmowic czytelnie, a nie wywalic sie na `undefined.wystawWiele`.
  it('bez podpietego inFaktu odmawia czytelnie, zamiast sie wywalic', async () => {
    const { app, db } = serwer({ fakturaHurtem: null });
    const a = zamowienie(db, { numer: 'A', zrodlo: 1, oplacone: true });
    const r = await app.inject({ method: 'POST', url: '/zamowienia/faktury-hurtem', headers: POST, payload: cialo([a]) });
    expect(r.statusCode).toBe(503);
  });

  it('wymaga logowania', async () => {
    const { app } = serwer();
    const r = await app.inject({ method: 'POST', url: '/zamowienia/faktury-hurtem', payload: '' });
    expect(r.statusCode).toBe(401);
  });

  it('lista ma przycisk prowadzacy na ekran podgladu', async () => {
    const { app } = serwer();
    const r = await app.inject({ method: 'GET', url: '/', headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('formaction="/zamowienia/faktury-hurtem/podglad"');
    expect(r.body).toMatch(/Wystaw faktury/);
  });
});
