// Cennik dostaw karty: jeden cennik OMS wybrany na karcie działa na każdym koncie,
// z którym ma powiązanie; na pozostałych karta dostaje cennik według rozmiaru. Podgląd „Wystaw oferty” pokazuje
// „Cennik: <nazwa> — <powód>”, karta bez wymiarów/wagi przy regułach rozmiaru dostaje odmowę.
// Klienci Allegro i ERLI to atrapy; dane zmyślone („Pracownia Półcień”, lampy).
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { definicjeKanalowHistoryczne } from '../../pomoc/przykladowe-definicje-kanalow.js';
import { szyfrTestowy } from '../../pomoc/sejf-testowy.ts';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import {
  ofertyKarty,
  wstawOferte,
  zmienOferte,
  zapiszUstawieniaOfertKonta,
  ustawieniaOfertKonta,
} from '../../../src/oms/db/oferty-kanalow.ts';
import { wyjatekCennika, zapiszWyjatekCennika, usunWyjatekCennika } from '../../../src/oms/db/cenniki-kart.ts';
import {
  cennikOmsKarty,
  dodajCennikOms,
  ustawPowiazanieCennika,
  ustawCennikKarty,
} from '../../../src/oms/db/cenniki-oms.ts';
import { migracjaCennikowDostaw } from '../../../src/moduly/magazyn/migracje/0003-cenniki-dostaw.ts';
import { ofertaAllegroKarty } from '../../../src/moduly/magazyn/services/tresc-oferty-allegro.js';
import { trescOferty } from '../../../src/moduly/magazyn/services/tresc-oferty.js';
import { opisKategorii } from '../../../src/domena/tresc-oferty-allegro.js';
import { kategoriaAllegroDemo, parametryKategoriiAllegroDemo } from '../../../scripts/demo-dane-katalog.mjs';
import { zalozKonto, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import slowniki from '../../fixtures/allegro/e3-dok-slowniki.json' with { type: 'json' };

const KONTO = 'allegro_lampy';
const ERLI = 'erli_lampy';
const T0 = '2026-11-14T08:00:00.000Z';
const OFERTY = ['allegro:api:sale:offers:write', 'allegro:api:sale:settings:read'];
const ODMOWA_WYMIAROW =
  'Odmowa: Brak wymiarów/wagi — OMS nie wie, czy produkt zmieści się w paczkomacie. ' +
  'Uzupełnij wymiary albo ustaw cennik na karcie albo wybierz cennik dla konta.';
const jwt = (scope) => ['e30', Buffer.from(JSON.stringify({ scope })).toString('base64url'), 'podpis'].join('.');
const auth = {
  authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`,
  origin: 'http://localhost',
};

// Reguły rozmiaru: paczkomat A, paczkomat C, cennik domyślny. Allegro: identyfikatory z listy konta; ERLI: nazwy.
const REGULY_ALLEGRO = [
  { doMm: [80, 380, 640], doG: 25000, cennik: 'cen-a' },
  { doMm: [410, 380, 640], doG: 25000, cennik: 'cen-c' },
  { cennik: 'cen-gabaryt' },
];
const REGULY_ERLI = [
  { doMm: [80, 380, 640], doG: 25000, cennik: 'Paczkomat A' },
  { doMm: [410, 380, 640], doG: 25000, cennik: 'Paczkomat C' },
  { cennik: 'Kurier gabaryt' },
];
const CENNIKI_ERLI = ['Paczkomat A', 'Paczkomat C', 'Kurier gabaryt', 'Lampy'];
const LISTA_NIEPOBRANA =
  'Lista cenników konta niepobrana — pobierz ją w Magazyn → Cenniki, potem wybierz cennik dla tego konta na karcie.';
const BRAK_CENNIKA =
  'Brak cennika dla tego konta — wybierz go na karcie albo ustaw cennik z rozmiarem lub domyślny w Magazyn → Cenniki.';
const CENNIKI_KONTA = [
  { id: 'cen-a', nazwa: 'Pracownia Półcień — paczkomat A' },
  { id: 'cen-c', nazwa: 'Pracownia Półcień — paczkomat C' },
  { id: 'cen-gabaryt', nazwa: 'Pracownia Półcień — kurier gabaryt' },
  { id: 'cennik-1', nazwa: 'Pracownia Półcień — standard' },
];
// Wymiary w mm i waga w g; `null` = brak na karcie.
const MALA = { szerokosc_mm: 630, wysokosc_mm: 370, glebokosc_mm: 60, waga_g: 2000 };
const SREDNIA = { szerokosc_mm: 640, wysokosc_mm: 380, glebokosc_mm: 300, waga_g: 4000 };
const DUZA = { szerokosc_mm: 900, wysokosc_mm: 500, glebokosc_mm: 500, waga_g: 12000 };
const BEZ_WAGI = { szerokosc_mm: 300, wysokosc_mm: 300, glebokosc_mm: 300 };

let db, app, klienci;
const post = (url, payload, headers = auth) => app.inject({ method: 'POST', url, payload, headers });
const get = (url, headers = auth) => app.inject({ method: 'GET', url, headers });
const podglad = (zaznaczone, konto = KONTO) => post('/magazyn/oferty/podglad', { konto, zaznaczone });
/** Zatwierdza podgląd jak przeglądarka: POST → 303 → GET ekranu wyniku. */
const zatwierdz = async (r, zaznaczone, konto = KONTO) => {
  const w = await post('/magazyn/oferty/zatwierdz', {
    konto,
    zaznaczone,
    podglad: /name="podglad" value="([^"]+)"/.exec(r.body)?.[1],
  });
  expect(w.statusCode).toBe(303);
  return get(w.headers.location);
};
/** Karty z partii, które nie trafiły do kolejki (wiersze „nie wysłano” na ekranie wyniku). */
const nieWyslano = (body) => body.split('nie wysłano — popraw błędy z podglądu').length - 1;
const zapiszCennik = (id, pola, headers) => post(`/magazyn/${id}/cenniki`, pola, headers);
const sekcja = (body) => body.match(/<section[^>]*id="cenniki-karty"[\s\S]*?<\/section>/)?.[0] ?? '';
/** Sekcja podglądu jednej karty (nagłówek z odnośnikiem do karty). */
const wierszPodgladu = (body, id) => body.match(new RegExp(`<a href="/magazyn/${id}">[\\s\\S]*?</section>`))?.[0] ?? '';
/** Pole cennika karty w podglądzie ERLI: `<select …>…</select>` albo `<input …>`. */
const poleCennika = (body, id) =>
  body.match(new RegExp(`<select id="cennik-${id}"[\\s\\S]*?</select>|<input id="cennik-${id}"[^>]*>`))?.[0] ?? '';
const wyborKonta = (id, konto = ERLI) =>
  db.prepare('SELECT cennik_kanalu FROM karty_cenniki_kanalow WHERE karta_id = ? AND konto = ?').get(id, konto)
    ?.cennik_kanalu ?? null;
const atrapa = () => ({
  podgladOplat: vi.fn(async () => structuredClone(slowniki.podgladOplat)),
  utworzOferte: vi.fn(),
  zmienOferte: vi.fn(),
  zmienStatusOferty: vi.fn(),
  komendaIlosci: vi.fn(),
  komendaCeny: vi.fn(),
  pobierzOferte: vi.fn(),
  wgrajZdjecie: vi.fn(),
});

/** Karta gotowa do wystawienia na Allegro i ERLI (kategoria z mapy, marka, GPSR konta, 3 zdjęcia) z podanym rozmiarem. */
function karta(n, rozmiar) {
  const id = utworzKarte(
    db,
    {
      nazwa: `Lampa stołowa Gliwka ${n}`,
      sku: `GLW-${n}`,
      cena_gr: 5900,
      stawka_vat: '23',
      marka: 'Pracownia Półcień',
      kategoria_glowna: 'Lampy stołowe',
      ...rozmiar,
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
  klienci = { [KONTO]: atrapa(), [ERLI]: { utworzProdukt: vi.fn(), zmienProdukt: vi.fn() } };
  app = buildOmsServer({
    db,
    config: {
      auth: { user: 'operator', pass: 'atrapa' },
      definicje: [
        ...definicjeKanalowHistoryczne,
        { klucz: ERLI, typ: 'erli', prefiks: 'ERLI_LAMPY', etykieta: 'ERLI Półcień' },
      ],
    },
    magazyn: { stan: () => ({ trwa: false, kanaly: [] }) },
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
  db.prepare(
    `INSERT INTO konfiguracja_integracji (integracja, ustawienia_json, sekrety_json, zmieniono_at) VALUES (?, ?, '{}', ?)`,
  ).run(`erli:${ERLI}`, JSON.stringify({ cennikiDostaw: CENNIKI_ERLI, cennikiPobranoAt: T0 }), T0);
});
afterEach(async () => {
  await app.close();
  db.close();
});

/** Cennik OMS „tylko na karcie” z powiązaniami `{ konto: cennikKanalu }`; zwraca jego id. */
const cennikNaKarcie = (nazwa, powiazania) => {
  const id = dodajCennikOms(db, { nazwa });
  for (const [konto, cennikKanalu] of Object.entries(powiazania))
    ustawPowiazanieCennika(db, { cennikId: id, konto, cennikKanalu });
  return id;
};

const regulyRozmiaru = () => {
  zapiszUstawieniaOfertKonta(db, KONTO, { cenniki: REGULY_ALLEGRO }, { teraz: T0 });
  zapiszUstawieniaOfertKonta(db, ERLI, { cenniki: REGULY_ERLI }, { teraz: T0 });
};

describe('podgląd Allegro — cennik i powód', () => {
  it('reguła 1, reguła 2 i „cennik domyślny” z nazwą ze słownika konta; karta bez wagi → odmowa, Zatwierdź ją pomija', async () => {
    regulyRozmiaru();
    const [a, b, c, d] = [karta(1, MALA), karta(2, SREDNIA), karta(3, DUZA), karta(4, BEZ_WAGI)];
    const r = await podglad([a, b, c, d]);
    expect(r.statusCode).toBe(200);
    expect(wierszPodgladu(r.body, a)).toContain(
      'Cennik: Pracownia Półcień — paczkomat A — cennik OMS „Do 64×38×8 cm, 25 kg” (do 64×38×8 cm, 25 kg)',
    );
    expect(wierszPodgladu(r.body, b)).toContain(
      'Cennik: Pracownia Półcień — paczkomat C — cennik OMS „Do 64×41×38 cm, 25 kg” (do 64×41×38 cm, 25 kg)',
    );
    expect(wierszPodgladu(r.body, c)).toContain('Cennik: Pracownia Półcień — kurier gabaryt — cennik OMS „Domyślny”');
    expect(wierszPodgladu(r.body, d)).toContain(ODMOWA_WYMIAROW);
    expect(wierszPodgladu(r.body, d)).not.toContain('Cennik:');
    for (const id of [a, b, c]) expect(wierszPodgladu(r.body, id)).not.toContain('Odmowa:');
    const w = await zatwierdz(r, [a, b, c, d]);
    expect(w.body).toContain('W kolejce do wysłania: 3.');
    expect(nieWyslano(w.body)).toBe(1);
    expect(ofertyKarty(db, d)).toHaveLength(0);
    expect(ofertyKarty(db, a)).toHaveLength(1);
  });

  it('jedno pole konta (po migracji) → „cennik domyślny konta”, karta bez wagi przechodzi', async () => {
    const d = karta(4, BEZ_WAGI);
    const r = await podglad([d]);
    expect(wierszPodgladu(r.body, d)).toContain('Cennik: Pracownia Półcień — standard — cennik OMS „Domyślny”');
    expect(r.body).not.toContain('Odmowa:');
  });

  it('cennik OMS wybrany na karcie usuwa odmowę: powód z nazwą cennika OMS, obaj budowniczowie biorą powiązany cennik kanału', async () => {
    regulyRozmiaru();
    const gabaryt = cennikNaKarcie('Gabaryt', { [KONTO]: 'cen-gabaryt', [ERLI]: 'Kurier gabaryt' });
    const d = karta(4, BEZ_WAGI);
    const z = await zapiszCennik(d, { cennik_oms: String(gabaryt) });
    expect(z.statusCode).toBe(303);
    expect(z.headers.location).toBe(`/magazyn/${d}#cenniki-karty`);
    expect(cennikOmsKarty(db, d)?.cennikId).toBe(gabaryt);
    expect(wyjatekCennika(db, { kartaId: d, konto: KONTO })).toBe('cen-gabaryt');
    const r = await podglad([d]);
    expect(r.body).not.toContain('Odmowa:');
    expect(wierszPodgladu(r.body, d)).toContain(
      'Cennik: Pracownia Półcień — kurier gabaryt — wyjątek na karcie: cennik OMS „Gabaryt”',
    );
    // Ten sam wybór czytają budowniczowie dla pętli (odczyt z bazy, nie z formularza).
    const w = ofertaAllegroKarty(db, d, { klucz: KONTO, srodowisko: 'produkcja' });
    expect(w.bledy).toEqual([]);
    expect(w.zadanie.delivery.shippingRates).toEqual({ id: 'cen-gabaryt' });
    expect(trescOferty(db, d, ustawieniaOfertKonta(db, ERLI)).cialo.deliveryPriceList).toBe('Kurier gabaryt');
    const wd = (await zatwierdz(r, [d])).body;
    expect(wd).toContain('W kolejce do wysłania: 1.');
    expect(nieWyslano(wd)).toBe(0);
  });

  it('cennik OMS karty bez powiązania z kontem Allegro: konto dobiera po rozmiarze, ERLI bierze powiązanie', async () => {
    regulyRozmiaru();
    const tylkoErli = cennikNaKarcie('Kurier ERLI', { [ERLI]: 'Kurier gabaryt' });
    const a = karta(1, MALA);
    ustawCennikKarty(db, { kartaId: a, cennikId: tylkoErli });
    expect(wyjatekCennika(db, { kartaId: a, konto: KONTO })).toBeNull();
    expect(wyjatekCennika(db, { kartaId: a, konto: ERLI })).toBe('Kurier gabaryt');
    const r = await podglad([a]);
    expect(wierszPodgladu(r.body, a)).toContain(
      'Cennik: Pracownia Półcień — paczkomat A — cennik OMS „Do 64×38×8 cm, 25 kg”',
    );
    expect(wierszPodgladu(r.body, a)).not.toContain('wyjątek na karcie');
    expect(ofertaAllegroKarty(db, a, { klucz: KONTO, srodowisko: 'produkcja' }).zadanie.delivery.shippingRates).toEqual(
      { id: 'cen-a' },
    );
    expect(trescOferty(db, a, ustawieniaOfertKonta(db, ERLI)).cialo.deliveryPriceList).toBe('Kurier gabaryt');
  });
});

