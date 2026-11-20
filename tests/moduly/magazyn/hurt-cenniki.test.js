// Edycja hurtem: cennik OMS kart i cennik wybrany dla każdego konta Allegro i ERLI. Panel z polami kont (konto bez
// pobranej listy — pole wyłączone z napisem), podgląd z liczbą wystawionych ofert, którym zmieni się cennik WYNIKOWY,
// zatwierdzenie liczone od nowa i odmowa całości. Hurt niczego nie wysyła do kanałów: oferty zmienia pętla, bo zmienia
// się treść (`delivery`) i jej skrót — tylko na koncie, którego wybór się zmienił. Konta, karty i cenniki zmyślone.
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { definicjeKanalowHistoryczne } from '../../pomoc/przykladowe-definicje-kanalow.js';
import { szyfrTestowy } from '../../pomoc/sejf-testowy.ts';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { dodajCennikOms, ustawPowiazanieCennika, ustawCennikKarty } from '../../../src/oms/db/cenniki-oms.ts';
import { wyjatekCennika, zapiszWyjatekCennika } from '../../../src/oms/db/cenniki-kart.ts';
import { wstawOferte, zapiszUstawieniaOfertKonta, ustawieniaOfertKonta } from '../../../src/oms/db/oferty-kanalow.ts';
import { ofertaAllegroKarty } from '../../../src/moduly/magazyn/services/tresc-oferty-allegro.js';
import { trescOferty } from '../../../src/moduly/magazyn/services/tresc-oferty.js';
import { trescAllegro } from '../../../src/moduly/magazyn/services/petla-ofert-allegro.js';
import { skrotTresci } from '../../../src/moduly/magazyn/services/oferty-wspolne.js';
import { TEKST_LISTA_NIEPOBRANA } from '../../../src/moduly/magazyn/services/cenniki-kont.js';
import { zalozKonto, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import { opisKategorii } from '../../../src/domena/tresc-oferty-allegro.js';
import { kategoriaAllegroDemo, parametryKategoriiAllegroDemo } from '../../../scripts/demo-dane-katalog.mjs';
import slowniki from '../../fixtures/allegro/e3-dok-slowniki.json' with { type: 'json' };

const KONTO = 'allegro_lampy';
const ERLI = 'erli_lampy';
const T0 = '2026-11-14T08:00:00.000Z';
const OFERTY = ['allegro:api:sale:offers:write', 'allegro:api:sale:settings:read'];
const jwt = (scope) => ['e30', Buffer.from(JSON.stringify({ scope })).toString('base64url'), 'podpis'].join('.');
const auth = {
  authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`,
  origin: 'http://localhost',
  'content-type': 'application/x-www-form-urlencoded',
};
const CENNIKI_KONTA = [
  { id: 'cen-a', nazwa: 'Pracownia Półcień — paczkomat A' },
  { id: 'cen-c', nazwa: 'Pracownia Półcień — paczkomat C' },
  { id: 'cen-gabaryt', nazwa: 'Pracownia Półcień — kurier gabaryt' },
  { id: 'cennik-1', nazwa: 'Pracownia Półcień — standard' },
];
const MALA = { szerokosc_mm: 630, wysokosc_mm: 370, glebokosc_mm: 60, waga_g: 2000 };

let db, app, klienci;

const atrapaAllegro = () => ({
  podgladOplat: vi.fn(async () => structuredClone(slowniki.podgladOplat)),
  utworzOferte: vi.fn(),
  zmienOferte: vi.fn(),
  zmienStatusOferty: vi.fn(),
  komendaIlosci: vi.fn(),
  komendaCeny: vi.fn(),
  pobierzOferte: vi.fn(),
  wgrajZdjecie: vi.fn(),
});

/** Karta gotowa do wystawienia na Allegro i ERLI (kategoria z mapy, marka, GPSR konta, 3 zdjęcia). */
function karta(n) {
  const id = utworzKarte(
    db,
    {
      nazwa: `Lampa stołowa Gliwka ${n}`,
      sku: `GLW-${n}`,
      cena_gr: 5900,
      stawka_vat: '23',
      marka: 'Pracownia Półcień',
      kategoria_glowna: 'Lampy stołowe',
      ...MALA,
      opis_sekcje_json: JSON.stringify({
        sekcje: [{ elementy: [{ typ: 'tekst', html: '<p>Lampa z mlecznym kloszem.</p>' }] }],
      }),
    },
    { at: T0 },
  );
  db.prepare('UPDATE karty_produktow SET informacja_bezpieczenstwa = ? WHERE id = ?').run(
    JSON.stringify({ typ: 'TEXT', tekst: 'Nie zostawiaj włączonej lampy bez nadzoru.' }),
    id,
  );
  const zdj =
    db.prepare(`INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, sha256, typ, ai, ai_reczne, utworzono_at)
    VALUES (?, ?, 'reczne', ?, NULL, 'image/jpeg', 0, 1, ?)`);
  for (let i = 0; i < 3; i++) zdj.run(id, i, `https://polcien.example.invalid/gliwka-${id}-${i + 1}.jpg`, T0);
  return id;
}

