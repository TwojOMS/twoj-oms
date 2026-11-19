import { wzorzecNazw } from '../pomoc/skroty-nazw-firmy.js';
// Generator danych demo (scripts/demo-dane.mjs): każda zakładka menu ma dane, dane są
// zmyślone, generator jest deterministyczny i nie nadpisuje istniejącej bazy.
//
// ⚠️ Zakładki bierzemy z `aplikacja.menu`, nie z listy w teście: nowa zakładka bez znacznika
// w ZNACZNIKI łamie test, zanim demo pokaże gościowi pusty ekran.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { uruchomPiaskownice } from '../../deploy/proba/atrapy/index.mjs';
import { createAtrapaWoo } from '../../deploy/proba/atrapy/kanaly.mjs';
import { createAtrapaErli } from '../../deploy/proba/atrapy/erli.mjs';
import { idProduktuErli } from '../../src/moduly/magazyn/services/petla-ofert.js';
import { zalozKonto } from '../../src/core/bezpieczenstwo/konta.js';
import { utworzBazeDemo, wygenerujDaneDemo, ENV_DEMO, nipFikcyjny } from '../../scripts/demo-dane.mjs';
import { FIRMY_B2B, KOSZTY, PRODUKTY, PRODUKTY_KATALOGU } from '../../scripts/demo-dane-firma.mjs';
import {
  eanDemo,
  klienciKataloguDemo,
  produktyAllegroDemoPoEan,
  zdjeciaKarty,
} from '../../scripts/demo-dane-katalog.mjs';
import { poprawnyEan } from '../../src/domena/ean.js';
import { cenyZakupuNa, historiaCenZakupu } from '../../src/oms/db/ceny-zakupu.js';
import { etapPrzesylki, kategoriaPrzesylki, bezRuchu } from '../../src/domena/etap-przesylki.js';
import { przewoznikWiersza } from '../../src/domena/przewoznik-przesylki.js';
import { pobierzZamowienie } from '../../src/oms/db/zamowienia.js';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