describe('podgląd ERLI — cennik i powód', () => {
  it('reguły, „cennik domyślny”, odmowa bez wagi, cennik OMS karty i „cennik domyślny konta”', async () => {
    regulyRozmiaru();
    const gabaryt = cennikNaKarcie('Gabaryt', { [ERLI]: 'Kurier gabaryt' });
    const [a, b, c, d] = [karta(1, MALA), karta(2, SREDNIA), karta(3, DUZA), karta(4, BEZ_WAGI)];
    let r = await podglad([a, b, c, d], ERLI);
    expect(r.statusCode).toBe(200);
    // Pierwsza opcja pola mówi, co karta dostaje bez własnego cennika; powód pod polem.
    expect(poleCennika(r.body, a)).toContain(
      '<option value="" selected>— z cennika OMS / według rozmiaru (teraz: Paczkomat A) —</option>',
    );
    expect(wierszPodgladu(r.body, a)).toContain('cennik OMS „Do 64×38×8 cm, 25 kg” (do 64×38×8 cm, 25 kg)');
    expect(poleCennika(r.body, b)).toContain('— z cennika OMS / według rozmiaru (teraz: Paczkomat C) —');
    expect(wierszPodgladu(r.body, b)).toContain('cennik OMS „Do 64×41×38 cm, 25 kg” (do 64×41×38 cm, 25 kg)');
    expect(poleCennika(r.body, c)).toContain('— z cennika OMS / według rozmiaru (teraz: Kurier gabaryt) —');
    expect(wierszPodgladu(r.body, c)).toContain('cennik OMS „Domyślny”');
    for (const k of [a, b, c]) expect(wierszPodgladu(r.body, k)).not.toContain('Cennik: ');
    expect(wierszPodgladu(r.body, d)).toContain(ODMOWA_WYMIAROW);
    // Karta z odmową też ma pole — to tu operator wybiera cennik, który odmowę usuwa.
    expect(poleCennika(r.body, d)).toContain('— z cennika OMS / według rozmiaru (teraz: brak) —');
    expect(r.body).toContain('Wystaw oferty (3)');
    const w = await zatwierdz(r, [a, b, c, d], ERLI);
    expect(nieWyslano(w.body)).toBe(1);
    expect(ofertyKarty(db, d)).toHaveLength(0);

    expect((await zapiszCennik(d, { cennik_oms: ` ${gabaryt} ` })).statusCode).toBe(303);
    expect(wyjatekCennika(db, { kartaId: d, konto: ERLI })).toBe('Kurier gabaryt');
    r = await podglad([d], ERLI);
    expect(r.body).not.toContain('Odmowa:');
    expect(poleCennika(r.body, d)).toContain(
      '<option value="" selected>— z cennika OMS / według rozmiaru (teraz: Kurier gabaryt) —</option>',
    );
    expect(wierszPodgladu(r.body, d)).toContain('wyjątek na karcie: cennik OMS „Gabaryt”');
    expect(trescOferty(db, d, ustawieniaOfertKonta(db, ERLI)).cialo.deliveryPriceList).toBe('Kurier gabaryt');

    zapiszUstawieniaOfertKonta(db, ERLI, { cennikDostaw: 'Lampy' }, { teraz: T0 });
    r = await podglad([a], ERLI);
    expect(poleCennika(r.body, a)).toContain('— z cennika OMS / według rozmiaru (teraz: Lampy) —');
    expect(wierszPodgladu(r.body, a)).toContain('cennik OMS „Domyślny”');
  });
});