beforeEach(async () => {
  db = openOmsDb(':memory:');
  klienci = { [KONTO]: atrapaAllegro(), [ERLI]: { utworzProdukt: vi.fn(), zmienProdukt: vi.fn() } };
  app = buildOmsServer({
    db,
    config: {
      auth: { user: 'operator', pass: 'atrapa' },
      definicje: [
        ...definicjeKanalowHistoryczne,
        { klucz: ERLI, typ: 'erli', prefiks: 'ERLI_LAMPY', etykieta: 'lampy.erli' },
      ],
    },
    magazyn: { start: vi.fn(), stan: () => ({ trwa: false, kanaly: [] }) },
    nadpisania: {
      'kanaly.klienciKanalow': klienci,
      'kanaly.repozytoriumKanalow': {
        listaTypu: (typ) =>
          typ === 'allegro'
            ? [{ klucz: KONTO, nazwa: 'Półcień', autoryzacja: 'polaczone', srodowisko: 'produkcja' }]
            : typ === 'erli'
              ? [{ klucz: ERLI, nazwa: 'Półcień' }]
              : [],
        zapisyZablokowane: () => false,
        konfliktKlucza: () => false,
      },
    },
  });
  await app.ready();
  db.prepare(
    `INSERT OR REPLACE INTO tokeny_kanalu (kanal, access_token, refresh_token, wygasa_at, refresh_wygasa_at, zaktualizowane_at)
    VALUES (?, ?, ?, '2026-11-14T11:00:00Z', '2027-01-01T00:00:00Z', '2026-11-14T10:00:00Z')`,
  ).run(
    KONTO,
    szyfrTestowy(db, 'tokeny_kanalu', 'access_token', KONTO, jwt(['allegro:api:orders:read', ...OFERTY])),
    szyfrTestowy(db, 'tokeny_kanalu', 'refresh_token', KONTO, 'REFRESH-ATRAPA'),
  );
  db.prepare(
    `INSERT INTO allegro_mapa_kategorii (kategoria_karty, srodowisko, kategoria_allegro_id) VALUES ('Lampy stołowe', 'produkcja', '257')`,
  ).run();
  const regula =
    db.prepare(`INSERT INTO allegro_reguly_parametrow (srodowisko, kategoria_allegro_id, parametr_id, rodzaj,
    wartosc_json, pole, zmieniono_at) VALUES ('produkcja', '257', ?, ?, ?, ?, ?)`);
  regula.run('11323', 'stala', JSON.stringify({ valuesIds: ['11323_1'] }), null, T0);
  regula.run('248811', 'pole', null, 'marka', T0);
  db.prepare(
    `INSERT INTO allegro_marki (marka, srodowisko, parametr_id, wartosc_id, kategorie_sprawdzone_json, zmieniono_at)
    VALUES ('Pracownia Półcień', 'produkcja', '248811', '248811_9001', '["257"]', ?)`,
  ).run(T0);
  const opis = opisKategorii(['5', '256', '257'].map(kategoriaAllegroDemo), parametryKategoriiAllegroDemo('257'));
  db.prepare(
    `INSERT INTO allegro_marki_gpsr (marka, konto, zrodlo, zmieniono_at) VALUES ('Pracownia Półcień', ?, 'konto', ?)`,
  ).run(KONTO, T0);
  db.prepare(
    `INSERT INTO kanaly_kategorie (polaczenie, kategoria_id, sciezka_json, parametry_json, pobrano_at) VALUES (?, '257', ?, ?, ?)`,
  ).run(
    KONTO,
    JSON.stringify(opis.sciezka),
    JSON.stringify({
      wersja: opis.wersja,
      lisc: opis.lisc,
      tworzenieProduktu: opis.tworzenieProduktu,
      parametry: opis.parametry,
    }),
    T0,
  );
  zapiszUstawieniaOfertKonta(
    db,
    KONTO,
    {
      narzutProcent: 0,
      stalaIlosc: 5,
      czasWysylkiDni: 2,
      cennikDostaw: 'cennik-1',
      stawkaVat: '23',
      zwrotyId: 'zwrot-1',
      reklamacjeId: 'rekl-1',
      producentId: 'prod-konta',
      slowniki: {
        pobranoAt: T0,
        cenniki: CENNIKI_KONTA,
        zwroty: [],
        reklamacje: [],
        gwarancje: [],
        producenci: [],
        osoby: [],
      },
    },
    { teraz: T0 },
  );
  zapiszUstawieniaOfertKonta(
    db,
    ERLI,
    { narzutProcent: 0, stalaIlosc: 5, czasWysylkiDni: 2, cennikDostaw: 'Lampy', stawkaVat: '23' },
    { teraz: T0 },
  );
});
afterEach(async () => {
  await app.close();
  db.close();
});

