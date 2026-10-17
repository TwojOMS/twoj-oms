import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zapiszProduktSklepowy, utworzKarte, powiazProdukt } from '../../../src/oms/db/magazyn.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNadanie } from '../../../src/moduly/wysylka/services/nadanie.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

// ================================================================================
// CZTERY EKRANY, JEDNA DROGA DO MINIATURY
//
// Zgloszenie wlasciciela: „zdjecia produktow nie laduja sie na ekranach zamowien". Reguly
// zgadywania (`-150x150` doklejane do nazwy pliku) uzywaly CZTERY miejsca naraz: lista
// zamowien, karta zamowienia, ekran nadania i galeria na karcie produktu. Zmierzone na
// produkcji: sklep A 608 brakow na 684 adresy (89%), bo TEN sklep skaluje miniatury
// do `247x296`; sklep PRO 0% brakow, bo tam zgadywanie trafialo przypadkiem.
//
// ⚠️⚠️ KAZDY EKRAN MA TU PARE TESTOW, i to jest cala tresc tego pliku:
//   * PRODUKT ZNANY LUSTRU bierze adres ZE SKLEPU (naprawa dla sklepu A);
//   * PRODUKT NIEZNANY LUSTRU bierze adres DOTYCHCZASOWY (PRO, Allegro i archiwum dzialaja
//     jak dotad).
// Dzien wczesniej ta sama poprawka w magazynie zostala zrobiona BEZ drugiej polowy pary —
// ekran przestawiono na czytanie wylacznie nowej kolumny, kolumna startowala pusta i zgasly
// takze miniatury PRO, ktore wczesniej dzialaly. Te testy istnieja po to, zeby jednostronnosc
// dalo sie zlamac WYLACZNIE swiadomie.

const config = { auth: { user: 'adam', pass: 'x' } };
const naglowek = {
  authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`,
  origin: 'http://localhost',
};
const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };

// Zdjecie produktu ze sklepu A — sklepu, ktory JEST usterka ze zgloszenia.
const ORYGINAL = 'https://sklep-polcien.example.invalid/wp-content/uploads/2026/07/kopula.jpg';
const ZGADNIETY = 'kopula-150x150.jpg';
const PRAWDZIWY = 'https://sklep-polcien.example.invalid/wp-content/uploads/2026/07/kopula-247x296.jpg';

const zmapowane = (nad = {}) => ({
  zrodlo_id: 5501, numer: '5501',
  klient: { first_name: 'Jan', last_name: 'Kowalski', email: 'j@k.pl', phone: '+48500600700' },
  dostawa: {
    first_name: 'Jan', last_name: 'Kowalski', company: '', address_1: 'Polna 1',
    postcode: '00-650', city: 'Pęki', country: 'PL',
  },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null,
  kwota_brutto: '212.90', koszt_dostawy_brutto: '0.00', status_woo: 'processing',
  oplacone_at: '2026-07-29T13:00:00', anulowane: 0, utworzone_at: '2026-07-29T13:19:52',
  pozycje: [{
    nazwa: 'Ozdobny KAN', sku: 'PLC-KAN-1', ilosc: 1, cena_brutto: '212.90',
    brutto_linii: '212.90', vat: 23, zdjecie_url: ORYGINAL, produkt_id: 944,
  }],
  ...nad,
});

// Wiersz LUSTRA dla tego samego produktu, z adresem, ktory sklep NAPRAWDE wygenerowal.
const wLustrze = (db, nad = {}) => zapiszProduktSklepowy(db, {
  kanal: 'szkicownia', produkt_id: '944', wariant_id: '', nazwa: 'Ozdobny KAN',
  zdjecia_json: JSON.stringify([ORYGINAL]), miniatura: PRAWDZIWY,
  odczytane_at: '2026-08-12T06:00:00.000Z', ...nad,
});

// ⚠️ POMOCNIK WYCINAJACY I RZUCAJACY. Asercja na CALEJ stronie bywa podparta otoczeniem:
// wspolny `layout-oms.ejs`, sasiednia kolumna, pasek filtrow albo drugie zamowienie w tej
// samej odpowiedzi. Test, ktory szuka adresu „gdzies w HTML-u", przechodzilby takze wtedy,
// gdyby miniatura zniknela z wiersza, a adres zostal w atrybucie obok. Brak fragmentu jest
// tu BLEDEM, nie pustym napisem, ktory po cichu spelni kazde `not.toContain`.
function fragment(html, od, doo, opis) {
  const start = html.indexOf(od);
  if (start === -1) throw new Error(`Nie znaleziono poczatku fragmentu „${opis}" (${od}) w HTML-u.`);
  const koniec = html.indexOf(doo, start + od.length);
  if (koniec === -1) throw new Error(`Nie znaleziono konca fragmentu „${opis}" (${doo}) w HTML-u.`);
  return html.slice(start, koniec);
}