describe('podgląd ERLI — cennik tego konta przy karcie', () => {
  const ZDANIE = 'Cennik wybrany przy karcie dotyczy tylko tego konta.';
  /** Podgląd albo zatwierdzenie z polami cenników z wiersza karty (`cennik_<id>`), jak wysyła formularz podglądu. */
  const zCennikami = (akcja, ids, cenniki, token) =>
    post(`/magazyn/oferty/${akcja}`, {
      konto: ERLI,
      zaznaczone: ids,
      ...(token ? { podglad: token } : {}),
      ...Object.fromEntries(Object.entries(cenniki).map(([id, v]) => [`cennik_${id}`, v])),
    });
  const tokenZ = (r) => /name="podglad" value="([^"]+)"/.exec(r.body)?.[1];

  it('zapisuje i usuwa wybór z listy ERLI bez zmiany cennika OMS i wyboru innego konta', async () => {
    const oms = cennikNaKarcie('Dostawa lamp', { [ERLI]: 'Paczkomat C', [KONTO]: 'cen-c' });
    const a = karta(1, MALA);
    ustawCennikKarty(db, { kartaId: a, cennikId: oms });
    zapiszWyjatekCennika(db, { kartaId: a, konto: KONTO, cennik: 'cen-a' });
    let r = await podglad([a], ERLI);
    expect(r.statusCode).toBe(200);
    const wiersz = wierszPodgladu(r.body, a);
    expect(wiersz).toContain(`<label for="cennik-${a}">Cennik dostaw</label>`);
    expect(wiersz.split('</select>')[1]).toContain(ZDANIE);
    const pole = poleCennika(r.body, a);
    expect(pole).toContain(`<select id="cennik-${a}" name="cennik_${a}"`);
    expect(pole).toContain(
      '<option value="" selected>— z cennika OMS / według rozmiaru (teraz: Paczkomat C) —</option>',
    );
    expect(
      [...pole.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)].map(([, wartosc, nazwa]) => [wartosc, nazwa]),
    ).toEqual(CENNIKI_ERLI.map((nazwa) => [nazwa, nazwa]));
    expect(wiersz).toContain('wyjątek na karcie: cennik OMS „Dostawa lamp”');
    expect(r.body).not.toMatch(/pobierz metody ponownie|lista pobrana z ERLI/i);
    expect(r.body).toContain('<button class="btn btn--glowny" type="submit">Wystaw oferty (1)</button>');
    expect(r.body).toMatch(
      /<button class="btn" type="submit" formaction="\/magazyn\/oferty\/podglad">Zapisz cenniki i odśwież podgląd<\/button>/,
    );

    r = await zCennikami('podglad', [a], { [a]: 'Kurier gabaryt' });
    expect(r.statusCode).toBe(200);
    expect(wyborKonta(a)).toBe('Kurier gabaryt');
    expect(cennikOmsKarty(db, a)?.cennikId).toBe(oms);
    expect(wyborKonta(a, KONTO)).toBe('cen-a');
    expect(poleCennika(r.body, a)).toContain('<option value="Kurier gabaryt" selected>Kurier gabaryt</option>');
    // Pusta opcja mówi, co obowiązuje BEZ wyboru konta (cennik OMS karty), a nie powtarza wybranego cennika.
    expect(poleCennika(r.body, a)).toContain(
      '<option value="">— z cennika OMS / według rozmiaru (teraz: Paczkomat C) —</option>',
    );
    expect(wierszPodgladu(r.body, a)).toContain('wybrany na karcie dla tego konta');
    expect(tokenZ(r)).toMatch(/^\d+\.[a-f0-9]{64}$/);

    r = await podglad([a], ERLI);
    expect(wyborKonta(a)).toBe('Kurier gabaryt');
    r = await zCennikami('podglad', [a], { [a]: '' });
    expect(r.statusCode).toBe(200);
    expect(wyborKonta(a)).toBeNull();
    expect(cennikOmsKarty(db, a)?.cennikId).toBe(oms);
    expect(wyborKonta(a, KONTO)).toBe('cen-a');
    expect(poleCennika(r.body, a)).toContain(
      '<option value="" selected>— z cennika OMS / według rozmiaru (teraz: Paczkomat C) —</option>',
    );
    expect(wierszPodgladu(r.body, a)).toContain('wyjątek na karcie: cennik OMS „Dostawa lamp”');
  });

  it('cennik OMS karty bez powiązania z kontem ERLI nie zmienia domyślnego doboru', async () => {
    const tylkoAllegro = cennikNaKarcie('Kurier Allegro', { [KONTO]: 'cen-gabaryt' });
    const a = karta(1, MALA);
    ustawCennikKarty(db, { kartaId: a, cennikId: tylkoAllegro });
    const r = await podglad([a], ERLI);
    expect(r.statusCode).toBe(200);
    expect(cennikOmsKarty(db, a)?.cennikId).toBe(tylkoAllegro);
    expect(poleCennika(r.body, a)).toContain(
      '<option value="" selected>— z cennika OMS / według rozmiaru (teraz: Lampy) —</option>',
    );
    expect(wierszPodgladu(r.body, a)).not.toContain('wyjątek na karcie');
    expect(wierszPodgladu(r.body, a)).toContain('cennik OMS „Domyślny”');
  });

  it('cennik spoza listy ERLI → 400 z błędem przy polu, także poprawny wybór obok nie zapisuje się', async () => {
    const [a, b] = [karta(1, MALA), karta(2, MALA)];
    for (const [akcja, zly] of [
      ['podglad', 'cen-a'],
      ['zatwierdz', 'Paczkomat Z'],
    ]) {
      const token = akcja === 'zatwierdz' ? tokenZ(await podglad([a, b], ERLI)) : undefined;
      const r = await zCennikami(akcja, [a, b], { [a]: 'Kurier gabaryt', [b]: zly }, token);
      expect(r.statusCode).toBe(400);
      expect(cennikOmsKarty(db, a)).toBeNull();
      expect(cennikOmsKarty(db, b)).toBeNull();
      expect(wyborKonta(a)).toBeNull();
      expect(wyborKonta(b)).toBeNull();
      expect(ofertyKarty(db, a)).toHaveLength(0);
      const pole = poleCennika(r.body, b);
      expect(pole).toContain('aria-invalid="true"');
      expect(pole).toContain(`aria-describedby="blad-cennik-${b}`);
      expect(wierszPodgladu(r.body, b)).toContain(
        `<p class="blad-pola pasek-blokada" id="blad-cennik-${b}">Wybierz cennik z listy konta ERLI · ERLI Półcień.</p>`,
      );
      // Wpisany wybór zostaje w formularzu, żeby poprawić tylko błędne pole.
      expect(poleCennika(r.body, a)).toContain('<option value="Kurier gabaryt" selected>');
      expect(poleCennika(r.body, a)).not.toContain('aria-invalid');
      expect(tokenZ(r)).toMatch(/^\d+\.[a-f0-9]{64}$/);
    }
  });

  it('zachowuje dotychczasowy wybór, który zniknął z listy konta', async () => {
    const a = karta(1, MALA);
    zapiszWyjatekCennika(db, { kartaId: a, konto: ERLI, cennik: 'Stary kurier' });
    const r = await zCennikami('podglad', [a], { [a]: 'Stary kurier' });
    expect(r.statusCode).toBe(200);
    expect(poleCennika(r.body, a)).toContain(
      '<option value="Stary kurier" selected>Stary kurier (nie ma już na liście konta)</option>',
    );
    expect(wyborKonta(a)).toBe('Stary kurier');
  });

  it('niepobrana lista ukrywa pole i pokazuje wskazówkę; odrzuca nowy wybór', async () => {
    db.prepare('DELETE FROM konfiguracja_integracji WHERE integracja = ?').run(`erli:${ERLI}`);
    const a = karta(1, MALA);
    const r = await podglad([a], ERLI);
    expect(r.statusCode).toBe(200);
    expect(poleCennika(r.body, a)).toBe('');
    expect(wierszPodgladu(r.body, a)).toContain(LISTA_NIEPOBRANA);
    expect(r.body).not.toContain('Zapisz cenniki i odśwież podgląd');
    const zapis = await zCennikami('podglad', [a], { [a]: 'Kurier gabaryt' });
    expect(zapis.statusCode).toBe(400);
    expect(wyborKonta(a)).toBeNull();
  });

  it('Wystaw oferty z innym cennikiem: cennik karty zapisany przed wstawieniem oferty, treść z pętli ma ten cennik', async () => {
    zapiszUstawieniaOfertKonta(db, ERLI, { cennikDostaw: null }, { teraz: T0 });
    const a = karta(1, MALA);
    const r = await podglad([a], ERLI);
    expect(wierszPodgladu(r.body, a)).toContain(`Odmowa: ${BRAK_CENNIKA}`);
    expect(r.body).toContain('Wystaw oferty (0)');
    const w = await zCennikami('zatwierdz', [a], { [a]: 'Kurier gabaryt' }, tokenZ(r));
    expect(w.statusCode).toBe(303);
    const wynik = (await get(w.headers.location)).body;
    expect(wynik).toContain('W kolejce do wysłania: 1.');
    expect(nieWyslano(wynik)).toBe(0);
    expect(wyborKonta(a)).toBe('Kurier gabaryt');
    expect(cennikOmsKarty(db, a)).toBeNull();
    const oferty = ofertyKarty(db, a);
    expect(oferty).toHaveLength(1);
    expect(oferty[0]).toMatchObject({ kanal: ERLI, stan: 'do_wyslania' });
    expect(trescOferty(db, a, ustawieniaOfertKonta(db, ERLI)).cialo.deliveryPriceList).toBe('Kurier gabaryt');
  });

  it('Wystaw oferty z podrobionym tokenem → 409, cennik karty nie zapisany', async () => {
    zapiszUstawieniaOfertKonta(db, ERLI, { cennikDostaw: null }, { teraz: T0 });
    const a = karta(1, MALA);
    const w = await zCennikami('zatwierdz', [a], { [a]: 'Kurier gabaryt' }, `1.${'0'.repeat(64)}`);
    expect(w.statusCode).toBe(409);
    expect(cennikOmsKarty(db, a)).toBeNull();
    expect(wyborKonta(a)).toBeNull();
    expect(ofertyKarty(db, a)).toHaveLength(0);
  });

  it('Allegro ignoruje pola cennik_<id> — wybór cennika z podglądu tylko dla ERLI', async () => {
    const a = karta(1, MALA);
    const r = await post('/magazyn/oferty/podglad', {
      konto: KONTO,
      zaznaczone: [a],
      [`cennik_${a}`]: 'cen-gabaryt',
    });
    expect(r.statusCode).toBe(200);
    expect(cennikOmsKarty(db, a)).toBeNull();
    expect(wyborKonta(a, KONTO)).toBeNull();
    expect(r.body).not.toContain(`name="cennik_${a}"`);
    expect(r.body).not.toContain(ZDANIE);
    expect(r.body).toContain('Wystaw oferty (');
  });
});