/** Pobrana lista cenników konta ERLI (bez niej konto ERLI ma pole wyłączone). */
const listaErli = (nazwy = ['Paczkomat A', 'Kurier gabaryt']) =>
  db
    .prepare(
      `INSERT OR REPLACE INTO konfiguracja_integracji (integracja, ustawienia_json, sekrety_json, zmieniono_at)
    VALUES (?, ?, '{}', ?)`,
    )
    .run(`erli:${ERLI}`, JSON.stringify({ cennikiDostaw: nazwy, cennikiPobranoAt: T0 }), T0);
/** Cennik OMS z powiązaniami `{ konto: cennikKanalu }`; zwraca jego id. */
const cennikOms = (nazwa, powiazania = {}) => {
  const id = dodajCennikOms(db, { nazwa });
  for (const [konto, cennikKanalu] of Object.entries(powiazania))
    ustawPowiazanieCennika(db, { cennikId: id, konto, cennikKanalu });
  return id;
};
const oferta = (kartaId, kanal, stan = 'aktywna', idZewnetrzne = `${kanal}-${kartaId}`) =>
  wstawOferte(db, { kartaId, kanal, idZewnetrzne, tryb: 'zarzadzana', stan }, { teraz: T0 });
const wyborKonta = (kartaId, konto) =>
  db
    .prepare(
      'SELECT cennik_kanalu, zmieniono_at, aktor_login FROM karty_cenniki_kanalow WHERE karta_id = ? AND konto = ?',
    )
    .get(kartaId, konto);
const omsKarty = (kartaId) =>
  db.prepare('SELECT cennik_id, zmieniono_at, aktor_login FROM karty_cennik_oms WHERE karta_id = ?').get(kartaId);
const ileWyborow = () =>
  db.prepare('SELECT (SELECT COUNT(*) FROM karty_cenniki_kanalow) + (SELECT COUNT(*) FROM karty_cennik_oms) c').get().c;

const wyslij = (url, pola) => {
  const dane = new URLSearchParams();
  for (const [k, v] of Object.entries(pola)) for (const x of [v].flat()) dane.append(k, x);
  return app.inject({ method: 'POST', url, headers: auth, payload: dane.toString() });
};
const podglad = (pola) => wyslij('/magazyn/hurt', pola);
const zatwierdz = (pola) => wyslij('/magazyn/hurt/zatwierdz', pola);

function sekcja(body, id) {
  const trafienie = new RegExp(`<(section|details)[^>]*id="${id}"[\\s\\S]*?</\\1>`).exec(body);
  if (!trafienie) throw new Error(`Na ekranie nie ma sekcji „${id}”`);
  return trafienie[0];
}
const bezZnacznikow = (html) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const wierszePodgladu = (body) =>
  sekcja(body, 'zmiany-hurtem')
    .split('<tr')
    .slice(1)
    .map((tr) => [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => bezZnacznikow(m[1])).filter(Boolean))
    .filter((k) => k.length);