// Komorka miniatury JEDNEJ pozycji na karcie/ekranie nadania — wiersz tabeli pozycji
// wycinany po nazwie produktu, zeby nie zlapac wiersza wysylki ani „Razem".
const komorkaMini = (html) => fragment(html, '<td class="kol-mini">', '</td>', 'komórka miniatury');

// Wiersz listy zamowien wycinany po numerze w odnosniku do karty — ten sam wzorzec, co
// w tests/oms/web-lista-tabela.test.js.
//
// `<tr[^>]*>`, nie literalne `<tr>` — wiersz „po terminie" (zegar wieku, 23.08.2026) niesie
// opcjonalny `class="po-terminie"` na otwarciu, i to jest STAN POPRAWNY: zamowienie 5501
// w tym pliku ma oplacone_at na sztywno w lipcu, wiec dzis realnie przekracza termin.
// Helper ma znalezc wiersz niezaleznie od tego, czy zegar go zabarwil.
function wierszListy(html, numer) {
  const re = new RegExp(`<tr[^>]*>(?:(?!</tr>)[\\s\\S])*?>${numer}</a>[\\s\\S]*?</tr>`);
  const m = html.match(re);
  if (!m) throw new Error(`Nie znaleziono wiersza zamówienia ${numer} w HTML-u listy.`);
  return m[0];
}

let db;
let app;
beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config, poller, nadanie: createNadanie({ db, kurierzy: {}, katalogEtykiet: join(mkdtempSync(join(tmpdir(), 'oms-mini-')), 'etykiety') }) });
  await app.ready();
});

const zalozZamowienie = (sklep = 'szkicownia', nad = {}) => {
  zapiszZamowienie(db, sklep, zmapowane(nad), {});
  return db.prepare('SELECT id FROM zamowienia WHERE sklep=? AND zrodlo_id=?')
    .get(sklep, nad.zrodlo_id ?? 5501).id;
};

const pobierz = async (url) => {
  const r = await app.inject({ method: 'GET', url, headers: naglowek });
  expect(r.statusCode, `${url} oddalo ${r.statusCode}`).toBe(200);
  return r.body;
};

describe('lista zamówień — kolumna „Produkty"', () => {
  it('produkt znany lustru dostaje adres miniatury ze sklepu', async () => {
    wLustrze(db);
    zalozZamowienie();
    const w = wierszListy(await pobierz('/?wszystkie=1'), '5501');
    expect(w).toContain(PRAWDZIWY);
    expect(w).not.toContain(ZGADNIETY);
  });

  it('produkt nieznany lustru dostaje dotychczasowy adres zgadywany', async () => {
    zalozZamowienie();
    const w = wierszListy(await pobierz('/?wszystkie=1'), '5501');
    expect(w).toContain(ZGADNIETY);
    expect(w).not.toContain(PRAWDZIWY);
  });
});

describe('karta zamówienia — tabela pozycji', () => {
  it('produkt znany lustru dostaje adres miniatury ze sklepu', async () => {
    wLustrze(db);
    const html = await pobierz(`/zamowienia/${zalozZamowienie()}`);
    expect(komorkaMini(html)).toContain(PRAWDZIWY);
  });

  it('produkt nieznany lustru dostaje dotychczasowy adres zgadywany', async () => {
    const html = await pobierz(`/zamowienia/${zalozZamowienie()}`);
    expect(komorkaMini(html)).toContain(ZGADNIETY);
  });
});