describe('decyzja kierownika: wyjątek z karty wystarcza na koncie bez reguł (Allegro jak ERLI)', () => {
  it('Allegro: konto bez cennika nie blokuje podglądu, gdy wybrana karta ma wyjątek; karta bez wyjątku dostaje odmowę', async () => {
    zapiszUstawieniaOfertKonta(db, KONTO, { cenniki: [] }, { teraz: T0 });
    const [a, b] = [karta(1, MALA), karta(2, MALA)];
    let r = await podglad([a, b]);
    expect(r.body).toContain('Uzupełnij ustawienia: cennik dostaw');
    zapiszWyjatekCennika(db, { kartaId: a, konto: KONTO, cennik: 'cen-a' }, { teraz: T0 });
    const w = ofertaAllegroKarty(db, a, { klucz: KONTO, srodowisko: 'produkcja' });
    expect(w.bledy.map((x) => x.kod)).not.toContain('ustawienia');
    expect(w.zadanie.delivery.shippingRates).toEqual({ id: 'cen-a' });
    r = await podglad([a, b]);
    expect(r.body).not.toContain('Uzupełnij ustawienia: cennik dostaw');
    expect(wierszPodgladu(r.body, a)).toContain(
      'Cennik: Pracownia Półcień — paczkomat A — wybrany na karcie dla tego konta',
    );
    expect(wierszPodgladu(r.body, a)).not.toContain('Odmowa:');
    expect(wierszPodgladu(r.body, b)).toContain('Odmowa:');
    expect(wierszPodgladu(r.body, b)).toContain('cennik dostaw');
    const wab = (await zatwierdz(r, [a, b])).body;
    expect(wab).toContain('W kolejce do wysłania: 1.');
    expect(nieWyslano(wab)).toBe(1);
    expect(ofertyKarty(db, b)).toHaveLength(0);
  });

  it('Allegro: cennik OMS karty powiązany tylko z innym kontem nie zastępuje cennika konta', async () => {
    zapiszUstawieniaOfertKonta(db, KONTO, { cenniki: [] }, { teraz: T0 });
    const tylkoErli = cennikNaKarcie('Kurier ERLI', { [ERLI]: 'Kurier gabaryt' });
    const a = karta(1, MALA);
    ustawCennikKarty(db, { kartaId: a, cennikId: tylkoErli });
    const r = await podglad([a]);
    expect(r.body).toContain('Uzupełnij ustawienia: cennik dostaw');
  });

  it('ERLI: konto bez cennika nie blokuje podglądu — karta z wyjątkiem przechodzi, karta bez wyjątku odmowa', async () => {
    zapiszUstawieniaOfertKonta(db, ERLI, { cennikDostaw: null }, { teraz: T0 });
    const [a, b] = [karta(1, MALA), karta(2, MALA)];
    let r = await podglad([a, b], ERLI);
    expect(r.body).not.toContain('Uzupełnij ustawienia');
    for (const k of [a, b]) expect(wierszPodgladu(r.body, k)).toContain(`Odmowa: ${BRAK_CENNIKA}`);
    zapiszWyjatekCennika(db, { kartaId: a, konto: ERLI, cennik: 'Paczkomat A' }, { teraz: T0 });
    r = await podglad([a, b], ERLI);
    expect(r.body).not.toContain('Uzupełnij ustawienia: cennik dostaw');
    // Wybór konta nie zakłada cennika OMS karty — karta zostaje „według rozmiaru”, a konto ma własny cennik.
    expect(cennikOmsKarty(db, a)).toBeNull();
    expect(wierszPodgladu(r.body, a)).toContain('wybrany na karcie dla tego konta');
    expect(wierszPodgladu(r.body, b)).toContain(`Odmowa: ${BRAK_CENNIKA}`);
    expect(nieWyslano((await zatwierdz(r, [a, b], ERLI)).body)).toBe(1);
    expect(ofertyKarty(db, a)).toHaveLength(1);
  });
});

