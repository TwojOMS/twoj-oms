// Sekcja GPSR karty: producent Allegro liczony tą samą funkcją co oferta („karta = oferta”), producent OMS
// ze słownika, informacja o bezpieczeństwie i jej zapis osobną trasą. Klienci Allegro to atrapy; dane zmyślone
// („Pracownia Półcień”, lampy).
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { zapiszUstawieniaOfertKonta } from '../../../src/oms/db/oferty-kanalow.ts';
import { dodajProducenta, przypiszMarki, ustawDomyslnego } from '../../../src/oms/db/producenci.js';
import { ofertaAllegroKarty } from '../../../src/moduly/magazyn/services/tresc-oferty-allegro.js';
import { daneGpsrKarty } from '../../../src/moduly/magazyn/karta-gpsr.js';
import { opisKategorii } from '../../../src/domena/tresc-oferty-allegro.js';
import { LIMIT_INFORMACJI_BEZPIECZENSTWA } from '../../../src/domena/allegro-oferta-z-karty.js';
import { kategoriaAllegroDemo, parametryKategoriiAllegroDemo } from '../../../scripts/demo-dane-katalog.mjs';
import { zalozKonto, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';

const KONTO = 'allegro_polcien';
const MARKA = 'Pracownia Półcień';
const T0 = '2026-11-14T08:00:00.000Z';
const auth = {
  authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`,
  origin: 'http://localhost',
};
const ZALACZNIKI = JSON.stringify({ typ: 'ATTACHMENTS', konto: KONTO, zalaczniki: [{ id: 'zal-1' }, { id: 'zal-2' }] });

let db, app;
const post = (url, payload, headers = auth) => app.inject({ method: 'POST', url, payload, headers });
const kolumna = (id) => db.prepare('SELECT informacja_bezpieczenstwa AS w FROM karty_produktow WHERE id = ?').get(id).w;
const kontaAllegro = () => [{ klucz: KONTO, srodowisko: 'produkcja' }];

function ustawienia(pola = {}) {
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
      bezpieczenstwoDomyslne: 'Tekst domyślny konta Półcień.',
      slowniki: {
        pobranoAt: T0,
        cenniki: [{ id: 'cennik-1', nazwa: 'Półcień — standard' }],
        zwroty: [],
        reklamacje: [],
        gwarancje: [],
        producenci: [
          { id: 'prod-konta', nazwa: 'Pracownia Półcień sp. z o.o.' },
          { id: 'prod-marki', nazwa: 'Huta Szkła Mleczna' },
        ],
        osoby: [{ id: 'osoba-1', nazwa: 'Jan Przykładowy' }],
      },
      ...pola,
    },
    { teraz: T0 },
  );
}

/** Karta gotowa do wystawienia na Allegro (kategoria z mapy, marka, 3 zdjęcia, informacja tekstem). */
function karta(pola = {}) {
  const id = utworzKarte(
    db,
    {
      nazwa: 'Lampa Półcień Gliwka',
      sku: `GLW-${Math.random().toString(36).slice(2, 8)}`,
      cena_gr: 5900,
      stawka_vat: '23',
      marka: MARKA,
      kategoria_glowna: 'Lampy stołowe',
      szerokosc_mm: 300,
      wysokosc_mm: 300,
      glebokosc_mm: 300,
      waga_g: 2000,
      opis_sekcje_json: JSON.stringify({
        sekcje: [{ elementy: [{ typ: 'tekst', html: '<p>Lampa z mlecznym kloszem.</p>' }] }],
      }),
      ...pola,
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

const wierszKarty = (id) => db.prepare('SELECT * FROM karty_produktow WHERE id = ?').get(id);
const gpsr = (id) => daneGpsrKarty(db, wierszKarty(id), kontaAllegro);

/** Producent z oferty Allegro tego konta: `{ id }` z zadania albo `{ blad }` z błędu „producent”. */
function producentOferty(id) {
  const wynik = ofertaAllegroKarty(db, id, { klucz: KONTO, srodowisko: 'produkcja' });
  const blad = wynik.bledy.find((b) => b.kod === 'producent');
  if (blad) return { blad: blad.tekst };
  // Bez innych błędów: zadanie istnieje i niesie producenta (albo go nie niesie — droga katalogowa).
  expect(wynik.bledy).toEqual([]);
  return { id: wynik.zadanie.productSet[0].responsibleProducer?.id ?? null };
}

function producentKartyAllegro(id) {
  const w = gpsr(id).allegro.find((a) => a.konto === KONTO);
  return w.blad ? { blad: w.blad } : { id: w.producentId };
}

beforeEach(async () => {
  db = openOmsDb(':memory:');
  const atrapa = { utworzOferte: vi.fn(), zmienOferte: vi.fn(), pobierzOferte: vi.fn() };
  app = buildOmsServer({
    db,
    config: { auth: { user: 'operator', pass: 'atrapa' } },
    magazyn: { stan: () => ({ trwa: false, kanaly: [] }) },
    nadpisania: {
      'kanaly.klienciKanalow': { [KONTO]: atrapa },
      'kanaly.repozytoriumKanalow': {
        listaTypu: (typ) =>
          typ === 'allegro'
            ? [{ klucz: KONTO, nazwa: 'Półcień', autoryzacja: 'polaczone', srodowisko: 'produkcja' }]
            : [],
        zapisyZablokowane: () => false,
        konfliktKlucza: () => false,
      },
    },
  });
  await app.ready();
  db.prepare(
    `INSERT INTO allegro_mapa_kategorii (kategoria_karty, srodowisko, kategoria_allegro_id) VALUES ('Lampy stołowe', 'produkcja', '257')`,
  ).run();
  db.prepare(
    `INSERT INTO allegro_reguly_parametrow (srodowisko, kategoria_allegro_id, parametr_id, rodzaj, wartosc_json, pole, zmieniono_at)
    VALUES ('produkcja', '257', '11323', 'stala', ?, NULL, ?)`,
  ).run(JSON.stringify({ valuesIds: ['11323_1'] }), T0);
  const opis = opisKategorii(['5', '256', '257'].map(kategoriaAllegroDemo), parametryKategoriiAllegroDemo('257'));
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
  ustawienia();
});
afterEach(async () => {
  await app.close();
  db.close();
});

const przypisz = (zrodlo, producentId = null, osoba = null) =>
  db
    .prepare(
      `INSERT OR REPLACE INTO allegro_marki_gpsr (marka, konto, zrodlo, producent_id, osoba_odpowiedzialna_id, zmieniono_at)
      VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(MARKA, KONTO, zrodlo, producentId, osoba, T0);

describe('producent Allegro na karcie = producent w ofercie', () => {
  it('marka przypisana do producenta konta', () => {
    przypisz('konto');
    const id = karta();
    expect(producentOferty(id)).toEqual({ id: 'prod-konta' });
    expect(producentKartyAllegro(id)).toEqual(producentOferty(id));
    const w = gpsr(id).allegro[0];
    expect(w).toMatchObject({ zrodlo: 'konto', producentNazwa: 'Pracownia Półcień sp. z o.o.', nazwaKonta: KONTO });
  });

  it('marka przypisana do wybranego producenta (z osobą odpowiedzialną)', () => {
    przypisz('wybrany', 'prod-marki', 'osoba-1');
    const id = karta();
    expect(producentOferty(id)).toEqual({ id: 'prod-marki' });
    expect(producentKartyAllegro(id)).toEqual(producentOferty(id));
    expect(gpsr(id).allegro[0]).toMatchObject({
      zrodlo: 'marka',
      producentNazwa: 'Huta Szkła Mleczna',
      osoba: { id: 'osoba-1', nazwa: 'Jan Przykładowy' },
    });
  });

  it('marka bez przypisania: ten sam tekst błędu co w ofercie', () => {
    const id = karta();
    const oferta = producentOferty(id);
    expect(oferta.blad).toContain(MARKA);
    expect(producentKartyAllegro(id)).toEqual(oferta);
  });

  it('karta bez marki: producent konta', () => {
    const id = karta({ marka: null });
    expect(producentOferty(id)).toEqual({ id: 'prod-konta' });
    expect(producentKartyAllegro(id)).toEqual(producentOferty(id));
  });

  it('karta z produktem z katalogu Allegro: producenta bierze Allegro z produktu', () => {
    const id = karta();
    db.prepare(`INSERT INTO karty_allegro (karta_id, produkt_id, zmieniono_at) VALUES (?, 'prod-katalog-1', ?)`).run(
      id,
      T0,
    );
    expect(producentOferty(id)).toEqual({ id: null });
    expect(producentKartyAllegro(id)).toEqual(producentOferty(id));
    const w = gpsr(id).allegro[0];
    expect(w.zrodlo).toBe('katalog');
    expect(w.dopisek).toContain('Allegro weźmie producenta z produktu w katalogu');
  });

  it('konto bez producenta: ten sam tekst błędu co w ofercie', () => {
    ustawienia({ producentId: null });
    przypisz('konto');
    const id = karta();
    const oferta = producentOferty(id);
    expect(oferta.blad).toContain('Ustaw producenta konta');
    expect(producentKartyAllegro(id)).toEqual(oferta);
  });

  it('konto sandbox obok produkcji: dla każdego konta producent z karty = z oferty tego konta', () => {
    // Produkt z katalogu zaimportowany na koncie produkcyjnym: w produkcji droga katalogowa, w sandboksie
    // (inne konto, inna mapa kategorii) produkt nowy — tam oferta wymaga przypisania marki.
    const SB = 'allegro_sb';
    const kanal = db.prepare(`INSERT INTO kanaly_sprzedazy (klucz, nazwa, srodowisko, zrodlo, konto_id, raport,
      autoryzacja, pobieranie, od_utc, wersja, generacja, generacja_importu, utworzono_at, zmieniono_at, aktor_id,
      aktor_login, typ) VALUES (?, ?, ?, 'panel', ?, 'x', 'polaczone', 'wylaczone', ?, 1, 1, 1, ?, ?, 1, 'x', 'allegro')`);
    kanal.run(KONTO, 'Półcień', 'produkcja', 'k-prod', T0, T0, T0);
    kanal.run(SB, 'Półcień test', 'sandbox', 'k-sb', T0, T0, T0);
    const id = karta();
    db.prepare(
      `INSERT INTO karty_dane_kanalu (karta_id, typ_kanalu, polaczenie, oferta_id, produkt_id, kategoria_id, pobrano_at)
      VALUES (?, 'allegro', ?, 'of-1', 'prod-kat-1', '257', ?)`,
    ).run(id, KONTO, T0);
    const konta = [
      { klucz: KONTO, srodowisko: 'produkcja' },
      { klucz: SB, srodowisko: 'sandbox' },
    ];
    const model = daneGpsrKarty(db, wierszKarty(id), () => konta);
    for (const konto of konta) {
      const w = model.allegro.find((a) => a.konto === konto.klucz);
      const oferta = ofertaAllegroKarty(db, id, konto);
      const blad = oferta.bledy.find((b) => b.kod === 'producent')?.tekst ?? null;
      expect({ konto: konto.klucz, blad: w.blad }).toEqual({ konto: konto.klucz, blad });
      if (!blad) expect(w.producentId).toBe(oferta.zadanie?.productSet[0].responsibleProducer?.id ?? null);
    }
    expect(model.allegro.find((a) => a.konto === KONTO).zrodlo).toBe('katalog');
    expect(model.allegro.find((a) => a.konto === SB).blad).toContain(SB);
  });

  it('identyfikator spoza pobranej listy: pokazuje ID i prosi o odświeżenie listy', () => {
    przypisz('wybrany', 'prod-nieznany');
    const w = gpsr(karta()).allegro[0];
    expect(w).toMatchObject({ producentId: 'prod-nieznany', producentNazwa: null });
    expect(w.dopisek).toContain('odśwież listę producentów w kroku Oferty konta');
  });
});

describe('model sekcji GPSR', () => {
  it('producent OMS: z marki, potem domyślny, potem brak', () => {
    db.prepare('INSERT OR IGNORE INTO marki (nazwa, utworzona_at) VALUES (?, ?)').run(MARKA, T0);
    const id = karta();
    expect(gpsr(id).producent).toMatchObject({ nazwa: null, zrodlo: null, adresSlownika: '/magazyn/producenci' });

    const dom = dodajProducenta(db, {
      nazwa: 'Zakład Domyślny',
      ulica: 'ul. Przykładowa 1',
      kod: '00-001',
      miasto: 'Wieś',
      kraj: 'PL',
      email: 'kontakt@domyslny.example.invalid',
    }).id;
    ustawDomyslnego(db, dom);
    expect(gpsr(id).producent).toMatchObject({ nazwa: 'Zakład Domyślny', zrodlo: 'domyslny' });

    const zMarki = dodajProducenta(db, {
      nazwa: 'Pracownia Półcień',
      ulica: 'ul. Cienista 2',
      kod: '00-002',
      miasto: 'Miasto',
      kraj: 'PL',
      email: 'kontakt@polcien.example.invalid',
    }).id;
    expect(przypiszMarki(db, [{ marka: MARKA, producentId: zMarki }])).toEqual({ ok: true });
    const p = gpsr(id).producent;
    expect(p).toMatchObject({ nazwa: 'Pracownia Półcień', zrodlo: 'marka', marka: MARKA });
    expect(p.opis).toContain('ul. Cienista 2');
  });

  it('bezpieczeństwo: tekst, załączniki, uszkodzona, domyślne konta i limit', () => {
    const id = karta();
    expect(gpsr(id).bezpieczenstwo).toMatchObject({
      typ: 'TEXT',
      tekst: 'Nie zostawiaj włączonej lampy bez nadzoru.',
      zalaczniki: null,
      domyslneKont: [{ nazwaKonta: KONTO, tekst: 'Tekst domyślny konta Półcień.' }],
      limit: LIMIT_INFORMACJI_BEZPIECZENSTWA,
      uszkodzona: false,
    });
    db.prepare('UPDATE karty_produktow SET informacja_bezpieczenstwa = ? WHERE id = ?').run(ZALACZNIKI, id);
    expect(gpsr(id).bezpieczenstwo).toMatchObject({
      typ: 'ATTACHMENTS',
      zalaczniki: { konto: KONTO, nazwaKonta: KONTO, liczba: 2 },
    });
    db.prepare('UPDATE karty_produktow SET informacja_bezpieczenstwa = ? WHERE id = ?').run('{zepsute', id);
    expect(gpsr(id).bezpieczenstwo).toMatchObject({ typ: null, uszkodzona: true });
    db.prepare('UPDATE karty_produktow SET informacja_bezpieczenstwa = NULL WHERE id = ?').run(id);
    expect(gpsr(id).bezpieczenstwo).toMatchObject({ typ: null, tekst: '', uszkodzona: false });
  });

  it('ekran karty liczy sekcję bez wywołań sieci', async () => {
    przypisz('konto');
    const id = karta();
    const r = await app.inject({ method: 'GET', url: `/magazyn/${id}`, headers: auth });
    expect(r.statusCode).toBe(200);
  });
});

describe('POST /magazyn/:id/bezpieczenstwo', () => {
  const zapisz = (id, pola, headers) => post(`/magazyn/${id}/bezpieczenstwo`, pola, headers);

  it('zapisuje tekst (przycięty, końce linii \\n), oznacza pole jako ręczne i wraca do sekcji', async () => {
    const id = karta();
    const r = await zapisz(id, { tekst: '  Trzymaj z dala od wody.\r\nNie dotykaj gorącej żarówki.  ' });
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe(`/magazyn/${id}?zapisano=bezpieczenstwo#gpsr-karty`);
    expect(kolumna(id)).toBe(
      JSON.stringify({ typ: 'TEXT', tekst: 'Trzymaj z dala od wody.\nNie dotykaj gorącej żarówki.' }),
    );
    const pole = db
      .prepare("SELECT reczne FROM karty_zrodla_pol WHERE karta_id = ? AND pole = 'informacja_bezpieczenstwa'")
      .get(id);
    expect(pole?.reczne).toBe(1);
  });

  it('pusty tekst czyści kolumnę (wraca tekst domyślny konta)', async () => {
    const id = karta();
    expect((await zapisz(id, { tekst: '   ' })).statusCode).toBe(303);
    expect(kolumna(id)).toBeNull();
  });

  it(`${LIMIT_INFORMACJI_BEZPIECZENSTWA} znaków przechodzi, ${LIMIT_INFORMACJI_BEZPIECZENSTWA + 1} odmowa 400`, async () => {
    const id = karta();
    const rowno = 'a'.repeat(LIMIT_INFORMACJI_BEZPIECZENSTWA);
    expect((await zapisz(id, { tekst: rowno })).statusCode).toBe(303);
    expect(JSON.parse(kolumna(id)).tekst).toBe(rowno);
    const r = await zapisz(id, { tekst: `${rowno}b` });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(kolumna(id)).tekst).toBe(rowno);
  });

  it('zapis karty zostawia załączniki bajt w bajt', async () => {
    const id = karta();
    db.prepare('UPDATE karty_produktow SET informacja_bezpieczenstwa = ? WHERE id = ?').run(ZALACZNIKI, id);
    const r = await post(`/magazyn/${id}`, { nazwa: 'Lampa Półcień Gliwka II', sku: 'GLW-II' });
    expect(r.statusCode).toBe(303);
    expect(wierszKarty(id).nazwa).toBe('Lampa Półcień Gliwka II');
    expect(kolumna(id)).toBe(ZALACZNIKI);
  });

  it('karta z załącznikami: 409 bez Zamień, tekst dopiero z zastap=zalaczniki', async () => {
    const id = karta();
    db.prepare('UPDATE karty_produktow SET informacja_bezpieczenstwa = ? WHERE id = ?').run(ZALACZNIKI, id);
    const r = await zapisz(id, { tekst: 'Nowy tekst.' });
    expect(r.statusCode).toBe(409);
    expect(r.body).toContain('Zamień na tekst');
    expect(kolumna(id)).toBe(ZALACZNIKI);
    expect((await zapisz(id, { tekst: 'Nowy tekst.', zastap: 'zalaczniki' })).statusCode).toBe(303);
    expect(kolumna(id)).toBe(JSON.stringify({ typ: 'TEXT', tekst: 'Nowy tekst.' }));
  });

  it('pusty tekst przy „Zamień na tekst”: 400, załączniki zostają', async () => {
    const id = karta();
    db.prepare('UPDATE karty_produktow SET informacja_bezpieczenstwa = ? WHERE id = ?').run(ZALACZNIKI, id);
    const r = await zapisz(id, { tekst: '  ', zastap: 'zalaczniki' });
    expect(r.statusCode).toBe(400);
    expect(kolumna(id)).toBe(ZALACZNIKI);
  });

  it('tekst, który nie jest napisem (powtórzone pole): 400 bez zapisu', async () => {
    const id = karta();
    const przed = kolumna(id);
    const r = await app.inject({
      method: 'POST',
      url: `/magazyn/${id}/bezpieczenstwo`,
      payload: 'tekst=a&tekst=b',
      headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(r.statusCode).toBe(400);
    expect(kolumna(id)).toBe(przed);
  });

  it('nieistniejąca karta: 404', async () => {
    expect((await zapisz(999, { tekst: 'x' })).statusCode).toBe(404);
  });

  it('bez CSRF i bez uprawnienia „magazyn” odmowa; operator z „magazyn” zapisuje', async () => {
    const id = karta();
    const przed = kolumna(id);
    expect((await zapisz(id, { tekst: 'x' }, { authorization: auth.authorization })).statusCode).toBe(403);
    zalozKonto(db, { login: 'admin', imie: 'Admin', haslo: 'test', rola: 'admin', admin: true });
    const bez = zalozKonto(db, { login: 'czytelnik', imie: 'Czytelnik', haslo: 'test', rola: 'operator' });
    ustawUprawnienia(db, bez, []);
    const ciastko = (login) => ({
      origin: auth.origin,
      cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz(login, wczytajSekret(db), Date.now(), 0)}`,
    });
    expect((await zapisz(id, { tekst: 'x' }, ciastko('czytelnik'))).statusCode).toBe(403);
    expect(kolumna(id)).toBe(przed);
    const mag = zalozKonto(db, { login: 'magazynier', imie: 'Magazynier', haslo: 'test', rola: 'operator' });
    ustawUprawnienia(db, mag, ['magazyn']);
    expect((await zapisz(id, { tekst: 'Od magazyniera.' }, ciastko('magazynier'))).statusCode).toBe(303);
    expect(JSON.parse(kolumna(id)).tekst).toBe('Od magazyniera.');
  });
});