/** Ukryte pola i zaznaczone karty z podglądu — dokładnie to, co wysyła przycisk „Zatwierdź”. */
function daneZPodgladu(body) {
  const dane = {};
  for (const [input] of sekcja(body, 'zmiany-hurtem').matchAll(/<input\b[^>]*>/g)) {
    const atrybut = (nazwa) => new RegExp(`\\b${nazwa}="([^"]*)"`).exec(input)?.[1];
    const typ = atrybut('type');
    if (typ === 'hidden' || (typ === 'checkbox' && /\schecked\b/.test(input))) {
      const nazwa = atrybut('name');
      const wartosc = atrybut('value')
        .replace(/&amp;/g, '&')
        .replace(/&#34;|&quot;/g, '"');
      dane[nazwa] = nazwa in dane ? [dane[nazwa], wartosc].flat() : wartosc;
    }
  }
  return dane;
}
const zatwierdzZPodgladu = (body) => zatwierdz(daneZPodgladu(body));
const zdanieOfert = (body) => /<p[^>]*id="hurt-oferty-cennika"[^>]*>([\s\S]*?)<\/p>/.exec(body)?.[1];

describe('panel hurtu — opcja „Cennik dostaw”', () => {
  it('grupa „Wysyłka”, pole cennika OMS i pole na każde konto; konto bez listy — pole wyłączone z napisem', async () => {
    cennikOms('Paczkomat mały');
    karta(1);
    const r = await app.inject({ method: 'GET', url: '/magazyn', headers: auth });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/<button[^>]*class="[^"]*hz-opcja[^"]*"[^>]*data-z="cennik"/);
    const szablon = /<li[^>]*data-zmiana="cennik"[\s\S]*?<\/li>/.exec(r.body)?.[0] ?? '';
    const oms = /<select[^>]*name="cennik_oms_hurt"[\s\S]*?<\/select>/.exec(szablon)?.[0] ?? '';
    // Te same pozycje i etykiety co pole „Cennik dostaw tej karty” — wszystkie cenniki OMS, także domyślny.
    const opcjeOms = [...oms.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)</g)].map((m) => [m[1], m[2].trim()]);
    expect(opcjeOms.slice(0, 2)).toEqual([
      ['', '— bez zmian —'],
      ['__usun__', '— usuń (według rozmiaru) —'],
    ]);
    const wBazie = db.prepare('SELECT id FROM cenniki_dostaw_oms ORDER BY id').all();
    expect(
      opcjeOms
        .slice(2)
        .map(([id]) => Number(id))
        .sort((x, y) => x - y),
    ).toEqual(wBazie.map((w) => Number(w.id)));
    expect(opcjeOms).toContainEqual([expect.stringMatching(/^\d+$/), 'Paczkomat mały (tylko na karcie)']);
    const allegro = /<select[^>]*name="cennik_konta_hurt_allegro_lampy"[\s\S]*?<\/select>/.exec(szablon)?.[0] ?? '';
    expect([...allegro.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)</g)].map((m) => m[1])).toEqual([
      '',
      '__usun__',
      'cen-a',
      'cen-c',
      'cen-gabaryt',
      'cennik-1',
    ]);
    expect(allegro).toContain('— usuń wybór konta —');
    expect(szablon).toContain('Allegro · allegro_lampy');
    const erli = /<select[^>]*name="cennik_konta_hurt_erli_lampy"[^>]*>/.exec(szablon)?.[0] ?? '';
    expect(erli).toMatch(/\sdisabled\b/);
    expect(szablon).toContain(TEKST_LISTA_NIEPOBRANA);
  });
});