describe('karta — sekcja „Cennik dostaw”: cennik OMS karty', () => {
  const NAPIS =
    'Cennik wybrany dla konta wygrywa z cennikiem OMS karty. Puste pole konta: karta bierze cennik OMS (gdy ma powiązanie z tym kontem), a bez niego cennik według rozmiaru. Zmiana dotyczy też już wystawionej oferty.';
  /** Wiersz tabeli „Teraz” dla konta (nagłówek wiersza zaczyna się od „Allegro ·” albo „ERLI ·”). */
  const wierszKonta = (s, rodzaj) => s.match(new RegExp(`<tr><th scope="row">${rodzaj} ·[\\s\\S]*?</tr>`))?.[0] ?? '';
  const wierszeKarty = (id) => db.prepare('SELECT cennik_id FROM karty_cennik_oms WHERE karta_id = ?').all(id);

  it('jedno pole „Cennik OMS tej karty (opcjonalnie)” ze wszystkimi cennikami OMS, napis pod polem i tabela „Teraz” na każde konto', async () => {
    regulyRozmiaru();
    const gabaryt = cennikNaKarcie('Gabaryt', { [ERLI]: 'Kurier gabaryt' });
    const d = karta(4, BEZ_WAGI);
    let s = sekcja((await get(`/magazyn/${d}`)).body);
    expect(s).toContain(`action="/magazyn/${d}/cenniki"`);
    expect(s).toContain('<label for="cennik-oms-karty">Cennik OMS tej karty (opcjonalnie)</label>');
    expect(s).toContain('<select id="cennik-oms-karty" name="cennik_oms" aria-describedby="cennik-oms-karty-napis">');
    expect(s).toContain('<option value="" selected>— według rozmiaru —</option>');
    expect(s).toContain(`<option value="${gabaryt}">Gabaryt (tylko na karcie)</option>`);
    expect(s).toMatch(/<option value="\d+">Do 64×38×8 cm, 25 kg<\/option>/);
    expect(s).toMatch(/<option value="\d+">Domyślny<\/option>/);
    expect(s).toContain(`<p class="podpowiedz" id="cennik-oms-karty-napis">${NAPIS}</p>`);
    expect(s).not.toMatch(/name="cennik:/);
    expect(s).not.toMatch(/pobierz metody ponownie|Pobierz z Allegro/);
    // Karta bez wagi i bez cennika: odmowa na obu kontach.
    expect(wierszKonta(s, 'Allegro')).toContain(ODMOWA_WYMIAROW);
    expect(wierszKonta(s, 'ERLI')).toContain(ODMOWA_WYMIAROW);
    for (const [, dla] of s.matchAll(/<label for="([^"]+)"/g)) expect(s).toContain(`id="${dla}"`);

    expect((await zapiszCennik(d, { cennik_oms: String(gabaryt) })).statusCode).toBe(303);
    expect(wierszeKarty(d)).toEqual([{ cennik_id: gabaryt }]);
    s = sekcja((await get(`/magazyn/${d}`)).body);
    expect(s).toContain(`<option value="${gabaryt}" selected>Gabaryt (tylko na karcie)</option>`);
    // ERLI ma powiązanie — bierze je; Allegro nie ma — zostaje przy doborze po rozmiarze (tu odmowa).
    expect(wierszKonta(s, 'ERLI')).toContain('Teraz: Kurier gabaryt — wyjątek na karcie: cennik OMS „Gabaryt”');
    expect(wierszKonta(s, 'Allegro')).toContain(ODMOWA_WYMIAROW);
  });

  it('„Teraz” na obu kontach z powiązań cennika karty; pusty wybór usuwa wiersz, pole nieprzysłane niczego nie zmienia', async () => {
    regulyRozmiaru();
    const kurier = cennikNaKarcie('Kurier na karcie', { [KONTO]: 'cen-gabaryt', [ERLI]: 'Kurier gabaryt' });
    const id = karta(1, MALA);
    let s = sekcja((await get(`/magazyn/${id}`)).body);
    expect(wierszKonta(s, 'Allegro')).toContain(
      'Teraz: Pracownia Półcień — paczkomat A — cennik OMS „Do 64×38×8 cm, 25 kg”',
    );
    expect(wierszKonta(s, 'ERLI')).toContain('Teraz: Paczkomat A — cennik OMS „Do 64×38×8 cm, 25 kg”');

    expect((await zapiszCennik(id, { cennik_oms: String(kurier) })).statusCode).toBe(303);
    s = sekcja((await get(`/magazyn/${id}`)).body);
    expect(wierszKonta(s, 'Allegro')).toContain(
      'Teraz: Pracownia Półcień — kurier gabaryt — wyjątek na karcie: cennik OMS „Kurier na karcie”',
    );
    expect(wierszKonta(s, 'ERLI')).toContain(
      'Teraz: Kurier gabaryt — wyjątek na karcie: cennik OMS „Kurier na karcie”',
    );

    expect((await zapiszCennik(id, {})).statusCode).toBe(303);
    expect(wierszeKarty(id)).toEqual([{ cennik_id: kurier }]);

    expect((await zapiszCennik(id, { cennik_oms: '  ' })).statusCode).toBe(303);
    expect(wierszeKarty(id)).toEqual([]);
    s = sekcja((await get(`/magazyn/${id}`)).body);
    expect(s).toContain('<option value="" selected>— według rozmiaru —</option>');
    expect(wierszKonta(s, 'ERLI')).toContain('Teraz: Paczkomat A — cennik OMS „Do 64×38×8 cm, 25 kg”');
  });

  it('cennik spoza listy OMS → 400 i wybór sprzed zostaje', async () => {
    const gabaryt = cennikNaKarcie('Gabaryt', { [ERLI]: 'Kurier gabaryt' });
    const id = karta(1, MALA);
    ustawCennikKarty(db, { kartaId: id, cennikId: gabaryt });
    for (const zly of ['999999', 'Paczkomat Z', '1.5']) {
      const r = await zapiszCennik(id, { cennik_oms: zly });
      expect(r.statusCode).toBe(400);
      expect(r.body).toContain('Wybierz cennik OMS z listy.');
      expect(wierszeKarty(id)).toEqual([{ cennik_id: gabaryt }]);
    }
  });

  it('nie-administrator i obcy CSRF → 403, nic nie zapisane; nie-administrator widzi sekcję tylko do odczytu', async () => {
    const gabaryt = cennikNaKarcie('Gabaryt', { [ERLI]: 'Kurier gabaryt' });
    const id = karta(1, MALA);
    const pola = { cennik_oms: String(gabaryt) };
    expect((await zapiszCennik(id, pola, { ...auth, origin: 'https://obcy.example' })).statusCode).toBe(403);
    zalozKonto(db, { login: 'admin', imie: 'Admin', haslo: 'test', rola: 'admin', admin: true });
    const user = zalozKonto(db, { login: 'czytelnik', imie: 'Czytelnik', haslo: 'test', rola: 'operator' });
    ustawUprawnienia(db, user, ['magazyn']);
    const headers = {
      origin: 'http://localhost',
      cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz('czytelnik', wczytajSekret(db), Date.now(), 0)}`,
    };
    expect((await zapiszCennik(id, pola, headers)).statusCode).toBe(403);
    expect(wierszeKarty(id)).toEqual([]);
    ustawCennikKarty(db, { kartaId: id, cennikId: gabaryt });
    const s = sekcja((await get(`/magazyn/${id}`, headers)).body);
    expect(s).toContain('Cennik OMS tej karty: Gabaryt (tylko na karcie)');
    expect(s).toContain(NAPIS);
    expect(s).toContain('Teraz: Kurier gabaryt — wyjątek na karcie: cennik OMS „Gabaryt”');
    expect(s).not.toContain('<form');
    expect(s).not.toContain('<select');
  });

  it('nieistniejąca karta → 404', async () => {
    expect((await zapiszCennik(999999, { cennik_oms: '' })).statusCode).toBe(404);
  });
});

describe('karta — cennik wybrany dla konta', () => {
  // Tu ERLI zaczyna bez pobranej listy cenników (wspólny beforeEach ją zakłada) — listę dokłada `listaErli()`.
  beforeEach(() => {
    db.prepare('DELETE FROM konfiguracja_integracji WHERE integracja = ?').run(`erli:${ERLI}`);
  });
  const NAPIS =
    'Cennik wybrany dla konta wygrywa z cennikiem OMS karty. Puste pole konta: karta bierze cennik OMS (gdy ma powiązanie z tym kontem), a bez niego cennik według rozmiaru. Zmiana dotyczy też już wystawionej oferty.';
  const wierszKonta = (s, rodzaj) => s.match(new RegExp(`<tr><th scope="row">${rodzaj} ·[\\s\\S]*?</tr>`))?.[0] ?? '';
  const wybory = (id) =>
    db
      .prepare('SELECT konto, cennik_kanalu, zmieniono_at FROM karty_cenniki_kanalow WHERE karta_id = ? ORDER BY konto')
      .all(id);
  const wierszeOms = (id) => db.prepare('SELECT cennik_id FROM karty_cennik_oms WHERE karta_id = ?').all(id);
  const listaErli = () =>
    db
      .prepare(
        `INSERT INTO konfiguracja_integracji (integracja, ustawienia_json, sekrety_json, zmieniono_at) VALUES (?, ?, '{}', ?)`,
      )
      .run(
        `erli:${ERLI}`,
        JSON.stringify({ cennikiDostaw: ['Paczkomat A', 'Kurier gabaryt'], cennikiPobranoAt: T0 }),
        T0,
      );

  it('konto z pobraną listą ma pole z pustą opcją i cennikami konta; konto bez listy — tekst i odnośnik do Cenników', async () => {
    const id = karta(1, MALA);
    const s = sekcja((await get(`/magazyn/${id}`)).body);
    expect(s).toContain('<label for="cennik-oms-karty">Cennik OMS tej karty (opcjonalnie)</label>');
    expect(s).toContain(`<p class="podpowiedz" id="cennik-oms-karty-napis">${NAPIS}</p>`);
    for (const naglowek of ['Konto', 'Cennik na tym koncie', 'Teraz'])
      expect(s).toContain(`<th scope="col">${naglowek}</th>`);
    const allegro = wierszKonta(s, 'Allegro');
    expect(allegro).toMatch(new RegExp(`<select [^>]*name="cennik_konta_${KONTO}"`));
    expect(allegro).toContain('<option value="" selected>— z cennika OMS / według rozmiaru —</option>');
    expect(allegro).toContain('<option value="cen-gabaryt">Pracownia Półcień — kurier gabaryt</option>');
    // ERLI nie ma pobranej listy: zamiast pola tekst i odnośnik.
    const erli = wierszKonta(s, 'ERLI');
    expect(erli).not.toContain('<select');
    expect(erli).toContain(
      `Lista cenników konta niepobrana — <a href="/magazyn/cenniki#kanal-${ERLI}">pobierz w Magazyn → Cenniki</a>`,
    );
    // Bez reguł i bez pobranej listy odmowa każe pobrać listę, a nie szukać powiązania.
    zapiszUstawieniaOfertKonta(db, ERLI, { cenniki: [] }, { teraz: T0 });
    expect(wierszKonta(sekcja((await get(`/magazyn/${id}`)).body), 'ERLI')).toContain(
      'Odmowa: Lista cenników konta niepobrana — pobierz ją w Magazyn → Cenniki, potem wybierz cennik dla tego konta na karcie.',
    );
    listaErli();
    const po = wierszKonta(sekcja((await get(`/magazyn/${id}`)).body), 'ERLI');
    expect(po).toContain(`name="cennik_konta_${ERLI}"`);
    expect(po).toContain('<option value="Kurier gabaryt">Kurier gabaryt</option>');
    expect(po).not.toContain('niepobrana');
  });

  it('zapis wyboru konta, „Teraz” z powodem „wybrany na karcie dla tego konta”, pusty usuwa, nieprzysłane i ten sam wybór nic nie zmieniają', async () => {
    regulyRozmiaru();
    const id = karta(1, MALA);
    expect((await zapiszCennik(id, { [`cennik_konta_${KONTO}`]: 'cen-gabaryt' })).statusCode).toBe(303);
    expect(wybory(id)).toMatchObject([{ konto: KONTO, cennik_kanalu: 'cen-gabaryt' }]);
    let s = sekcja((await get(`/magazyn/${id}`)).body);
    expect(wierszKonta(s, 'Allegro')).toContain(
      'Teraz: Pracownia Półcień — kurier gabaryt — wybrany na karcie dla tego konta',
    );
    expect(wierszKonta(s, 'Allegro')).toContain('<option value="cen-gabaryt" selected>');
    // Nieprzysłane pole nie zmienia wyboru; ten sam wybór nie przesuwa daty zmiany.
    db.prepare('UPDATE karty_cenniki_kanalow SET zmieniono_at = ? WHERE karta_id = ?').run(T0, id);
    expect((await zapiszCennik(id, {})).statusCode).toBe(303);
    expect((await zapiszCennik(id, { cennik_oms: '', [`cennik_konta_${KONTO}`]: 'cen-gabaryt' })).statusCode).toBe(303);
    expect(wybory(id)).toEqual([{ konto: KONTO, cennik_kanalu: 'cen-gabaryt', zmieniono_at: T0 }]);
    // Puste pole usuwa wybór — konto wraca do doboru po rozmiarze.
    expect((await zapiszCennik(id, { [`cennik_konta_${KONTO}`]: '' })).statusCode).toBe(303);
    expect(wybory(id)).toEqual([]);
    s = sekcja((await get(`/magazyn/${id}`)).body);
    expect(wierszKonta(s, 'Allegro')).toContain('Teraz: Pracownia Półcień — paczkomat A');
    expect(wierszKonta(s, 'Allegro')).not.toContain('wybrany na karcie');
  });

  it('wybór konta wygrywa z cennikiem OMS karty, a bez niego karta wraca do cennika OMS', async () => {
    regulyRozmiaru();
    const kurier = cennikNaKarcie('Kurier na karcie', { [KONTO]: 'cen-a' });
    const id = karta(1, MALA);
    expect(
      (await zapiszCennik(id, { cennik_oms: String(kurier), [`cennik_konta_${KONTO}`]: 'cen-c' })).statusCode,
    ).toBe(303);
    let s = sekcja((await get(`/magazyn/${id}`)).body);
    expect(wierszKonta(s, 'Allegro')).toContain('wybrany na karcie dla tego konta');
    await zapiszCennik(id, { [`cennik_konta_${KONTO}`]: '' });
    s = sekcja((await get(`/magazyn/${id}`)).body);
    expect(wierszKonta(s, 'Allegro')).toContain('wyjątek na karcie: cennik OMS „Kurier na karcie”');
  });

  it('wartość spoza listy albo konto bez listy → 400 i nic nie zapisane, także cennik OMS z tego formularza', async () => {
    const gabaryt = cennikNaKarcie('Gabaryt', { [ERLI]: 'Kurier gabaryt' });
    const id = karta(1, MALA);
    // ERLI nie ma jeszcze pobranej listy: nowy wybór nie przejdzie.
    const bez = await zapiszCennik(id, { cennik_oms: String(gabaryt), [`cennik_konta_${ERLI}`]: 'Kurier gabaryt' });
    expect(bez.statusCode).toBe(400);
    expect(wybory(id)).toEqual([]);
    expect(wierszeOms(id)).toEqual([]);
    listaErli();
    const r = await zapiszCennik(id, {
      cennik_oms: String(gabaryt),
      [`cennik_konta_${KONTO}`]: 'cen-a',
      [`cennik_konta_${ERLI}`]: 'Nie ma takiego',
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('Wybierz cennik z listy konta ERLI');
    expect(wybory(id)).toEqual([]);
    expect(wierszeOms(id)).toEqual([]);
  });

  it('wybór zapisany wcześniej, którego nie ma już na liście, zostaje z dopiskiem i nie blokuje zapisu innych pól', async () => {
    const id = karta(1, MALA);
    zapiszWyjatekCennika(db, { kartaId: id, konto: KONTO, cennik: 'cen-zniknal' }, { teraz: T0 });
    const s = sekcja((await get(`/magazyn/${id}`)).body);
    expect(wierszKonta(s, 'Allegro')).toContain(
      '<option value="cen-zniknal" selected>cen-zniknal (nie ma już na liście konta)</option>',
    );
    const gabaryt = cennikNaKarcie('Gabaryt', { [ERLI]: 'Kurier gabaryt' });
    expect(
      (await zapiszCennik(id, { cennik_oms: String(gabaryt), [`cennik_konta_${KONTO}`]: 'cen-zniknal' })).statusCode,
    ).toBe(303);
    expect(wybory(id)).toMatchObject([{ konto: KONTO, cennik_kanalu: 'cen-zniknal' }]);
    expect(wierszeOms(id)).toEqual([{ cennik_id: gabaryt }]);
  });

  it('tryb tylko do odczytu pokazuje nazwy cenników kont zamiast pól', async () => {
    const id = karta(1, MALA);
    zapiszWyjatekCennika(db, { kartaId: id, konto: KONTO, cennik: 'cen-gabaryt' }, { teraz: T0 });
    zalozKonto(db, { login: 'admin', imie: 'Admin', haslo: 'test', rola: 'admin', admin: true });
    const user = zalozKonto(db, { login: 'czytelnik', imie: 'Czytelnik', haslo: 'test', rola: 'operator' });
    ustawUprawnienia(db, user, ['magazyn']);
    const headers = {
      origin: 'http://localhost',
      cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz('czytelnik', wczytajSekret(db), Date.now(), 0)}`,
    };
    const s = sekcja((await get(`/magazyn/${id}`, headers)).body);
    expect(s).not.toContain('<select');
    expect(wierszKonta(s, 'Allegro')).toContain('Pracownia Półcień — kurier gabaryt');
    expect(wierszKonta(s, 'Allegro')).toContain('wybrany na karcie dla tego konta');
  });
});

