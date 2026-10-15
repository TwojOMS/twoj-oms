import { describe, it, expect } from 'vitest';
import { SUFIT_FAKTUR_HURTEM } from '../../../src/domena/masowe.js';
import {
  POST, zamowienie, serwer, cialo,
} from './_hurtem-pomocniki.js';

/**
 * Numer zamowienia zlozony WYLACZNIE z liter (A, B, … Z, AA, …) — ten sam wzorzec, co w
 * faktury-hurtem-trasy.test.js. Zadnej cyfry w numerze, zeby przy 12 zamowieniach numer
 * (np. „L") nie mogl przypadkiem dopisac sie do liczby „12" w asercji na odmiane liczebnika.
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

describe('ekrany podgladu i wyniku faktur hurtem', () => {
  it('podglad wymienia numer zamowienia, kwote i liczbe faktur do wystawienia', async () => {
    const { app, db } = serwer();
    const a = zamowienie(db, { numer: 'A', zrodlo: 1, oplacone: true });
    const r = await app.inject({
      method: 'POST', url: '/zamowienia/faktury-hurtem/podglad', headers: POST, payload: cialo([a]),
    });
    // ⚠️ NIE `toContain('A')`: samo „A" trafia sie na tej stronie dziesiatki razy (nawigacja,
    // naglowki), wiec taka asercja przechodzilaby, nawet gdyby numer zamowienia zniknal
    // z widoku. Kotwiczymy do znacznika, w ktorym widok faktycznie renderuje numer.
    expect(r.body).toContain('<b>A</b>');
    expect(r.body).toContain('100.00');
    expect(r.body).toMatch(/1 faktur/);
  });

  // ⚠️ WYJATEK 12/13/14 W ODMIANIE LICZEBNIKA. `ile()` w widoku ma regule „12, 13, 14 ida
  // do formy mnogiej mimo koncowek 2/3/4" (ta sama, co w views/faktury.ejs) — bez niej ten
  // ekran napisalby „12 faktury" zamiast „12 faktur". Zaden inny test w tym pliku nie
  // renderuje wiecej niz dwoch zamowien, wiec bez tego testu usuniecie wyjatku przeszloby
  // przez zielona suite. `\b` po „faktur” odrzuca „12 faktury” (nie ma granicy slowa
  // miedzy „r” a „y”), wiec asercja lapie wlasnie te forme, a nie sama obecnosc podciagu.
  it('odmienia liczebnik poprawnie przy 12 zamowieniach (wyjatek 12-14 -> forma mnoga)', async () => {
    const { app, db } = serwer();
    const ids = [];
    for (let i = 0; i < 12; i += 1) {
      ids.push(zamowienie(db, { numer: literami(i), zrodlo: 300 + i, oplacone: true }));
    }
    const r = await app.inject({
      method: 'POST', url: '/zamowienia/faktury-hurtem/podglad', headers: POST, payload: cialo(ids),
    });
    expect(r.body).toMatch(/12 faktur\b/);
  });

  // ⚠️ POWOD, A NIE SAMA LICZBA. „Pominieto 3" kaze operatorowi szukac winowajcy wsrod
  // dwudziestu zaznaczen; powod przy numerze konczy sprawe w sekunde.
  it('podglad pokazuje pominiete razem z powodem', async () => {
    const { app, db } = serwer();
    const a = zamowienie(db, { numer: 'A', zrodlo: 1, oplacone: true });
    const b = zamowienie(db, { numer: 'B', zrodlo: 2, oplacone: false });
    const r = await app.inject({
      method: 'POST', url: '/zamowienia/faktury-hurtem/podglad', headers: POST, payload: cialo([a, b]),
    });
    // ⚠️ Ta sama pulapka co wyzej: samo „B" nie dowodzi niczego na tej stronie. Powod ma
    // stac PRZY SWOIM numerze, wiec sprawdzamy oba naraz w jednym dopasowaniu.
    expect(r.body).toMatch(/<b>B<\/b> — [^<]*wpłat/i);
  });

  // ⚠️ PILNUJE KONKRETNEJ REGRESJI TEGO MODULU: klasa `.btn--groza` stala kiedys w arkuszu
  // WYZEJ niz `.btn`, wiec przycisk operacji nieodwracalnej renderowal sie jak zwykly bialy —
  // na trzech ekranach naraz i nikt tego nie zauwazyl.
  it('przycisk zatwierdzenia nosi klase operacji nieodwracalnej', async () => {
    const { app, db } = serwer();
    const a = zamowienie(db, { numer: 'A', zrodlo: 1, oplacone: true });
    const r = await app.inject({
      method: 'POST', url: '/zamowienia/faktury-hurtem/podglad', headers: POST, payload: cialo([a]),
    });
    expect(r.body).toContain('btn--groza');
  });

  it('wynik rozdziela wystawione, bledy i nietkniete na trzy osobne sekcje', async () => {
    const { app, db } = serwer({
      wystawWiele: async () => ({
        wystawione: [{ id: 1, numer: 'A', numerFaktury: '31/08/2026' }],
        bledy: [{ id: 2, numer: 'B', powod: 'inFakt odmówił' }],
        nietkniete: [{ id: 3, numer: 'C' }],
      }),
    });
    const a = zamowienie(db, { numer: 'A', zrodlo: 1, oplacone: true });
    const r = await app.inject({
      method: 'POST', url: '/zamowienia/faktury-hurtem', headers: POST, payload: cialo([a]),
    });
    expect(r.body).toContain('31/08/2026');
    expect(r.body).toContain('inFakt odmówił');
    expect(r.body).toMatch(/Zabrakło czasu/i);
  });

  // Pusty ekran wyglada jak ekran, ktory sie nie wczytal — ta sama zasada, co przy pustej
  // liscie zamowien i pustym pasie dlugow w zakladce FAKTURY.
  it('gdy nic nie poszlo, ekran mowi to wprost zamiast pustej tabeli', async () => {
    const { app, db } = serwer();
    const a = zamowienie(db, { numer: 'A', zrodlo: 1, oplacone: false });
    const r = await app.inject({
      method: 'POST', url: '/zamowienia/faktury-hurtem', headers: POST, payload: cialo([a]),
    });
    expect(r.body).toMatch(/nie wystawiono ani jednej faktury/i);
  });
});

// ---------------------------------------------------------------------------------
// POWROT NA ZAWEZONA LISTE (4.13d, dokonczenie z 2026-09-10).
//
// Trzecia akcja masowa dostaje to samo, co zmiana statusu i nadanie zbiorcze: operator
// wraca na zakladke i filtry, z ktorych zaznaczyl zamowienia. Ukryte pole `powrot` przychodzi
// z paska akcji masowych — formularz jest wspolny dla wszystkich czterech przyciskow, wiec
// wartosc TU BYLA JUZ WCZESNIEJ, a te trasy po prostu ja wyrzucaly.
// ---------------------------------------------------------------------------------
describe('powrót na zawężoną listę z ekranów faktur hurtem', () => {
  const ZAWEZENIE = '/?status=w_realizacji&kanal=pro';
  const zPowrotem = (ids, powrot = ZAWEZENIE) => {
    const p = new URLSearchParams();
    for (const id of ids) p.append('id', String(id));
    if (powrot !== null) p.set('powrot', powrot);
    return p.toString();
  };
  // Asercje na FRAGMENCIE: adres listy pojawia sie na tych ekranach takze w pasie marki
  // layoutu, wiec `toContain` na calym body przechodzilby rowniez przy milczacym odnosniku.
  const odnosnikPowrotu = (body) => {
    const m = body.match(/<p class="wroc">[\s\S]*?<\/p>/);
    expect(m).not.toBeNull();
    return m[0];
  };

  const podglad = (app, payload) => app.inject({
    method: 'POST', url: '/zamowienia/faktury-hurtem/podglad', headers: POST, payload,
  });
  const wystaw = (app, payload) => app.inject({
    method: 'POST', url: '/zamowienia/faktury-hurtem', headers: POST, payload,
  });

  it('ekran podglądu odsyła na widok, z którego kliknięto — odnośnikiem i przyciskiem „Anuluj"', async () => {
    const { app, db } = serwer();
    const a = zamowienie(db, { numer: 'A', zrodlo: 1, oplacone: true });
    const r = await podglad(app, zPowrotem([a]));
    expect(odnosnikPowrotu(r.body)).toContain(`href="${ZAWEZENIE.replace(/&/g, '&amp;')}"`);
    // ⚠️ „Anuluj" to DRUGIE wyjscie z tego samego ekranu i gubilo zawezenie osobno —
    // naprawienie samej gory strony zostawia operatora z polowa poprawki.
    expect(r.body).toContain(`<a class="btn" href="${ZAWEZENIE.replace(/&/g, '&amp;')}">Anuluj</a>`);
  });

  it('adres jedzie dalej ukrytym polem formularza zatwierdzenia', async () => {
    const { app, db } = serwer();
    const a = zamowienie(db, { numer: 'A', zrodlo: 1, oplacone: true });
    const r = await podglad(app, zPowrotem([a]));
    const start = r.body.indexOf('<form method="post" action="/zamowienia/faktury-hurtem"');
    expect(start).toBeGreaterThan(-1);
    const formularz = r.body.slice(start, r.body.indexOf('</form>', start));
    expect(formularz).toContain(`name="powrot" value="${ZAWEZENIE.replace(/&/g, '&amp;')}"`);
  });

  it('ekran wyniku odsyła tam samo', async () => {
    const { app, db } = serwer({
      wystawWiele: async () => ({
        wystawione: [{ id: 1, numer: 'A', numerFaktury: '31/08/2026' }], bledy: [], nietkniete: [],
      }),
    });
    const a = zamowienie(db, { numer: 'A', zrodlo: 1, oplacone: true });
    const r = await wystaw(app, zPowrotem([a]));
    expect(odnosnikPowrotu(r.body)).toContain(`href="${ZAWEZENIE.replace(/&/g, '&amp;')}"`);
  });

  // ⚠️ DRUGA GALAZ `reply.view` w tej trasie: odmowa za duzej partii wraca tym samym
  // ekranem, a mija podzial i usluge. Ekran, ktory odmawia, tez musi umiec odeslac.
  it('ekran odmowy przy za dużej partii też odsyła na zawężony widok', async () => {
    const { app, db } = serwer();
    const ids = [];
    for (let i = 0; i < SUFIT_FAKTUR_HURTEM + 1; i += 1) {
      ids.push(zamowienie(db, { numer: literami(i), zrodlo: i + 1, oplacone: true }));
    }
    const r = await wystaw(app, zPowrotem(ids));
    expect(r.body).toMatch(/najwyżej/i);
    expect(odnosnikPowrotu(r.body)).toContain(`href="${ZAWEZENIE.replace(/&/g, '&amp;')}"`);
  });

  it('bez adresu powrotu oba ekrany odsyłają na gołą listę', async () => {
    const { app, db } = serwer();
    const a = zamowienie(db, { numer: 'A', zrodlo: 1, oplacone: true });
    expect(odnosnikPowrotu((await podglad(app, zPowrotem([a], null))).body)).toContain('href="/"');
    expect(odnosnikPowrotu((await wystaw(app, zPowrotem([a], null))).body)).toContain('href="/"');
  });

  // Wartosc wraca z przegladarki, wiec przechodzi przez te sama bariere, co przy zmianie
  // statusu (domain/filtry-listy.js, `bezpiecznyPowrotNaListe`).
  it('adres spoza listy zamówień jest odrzucany', async () => {
    const { app, db } = serwer();
    const a = zamowienie(db, { numer: 'A', zrodlo: 1, oplacone: true });
    for (const zly of ['//obcy.example.com/', '/faktury?miesiac=2026-09']) {
      expect(odnosnikPowrotu((await podglad(app, zPowrotem([a], zly))).body)).toContain('href="/"');
      expect(odnosnikPowrotu((await wystaw(app, zPowrotem([a], zly))).body)).toContain('href="/"');
    }
  });
});