describe('podgląd i zatwierdzenie cenników hurtem', () => {
  it('ustawia cennik OMS i wybór konta; podgląd nic nie zapisuje, zatwierdzenie jednym znacznikiem z autorem', async () => {
    const kurier = cennikOms('Kurier gabaryt');
    const a = karta(1);
    const b = karta(2);
    zapiszWyjatekCennika(db, { kartaId: b, konto: KONTO, cennik: 'cen-a' }, { teraz: T0, aktor: 'import' });
    const p = await podglad({
      zaznaczone: [String(a), String(b)],
      cennik_oms_hurt: String(kurier),
      cennik_konta_hurt_allegro_lampy: 'cen-c',
    });
    expect(p.statusCode).toBe(200);
    expect(wierszePodgladu(p.body)).toEqual([
      ['Lampa stołowa Gliwka 1', 'Cennik OMS', 'według rozmiaru', 'Kurier gabaryt'],
      ['Cennik · Allegro · allegro_lampy', 'z cennika OMS / według rozmiaru', 'Pracownia Półcień — paczkomat C'],
      ['Lampa stołowa Gliwka 2', 'Cennik OMS', 'według rozmiaru', 'Kurier gabaryt'],
      ['Cennik · Allegro · allegro_lampy', 'Pracownia Półcień — paczkomat A', 'Pracownia Półcień — paczkomat C'],
    ]);
    expect(omsKarty(a)).toBeUndefined();
    expect(wyborKonta(a, KONTO)).toBeUndefined();
    expect(wyborKonta(b, KONTO).cennik_kanalu).toBe('cen-a');

    const z = await zatwierdzZPodgladu(p.body);
    expect(z.statusCode).toBe(200);
    expect(z.body).toContain('Zmieniono <b>2 karty</b>');
    const zapisy = [omsKarty(a), omsKarty(b), wyborKonta(a, KONTO), wyborKonta(b, KONTO)];
    expect(zapisy.map((w) => w.aktor_login)).toEqual(['operator', 'operator', 'operator', 'operator']);
    expect(new Set(zapisy.map((w) => w.zmieniono_at)).size).toBe(1);
    expect([omsKarty(a).cennik_id, wyborKonta(a, KONTO).cennik_kanalu, wyborKonta(b, KONTO).cennik_kanalu]).toEqual([
      kurier,
      'cen-c',
      'cen-c',
    ]);
    // Hurt to tylko zapis w OMS — oferty zmienia pętla.
    expect(klienci[KONTO].zmienOferte).not.toHaveBeenCalled();
    expect(klienci[ERLI].zmienProdukt).not.toHaveBeenCalled();
  });

  it('„usuń” zdejmuje wybór; puste pole konta zostawia wybór; karta bez zmiany nie wchodzi do planu', async () => {
    const maly = cennikOms('Paczkomat mały');
    listaErli();
    const a = karta(1);
    const b = karta(2);
    ustawCennikKarty(db, { kartaId: a, cennikId: maly }, { teraz: T0, aktor: 'import' });
    zapiszWyjatekCennika(db, { kartaId: a, konto: KONTO, cennik: 'cen-a' }, { teraz: T0, aktor: 'import' });
    zapiszWyjatekCennika(db, { kartaId: a, konto: ERLI, cennik: 'Kurier gabaryt' }, { teraz: T0, aktor: 'import' });
    const pola = {
      zaznaczone: [String(a), String(b)],
      cennik_oms_hurt: '__usun__',
      cennik_konta_hurt_allegro_lampy: '',
      cennik_konta_hurt_erli_lampy: '__usun__',
    };
    const p = await podglad(pola);
    expect(wierszePodgladu(p.body)).toEqual([
      ['Lampa stołowa Gliwka 1', 'Cennik OMS', 'Paczkomat mały', 'według rozmiaru'],
      ['Cennik · ERLI · lampy.erli', 'Kurier gabaryt', 'z cennika OMS / według rozmiaru'],
    ]);
    expect((await zatwierdzZPodgladu(p.body)).statusCode).toBe(200);
    expect(omsKarty(a)).toBeUndefined();
    expect(wyborKonta(a, ERLI)).toBeUndefined();
    expect(wyborKonta(a, KONTO)).toEqual({ cennik_kanalu: 'cen-a', zmieniono_at: T0, aktor_login: 'import' });
  });

  it('same puste pola cenników to brak decyzji', async () => {
    const a = karta(1);
    const r = await zatwierdz({ zaznaczone: String(a), cennik_oms_hurt: '', cennik_konta_hurt_allegro_lampy: '' });
    expect(r.statusCode).toBe(400);
    expect(ileWyborow()).toBe(0);
  });

  it.each(['/magazyn/hurt', '/magazyn/hurt/zatwierdz'])(
    'klucz konta spoza konfiguracji albo wartość spoza listy w %s odmawia całości i nic nie zapisuje',
    async (url) => {
      const kurier = cennikOms('Kurier gabaryt');
      const a = karta(1);
      for (const [pole, wartosc, komunikat] of [
        ['cennik_konta_hurt_allegro_obce', 'cen-a', 'allegro_obce'],
        ['cennik_konta_hurt_allegro_lampy', 'cen-obcy', 'Wybierz cennik z listy konta Allegro · allegro_lampy.'],
        ['cennik_konta_hurt_erli_lampy', 'Kurier gabaryt', 'Wybierz cennik z listy konta ERLI · lampy.erli.'],
      ]) {
        const r = await wyslij(url, {
          zaznaczone: String(a),
          szerokosc_cm: '70',
          cennik_oms_hurt: String(kurier),
          [pole]: wartosc,
        });
        expect(r.statusCode, pole).toBe(400);
        expect(r.body).toContain(komunikat);
      }
      expect(ileWyborow()).toBe(0);
      expect(db.prepare('SELECT szerokosc_mm FROM karty_produktow WHERE id = ?').get(a).szerokosc_mm).toBe(630);
    },
  );

  it('lista cenników konta zmieniła się między podglądem a zatwierdzeniem → odmowa, nic nie zapisane', async () => {
    const a = karta(1);
    const p = await podglad({ zaznaczone: String(a), cennik_konta_hurt_allegro_lampy: 'cen-c' });
    expect(p.statusCode).toBe(200);
    zapiszUstawieniaOfertKonta(
      db,
      KONTO,
      { slowniki: { pobranoAt: '2026-11-15T08:00:00.000Z', cenniki: [{ id: 'cen-c', nazwa: 'Paczkomat C (nowy)' }] } },
      { teraz: T0 },
    );
    const z = await zatwierdzZPodgladu(p.body);
    expect(z.statusCode).toBe(400);
    expect(z.body).toContain('Lista cenników konta Allegro · allegro_lampy zmieniła się od podglądu');
    expect(ileWyborow()).toBe(0);
  });
});