describe('ekran nadania — zawartość paczki', () => {
  it('produkt znany lustru dostaje adres miniatury ze sklepu', async () => {
    wLustrze(db);
    const html = await pobierz(`/zamowienia/${zalozZamowienie()}/nadaj`);
    expect(komorkaMini(html)).toContain(PRAWDZIWY);
  });

  it('produkt nieznany lustru dostaje dotychczasowy adres zgadywany', async () => {
    const html = await pobierz(`/zamowienia/${zalozZamowienie()}/nadaj`);
    expect(komorkaMini(html)).toContain(ZGADNIETY);
  });
});

describe('karta produktu — galeria produktu', () => {
  const kartaProduktu = async (nadpisania) => {
    const magazyn = { start: vi.fn(), stan: () => ({ trwa: false, kanaly: [], blad: null }) };
    const serwer = buildOmsServer({ db, config, poller, magazyn });
    await serwer.ready();
    const karta = utworzKarte(db, { nazwa: 'Kopuła' });
    powiazProdukt(db, wLustrze(db, nadpisania), karta);
    const r = await serwer.inject({ method: 'GET', url: `/magazyn/${karta}`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    return r.body;
  };

  // Kafelek JEDNEGO zdjecia: `<a href="ORYGINAL" …><img … src="MINIATURA"></a>`. Wycinamy go
  // po adresie oryginalu, bo to jedyna wartosc, ktora odroznia kafelki od siebie — asercja
  // na calej karcie przechodzilaby takze wtedy, gdyby adres siedzial w SASIEDNIM kafelku.
  const kafelek = (html, oryginal) => fragment(html, `<a href="${oryginal}"`, '</a>', `kafelek ${oryginal}`);

  it('produkt z zapisaną miniaturą pokazuje adres ze sklepu', async () => {
    const k = kafelek(await kartaProduktu({}), ORYGINAL);
    expect(k).toContain(`src="${PRAWDZIWY}"`);
    expect(k).not.toContain(ZGADNIETY);
  });

  // ⚠️ TA POLOWA PARY JEST CALYM SENSEM POPRAWKI. Produkt sprzed odczytu katalogu ma
  // `miniatura` puste — i wtedy galeria ma pokazac to, co dzis, a nie pusta ramke.
  it('produkt bez zapisanej miniatury pokazuje dotychczasowy adres zgadywany', async () => {
    const k = kafelek(await kartaProduktu({ miniatura: null }), ORYGINAL);
    expect(k).toContain(ZGADNIETY);
  });

  // ⚠️ LUSTRO ZNA MINIATURE TYLKO ZDJECIA GLOWNEGO — Store API oddaje `thumbnail` przy kazdym
  // zdjeciu, ale kolumna `miniatura` trzyma JEDNA wartosc, pierwsza z galerii (schema.sql).
  // Pozostale kafelki musza wiec zostac przy dotychczasowym zgadywaniu: podstawienie im
  // adresu zdjecia GLOWNEGO pokazywaloby kilkanascie razy ten sam obrazek i klamalo o tym,
  // co w tym sklepie naprawde lezy.
  it('drugie zdjęcie galerii zostaje przy dotychczasowym adresie, bo lustro go nie zna', async () => {
    const drugie = 'https://sklep-polcien.example.invalid/wp-content/uploads/2026/07/kopula-2.jpg';
    const html = await kartaProduktu({ zdjecia_json: JSON.stringify([ORYGINAL, drugie]) });
    expect(kafelek(html, ORYGINAL)).toContain(`src="${PRAWDZIWY}"`);
    expect(kafelek(html, drugie)).toContain('kopula-2-150x150.jpg');
  });
});

// ================================================================================
// KOSZT — ILE ZAPYTAN DOKLADA LISTA ZAMOWIEN
//
// ⚠️⚠️ Lista renderuje kilkadziesiat zamowien po kilka pozycji. Odczyt miniatury „per pozycja"
// byloby setkami zapytan na KAZDE otwarcie strony glownej — usterka niewidoczna na bazie
// testowej i kladaca ekran na produkcyjnej. Liczymy WYKONANIA dotykajace lustra, a nie
// milisekundy: wzorzec z tests/oms/magazyn-db.test.js.

function bazaZLicznikiem(db, fraza) {
  const licznik = { zapytania: 0 };
  return [new Proxy(db, {
    get(cel, pole) {
      if (pole !== 'prepare') {
        const w = cel[pole];
        return typeof w === 'function' ? w.bind(cel) : w;
      }
      return (sql) => {
        const st = cel.prepare(sql);
        if (!sql.includes(fraza)) return st;
        return new Proxy(st, {
          get(s, p) {
            const w = s[p];
            if (typeof w !== 'function') return w;
            return (...a) => {
              if (p === 'all' || p === 'get' || p === 'run') licznik.zapytania += 1;
              return w.apply(s, a);
            };
          },
        });
      };
    },
  }), licznik];
}

describe('lista zamówień — koszt odczytu miniatur', () => {
  it('liczba zapytań do lustra nie rośnie z liczbą zamówień i pozycji', async () => {
    const zbuduj = (od, ile) => {
      for (let i = 0; i < ile; i += 1) {
        const numer = od + i;
        zapiszZamowienie(db, 'szkicownia', zmapowane({
          zrodlo_id: numer,
          numer: String(numer),
          pozycje: [1, 2, 3].map((n) => ({
            nazwa: `Lampa ${n}`, sku: `PLC-${n}`, ilosc: 1, cena_brutto: '10.00',
            brutto_linii: '10.00', vat: 23, zdjecie_url: ORYGINAL, produkt_id: 900 + n,
          })),
        }), {});
      }
    };
    for (const n of [901, 902, 903]) wLustrze(db, { produkt_id: String(n) });

    zbuduj(6000, 3);
    const [maly, licznikMaly] = bazaZLicznikiem(db, 'produkty_sklepowe');
    const appMaly = buildOmsServer({ db: maly, config, poller });
    await appMaly.ready();
    expect((await appMaly.inject({ method: 'GET', url: '/?wszystkie=1', headers: naglowek })).statusCode).toBe(200);

    zbuduj(7000, 40);
    const [duzy, licznikDuzy] = bazaZLicznikiem(db, 'produkty_sklepowe');
    const appDuzy = buildOmsServer({ db: duzy, config, poller });
    await appDuzy.ready();
    expect((await appDuzy.inject({ method: 'GET', url: '/?wszystkie=1', headers: naglowek })).statusCode).toBe(200);

    expect(licznikDuzy.zapytania).toBe(licznikMaly.zapytania);
    expect(licznikDuzy.zapytania).toBe(1);
  });

  // Lista samych zamowien recznych nie ma o co pytac lustra — i nie ma prawa go dotknac.
  it('lista bez ani jednej pozycji sklepowej nie dokłada żadnego zapytania', async () => {
    zapiszZamowienie(db, 'szkicownia', zmapowane({ pozycje: [] }), {});
    const [licznikowa, licznik] = bazaZLicznikiem(db, 'produkty_sklepowe');
    const appPusty = buildOmsServer({ db: licznikowa, config, poller });
    await appPusty.ready();
    expect((await appPusty.inject({ method: 'GET', url: '/?wszystkie=1', headers: naglowek })).statusCode).toBe(200);
    expect(licznik.zapytania).toBe(0);
  });
});

// ================================================================================
// ZERO NOWYCH ZADAN DO SKLEPU
//
// ⚠️ Cala wartosc tej poprawki pochodzi z BAZY. Rozwiazanie, ktore odpytuje sklep na kazda
// pozycje, byloby zle nawet gdyby pokazywalo wlasciwe zdjecia: strona glowna z 40 zamowieniami
// robilaby setke zadan HTTP do sklepu przy kazdym odswiezeniu.

describe('ekrany zamówień nie odpytują sklepu', () => {
  it('render listy, karty i ekranu nadania nie wykonuje ani jednego żądania HTTP', async () => {
    const strazFetch = vi.fn(async () => { throw new Error('ekran nie ma prawa odpytywac sklepu'); });
    const poprzedni = globalThis.fetch;
    globalThis.fetch = strazFetch;
    try {
      wLustrze(db);
      const id = zalozZamowienie();
      await pobierz('/?wszystkie=1');
      await pobierz(`/zamowienia/${id}`);
      await pobierz(`/zamowienia/${id}/nadaj`);
    } finally {
      globalThis.fetch = poprzedni;
    }
    expect(strazFetch).not.toHaveBeenCalled();
  });
});