const DZIS = '2026-10-14';
// Zakładki (Raporty, Koszty) otwierają się na bieżącym miesiącu wg zegara — demo dla nich liczone od dziś.
const DZIS_TERAZ = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
const katalogi = [];
function katalog() {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'oms-demo-dane-'));
  katalogi.push(p);
  return p;
}
function envDla(k) {
  fs.mkdirSync(path.join(k, 'proformy'), { recursive: true });
  fs.mkdirSync(path.join(k, 'etykiety'), { recursive: true });
  return {
    ...ENV_DEMO,
    OMS_DB_PATH: path.join(k, 'oms.sqlite'),
    OMS_PORT: '0',
    OMS_USER: 'serwis-demo',
    OMS_PASS: 'haslo-serwisowe-testu',
    OMS_PROFORMY_KATALOG: path.join(k, 'proformy'),
    OMS_ETYKIETY_KATALOG: path.join(k, 'etykiety'),
  };
}
afterAll(() => {
  for (const p of katalogi.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});

// Adres zakładki → co MUSI na niej stać, gdy demo ma dane. Demo stoi jak w piaskownicy: z atrapami inFaktu, Woo
// i Allegro (deploy/proba/atrapy), więc Faktury i Magazyn — czytające na żywo z inFaktu i sklepu — też mają dane.
const ZNACZNIKI = {
  '/': ['Sklep Półcień', 'Allegro Półcień Outlet'],
  '/przesylki': ['0000'],
  '/faktury': ['FV '], // Na początku miesiąca stoi tu pojedyncza faktura, później kilkanaście — nic pewniejszego od „FV ”
  '/okresy': ['Kawiarnie Dzbanuszek'],
  '/klienci': ['Hotel Zaciszny Brzeg', 'Wohnlicht Nordstrand GmbH (demo)'],
  '/wiadomosci': ['demo-watek-1', 'oprawka jest E27'],
  '/magazyn': ['Lampa stołowa Gliwka', 'LMP-STO-001', 'LMP-KAT-001'],
  '/analityka': ['Nowe zamówienia', 'W realizacji'],
  '/raporty': ['Sprzedaż brutto', 'Lampa'],
  '/statystyki': ['Paczkomat'],
  '/kampania': ['Google · GA4', 'Meta · insights'],
  '/koszty': ['Huta Szkła Brzeziny (demo)', 'Spółdzielnia Warsztatowa Cegielnia (demo)'],
  '/finanse': ['Czynsz pracowni', 'Szkło i klosze'],
  '/ustawienia': ['Ustawienia'],
};
const PUSTE = [
  'W tym okresie nie ma ani jednego zamówienia',
  'W tym zakresie nie ma zamówień.',
  'Nie ma jeszcze żadnego okresu rozliczeniowego',
  'Nie ma tu żadnej wiadomości',
  'Nie ma jeszcze żadnego celu',
  'Brak faktur kosztowych w tym miesiącu',
  'Nie da się policzyć',
];

it.each(['woocommerce_calc_taxes', 'woocommerce_prices_include_tax'])(
  'klient katalogu i atrapa Woo mają to samo ustawienie %s',
  async (klucz) => {
    const db = new DatabaseSync(':memory:');
    try {
      const { sklepy, kanalySklepow } = klienciKataloguDemo();
      for (const kanal of kanalySklepow) {
        const atrapa = createAtrapaWoo({ db, kanal, env: ENV_DEMO });
        const ustawienie = await atrapa.ustawienieSklepu(klucz);
        expect(ustawienie, kanal).toBe('no');
        expect(await sklepy[kanal].ustawienieSklepu(klucz), kanal).toBe(ustawienie);
      }
    } finally {
      db.close();
    }
  },
);

describe('generator danych demo na świeżej bazie', () => {
  let env, wynik, live, url, cookie;
  beforeAll(async () => {
    env = envDla(katalog());
    wynik = await utworzBazeDemo({ baza: env.OMS_DB_PATH, dzis: DZIS_TERAZ, env });
    const db = new DatabaseSync(env.OMS_DB_PATH);
    try {
      zalozKonto(db, {
        login: 'demo-admin',
        imie: 'Administrator demo',
        haslo: 'haslo-testu-demo-1',
        rola: 'administrator',
        admin: true,
      });
    } finally {
      db.close();
    }
    live = await uruchomPiaskownice(env, { host: '127.0.0.1' });
    url = live.aplikacja.app.listeningOrigin;
    const login = await fetch(url + '/login', {
      method: 'POST',
      redirect: 'manual',
      headers: { origin: url, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ uzytkownik: 'demo-admin', haslo: 'haslo-testu-demo-1', powrot: '/' }),
    });
    expect(login.status).toBe(302);
    cookie = login.headers.get('set-cookie').match(/sesja_oms_proba=[^;]+/)[0];
  }, 60000);
  afterAll(async () => {
    await live?.zamknij();
  });

  const strona = async (adres) => {
    let r = await fetch(url + adres, { headers: { cookie }, redirect: 'manual' });
    if (r.status === 302) r = await fetch(url + r.headers.get('location'), { headers: { cookie }, redirect: 'manual' });
    return { status: r.status, html: await r.text() };
  };

  it('ma 150 kart z ceną, VAT 23%, marką i obowiązującą ceną zakupu', () => {
    const db = new DatabaseSync(env.OMS_DB_PATH, { readOnly: true });
    try {
      const karty = db.prepare('SELECT id, sku, cena_gr, stawka_vat, marka FROM karty_produktow ORDER BY id').all();
      const cenyZakupu = cenyZakupuNa(db, DZIS_TERAZ);
      expect(karty).toHaveLength(150);
      expect(cenyZakupu.size).toBe(150);
      const marki = ['Pracownia Półcień', 'Zakład Szkła Przykładowego', 'Marka przykładowa 001', 'Oprawy Przykładowe'];
      const skuHistorii = ['LMP-STO-001', 'LMP-STO-002', 'LMP-STO-003'];
      const dataWzgledna = (dni) => new Date(Date.parse(DZIS_TERAZ) + dni * 86400000).toISOString().slice(0, 10);
      for (const { id, sku, cena_gr, stawka_vat, marka } of karty) {
        expect(cena_gr, sku).toBeGreaterThan(0);
        expect(stawka_vat, sku).toBe('23');
        expect(marki, sku).toContain(marka);
        expect(cenyZakupu.get(id), sku).toBeGreaterThan(0);
        const historia = historiaCenZakupu(db, id);
        const i = skuHistorii.indexOf(sku);
        if (i !== -1) {
          expect(historia, sku).toMatchObject([
            { cena_netto_gr: 4500 + i * 1000, obowiazuje_od: dataWzgledna(-90) },
            { cena_netto_gr: 5000 + i * 1000, obowiazuje_od: dataWzgledna(-30) },
            ...(i === 0 ? [{ cena_netto_gr: 5500, obowiazuje_od: dataWzgledna(30) }] : []),
          ]);
          expect(cenyZakupu.get(id), sku).toBe(5000 + i * 1000);
        } else {
          const gr = cenyZakupu.get(id);
          expect(historia, sku).toMatchObject([{ cena_netto_gr: gr, obowiazuje_od: dataWzgledna(-60) }]);
          expect(gr % 10, sku).toBe(0);
          expect(gr, sku).toBeGreaterThanOrEqual(cena_gr * 0.45 - 5);
          expect(gr, sku).toBeLessThanOrEqual(cena_gr * 0.6 + 5);
        }
      }
    } finally {
      db.close();
    }
  });

  it('karty demo mają cztery parametry w stałej kolejności, wartości na lampach i kilka lamp bez wymaganego Gwintu', () => {
    const db = new DatabaseSync(env.OMS_DB_PATH, { readOnly: true });
    try {
      const parametry = db
        .prepare('SELECT id, nazwa, typ, jednostka, wymagany FROM parametry_kart ORDER BY kolejnosc, id')
        .all();
      expect(parametry.map((p) => [p.nazwa, p.typ, p.jednostka, p.wymagany])).toEqual([
        ['Moc żarówki', 'liczba', 'W', 0],
        ['Kolor', 'lista', null, 0],
        ['Gwint', 'lista', null, 1],
        ['Materiał', 'tekst', null, 0],
      ]);
      const ile = db.prepare('SELECT COUNT(*) n FROM karty_parametry WHERE parametr_id = ?');
      for (const p of parametry) expect(ile.get(p.id).n, p.nazwa).toBeGreaterThan(0);
      const gwint = parametry[2].id;
      const moc = parametry[0].id;
      // Szkic produktu powstaje później i celowo jest niedokończony — nie liczy się do lamp bez Gwintu.
      const lampyBezGwintu = db
        .prepare(
          `SELECT COUNT(*) n FROM karty_produktow k
          WHERE k.kategoria_glowna NOT IN ('Abażury i klosze', 'Akcesoria') AND k.sku NOT LIKE 'LMP-SZK-%'
            AND NOT EXISTS (SELECT 1 FROM karty_parametry v WHERE v.karta_id = k.id AND v.parametr_id = ?)`,
        )
        .get(gwint).n;
      expect(lampyBezGwintu).toBeGreaterThanOrEqual(2);
      expect(lampyBezGwintu).toBeLessThanOrEqual(3);
      const akcesoriaZMoca = db
        .prepare(
          `SELECT COUNT(*) n FROM karty_parametry v JOIN karty_produktow k ON k.id = v.karta_id
          WHERE v.parametr_id IN (?, ?) AND k.kategoria_glowna IN ('Abażury i klosze', 'Akcesoria')`,
        )
        .get(moc, gwint).n;
      expect(akcesoriaZMoca).toBe(0);
      expect(db.prepare('SELECT COUNT(*) n FROM karty_produktow WHERE paczkomat IS NOT NULL').get().n).toBe(0);
    } finally {
      db.close();
    }
  });

  it('pokazuje nowe SKU w lustrze Woo Półcień i poza Allegro oraz zamówieniami', () => {
    const db = new DatabaseSync(env.OMS_DB_PATH, { readOnly: true });
    try {
      const lustro = db
        .prepare(
          "SELECT sku_sklepu, kanal FROM produkty_sklepowe WHERE sku_sklepu LIKE 'LMP-KAT-%' ORDER BY sku_sklepu, kanal",
        )
        .all();
      expect(lustro).toEqual(
        Array.from({ length: 119 }, (_, i) => ({
          sku_sklepu: `LMP-KAT-${String(i + 1).padStart(3, '0')}`,
          kanal: 'polcien',
        })),
      );
      const karty = db
        .prepare(
          "SELECT id, sku, nazwa, kategoria_glowna, cena_gr FROM karty_produktow WHERE sku LIKE 'LMP-KAT-%' ORDER BY sku",
        )
        .all();
      expect(karty).toHaveLength(119);
      const nazwy = [
        'Lampa stołowa',
        'Lampa wisząca',
        'Lampa podłogowa',
        'Kinkiet',
        'Lampka nocna',
        'Abażur',
        'Żarówka LED',
      ];
      const kategorie = [
        'Lampy stołowe',
        'Lampy wiszące',
        'Lampy podłogowe',
        'Kinkiety',
        'Lampki nocne',
        'Abażury i klosze',
        'Akcesoria',
      ];
      const zdjecia = db.prepare('SELECT adres_zrodlowy FROM zdjecia_kart WHERE karta_id = ?');
      for (const [i, { id, sku, nazwa, kategoria_glowna, cena_gr }] of karty.entries()) {
        expect(nazwa).toBe(`${nazwy[i % 7]} ${i + 22}`);
        expect(kategoria_glowna).toBe(kategorie[i % 7]);
        expect(cena_gr % 100).toBe([0, 90, 99][i % 3]);
        expect(cena_gr).toBeGreaterThanOrEqual(3900);
        expect(cena_gr).toBeLessThanOrEqual(i % 7 >= 5 ? 14900 : 89900);
        expect(zdjecia.all(id), sku).toEqual([
          { adres_zrodlowy: expect.stringMatching(/\/demo-produkty\/(?!rys-)[^/]+\.jpg$/) },
        ]);
      }
      expect(
        db
          .prepare(
            `SELECT COUNT(*) n FROM oferty_kanalow o JOIN karty_produktow k ON k.id = o.karta_id
            WHERE k.sku LIKE 'LMP-KAT-%' AND o.kanal <> 'erli_polcien'`,
          )
          .get().n,
      ).toBe(0);
      expect(db.prepare("SELECT COUNT(*) n FROM pozycje WHERE sku LIKE 'LMP-KAT-%'").get().n).toBe(0);
    } finally {
      db.close();
    }
  });

  it('magazyn demo ma karty bez EAN-u i karty z poprawnym EAN-em z katalogu Allegro', () => {
    const db = new DatabaseSync(env.OMS_DB_PATH, { readOnly: true });
    try {
      const karty = db.prepare('SELECT sku, ean FROM karty_produktow').all();
      const zEan = karty.filter((k) => k.ean);
      const udzialBezEan = (karty.length - zEan.length) / karty.length;
      expect(udzialBezEan).toBeGreaterThanOrEqual(0.15);
      expect(udzialBezEan).toBeLessThanOrEqual(0.25);
      expect(zEan).toContainEqual({ sku: PRODUKTY[0].sku, ean: eanDemo(1) });
      const produkty = [...PRODUKTY, ...PRODUKTY_KATALOGU];
      for (const { sku, ean } of zEan) {
        const nr = produkty.findIndex((p) => p.sku === sku) + 1;
        expect(ean, sku).toBe(eanDemo(nr));
        expect(poprawnyEan(ean), sku).toBe(true);
        expect(produktyAllegroDemoPoEan(ean)).toEqual([expect.objectContaining({ name: produkty[nr - 1].nazwa })]);
      }
    } finally {
      db.close();
    }
  });

  it('każda karta demo ma regularną cenę katalogową, a karty powiązane z Woo mają źródło ceny', () => {
    const db = new DatabaseSync(env.OMS_DB_PATH, { readOnly: true });
    try {
      const ceny = new Map([...PRODUKTY, ...PRODUKTY_KATALOGU].map(({ sku, cena_gr }) => [sku, cena_gr]));
      ceny.set('LMP-SZK-001', 18900);
      const karty = db.prepare('SELECT id, sku, cena_gr FROM karty_produktow').all();
      const zrodloCeny = db.prepare(
        "SELECT zrodlo, reczne FROM karty_zrodla_pol WHERE karta_id = ? AND pole = 'cena_gr'",
      );
      const { kanalySklepow } = klienciKataloguDemo();
      const lustroWoo = db.prepare(
        `SELECT kanal FROM produkty_sklepowe WHERE karta_id = ? AND kanal IN (${kanalySklepow.map(() => '?').join(',')})`,
      );
      expect(karty.map(({ sku }) => sku)).toContain('LMP-SZK-001');
      for (const { id, sku, cena_gr } of karty) {
        expect(cena_gr, sku).toBe(ceny.get(sku));
        const powiazania = lustroWoo.all(id, ...kanalySklepow);
        if (powiazania.length) {
          const zrodlo = zrodloCeny.get(id);
          expect(
            powiazania.map(({ kanal }) => `woo:${kanal}`),
            sku,
          ).toContain(zrodlo?.zrodlo);
          expect(zrodlo.reczne, sku).toBe(0);
        }
      }
    } finally {
      db.close();
    }
  });

  it('galerie kart demo zaczynają się od zdjęcia SKU, z zachowaniem celowych braków', () => {
    const db = new DatabaseSync(env.OMS_DB_PATH, { readOnly: true });
    try {
      const karty = db.prepare('SELECT id, sku FROM karty_produktow').all();
      const zdjecia = db.prepare(
        'SELECT kolejnosc, adres_zrodlowy FROM zdjecia_kart WHERE karta_id = ? ORDER BY kolejnosc',
      );
      const bezZdjec = [];
      for (const { id, sku } of karty) {
        const galeria = zdjecia.all(id);
        const [pierwsze] = zdjeciaKarty(sku);
        if (pierwsze) {
          expect(galeria[0], sku).toEqual({ kolejnosc: 0, adres_zrodlowy: pierwsze });
        } else {
          expect(galeria, sku).toHaveLength(0);
          bezZdjec.push(sku);
        }
      }
      expect(bezZdjec.sort()).toEqual(['LMP-KIN-001', 'LMP-KIN-002']);
    } finally {
      db.close();
    }
  });

  it('każda karta demo ma stawkę VAT 23%', () => {
    const db = new DatabaseSync(env.OMS_DB_PATH, { readOnly: true });
    try {
      const karty = db.prepare('SELECT sku, stawka_vat FROM karty_produktow').all();
      expect(karty.map(({ sku }) => sku)).toContain('LMP-SZK-001');
      for (const { sku, stawka_vat } of karty) expect(stawka_vat, sku).toBe('23');
    } finally {
      db.close();
    }
  });

  it('magazyn demo ma historię ceny zakupu z przyszłą podwyżką', () => {
    const db = new DatabaseSync(env.OMS_DB_PATH, { readOnly: true });
    try {
      const historia = db
        .prepare(
          `SELECT karta_id, cena_netto_gr, obowiazuje_od, kto, zrodlo
        FROM ceny_zakupu_kart ORDER BY karta_id, obowiazuje_od`,
        )
        .all();
      const grupy = Map.groupBy(historia, (w) => w.karta_id);
      expect(
        [...grupy.values()].some(
          (wpisy) =>
            wpisy.length >= 2 &&
            wpisy.some((w, i) => i > 0 && w.obowiazuje_od > DZIS_TERAZ && w.cena_netto_gr > wpisy[i - 1].cena_netto_gr),
        ),
      ).toBe(true);
      expect(historia.every((w) => w.kto === null && w.zrodlo === 'karta')).toBe(true);
    } finally {
      db.close();
    }
  });

  // Zamówienie z 15 różnymi produktami — lista pokazuje 5, resztę zwija.
  it('jest zamówienie z 15 różnymi produktami, a lista zamówień zwija je pod „Pokaż jeszcze 10”', async () => {
    const db = new DatabaseSync(env.OMS_DB_PATH, { readOnly: true });
    let id;
    try {
      const w = db
        .prepare(
          'SELECT zamowienie_id id, COUNT(DISTINCT sku) n FROM pozycje GROUP BY zamowienie_id ORDER BY n DESC LIMIT 1',
        )
        .get();
      expect(w.n).toBe(15);
      id = w.id;
    } finally {
      db.close();
    }
    const { status, html } = await strona('/');
    expect(status).toBe(200);
    const wiersz = html.match(new RegExp(`<tr id="zamowienie-${id}"[\\s\\S]*?</tr>`));
    expect(wiersz, 'zamówienie z 15 pozycjami na pierwszej stronie listy').toBeTruthy();
    expect(wiersz[0]).toContain('Pokaż jeszcze 10');
  });

  // W „Nowych” jedno zamówienie z 7 i jedno z 12 pozycjami — oba zwinięte (widać 5).
  it('lista „Nowe” ma zamówienie z 7 i z 12 różnymi produktami, zwinięte pod „Pokaż jeszcze 2” i „Pokaż jeszcze 7”', async () => {
    const { status, html } = await strona('/?status=nowe');
    expect(status).toBe(200);
    const pokaz = [...html.matchAll(/Pokaż jeszcze (\d+)/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
    expect(pokaz).toEqual([2, 7]);
  });

  // Pętla pomija ostatnie 3 dni (−19), uzupełnienia dokładają 40 (12 nowych, 24 w realizacji, 4 wysłane; bez „indywidualnych”).
  // +19 dużych koszyków i paczek, +10–13 zamówień firm zbiorczych (3 z miesiąca sprzed dwóch wypadają
  // z okna 58 dni pod koniec miesiąca) — 206–209 zależnie od dnia; +1 koszyk z 15 produktami i +2 duże „nowe” daje 209–212.
  it('ok. 212 zamówień z 60 dni (wszystkie scenariusze demo), wszystkie statusy, faktury z WDT, zwroty, przesyłki, koszty', () => {
    expect(wynik.zamowienia).toBeGreaterThanOrEqual(209);
    expect(wynik.zamowienia).toBeLessThanOrEqual(212);
    expect(Object.keys(wynik.statusy).sort()).toEqual(['anulowane', 'nowe', 'w_realizacji', 'wyslane', 'zwrot']);
    const db = new DatabaseSync(env.OMS_DB_PATH, { readOnly: true });
    try {
      const n = (sql) => db.prepare(sql).get().n;
      expect(n('SELECT COUNT(*) n FROM faktury')).toBeGreaterThanOrEqual(20);
      expect(n("SELECT COUNT(*) n FROM faktury WHERE numer LIKE 'WDT/%'")).toBeGreaterThanOrEqual(1);
      expect(
        n('SELECT COUNT(*) n FROM faktury f JOIN zamowienia z ON z.id = f.zamowienie_id WHERE z.pobranie = 1'),
      ).toBeGreaterThanOrEqual(1);
      expect(n('SELECT COUNT(*) n FROM zwroty')).toBeGreaterThanOrEqual(5);
      expect(n('SELECT COUNT(*) n FROM przesylki WHERE numer_listu IS NOT NULL')).toBeGreaterThanOrEqual(50);
      expect(n('SELECT COUNT(DISTINCT sklep) n FROM zamowienia')).toBe(4);
      const [od, doD] = Object.values(
        db.prepare('SELECT MIN(utworzone_at) a, MAX(utworzone_at) b FROM zamowienia').get(),
      );
      expect((Date.parse(doD) - Date.parse(od)) / 86400000).toBeGreaterThan(50);
      // Nic z przyszłości dla gościa, który otwiera demo rano (reset bywa nocny).
      expect(doD < `${DZIS_TERAZ}T06:00:00`).toBe(true);
      const najpozniej = db
        .prepare(
          `SELECT MAX(t) t FROM (SELECT MAX(wyslane_at) t FROM zamowienia UNION ALL
        SELECT MAX(oplacone_at) FROM zamowienia UNION ALL SELECT MAX(last_message_date_time) FROM allegro_watki
        UNION ALL SELECT MAX(wyslana_at) FROM wiadomosci UNION ALL SELECT MAX(status_kuriera_at) FROM przesylki)`,
        )
        .get().t;
      expect(najpozniej < `${DZIS_TERAZ}T06:00:00`, najpozniej).toBe(true);
    } finally {
      db.close();
    }
  });

  // Demo i piaskownica bez statusu „Indywidualne”; praca „w toku” zostaje (nowe + w realizacji).
  it('bez zamówień indywidualnych, kanał indywidualny wyłączony, „w toku” nie spada (było 34)', () => {
    expect(ENV_DEMO.OMS_KANAL_INDYWIDUALNY).toBeUndefined();
    expect(wynik.statusy.indywidualne).toBeUndefined();
    expect((wynik.statusy.nowe ?? 0) + (wynik.statusy.w_realizacji ?? 0)).toBeGreaterThanOrEqual(34);
    const db = new DatabaseSync(env.OMS_DB_PATH, { readOnly: true });
    try {
      expect(db.prepare('SELECT COUNT(*) n FROM zamowienia WHERE indywidualne = 1').get().n).toBe(0);
    } finally {
      db.close();
    }
  });

  // Pozycja bez identyfikatora linii sklepu nie da się usunąć „×” na karcie — demo musi je mieć.
  it('każda pozycja zamówienia ze sklepu ma identyfikator linii, różny w obrębie zamówienia', () => {
    const db = new DatabaseSync(env.OMS_DB_PATH, { readOnly: true });
    try {
      const sklepowe = "FROM pozycje p WHERE p.zrodlo = 'sklep'";
      expect(db.prepare(`SELECT COUNT(*) n ${sklepowe}`).get().n).toBeGreaterThan(100);
      expect(db.prepare(`SELECT COUNT(*) n ${sklepowe} AND p.zrodlo_id IS NULL`).get().n).toBe(0);
      expect(
        db
          .prepare(
            `SELECT COUNT(*) n FROM (SELECT 1 ${sklepowe} GROUP BY p.zamowienie_id, p.zrodlo_id HAVING COUNT(*) > 1)`,
          )
          .get().n,
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it('każda zakładka menu odpowiada 200 i pokazuje dane demo', async () => {
    const adresy = live.aplikacja.menu.map((m) => m.adres);
    expect(
      adresy.filter((a) => !ZNACZNIKI[a]),
      'zakładka bez znacznika demo — dopisz do ZNACZNIKI',
    ).toEqual([]);
    for (const adres of adresy) {
      const { status, html } = await strona(adres);
      expect.soft(status, adres).toBe(200);
      const z = ZNACZNIKI[adres];

      for (const tekst of z) expect.soft(html, `${adres}: brak „${tekst}”`).toContain(tekst);
      for (const tekst of PUSTE) expect.soft(html, `${adres}: pusty stan „${tekst}”`).not.toContain(tekst);
    }
  }, 60000);

  it('licznik każdego statusu na liście zamówień jest niezerowy', async () => {
    const { html } = await strona('/');
    for (const s of ['nowe', 'w_realizacji', 'wyslane', 'zwrot', 'anulowane']) {
      const m = html.match(new RegExp(`data-status="${s}">(\\d+)<`));
      expect.soft(Number(m?.[1] ?? 0), s).toBeGreaterThan(0);
    }
  });

  it('karta zamówienia z fakturą WDT i z pobraniem pokazuje numer dokumentu', async () => {
    const db = new DatabaseSync(env.OMS_DB_PATH, { readOnly: true });
    let wdt, pobranie;
    try {
      wdt = db.prepare("SELECT zamowienie_id id, numer FROM faktury WHERE numer LIKE 'WDT/%' LIMIT 1").get();
      pobranie = db
        .prepare(
          'SELECT f.zamowienie_id id, f.numer FROM faktury f JOIN zamowienia z ON z.id = f.zamowienie_id WHERE z.pobranie = 1 LIMIT 1',
        )
        .get();
    } finally {
      db.close();
    }
    for (const f of [wdt, pobranie]) {
      const { status, html } = await strona(`/zamowienia/${f.id}`);
      expect(status).toBe(200);
      expect(html).toContain(f.numer);
    }
  });

  it('demo ma producentów GPSR: dwóch, jeden domyślny, marka z kartami bez producenta i karty z własnym tekstem', () => {
    const db = new DatabaseSync(env.OMS_DB_PATH, { readOnly: true });
    try {
      const producenci = db.prepare('SELECT id, nazwa, domyslny FROM producenci ORDER BY nazwa').all();
      expect(producenci.map((p) => p.nazwa)).toEqual(['Pracownia Półcień', 'Zakład Szkła Przykładowego']);
      expect(producenci.filter((p) => p.domyslny === 1).map((p) => p.nazwa)).toEqual(['Pracownia Półcień']);
      // Adres w polach — jak po dodaniu w formularzu, z krajem, którego wymaga GPSR.
      expect(
        db
          .prepare('SELECT nazwa, kod_pocztowy, kraj, adres FROM producenci ORDER BY nazwa')
          .all()
          .map((p) => ({ ...p })),
      ).toEqual([
        {
          nazwa: 'Pracownia Półcień',
          kod_pocztowy: '00-001',
          kraj: 'PL',
          adres: 'ul. Przykładowa 1\n00-001 Miasto Przykładowe\nPolska',
        },
        {
          nazwa: 'Zakład Szkła Przykładowego',
          kod_pocztowy: '00-002',
          kraj: 'PL',
          adres: 'ul. Hutnicza 2\n00-002 Miasto Przykładowe\nPolska',
        },
      ]);
      const przypisane = db
        .prepare('SELECT marka FROM marki_producenci')
        .all()
        .map((r) => r.marka);
      expect(przypisane.length).toBeGreaterThanOrEqual(2);
      expect(
        db
          .prepare(
            "SELECT p.domyslny FROM producenci p JOIN marki_producenci m ON m.producent_id = p.id WHERE m.marka = 'Oprawy Przykładowe'",
          )
          .get()?.domyslny,
      ).toBe(1);
      const bezProducenta = db
        .prepare(
          `SELECT k.marka, COUNT(*) n FROM karty_produktow k
           WHERE k.marka IS NOT NULL AND k.marka NOT IN (SELECT marka FROM marki_producenci) GROUP BY k.marka`,
        )
        .all();
      expect(bezProducenta.length).toBeGreaterThanOrEqual(1);
      expect(bezProducenta[0].n).toBeGreaterThan(0);
      const teksty = db
        .prepare(
          'SELECT informacja_bezpieczenstwa AS i FROM karty_produktow WHERE informacja_bezpieczenstwa IS NOT NULL',
        )
        .all()
        .map((r) => JSON.parse(r.i));
      expect(teksty.length).toBeGreaterThanOrEqual(3);
      expect(teksty.length).toBeLessThanOrEqual(5);
      for (const t of teksty) expect(t).toMatchObject({ typ: 'TEXT', tekst: expect.stringMatching(/\S/) });
      const kartyZMarka = db.prepare('SELECT COUNT(*) n FROM karty_produktow WHERE marka IS NOT NULL').get().n;
      expect(kartyZMarka).toBeGreaterThan(teksty.length);
    } finally {
      db.close();
    }
  });

  it('strażnik: zero danych spoza puli zmyślonej (e-maile .invalid, NIP 999…, adresy przykładowe)', () => {
    const db = new DatabaseSync(env.OMS_DB_PATH, { readOnly: true });
    try {
      const tabele = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map((t) => t.name);
      const tekst = tabele
        .flatMap((t) =>
          db
            .prepare(`SELECT * FROM "${t}"`)
            .all()
            .map((w) => JSON.stringify(w)),
        )
        .join('\n');
      const maile = [...new Set(tekst.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) ?? [])];
      expect(maile.length).toBeGreaterThan(10);
      expect(maile.filter((m) => !/@example\.invalid$/i.test(m))).toEqual([]);
      expect(
        wzorzecNazw([
          {
            'wzor': '\\p{L}{7}',
            'skrot': 'c6c60e0a2a507cd86e6f25a4232e3fbe8ddc5ad0653c53906011a280c12ad2e0',
            'bezWielkosci': true,
          },
          {
            'wzor': '\\p{L}{8}',
            'skrot': 'a2ac0b2e157811634f85a0cd5e7ec6ae46b6123e724924eba975ef822566f72e',
            'bezWielkosci': true,
          },
          {
            'wzor': '\\p{L}{7}',
            'skrot': 'bbad42404dae7eccdb5c9da096a448d035cbe65c428a1f58cad5e8617dff6d6a',
            'bezWielkosci': true,
          },
          {
            'wzor': '\\p{L}{7}',
            'skrot': '621ff5bc8c1a1c6efc971f9b84d23fd0cd4d1253e9591b25270647d40c165c4b',
            'bezWielkosci': true,
          },
          {
            'wzor': '\\p{L}{6}',
            'skrot': '22fd0120386bf44db9b2553babeb20e750484883331baed1e36f87aaf1dc7473',
            'bezWielkosci': true,
          },
          {
            'wzor': '\\p{L}{6}',
            'skrot': '90169bc179e0b72e1c17e7e07adcb8c6c8d57e97e32822f302cd8548700c5fda',
            'bezWielkosci': true,
          },
        ]).test(tekst),
      ).toBe(false);
      const nipy = [
        ...db
          .prepare(
            'SELECT nip FROM zamowienia WHERE nip IS NOT NULL UNION SELECT nip FROM klienci WHERE nip IS NOT NULL',
          )
          .all(),
      ].map((w) => w.nip);
      expect(nipy.length).toBeGreaterThan(5);
      expect(nipy.filter((n) => !/^(999\d{7}|[A-Z]{2}999\d+)$/.test(n))).toEqual([]);
      const adresy = db
        .prepare('SELECT dostawa_json FROM zamowienia')
        .all()
        .map((w) => JSON.parse(w.dostawa_json));
      expect(
        adresy.filter((a) => !/^(Ulica Przykładowa \d+|Musterstraße \d+|Ukázková \d+)$/.test(a.address_1)),
      ).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('uzupełnia oferty ERLI według id i pokazuje odpowiadające im plakietki Magazynu', async () => {
    const kanal = 'erli_polcien';
    const scenariusze = new Map([
      ['LMP-STO-001', ['aktywna', 'oms']],
      ['LMP-STO-002', ['do_wyslania', 'oms']],
      ['LMP-STO-003', ['problem', 'oms']],
      ['LMP-STO-004', ['blad', 'oms']],
      ['LMP-STO-005', ['aktywna', 'oms']],
      ['LMP-STO-006', ['aktywna', 'przejeta']],
    ]);
    const bezTresci = ['LMP-KIN-001', 'LMP-KIN-002'];
    await live.aplikacja.zegary.find((z) => z.nazwa === 'poller').przebieg();
    const db = new DatabaseSync(env.OMS_DB_PATH);
    try {
      const erli = createAtrapaErli({ db, kanal, env, demoZmiany: true });
      const karty = db
        .prepare(
          `SELECT k.id, k.sku, k.cena_gr, o.stan, o.pochodzenie, o.id_zewnetrzne, o.odczyt_cena_gr, o.odczyt_ilosc
          FROM karty_produktow k LEFT JOIN oferty_kanalow o ON o.karta_id = k.id AND o.kanal = ? ORDER BY k.id`,
        )
        .all(kanal);
      expect(karty).toHaveLength(150);
      expect(karty.filter((k) => bezTresci.includes(k.sku)).map((k) => k.sku)).toEqual(bezTresci);
      expect.soft(karty.filter((k) => k.stan === 'aktywna')).toHaveLength(117);
      expect.soft(karty.filter((k) => k.sku.startsWith('LMP-KAT-') && k.stan === 'aktywna')).toHaveLength(96);
      const { status, html } = await strona('/magazyn?wszystkie=1');
      expect(status).toBe(200);
      const wiersze = new Map(
        [...html.matchAll(/<tr>[\s\S]*?<\/tr>/g)]
          .map(([wiersz]) => [wiersz.match(/<div class="sku">([\w-]+)/)?.[1], wiersz])
          .filter(([sku]) => sku),
      );
      expect(wiersze.size).toBe(150);
      for (const karta of karty) {
        const { id, sku, stan, pochodzenie, id_zewnetrzne } = karta;
        const oczekiwana =
          scenariusze.get(sku) ?? (id % 5 !== 0 && !bezTresci.includes(sku) ? ['aktywna', 'oms'] : [null, null]);
        expect.soft([stan, pochodzenie], sku).toEqual(oczekiwana);
        if (oczekiwana[0] === 'aktywna' && !scenariusze.has(sku)) {
          expect.soft(id_zewnetrzne, sku).toBe(idProduktuErli(db, id));
        }
        const klasa = wiersze.get(sku)?.match(/class="plakietka plakietka--kanal (plakietka--erli[^"]*)"/)?.[1];
        expect
          .soft(klasa, sku)
          .toBe(
            oczekiwana[0] === null
              ? undefined
              : oczekiwana[0] === 'aktywna'
                ? 'plakietka--erli'
                : 'plakietka--erli plakietka--nieaktywna',
          );
      }
      const produkty = await erli.szukajProduktow({ pagination: { limit: 200 } });
      expect(produkty).toHaveLength(118);
      const znaneAtrapom = karty.filter((k) => ['aktywna', 'problem'].includes(k.stan));
      expect(produkty.map((p) => p.externalId).sort()).toEqual(znaneAtrapom.map((k) => k.id_zewnetrzne).sort());
      const poId = new Map(produkty.map((p) => [p.externalId, p]));
      for (const karta of znaneAtrapom) {
        expect(poId.get(karta.id_zewnetrzne), karta.sku).toMatchObject({
          sku: karta.sku,
          price: scenariusze.has(karta.sku) ? karta.odczyt_cena_gr : karta.cena_gr,
          stock: karta.odczyt_ilosc,
          status: 'active',
        });
      }
    } finally {
      db.close();
    }
  });
});

describe('generator danych demo — determinizm i odmowy', () => {
  it('zamówienia demo bez zmian', async () => {
    const env = envDla(katalog());
    await utworzBazeDemo({ baza: env.OMS_DB_PATH, dzis: '2026-11-19', env });
    const db = new DatabaseSync(env.OMS_DB_PATH, { readOnly: true });
    try {
      expect(
        db.prepare('SELECT COUNT(*) AS liczba, SUM(ROUND(kwota_brutto * 100)) AS suma_gr FROM zamowienia').get(),
      ).toEqual({ liczba: 212, suma_gr: 10065284 });
      expect(
        db.prepare('SELECT COUNT(*) AS liczba, SUM(ROUND(cena_brutto * ilosc * 100)) AS suma_gr FROM pozycje').get(),
      ).toEqual({ liczba: 384, suma_gr: 9755864 });
    } finally {
      db.close();
    }
  }, 60000);

  const migawka = async (ziarno) => {
    const k = katalog();
    const env = envDla(k);
    await utworzBazeDemo({ baza: env.OMS_DB_PATH, dzis: DZIS, ziarno, env });
    const db = new DatabaseSync(env.OMS_DB_PATH, { readOnly: true });
    try {
      return db
        .prepare(
          `SELECT sklep, numer, kwota_brutto, utworzone_at, wyslane_at, w_realizacji_at, anulowane, nip,
        (SELECT COUNT(*) FROM pozycje p WHERE p.zamowienie_id = z.id) pozycji FROM zamowienia z ORDER BY id`,
        )
        .all();
    } finally {
      db.close();
    }
  };

  it('to samo ziarno i dzień dają te same zamówienia, inne ziarno — inne', async () => {
    const a = await migawka(7),
      b = await migawka(7),
      c = await migawka(8);
    expect(b).toEqual(a);
    expect(c).not.toEqual(a);
  }, 60000);

  it('reset 1. dnia miesiąca: bieżący miesiąc ma koszty (zakładka Koszty otwiera się na nim)', async () => {
    const k = katalog();
    const env = envDla(k);
    await utworzBazeDemo({ baza: env.OMS_DB_PATH, dzis: '2026-11-01', env });
    const db = new DatabaseSync(env.OMS_DB_PATH, { readOnly: true });
    try {
      const w = db
        .prepare("SELECT COUNT(*) n, MAX(data_wystawienia) d FROM koszty WHERE data_wystawienia LIKE '2026-11-%'")
        .get();
      expect(w.n).toBe(8);
      expect(w.d).toBe('2026-11-01');
      // Pierwszego dnia minęła 1/30 miesiąca — kwota każdego kosztu to ta część przedziału z pliku firmy, nie pełny miesiąc.
      const wiersze = db
        .prepare(
          "SELECT numer_dokumentu, netto, kategoria_dokumentu k FROM koszty WHERE numer_dokumentu LIKE 'DEMO/2026-11/%' ORDER BY numer_dokumentu",
        )
        .all();
      expect(wiersze.map((x) => x.k)).toEqual(KOSZTY.map((x) => x.kategoria));
      wiersze.forEach((x, i) => {
        const gr = Math.round(Number(x.netto) * 100);
        expect(gr).toBeGreaterThanOrEqual(Math.round(KOSZTY[i].netto_od_gr / 30));
        expect(gr).toBeLessThanOrEqual(Math.round(KOSZTY[i].netto_do_gr / 30));
      });
    } finally {
      db.close();
    }
  });

  it('istniejący plik bazy: odmowa, bajty nietknięte', async () => {
    const k = katalog();
    const plik = path.join(k, 'oms.sqlite');
    fs.writeFileSync(plik, 'cudza-baza');
    await expect(utworzBazeDemo({ baza: plik, dzis: DZIS, env: envDla(k) })).rejects.toThrow('DEMO_ODMOWA_NADPISANIA');
    expect(fs.readFileSync(plik, 'utf8')).toBe('cudza-baza');
  });

  it('baza z zamówieniem: odmowa przed jakimkolwiek zapisem', async () => {
    const k = katalog();
    const env = envDla(k);
    await utworzBazeDemo({ baza: env.OMS_DB_PATH, dzis: DZIS, env });
    const db = new DatabaseSync(env.OMS_DB_PATH);
    try {
      const przed = db.prepare('SELECT COUNT(*) n FROM zamowienia').get().n;
      expect(() => wygenerujDaneDemo(db, { dzis: DZIS, env })).toThrow('DEMO_BAZA_NIEPUSTA');
      expect(db.prepare('SELECT COUNT(*) n FROM zamowienia').get().n).toBe(przed);
    } finally {
      db.close();
    }
  }, 30000);

  it('NIP fikcyjny ma poprawną sumę kontrolną i prefiks 999', () => {
    for (const n of [0, 1, 1000, 5011, 7013, ...FIRMY_B2B.map((f) => f.nip)].map((x) =>
      typeof x === 'number' ? nipFikcyjny(x) : x,
    )) {
      const c = n.split('').map(Number);
      expect(n).toMatch(/^999\d{7}$/);
      expect([6, 5, 7, 2, 3, 4, 5, 6, 7].reduce((s, w, i) => s + w * c[i], 0) % 11).toBe(c[9]);
    }
  });
});

// Nowe dane demo i piaskownicy: duże koszyki, więcej faktur, „nowe” tylko z dziś,
// okresy rozliczeniowe w różnych stanach, korekty, przesyłki utworzone i w drodze u różnych przewoźników i w kanałach.
describe('dane demo do pokazania', () => {
  const dzienW = (t) => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
  /** Godzina zegara w Polsce danego dnia → ISO UTC (strefa z Intl, także w dniu zmiany czasu). */
  const chwilaWarszawy = (dzis, hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    const naiwna = Date.parse(`${dzis}T00:00:00Z`) + h * 3600000 + m * 60000;
    const strefa = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Warsaw', timeZoneName: 'shortOffset' })
      .formatToParts(new Date(naiwna))
      .find((p) => p.type === 'timeZoneName').value;
    return new Date(naiwna - Number(/GMT([+-]\d+)/.exec(strefa)?.[1] ?? 0) * 3600000).toISOString();
  };
  const bazy = new Map();
  /** Baza demo na dzień (i opcjonalnie „teraz” HH:MM czasu Warszawy) — jedna na przebieg, otwarta do odczytu. */
  const baza = async (dzis, teraz) => {
    const klucz = `${dzis} ${teraz ?? ''}`;
    if (!bazy.has(klucz)) {
      const env = envDla(katalog());
      const wynik = await utworzBazeDemo({ baza: env.OMS_DB_PATH, dzis, env, ...(teraz ? { teraz } : {}) });
      bazy.set(klucz, { db: new DatabaseSync(env.OMS_DB_PATH), wynik });
    }
    return bazy.get(klucz);
  };
  afterAll(() => {
    for (const { db } of bazy.values()) db.close();
  });
  const tylko = (db, sql, ...a) => db.prepare(sql).all(...a);
  const nowe = (db) =>
    tylko(
      db,
      `SELECT id, sklep, utworzone_at FROM zamowienia z WHERE anulowane = 0 AND indywidualne = 0
    AND w_realizacji_at IS NULL AND wyslane_at IS NULL AND zwrot_at IS NULL AND NOT EXISTS (SELECT 1 FROM zwroty w WHERE w.zamowienie_id = z.id)`,
    );

  it('co najmniej 8 zamówień z 4–7 różnymi produktami, w sklepie, na obu kontach Allegro i w B2B; część z ilością > 1', async () => {
    const { db } = await baza('2026-11-13');
    const duze = tylko(
      db,
      `SELECT z.id, z.sklep, COUNT(DISTINCT p.sku) rodzajow, MAX(p.ilosc) maks FROM zamowienia z JOIN pozycje p ON p.zamowienie_id = z.id
      WHERE p.sku IS NOT NULL GROUP BY z.id HAVING COUNT(DISTINCT p.sku) >= 4`,
    );
    expect(duze.length).toBeGreaterThanOrEqual(8);
    // Wyjątki: koszyk z 15 produktami i „nowe” z 12 do zwijania na liście zamówień.
    expect(
      duze
        .filter((z) => z.rodzajow > 7)
        .map((z) => z.rodzajow)
        .sort((a, b) => a - b),
    ).toEqual([12, 15]);
    expect(new Set(duze.map((z) => z.sklep))).toEqual(new Set(['polcien', 'allegro', 'allegro-outlet', 'reczne']));
    expect(duze.filter((z) => z.maks > 1).length).toBeGreaterThanOrEqual(4);
  });

  it('faktura przy co najmniej 30% zamówień (było 34/177 = 19%), także osoby prywatne bez NIP-u i Allegro', async () => {
    const { db } = await baza('2026-11-13');
    const razem = tylko(db, 'SELECT COUNT(*) n FROM zamowienia')[0].n;
    const zFaktura = tylko(
      db,
      `SELECT COUNT(*) n FROM zamowienia z WHERE EXISTS (SELECT 1 FROM faktury f WHERE f.zamowienie_id = z.id)
      OR (z.anulowane = 0 AND EXISTS (SELECT 1 FROM okresy_rozliczeniowe o WHERE o.id = z.okres_rozliczeniowy_id AND o.numer IS NOT NULL))`,
    )[0].n;
    expect(zFaktura / razem).toBeGreaterThanOrEqual(0.3);
    const wgKanalu = Object.fromEntries(
      tylko(
        db,
        'SELECT z.sklep k, COUNT(*) n FROM faktury f JOIN zamowienia z ON z.id = f.zamowienie_id GROUP BY z.sklep',
      ).map((w) => [w.k, w.n]),
    );
    expect(wgKanalu.allegro).toBeGreaterThanOrEqual(8);
    expect(wgKanalu['allegro-outlet']).toBeGreaterThanOrEqual(3);
    expect(wgKanalu.polcien).toBeGreaterThanOrEqual(15);
    expect(
      tylko(
        db,
        `SELECT COUNT(*) n FROM faktury f JOIN zamowienia z ON z.id = f.zamowienie_id WHERE z.nip IS NULL
      AND COALESCE(json_extract(z.klient_json, '$.company'), '') = ''`,
      )[0].n,
    ).toBeGreaterThanOrEqual(3);
  });

  it.each([
    ['2026-11-13', undefined, '06:30'],
    ['2026-11-13', '00:20', '00:20'],
    ['2026-11-01', '00:20', '00:20'],
    ['2026-03-29', '09:00', '09:00'],
  ])('status „nowe” tylko z dziś i nie z przyszłości (%s, teraz %s)', async (dzis, teraz, godzina) => {
    const { db } = await baza(dzis, teraz);
    const terazIso = chwilaWarszawy(dzis, godzina);
    const lista = nowe(db);
    for (const z of lista) {
      expect.soft(dzienW(z.utworzone_at), `#${z.id} ${z.sklep}`).toBe(dzis);
      expect.soft(z.utworzone_at <= terazIso, `#${z.id} ${z.utworzone_at} > ${terazIso}`).toBe(true);
    }
    if (!teraz) expect(lista.length).toBeGreaterThanOrEqual(10);
    // Nic z przyszłości: zamówienia, fakty statusu, wpłaty, faktury, paczki.
    const najpozniej = tylko(
      db,
      `SELECT MAX(t) t FROM (SELECT MAX(utworzone_at) t FROM zamowienia UNION ALL SELECT MAX(w_realizacji_at) FROM zamowienia
        UNION ALL SELECT MAX(wyslane_at) FROM zamowienia UNION ALL SELECT MAX(oplacone_at) FROM zamowienia UNION ALL SELECT MAX(utworzona_at) FROM faktury
        UNION ALL SELECT MAX(utworzona_at) FROM przesylki UNION ALL SELECT MAX(status_kuriera_at) FROM przesylki
        UNION ALL SELECT MAX(utworzona_at) FROM okresy_rozliczeniowe UNION ALL SELECT MAX(zamkniety_at) FROM okresy_rozliczeniowe
        UNION ALL SELECT MAX(utworzona_at) FROM platnosci_okresu UNION ALL SELECT MAX(korekta_zlecona_at) FROM zwroty)`,
    )[0].t;
    expect(najpozniej <= terazIso, `${najpozniej} > ${terazIso}`).toBe(true);
  });

  it.each(['2026-11-13', '2026-11-02', '2026-11-30', '2026-03-01'])(
    'okresy rozliczeniowe (%s): ≥ 4 firmy, ≥ 8 okresów, wszystkie stany, różne ustalenia',
    async (dzis) => {
      const { db } = await baza(dzis);
      const firmy = tylko(
        db,
        'SELECT klucz, termin_platnosci, prog_darmowej_dostawy_gr, oplata_obslugi_gr, rabat_procent FROM klienci WHERE rozliczenie_zbiorcze = 1',
      );
      expect(firmy.length).toBeGreaterThanOrEqual(4);
      expect(
        new Set(firmy.map((f) => JSON.stringify([f.termin_platnosci, f.prog_darmowej_dostawy_gr, f.oplata_obslugi_gr])))
          .size,
      ).toBeGreaterThanOrEqual(4);
      const okresy = tylko(
        db,
        `SELECT o.*, (SELECT COALESCE(SUM(CAST(kwota AS REAL)), 0) FROM platnosci_okresu p WHERE p.okres_rozliczeniowy_id = o.id) wplacono,
      (SELECT dane_json FROM atrapa_infakt_dokumenty a WHERE a.uuid = o.infakt_uuid) dok FROM okresy_rozliczeniowe o`,
      );
      expect(okresy.length).toBeGreaterThanOrEqual(8);
      expect(new Set(okresy.map((o) => o.klient_klucz)).size).toBeGreaterThanOrEqual(4);
      const miesiacDzis = `${dzis.slice(0, 4)}-${dzis.slice(5, 7)}`;
      const biezace = okresy.filter((o) => `${o.rok}-${String(o.miesiac).padStart(2, '0')}` === miesiacDzis);
      expect(biezace.length).toBeGreaterThanOrEqual(1);
      expect(biezace.every((o) => o.stan === 'otwarty')).toBe(true);
      // Każdy okres ma zamówienia; otwarte są tylko w bieżącym miesiącu.
      for (const o of okresy)
        expect
          .soft(
            tylko(db, 'SELECT COUNT(*) n FROM zamowienia WHERE okres_rozliczeniowy_id = ?', o.id)[0].n,
            `okres ${o.id}`,
          )
          .toBeGreaterThan(0);
      expect(okresy.filter((o) => o.stan === 'otwarty').every((o) => biezace.includes(o))).toBe(true);
      expect(okresy.filter((o) => o.stan === 'zamkniety' && !o.numer).length).toBeGreaterThanOrEqual(1);
      const zafakturowane = okresy.filter((o) => o.stan === 'zafakturowany');
      for (const o of zafakturowane)
        expect.soft(o.numer && o.dok, `okres ${o.id} bez dokumentu w atrapie`).toBeTruthy();
      const dok = (o) => JSON.parse(o.dok);
      const oplacony = (o) => o.wplacono * 100 >= dok(o).gross_price && dok(o).status === 'paid';
      expect(zafakturowane.filter(oplacony).length).toBeGreaterThanOrEqual(1);
      const nieoplacone = zafakturowane.filter((o) => !oplacony(o) && dok(o).status !== 'paid');
      expect(
        nieoplacone.filter((o) => dok(o).payment_date >= dzis).length,
        'nieopłacony w terminie',
      ).toBeGreaterThanOrEqual(1);
      expect(
        nieoplacone.filter((o) => dok(o).payment_date < dzis).length,
        'nieopłacony po terminie',
      ).toBeGreaterThanOrEqual(1);
      // Firma z własną etykietą płaci za obsługę zamiast dostawy.
      expect(
        tylko(db, "SELECT COUNT(*) n FROM pozycje WHERE nazwa LIKE 'Obsługa%' AND zrodlo = 'reczna'")[0].n,
      ).toBeGreaterThanOrEqual(1);
    },
  );

  it('co najmniej 3 korekty na liście faktur (atrapa inFaktu), jedna wystawiona usługą korekty do zwrotu części koszyka', async () => {
    const { db } = await baza('2026-11-13');
    const zwroty = tylko(db, 'SELECT * FROM zwroty WHERE korekta_numer IS NOT NULL');
    expect(zwroty.length).toBeGreaterThanOrEqual(3);
    const korekty = tylko(db, "SELECT dane_json FROM atrapa_infakt_dokumenty WHERE rodzaj = 'korekta'").map((w) =>
      JSON.parse(w.dane_json),
    );
    expect(korekty.length).toBeGreaterThanOrEqual(3);
    for (const z of zwroty)
      expect
        .soft(
          korekty.some((k) => k.number === z.korekta_numer),
          z.korekta_numer,
        )
        .toBe(true);
    // Korekta części koszyka: dokument koryguje jedną pozycję faktury z kilkoma pozycjami.
    const czesciowa = korekty.find((k) => k.correction_reason === 'zwrot towaru');
    expect(czesciowa).toBeTruthy();
  });

  it('przesyłki: utworzone i w drodze u różnych przewoźników i w różnych kanałach, jedna stoi bez ruchu', async () => {
    const { db } = await baza('2026-11-13');
    const kubly = { utworzone: [], w_drodze: [] };
    const terazIso = new Date(Date.parse('2026-11-13T05:30:00Z')).toISOString();
    let stoi = 0;
    for (const p of tylko(db, 'SELECT p.*, z.sklep FROM przesylki p JOIN zamowienia z ON z.id = p.zamowienie_id')) {
      const etap = etapPrzesylki(p.status_kuriera);
      if (bezRuchu({ etap, statusKurieraAt: p.status_kuriera_at, nadanaAt: p.utworzona_at, teraz: terazIso }))
        stoi += 1;
      const kat = kategoriaPrzesylki(p, etap);
      if (!kubly[kat]) continue;
      kubly[kat].push({
        sklep: p.sklep,
        przewoznik: przewoznikWiersza(p, pobierzZamowienie(db, p.zamowienie_id))?.nazwa,
      });
    }
    expect(stoi).toBe(1);
    for (const [kat, lista] of Object.entries(kubly)) {
      expect.soft(lista.length, kat).toBeGreaterThanOrEqual(9);
      expect.soft(new Set(lista.map((x) => x.przewoznik)).size, `${kat}: przewoźnicy`).toBeGreaterThanOrEqual(4);
      expect
        .soft(new Set(lista.map((x) => x.sklep)), `${kat}: kanały`)
        .toEqual(new Set(['polcien', 'allegro', 'allegro-outlet', 'reczne']));
    }
  });
});