describe('cennik OMS karty — objęcie ERLI, odmowy i dopisek reguł (Allegro i ERLI)', () => {
  it('objęcie ERLI bez reguł wymaga wyjątku; po jego zapisaniu przechodzi', async () => {
    zapiszUstawieniaOfertKonta(db, ERLI, { cenniki: [] }, { teraz: T0 });
    const id = karta(1, MALA);
    const oferta = wstawOferte(db, {
      kartaId: id,
      kanal: ERLI,
      idZewnetrzne: 'reczna-1',
      tryb: 'obserwowana',
      pochodzenie: 'przejeta',
      stan: 'aktywna',
    });
    zmienOferte(db, oferta.id, { odczytCenaGr: 5900, odczytIlosc: 5 });
    const url = `/magazyn/${id}/oferty/${oferta.id}/objecie`;
    let r = await post(`${url}/podglad`);
    expect(r.body).toContain('Uzupełnij ustawienia: cennik dostaw');
    const token = (r) => /name="podglad" value="([^"]+)"/.exec(r.body)?.[1];
    expect(token(r)).toBeUndefined();
    // Prawdziwy token: podgląd z wyjątkiem, potem wyjątek znika, zatwierdzenie tym tokenem.
    zapiszWyjatekCennika(db, { kartaId: id, konto: ERLI, cennik: 'Paczkomat A' }, { teraz: T0 });
    const zWyjatkiem = await post(`${url}/podglad`);
    const prawdziwy = token(zWyjatkiem);
    expect(prawdziwy).toBeTruthy();
    usunWyjatekCennika(db, { kartaId: id, konto: ERLI });
    const odmowa = await post(`${url}/zatwierdz`, { podglad: prawdziwy });
    expect(odmowa.statusCode).toBe(409);
    expect(odmowa.body).toContain('cennik dostaw');
    expect(ofertyKarty(db, id)[0].tryb).toBe('obserwowana');
    zapiszWyjatekCennika(db, { kartaId: id, konto: ERLI, cennik: 'Paczkomat A' }, { teraz: T0 });
    r = await post(`${url}/podglad`);
    expect(r.body).not.toContain('Uzupełnij ustawienia: cennik dostaw');
    expect((await post(`${url}/zatwierdz`, { podglad: token(r) })).statusCode).toBe(303);
    expect(ofertyKarty(db, id)[0].tryb).toBe('zarzadzana');
    expect(klienci[ERLI].zmienProdukt).not.toHaveBeenCalled();
  });

  it('cennik OMS karty powiązany z cennikiem spoza listy Allegro → „Odmowa” w tabeli karty', async () => {
    const stary = cennikNaKarcie('Stary kurier', { [KONTO]: 'cen-old' });
    const id = karta(1, MALA);
    ustawCennikKarty(db, { kartaId: id, cennikId: stary });
    const s = sekcja((await get(`/magazyn/${id}`)).body);
    expect(s).toContain('Odmowa: Cennik z karty nie istnieje już na koncie Allegro — wybierz inny');
  });

  it('wyjątek Allegro spoza bieżącej listy daje odmowę przed kolejką', async () => {
    const id = karta(1, MALA);
    zapiszWyjatekCennika(db, { kartaId: id, konto: KONTO, cennik: 'cen-old' }, { teraz: T0 });
    const r = await podglad([id]);
    expect(wierszPodgladu(r.body, id)).toContain(
      'Odmowa: Cennik z karty nie istnieje już na koncie Allegro — wybierz inny',
    );
    // Odmowa pochodzi z budowniczego, ale tylko przy tworzeniu oferty: pętla
    // (synchronizacja ceny/ilości, wznowienie) woła go bez `tworzenie` i dostaje treść z cennikiem z karty.
    const w = ofertaAllegroKarty(db, id, { klucz: KONTO, srodowisko: 'produkcja' }, { tworzenie: true });
    expect(w.bledy.map((x) => x.kod)).toContain('cennik');
    expect(w.zadanie).toBeNull();
    const wPetli = ofertaAllegroKarty(db, id, { klucz: KONTO, srodowisko: 'produkcja' });
    expect(wPetli.bledy.map((x) => x.kod)).not.toContain('cennik');
    const wid = (await zatwierdz(r, [id])).body;
    expect(wid).toContain('W kolejce do wysłania: 0.');
    expect(nieWyslano(wid)).toBe(1);
    expect(ofertyKarty(db, id)).toHaveLength(0);
    expect(klienci[KONTO].utworzOferte).not.toHaveBeenCalled();
  });

  it.each([
    [
      MALA,
      'cen-gabaryt',
      'Kurier gabaryt',
      'Pracownia Półcień — paczkomat A — cennik OMS „Do 64×38×8 cm, 25 kg” (do 64×38×8 cm, 25 kg)',
      'Paczkomat A — cennik OMS „Do 64×38×8 cm, 25 kg” (do 64×38×8 cm, 25 kg)',
    ],
    [
      DUZA,
      'cen-a',
      'Paczkomat A',
      'Pracownia Półcień — kurier gabaryt — cennik OMS „Domyślny”',
      'Kurier gabaryt — cennik OMS „Domyślny”',
    ],
    [
      BEZ_WAGI,
      'cen-a',
      'Paczkomat A',
      ODMOWA_WYMIAROW.slice('Odmowa: '.length),
      ODMOWA_WYMIAROW.slice('Odmowa: '.length),
    ],
  ])(
    'podgląd i karta pokazują inny dobór reguł z nazwą i powodem (%j)',
    async (rozmiar, allegro, erli, opisAllegro, opisErli) => {
      regulyRozmiaru();
      const id = karta(1, rozmiar);
      const wybor = cennikNaKarcie('Wybór', { [KONTO]: allegro, [ERLI]: erli });
      ustawCennikKarty(db, { kartaId: id, cennikId: wybor });
      const sekcjaKarty = sekcja((await get(`/magazyn/${id}`)).body);
      for (const [konto, opis] of [
        [KONTO, opisAllegro],
        [ERLI, opisErli],
      ]) {
        const powod = `wyjątek na karcie: cennik OMS „Wybór” (reguły dałyby: ${opis})`;
        expect(wierszPodgladu((await podglad([id], konto)).body, id)).toContain(powod);
        expect(sekcjaKarty).toContain(powod);
      }
    },
  );

  it.each([true, false])('bez dopisku, gdy reguły dają to samo lub ich brak (reguły: %s)', async (saReguly) => {
    regulyRozmiaru();
    const id = karta(1, MALA);
    const wybor = cennikNaKarcie('Wybór', { [KONTO]: 'cen-a', [ERLI]: 'Paczkomat A' });
    ustawCennikKarty(db, { kartaId: id, cennikId: wybor });
    for (const konto of [KONTO, ERLI]) {
      if (!saReguly) zapiszUstawieniaOfertKonta(db, konto, { cenniki: [] }, { teraz: T0 });
      const wiersz = wierszPodgladu((await podglad([id], konto)).body, id);
      expect(wiersz).toContain('wyjątek na karcie: cennik OMS „Wybór”');
      expect(wiersz).not.toContain('reguły dałyby:');
    }
    const kartaHtml = sekcja((await get(`/magazyn/${id}`)).body);
    expect(kartaHtml).toContain('wyjątek na karcie: cennik OMS „Wybór”');
    expect(kartaHtml).not.toContain('reguły dałyby:');
  });
});