describe('cenniki hurtem — tylko administrator, jak pole cennika na karcie', () => {
  /** Konto z prawem do magazynu, ale bez administratora; zwraca nagłówki jego sesji. */
  const bezAdmina = () => {
    zalozKonto(db, { login: 'admin', imie: 'Admin', haslo: 'test', rola: 'admin', admin: true });
    const id = zalozKonto(db, { login: 'magazynier', imie: 'Ola', haslo: 'test', rola: 'operator', admin: false });
    ustawUprawnienia(db, id, ['magazyn']);
    return {
      origin: 'http://localhost',
      'content-type': 'application/x-www-form-urlencoded',
      cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz('magazynier', wczytajSekret(db), Date.now(), 0)}`,
    };
  };
  const jako = (headers, url, pola) => {
    const dane = new URLSearchParams();
    for (const [k, v] of Object.entries(pola)) for (const x of [v].flat()) dane.append(k, x);
    return app.inject({ method: 'POST', url, headers, payload: dane.toString() });
  };

  it.each([
    ['/magazyn/hurt', { cennik_oms_hurt: 'OMS' }],
    ['/magazyn/hurt/zatwierdz', { cennik_oms_hurt: 'OMS' }],
    ['/magazyn/hurt', { cennik_konta_hurt_allegro_lampy: 'cen-c' }],
    ['/magazyn/hurt/zatwierdz', { cennik_konta_hurt_allegro_lampy: 'cen-c' }],
  ])('konto bez administratora: %s z polem cennika → 403 dla całości, nic nie zapisane', async (url, pole) => {
    const kurier = cennikOms('Kurier gabaryt');
    const a = karta(1);
    const headers = bezAdmina();
    const pola = { zaznaczone: String(a), szerokosc_cm: '70', ...pole };
    if (pola.cennik_oms_hurt) pola.cennik_oms_hurt = String(kurier);
    const r = await jako(headers, url, pola);
    expect(r.statusCode).toBe(403);
    expect(ileWyborow()).toBe(0);
    expect(db.prepare('SELECT szerokosc_mm FROM karty_produktow WHERE id = ?').get(a).szerokosc_mm).toBe(630);
  });

  it('konto bez administratora: inne pola hurtu działają, a pozycji „Cennik dostaw” w panelu nie ma', async () => {
    cennikOms('Kurier gabaryt');
    const a = karta(1);
    const headers = bezAdmina();
    const r = await app.inject({ method: 'GET', url: '/magazyn', headers });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('data-z="');
    expect(r.body).not.toMatch(/data-z="cennik"/);
    expect(r.body).not.toContain('data-zmiana="cennik"');
    expect(r.body).not.toContain('name="cennik_oms_hurt"');
    const z = await jako(headers, '/magazyn/hurt/zatwierdz', { zaznaczone: String(a), szerokosc_cm: '70' });
    expect(z.statusCode).toBe(200);
    expect(db.prepare('SELECT szerokosc_mm FROM karty_produktow WHERE id = ?').get(a).szerokosc_mm).toBe(700);
  });
});

describe('podgląd mówi, ile wystawionych ofert dostanie nowy cennik', () => {
  it('N z wyniku doboru: karta z wyborem konta + zmiana cennika OMS nie wchodzi; szkic i oferta obca też nie', async () => {
    listaErli();
    const kurier = cennikOms('Kurier gabaryt', { [KONTO]: 'cen-gabaryt', [ERLI]: 'Kurier gabaryt' });
    const a = karta(1);
    const b = karta(2);
    const c = karta(3);
    oferta(a, KONTO);
    oferta(a, ERLI, 'sprawdzana');
    // Wybór konta wygrywa z cennikiem OMS — oferta b na Allegro nie zmieni cennika.
    zapiszWyjatekCennika(db, { kartaId: b, konto: KONTO, cennik: 'cen-a' }, { teraz: T0 });
    oferta(b, KONTO);
    oferta(b, ERLI, 'nieaktywna');
    oferta(c, KONTO, 'szkic');
    oferta(c, ERLI, 'aktywna', 'ext:9');
    const przed = ileWyborow();
    const p = await podglad({ zaznaczone: [String(a), String(b), String(c)], cennik_oms_hurt: String(kurier) });
    expect(p.statusCode).toBe(200);
    expect(bezZnacznikow(zdanieOfert(p.body) ?? '')).toBe(
      'Zmiana obejmie też 3 wystawione oferty (Allegro · allegro_lampy: 1, ERLI · lampy.erli: 2) — dostaną nowy cennik przy następnym przebiegu.',
    );
    // Podgląd liczy „po” na próbę i cofa — w bazie nic nie przybyło.
    expect(ileWyborow()).toBe(przed);
    expect(wyjatekCennika(db, { kartaId: a, konto: KONTO })).toBeNull();
  });

  it('bez wystawionych ofert, którym zmienia się cennik, zdania nie ma', async () => {
    const kurier = cennikOms('Kurier gabaryt', { [KONTO]: 'cen-gabaryt' });
    const a = karta(1);
    oferta(a, ERLI);
    const p = await podglad({ zaznaczone: String(a), cennik_oms_hurt: String(kurier) });
    expect(wierszePodgladu(p.body)).toHaveLength(1);
    expect(zdanieOfert(p.body)).toBeUndefined();
    expect(p.body).not.toContain('Zmiana obejmie też');
  });
});

describe('skutek dla wystawionej oferty — tylko na koncie, którego wybór się zmienił', () => {
  const skrotAllegro = (kartaId) => {
    const w = ofertaAllegroKarty(db, kartaId, { klucz: KONTO, srodowisko: 'produkcja' });
    expect(w.bledy).toEqual([]);
    return { delivery: w.zadanie.delivery, skrot: skrotTresci(trescAllegro(w.zadanie, null)) };
  };
  const cialoErli = (kartaId) => trescOferty(db, kartaId, ustawieniaOfertKonta(db, ERLI)).cialo;

  it('wybór ERLI nie rusza skrótu Allegro; wybór Allegro zmienia delivery i skrót tylko na Allegro', async () => {
    listaErli();
    const a = karta(1);
    oferta(a, KONTO);
    oferta(a, ERLI);
    const allegro0 = skrotAllegro(a);
    const erli0 = cialoErli(a);

    let p = await podglad({ zaznaczone: String(a), cennik_konta_hurt_erli_lampy: 'Kurier gabaryt' });
    expect((await zatwierdzZPodgladu(p.body)).statusCode).toBe(200);
    expect(skrotAllegro(a)).toEqual(allegro0);
    const erli1 = cialoErli(a);
    expect(erli1.deliveryPriceList).toBe('Kurier gabaryt');
    expect(skrotTresci(erli1)).not.toBe(skrotTresci(erli0));

    p = await podglad({ zaznaczone: String(a), cennik_konta_hurt_allegro_lampy: 'cen-c' });
    expect((await zatwierdzZPodgladu(p.body)).statusCode).toBe(200);
    const allegro2 = skrotAllegro(a);
    expect(allegro2.delivery.shippingRates).toEqual({ id: 'cen-c' });
    expect(allegro2.skrot).not.toBe(allegro0.skrot);
    expect(skrotTresci(cialoErli(a))).toBe(skrotTresci(erli1));
  });
});