describe('migracja magazyn/0003 — warunek pustej wartości (length(trim(...)) > 0)', () => {
  it('pusty albo z samych spacji cennik_dostaw nie staje się regułą; niepusty — tak', () => {
    const wstaw = db.prepare(`INSERT OR REPLACE INTO oferty_ustawienia_kont
      (klucz, oferty_czynne, narzut_bp, stala_ilosc, cennik_dostaw, cenniki_json, zmieniono_at) VALUES (?, 1, 0, 5, ?, NULL, ?)`);
    wstaw.run('konto_spacje', '   ', T0);
    wstaw.run('konto_puste', '', T0);
    wstaw.run('konto_null', null, T0);
    wstaw.run('konto_pelne', ' cennik-7 ', T0);
    migracjaCennikowDostaw.wykonaj(db);
    const json = (k) => db.prepare('SELECT cenniki_json j FROM oferty_ustawienia_kont WHERE klucz = ?').get(k).j;
    expect(json('konto_spacje')).toBeNull();
    expect(json('konto_puste')).toBeNull();
    expect(json('konto_null')).toBeNull();
    expect(JSON.parse(json('konto_pelne'))).toEqual([{ cennik: 'cennik-7' }]);
    expect(ustawieniaOfertKonta(db, 'konto_spacje').cenniki).toEqual([]);
  });
});
