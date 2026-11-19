// „Wystaw oferty” Allegro: podgląd, zatwierdzenie, lista i akcje.
// Klienci Allegro to atrapy; jedyne „wyjście” w podglądzie to prowizja (D40) — reszta nie woła kanału.
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { definicjeKanalowHistoryczne } from '../../pomoc/przykladowe-definicje-kanalow.js';
import { szyfrTestowy } from '../../pomoc/sejf-testowy.ts';
import { utworzKarte, zapiszProduktSklepowy, powiazProdukt } from '../../../src/oms/db/magazyn.js';
import {
  ofertyKarty,
  wstawOferte,
  zmienOferte,
  ofertaPoId,
  zapiszUstawieniaOfertKonta,
  przypiszIdZewnetrzne,
} from '../../../src/oms/db/oferty-kanalow.ts';
import { opisKategorii } from '../../../src/domena/tresc-oferty-allegro.js';
import { kategoriaAllegroDemo, parametryKategoriiAllegroDemo } from '../../../scripts/demo-dane-katalog.mjs';
import { BRAK_ZGODY_OFERT } from '../../../src/moduly/kanaly/services/oferty-allegro-ustawienia.ts';
import { PROWIZJA_NIE_POLICZONO, PROWIZJA_NIEDOSTEPNA } from '../../../src/moduly/magazyn/services/oplaty-allegro.js';
import { zalozKonto, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import slowniki from '../../fixtures/allegro/e3-dok-slowniki.json' with { type: 'json' };

const KONTO = 'allegro_swietlik'; // zgoda na oferty
const BEZ_ZGODY = 'allegro_polcien2'; // token bez zakresów ofert
const ERLI = 'erli-polcien';
const T0 = '2026-11-14T08:00:00.000Z';
const OFERTY = ['allegro:api:sale:offers:write', 'allegro:api:sale:settings:read'];
const jwt = (scope) => ['e30', Buffer.from(JSON.stringify({ scope })).toString('base64url'), 'podpis'].join('.');
const auth = {
  authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`,
  origin: 'http://localhost',
};

let db, app, klienci, kontaAllegro;
const post = (url, payload, headers = auth) => app.inject({ method: 'POST', url, payload, headers });
const get = (url, headers = auth) => app.inject({ method: 'GET', url, headers });
const podglad = (zaznaczone, konto = KONTO) => post('/magazyn/oferty/podglad', { konto, zaznaczone });
const decyzja = (r, zaznaczone, konto = KONTO) => ({
  konto,
  zaznaczone,
  podglad: /name="podglad" value="([^"]+)"/.exec(r.body)?.[1],
});
/** Zatwierdza podgląd jak przeglądarka: POST → 303 → GET ekranu wyniku. */
const zatwierdz = async (r, zaznaczone, konto = KONTO) => {
  const w = await post('/magazyn/oferty/zatwierdz', decyzja(r, zaznaczone, konto));
  expect(w.statusCode).toBe(303);
  return get(w.headers.location);
};
const wywolania = (k) =>
  Object.entries(k)
    .filter(([, f]) => f.mock.calls.length)
    .map(([n]) => n);
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
const tokeny = (kanal, scope) =>
  db
    .prepare(
      `INSERT OR REPLACE INTO tokeny_kanalu (kanal, access_token, refresh_token, wygasa_at, refresh_wygasa_at, zaktualizowane_at)
  VALUES (?, ?, ?, '2026-11-14T11:00:00Z', '2027-01-01T00:00:00Z', '2026-11-14T10:00:00Z')`,
    )
    .run(
      kanal,
      szyfrTestowy(db, 'tokeny_kanalu', 'access_token', kanal, jwt(scope)),
      szyfrTestowy(db, 'tokeny_kanalu', 'refresh_token', kanal, 'REFRESH-ATRAPA'),
    );

/** Karta gotowa do wystawienia na Allegro (kategoria z mapy, reguły, marka, GPSR konta, 3 zdjęcia). */
function karta(n, { cena_gr = 5900 } = {}) {
  const id = utworzKarte(
    db,
    {
      nazwa: `Lampa stołowa Gliwka ${n}`,
      sku: `GLW-${n}`,
      cena_gr,
      stawka_vat: '23',
      marka: 'Pracownia Półcień',
      kategoria_glowna: 'Lampy stołowe',
      szerokosc_mm: 255,
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

/** Serwer testu; `dodatki` rozszerzają config (np. konto gościa demo). */
const serwer = (dodatki = {}) =>
  buildOmsServer({
    db,
    config: {
      auth: { user: 'operator', pass: 'atrapa' },
      ...dodatki,
      definicje: [
        ...definicjeKanalowHistoryczne,
        { klucz: ERLI, typ: 'erli', prefiks: 'ERLI_POLCIEN', etykieta: 'ERLI Półcień' },
      ],
    },
    magazyn: { stan: () => ({ trwa: false, kanaly: [] }) },
    nadpisania: {
      'kanaly.klienciKanalow': klienci,
      'kanaly.repozytoriumKanalow': {
        listaTypu: (typ) =>
          typ === 'allegro' ? kontaAllegro : typ === 'erli' ? [{ klucz: ERLI, nazwa: 'Półcień' }] : [],
        zapisyZablokowane: () => false,
        konfliktKlucza: () => false,
      },
    },
  });

beforeEach(async () => {
  db = openOmsDb(':memory:');
  klienci = { [KONTO]: atrapa(), [BEZ_ZGODY]: atrapa(), [ERLI]: { utworzProdukt: vi.fn(), zmienProdukt: vi.fn() } };
  kontaAllegro = [
    { klucz: KONTO, nazwa: 'Świetlik', autoryzacja: 'polaczone', srodowisko: 'produkcja' },
    { klucz: BEZ_ZGODY, nazwa: 'Półcień Druga', autoryzacja: 'polaczone', srodowisko: 'produkcja' },
  ];
  app = serwer();
  await app.ready();
  tokeny(KONTO, ['allegro:api:orders:read', ...OFERTY]);
  tokeny(BEZ_ZGODY, ['allegro:api:orders:read']);
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
  for (const k of [KONTO, BEZ_ZGODY]) {
    db.prepare(
      `INSERT INTO allegro_marki_gpsr (marka, konto, zrodlo, zmieniono_at) VALUES ('Pracownia Półcień', ?, 'konto', ?)`,
    ).run(k, T0);
    db.prepare(
      `INSERT INTO kanaly_kategorie (polaczenie, kategoria_id, sciezka_json, parametry_json, pobrano_at) VALUES (?, '257', ?, ?, ?)`,
    ).run(
      k,
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
      k,
      {
        narzutProcent: 0,
        stalaIlosc: 5,
        czasWysylkiDni: 2,
        cennikDostaw: 'cennik-1',
        stawkaVat: '23',
        zwrotyId: 'zwrot-1',
        reklamacjeId: 'rekl-1',
        producentId: 'prod-konta',
      },
      { teraz: T0 },
    );
  }
});
afterEach(async () => {
  await app.close();
  db.close();
  vi.useRealTimers();
});

it('„Wystaw oferty” pokazuje konta obu typów; konto bez zgody jest wyszarzone z komunikatem o braku zgody; jest „Aktywuj w Allegro”', async () => {
  karta(1);
  const r = await get('/magazyn');
  expect(r.statusCode).toBe(200);
  // Kafelki z nazwą konta zamiast listy z kluczem.
  const kafel = (klucz) =>
    r.body.match(
      new RegExp(`<label class="konto-kafel">(?:(?!</label>)[\\s\\S])*?value="${klucz}"[\\s\\S]*?</label>`),
    )?.[0] ?? '';
  const erli = kafel(ERLI);
  const zgodne = kafel(KONTO);
  const bez = kafel(BEZ_ZGODY);
  expect(erli).toContain(`<input type="radio" name="konto" value="${ERLI}"`);
  expect(erli).toContain('src="/public/integracje/erli.svg"');
  expect(erli).toContain('<span class="konto-kafel-nazwa">Półcień</span>');
  expect(zgodne).toContain('src="/public/integracje/allegro.svg"');
  expect(zgodne).toContain('<span class="konto-kafel-nazwa">Świetlik</span>');
  expect(zgodne).toContain('<span class="konto-kafel-kanal">Allegro</span>');
  expect(bez).toContain('<span class="konto-kafel-nazwa">Półcień Druga</span>');
  expect(bez).toContain(' disabled');
  expect(bez).toContain('<small>Brak zgody na zapis ofert — połącz ponownie w Ustawieniach → Integracje</small>');
  expect(bez).not.toContain('checked');
  expect(erli).toContain('checked');
  expect(zgodne).not.toContain('checked');
  expect(r.body).not.toContain(`>ERLI · ${ERLI}<`);
  expect(r.body).not.toContain(`>${ERLI}<`);
  expect(r.body).not.toContain('<select id="konto-ofert"');
  expect(r.body).not.toContain('id="konto-ofert-zgoda"');
  expect(r.body).toContain('formaction="/magazyn/oferty/aktywuj"');
  expect(r.body).toContain('Aktywuj w Allegro');
});

it('podgląd Allegro: droga, kategoria, cena i prowizja; zatwierdzenie kładzie ext:… do wysłania; wysyła tylko podgląd prowizji', async () => {
  const id = karta(1);
  const r = await podglad([id]);
  expect(r.statusCode).toBe(200);
  // Nagłówek używa nazwy z konfiguracji, zamiast technicznego klucza konta.
  for (const tekst of [
    'Oferty Allegro',
    'Allegro swietlik_pl',
    'nowy produkt',
    'Kategoria Allegro: 257',
    '59,00 zł',
    'Prowizja: 19,00 zł',
    'Ilość: 5',
  ])
    expect(r.body).toContain(tekst);
  expect(r.body).not.toContain('Odmowa:');
  expect(ofertyKarty(db, id)).toHaveLength(0);
  expect(klienci[KONTO].podgladOplat).toHaveBeenCalledTimes(1);
  expect(klienci[KONTO].podgladOplat.mock.calls[0][0]).toEqual({
    category: { id: '257' },
    sellingMode: { format: 'BUY_NOW', price: { amount: '59.00', currency: 'PLN' } },
  });
  // Wynik ma własny ekran: POST kończy się przekierowaniem, F5 na wyniku nie wysyła formularza drugi raz.
  const w = await post('/magazyn/oferty/zatwierdz', decyzja(r, [id]));
  expect(w.statusCode).toBe(303);
  expect(w.headers.location).toBe(`/magazyn/oferty/wynik?konto=${KONTO}&karty=${id}`);
  expect((await get(w.headers.location)).body).toContain('W kolejce do wysłania: 1.');
  const [o] = ofertyKarty(db, id);
  expect(o).toMatchObject({ kanal: KONTO, stan: 'do_wyslania', tryb: 'zarzadzana', pochodzenie: 'oms' });
  expect(o.idZewnetrzne).toMatch(new RegExp(`^ext:\\S+-K${id}$`));
  // Zatwierdzenie nie liczy prowizji ponownie i niczego nie wysyła — robi to pętla.
  expect(wywolania(klienci[KONTO])).toEqual(['podgladOplat']);
  expect(klienci[KONTO].podgladOplat).toHaveBeenCalledTimes(1);
});

it('bez podglądu nie ma zatwierdzenia', async () => {
  const id = karta(1);
  const w = await post('/magazyn/oferty/zatwierdz', { konto: KONTO, zaznaczone: [id] });
  expect(w.statusCode).toBe(409);
  expect(ofertyKarty(db, id)).toHaveLength(0);
});

it('token podglądu innych kart albo spreparowany → 409 bez przekierowania na wynik i bez wiersza', async () => {
  const id = karta(1);
  const inna = karta(2);
  const cudzy = await podglad([inna]);
  for (const podglad of [decyzja(cudzy, [inna]).podglad, `${Date.now()}.${'0'.repeat(64)}`, 'brak']) {
    const w = await post('/magazyn/oferty/zatwierdz', { konto: KONTO, zaznaczone: [id], podglad });
    expect(w.statusCode).toBe(409);
    expect(w.headers.location).toBeUndefined();
  }
  expect(ofertyKarty(db, id)).toHaveLength(0);
});

it('karta z ofertą Allegro w lustrze na tym koncie → odmowa liczona osobno', async () => {
  const a = karta(1);
  const b = karta(2);
  const pid = zapiszProduktSklepowy(db, {
    kanal: KONTO,
    produkt_id: '17000000000777',
    wariant_id: '',
    nazwa: 'Gliwka (poza OMS)',
    status_publikacji: 'ACTIVE',
    odczytane_at: T0,
  });
  powiazProdukt(db, pid, a);
  const r = await podglad([a, b]);
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain('Odmowa: Karta ma już ofertę na tym koncie.');
  const w = await zatwierdz(r, [a, b]);
  expect(w.body).toContain('W kolejce do wysłania: 1.');
  expect(w.body).toContain('nie wysłano — popraw błędy z podglądu');
  expect(ofertyKarty(db, a)).toHaveLength(0);
  expect(ofertyKarty(db, b)).toHaveLength(1);
});

it('karta z 2 ofertami na innych kontach → ostrzeżenie, nie odmowa', async () => {
  const id = karta(1);
  wstawOferte(db, {
    kartaId: id,
    kanal: BEZ_ZGODY,
    idZewnetrzne: '17000000000101',
    stan: 'aktywna',
    pochodzenie: 'oms',
    tryb: 'zarzadzana',
  });
  const pid = zapiszProduktSklepowy(db, {
    kanal: BEZ_ZGODY,
    produkt_id: '17000000000102',
    wariant_id: '',
    nazwa: 'Gliwka bis',
    status_publikacji: 'ACTIVE',
    odczytane_at: T0,
  });
  powiazProdukt(db, pid, id);
  const r = await podglad([id]);
  expect(r.body).toContain('Allegro nie pozwala na więcej niż dwie oferty');
  expect(r.body).not.toContain('Odmowa:');
  expect((await zatwierdz(r, [id])).body).toContain('W kolejce do wysłania: 1.');
});

it('konto bez zgody na oferty → 400 z komunikatem o braku zgody; konto spoza list → 400', async () => {
  const id = karta(1);
  const r = await podglad([id], BEZ_ZGODY);
  expect(r.statusCode).toBe(400);
  expect(r.body).toContain(BRAK_ZGODY_OFERT);
  expect((await podglad([id], 'allegro_obce')).statusCode).toBe(400);
  expect(wywolania(klienci[BEZ_ZGODY])).toEqual([]);
});

it('prowizja dla 21. karty → „nie policzono”; jedno zapytanie na (kategoria, cena)', async () => {
  const ids = Array.from({ length: 21 }, (_, i) => karta(i + 1));
  const r = await podglad(ids);
  expect(r.statusCode).toBe(200);
  expect(r.body.split('Prowizja: 19,00 zł').length - 1).toBe(20);
  expect(r.body.split(`Prowizja: ${PROWIZJA_NIE_POLICZONO}`).length - 1).toBe(1);
  expect(r.body.indexOf(`Prowizja: ${PROWIZJA_NIE_POLICZONO}`)).toBeGreaterThan(
    r.body.indexOf(`Lampa stołowa Gliwka 21<`),
  );
  expect(klienci[KONTO].podgladOplat).toHaveBeenCalledTimes(1);
  // Pamięć 10 min: drugi podgląd nie pyta ponownie.
  await podglad(ids.slice(0, 2));
  expect(klienci[KONTO].podgladOplat).toHaveBeenCalledTimes(1);
});

it('prowizja z odmową → „niedostępna”, podgląd i zatwierdzenie działają', async () => {
  const id = karta(1);
  klienci[KONTO].podgladOplat.mockRejectedValue(Object.assign(new Error('Allegro 403'), { status: 403 }));
  const r = await podglad([id]);
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain(`Prowizja: ${PROWIZJA_NIEDOSTEPNA}`);
  expect((await zatwierdz(r, [id])).body).toContain('W kolejce do wysłania: 1.');
});

it('„Aktywuj” na szkicu zapisuje aktywuj = true i niczego nie wysyła; przycisk na karcie i hurtem', async () => {
  const id = karta(1);
  const drugi = karta(2);
  const szkic = (kartaId) => {
    const o = wstawOferte(db, {
      kartaId,
      kanal: KONTO,
      idZewnetrzne: `ext:TEST-K${kartaId}`,
      stan: 'nieaktywna',
      pochodzenie: 'oms',
      tryb: 'zarzadzana',
    });
    zmienOferte(db, o.id, { wyslanePola: { externalId: `TEST-K${kartaId}`, szkic: true, skrot: 'abc' } });
    return o;
  };
  const o = szkic(id);
  const k = await get(`/magazyn/${id}`);
  expect(k.body).toContain(`/magazyn/${id}/oferty/${o.id}/aktywuj`);
  expect(k.body).toContain('Aktywuj w Allegro');
  expect(k.body).toContain(`Allegro · Świetlik`);
  const r = await post(`/magazyn/${id}/oferty/${o.id}/aktywuj`, {});
  expect(r.statusCode).toBe(303);
  expect(ofertaPoId(db, o.id)).toMatchObject({
    stan: 'nieaktywna',
    wyslanePola: { externalId: `TEST-K${id}`, szkic: true, skrot: 'abc', aktywuj: true },
  });
  const o2 = szkic(drugi);
  const h = await post('/magazyn/oferty/aktywuj', { konto: KONTO, zakres: 'zaznaczone', zaznaczone: [id, drugi] });
  expect(h.statusCode).toBe(200);
  expect(h.body).toContain('Do aktywacji: 1.');
  expect(ofertaPoId(db, o2.id).wyslanePola.aktywuj).toBe(true);
  expect(wywolania(klienci[KONTO])).toEqual([]);
});

it('„Aktywuj” na ofercie zdjętej (albo bez szkicu) → 409', async () => {
  const id = karta(1);
  const zakonczona = wstawOferte(db, {
    kartaId: id,
    kanal: KONTO,
    idZewnetrzne: `ext:TEST-K${id}`,
    stan: 'nieaktywna',
    pochodzenie: 'oms',
    tryb: 'zarzadzana',
  });
  zmienOferte(db, zakonczona.id, { wyslanePola: { externalId: `TEST-K${id}` } });
  const r = await post(`/magazyn/${id}/oferty/${zakonczona.id}/aktywuj`, {});
  expect(r.statusCode).toBe(409);
  expect(r.body).toContain('Aktywować można tylko szkic oferty Allegro.');
  expect(r.body).not.toContain('Zdjętą ofertę');
  expect(ofertaPoId(db, zakonczona.id).wyslanePola.aktywuj).toBeUndefined();
  zmienOferte(db, zakonczona.id, { wyslanePola: { externalId: `TEST-K${id}`, szkic: true, zdejmij: true } });
  expect((await post(`/magazyn/${id}/oferty/${zakonczona.id}/aktywuj`, {})).statusCode).toBe(409);
  expect((await get(`/magazyn/${id}`)).body).not.toContain(`/oferty/${zakonczona.id}/aktywuj`);
});

it('„Aktywuj” bez zgody konta → 400 w obu trasach; hurt na jednym koncie nie rusza szkicu na drugim', async () => {
  const id = karta(1);
  const szkic = (kanal, ext) => {
    const o = wstawOferte(db, {
      kartaId: id,
      kanal,
      idZewnetrzne: ext,
      stan: 'nieaktywna',
      pochodzenie: 'oms',
      tryb: 'zarzadzana',
    });
    zmienOferte(db, o.id, { wyslanePola: { externalId: ext, szkic: true } });
    return o;
  };
  const obcy = szkic(BEZ_ZGODY, 'ext:TEST-OBCY');
  const r = await post(`/magazyn/${id}/oferty/${obcy.id}/aktywuj`, {});
  expect(r.statusCode).toBe(400);
  expect(r.body).toContain(BRAK_ZGODY_OFERT);
  expect(ofertaPoId(db, obcy.id).wyslanePola.aktywuj).toBeUndefined();
  const h = await post('/magazyn/oferty/aktywuj', { konto: BEZ_ZGODY, zaznaczone: [id] });
  expect(h.statusCode).toBe(400);
  expect(h.body).toContain(BRAK_ZGODY_OFERT);
  expect(ofertaPoId(db, obcy.id).wyslanePola.aktywuj).toBeUndefined();
  const wlasny = szkic(KONTO, 'ext:TEST-WLASNY');
  const w = await post('/magazyn/oferty/aktywuj', { konto: KONTO, zaznaczone: [id] });
  expect(w.statusCode).toBe(200);
  expect(w.body).toContain('Do aktywacji: 1.');
  expect(ofertaPoId(db, wlasny.id).wyslanePola.aktywuj).toBe(true);
  expect(ofertaPoId(db, obcy.id).wyslanePola.aktywuj).toBeUndefined();
});

it('konto sandbox ma dopisek „sandbox” na kafelku „Wystaw oferty” i w nagłówku podglądu', async () => {
  kontaAllegro[0] = { ...kontaAllegro[0], srodowisko: 'sandbox' };
  const id = karta(1);
  const l = await get('/magazyn');
  const kafel = (klucz) =>
    l.body.match(
      new RegExp(`<label class="konto-kafel">(?:(?!</label>)[\\s\\S])*?value="${klucz}"[\\s\\S]*?</label>`),
    )?.[0] ?? '';
  expect(kafel(KONTO)).toContain('<span class="konto-kafel-kanal">Allegro · sandbox</span>');
  expect(kafel(BEZ_ZGODY)).toContain(' disabled');
  const r = await podglad([id]);
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain('Allegro swietlik_pl (sandbox)');
});

it('aktywacja pokazuje nazwę konta zamiast klucza', async () => {
  const id = karta(1);
  const r = await post('/magazyn/oferty/aktywuj', { konto: KONTO, zaznaczone: [id] });
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain('Allegro swietlik_pl');
  expect(r.body).not.toContain('Allegro · Allegro');
  expect(r.body).not.toContain(`Allegro · ${KONTO}`);
});

it('„Zdejmij” na Allegro zapisuje tylko zamiar ENDED i zeruje liczniki zdejmowania; „Wyślij ponownie” działa dla Allegro', async () => {
  const id = karta(1);
  const o = wstawOferte(db, {
    kartaId: id,
    kanal: KONTO,
    idZewnetrzne: `ext:TEST-K${id}`,
    stan: 'aktywna',
    pochodzenie: 'oms',
    tryb: 'zarzadzana',
  });
  zmienOferte(db, o.id, { wyslanePola: { externalId: `TEST-K${id}`, skrot: 'abc', probyZdjecia: 5, bledyZdjecia: 2 } });
  const przed = ofertaPoId(db, o.id);
  const r = await post(`/magazyn/${id}/oferty/${o.id}/zdejmij`, {});
  expect(r.statusCode).toBe(303);
  const po = ofertaPoId(db, o.id);
  expect(po.wyslanePola).toEqual({ externalId: `TEST-K${id}`, skrot: 'abc', zdejmij: true });
  expect(po.stan).toBe(przed.stan);
  expect(wywolania(klienci[KONTO])).toEqual([]);
  const p = wstawOferte(db, {
    kartaId: karta(2),
    kanal: KONTO,
    idZewnetrzne: 'ext:TEST-K99',
    stan: 'problem',
    pochodzenie: 'oms',
    tryb: 'zarzadzana',
  });
  expect((await post(`/magazyn/${p.kartaId}/oferty/${p.id}/ponow`, {})).statusCode).toBe(303);
  expect(ofertaPoId(db, p.id).stan).toBe('do_wyslania');
});

it('„Ponów” na ofercie z numerem Allegro wraca do synchronizacji, nie do wysłania (bez drugiego POST)', async () => {
  const id = karta(3);
  const o = wstawOferte(db, {
    kartaId: id,
    kanal: KONTO,
    idZewnetrzne: '7712001',
    stan: 'problem',
    pochodzenie: 'oms',
    tryb: 'zarzadzana',
  });
  zmienOferte(db, o.id, {
    odczytStatus: 'ACTIVE',
    liczbaProb: 5,
    problemy: [{ kod: 'komenda', rodzaj: 'ilosc', tekst: 'Odrzucona' }],
    wyslanePola: { komendaIlosci: { id: 'k-1', wartosc: 4 }, produktId: '42' },
  });
  expect((await post(`/magazyn/${id}/oferty/${o.id}/ponow`, {})).statusCode).toBe(303);
  expect(ofertaPoId(db, o.id)).toMatchObject({
    stan: 'aktywna',
    liczbaProb: 0,
    problemy: [],
    wyslanePola: { produktId: '42' },
  });
  expect(ofertaPoId(db, o.id).wyslanePola.komendaIlosci).toBeUndefined();
  expect(wywolania(klienci[KONTO])).toEqual([]);
});

it('lista: oferta Allegro z rejestru ma plakietkę ze stanem; liczba zapytań nie rośnie z liczbą kart', async () => {
  const policz = async () => {
    const oryginal = db.prepare;
    let n = 0;
    db.prepare = function (...args) {
      n++;
      return oryginal.apply(this, args);
    };
    try {
      expect((await get('/magazyn')).statusCode).toBe(200);
    } finally {
      db.prepare = oryginal;
    }
    return n;
  };
  const dodaj = (ile, start) => {
    for (let i = 0; i < ile; i++) {
      const id = karta(start + i);
      wstawOferte(db, {
        kartaId: id,
        kanal: KONTO,
        idZewnetrzne: `ext:TEST-K${id}`,
        stan: 'do_wyslania',
        pochodzenie: 'oms',
        tryb: 'zarzadzana',
      });
      wstawOferte(db, {
        kartaId: id,
        kanal: ERLI,
        idZewnetrzne: `GLW-${id}`,
        stan: 'aktywna',
        pochodzenie: 'oms',
        tryb: 'zarzadzana',
      });
    }
  };
  dodaj(3, 1);
  const r = await get('/magazyn');
  expect(r.body).toContain('Allegro swietlik_pl — do wysłania');
  const trzy = await policz();
  dodaj(6, 4);
  const dziewiec = await policz();
  expect(dziewiec).toBe(trzy);
});

it('odrzuca obcy CSRF oraz nie-admina na trasach ofert Allegro', async () => {
  const id = karta(1);
  const o = wstawOferte(db, {
    kartaId: id,
    kanal: KONTO,
    idZewnetrzne: `ext:TEST-K${id}`,
    stan: 'nieaktywna',
    pochodzenie: 'oms',
    tryb: 'zarzadzana',
  });
  zmienOferte(db, o.id, { wyslanePola: { szkic: true } });
  const trasy = [
    '/magazyn/oferty/podglad',
    '/magazyn/oferty/zatwierdz',
    '/magazyn/oferty/aktywuj',
    `/magazyn/${id}/oferty/${o.id}/aktywuj`,
    `/magazyn/${id}/oferty/${o.id}/zdejmij`,
  ];
  for (const url of trasy)
    expect(
      (await post(url, { konto: KONTO, zaznaczone: [id] }, { ...auth, origin: 'https://obcy.example' })).statusCode,
    ).toBe(403);
  zalozKonto(db, { login: 'admin', imie: 'Admin', haslo: 'test', rola: 'admin', admin: true });
  const user = zalozKonto(db, { login: 'czytelnik', imie: 'Czytelnik', haslo: 'test', rola: 'operator' });
  ustawUprawnienia(db, user, ['magazyn']);
  const headers = {
    origin: 'http://localhost',
    cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz('czytelnik', wczytajSekret(db), Date.now(), 0)}`,
  };
  for (const url of trasy) expect((await post(url, { konto: KONTO, zaznaczone: [id] }, headers)).statusCode).toBe(403);
  expect(ofertaPoId(db, o.id).wyslanePola.aktywuj).toBeUndefined();
  expect(wywolania(klienci[KONTO])).toEqual([]);
});

describe('Aktywuj z kontem ERLI w polu', () => {
  function szkice() {
    const id = karta(1);
    const drugaKarta = karta(2);
    const oferty = [
      [id, KONTO],
      [id, BEZ_ZGODY],
      [id, ERLI],
      [drugaKarta, KONTO],
    ].map(([kartaId, kanal]) => {
      const o = wstawOferte(db, {
        kartaId,
        kanal,
        idZewnetrzne: `ext:TEST-K${kartaId}-${kanal}`,
        stan: 'nieaktywna',
        pochodzenie: 'oms',
        tryb: 'zarzadzana',
      });
      zmienOferte(db, o.id, { wyslanePola: { szkic: true } });
      return o;
    });
    return { id, oferty };
  }

  it('ERLI i jedno konto Allegro ze zgodą → oznacza tylko szkic zaznaczonej karty na tym koncie', async () => {
    const { id, oferty } = szkice();
    const r = await post('/magazyn/oferty/aktywuj', { konto: ERLI, zaznaczone: [id] });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Do aktywacji: 1.');
    expect(ofertaPoId(db, oferty[0].id).wyslanePola.aktywuj).toBe(true);
    for (const o of oferty.slice(1)) expect(ofertaPoId(db, o.id).wyslanePola.aktywuj).toBeUndefined();
    for (const klient of Object.values(klienci)) expect(wywolania(klient)).toEqual([]);
  });

  it('ERLI i dwa konta Allegro ze zgodą → 400 z prośbą o wybór konta, bez oznaczania szkiców', async () => {
    tokeny(BEZ_ZGODY, OFERTY);
    const { id, oferty } = szkice();
    const r = await post('/magazyn/oferty/aktywuj', { konto: ERLI, zaznaczone: [id] });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('Wybierz w polu Konto, na którym koncie Allegro aktywować szkice.');
    for (const o of oferty) expect(ofertaPoId(db, o.id).wyslanePola.aktywuj).toBeUndefined();
    for (const klient of Object.values(klienci)) expect(wywolania(klient)).toEqual([]);
  });

  it('wybrane Allegro przy dwóch kontach ze zgodą → oznacza tylko szkic wybranego konta', async () => {
    tokeny(BEZ_ZGODY, OFERTY);
    const { id, oferty } = szkice();
    const r = await post('/magazyn/oferty/aktywuj', { konto: KONTO, zaznaczone: [id] });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Do aktywacji: 1.');
    expect(ofertaPoId(db, oferty[0].id).wyslanePola.aktywuj).toBe(true);
    for (const o of oferty.slice(1)) expect(ofertaPoId(db, o.id).wyslanePola.aktywuj).toBeUndefined();
    for (const klient of Object.values(klienci)) expect(wywolania(klient)).toEqual([]);
  });

  it('nieznany klucz konta (np. Allegro rozłączone po otwarciu strony) → dawne 400, bez zamiany na jedyne konto', async () => {
    const { id, oferty } = szkice();
    const r = await post('/magazyn/oferty/aktywuj', { konto: 'allegro-rozlaczone', zaznaczone: [id] });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('Wybierz bieżące konto Allegro.');
    for (const o of oferty) expect(ofertaPoId(db, o.id).wyslanePola.aktywuj).toBeUndefined();
  });
});

describe('odmowa o informacji o bezpieczeństwie mówi, gdzie ją uzupełnić', () => {
  const USTAWIENIA = `/ustawienia/integracje/allegro/${KONTO}/oferty#allegro-oferty-bezpieczenstwo`;
  const NA_KARCIE = (id) => `<a href="/magazyn/${id}#gpsr-informacja-tytul">Uzupełnij na karcie</a>`;
  const informacja = (id, wartosc) =>
    db
      .prepare('UPDATE karty_produktow SET informacja_bezpieczenstwa = ? WHERE id = ?')
      .run(wartosc === null ? null : JSON.stringify(wartosc), id);
  const linia = (body, poczatek) =>
    body.match(new RegExp(`<p class="pasek-blokada">Odmowa: ${poczatek}[\\s\\S]*?</p>`))?.[0] ?? '';

  it('admin: brak tekstu i obce załączniki → odnośnik do karty i do tekstu domyślnego konta, nazwa konta zamiast klucza', async () => {
    const bez = karta(1);
    const obce = karta(2);
    informacja(bez, null);
    informacja(obce, { typ: 'ATTACHMENTS', konto: 'allegro_inne', zalaczniki: [{ id: 'zal-1' }] });
    const r = await podglad([bez, obce]);
    expect(r.statusCode).toBe(200);
    const brak = linia(r.body, 'Wpisz informację');
    expect(brak).toBe(
      `<p class="pasek-blokada">Odmowa: Wpisz informację o bezpieczeństwie na karcie albo tekst domyślny konta Świetlik. ${NA_KARCIE(bez)} · <a href="${USTAWIENIA}">Ustaw tekst domyślny konta Świetlik</a></p>`,
    );
    const zal = linia(r.body, 'Załączniki');
    expect(zal).toContain('na koncie Świetlik wpisz informację tekstem.');
    expect(zal).toContain(NA_KARCIE(obce));
    expect(zal).toContain(`<a href="${USTAWIENIA}">Ustaw tekst domyślny konta Świetlik</a>`);
    expect(r.body).not.toContain(`konta ${KONTO}`);
    expect(r.body).not.toContain('[object Object]');
    expect(r.body).not.toContain('ustawia administrator');
  });

  it('za długi tekst → tylko odnośnik do karty', async () => {
    const id = karta(1);
    informacja(id, { typ: 'TEXT', tekst: 'x'.repeat(5001) });
    const r = await podglad([id]);
    expect(linia(r.body, 'Informacja o bezpieczeństwie ma 5001')).toBe(
      `<p class="pasek-blokada">Odmowa: Informacja o bezpieczeństwie ma 5001 znaków — Allegro przyjmie najwyżej 5000. ${NA_KARCIE(id)}</p>`,
    );
    expect(r.body).not.toContain('/ustawienia/integracje/allegro/');
  });

  it('dopiski podglądu (karta z ofertą na koncie) zostają czystym tekstem bez odnośników', async () => {
    const id = karta(1);
    wstawOferte(db, { kartaId: id, kanal: KONTO, idZewnetrzne: `ext:TEST-K${id}`, stan: 'aktywna' });
    const r = await podglad([id]);
    expect(r.body).toContain('<p class="pasek-blokada">Odmowa: Karta ma już ofertę na tym koncie.</p>');
  });

  it('gość demo (bez Ustawień): odnośnik do karty, zamiast odnośnika do Ustawień zdanie, kto ustawia tekst konta', async () => {
    await app.close();
    app = serwer({ demo: { login: 'gosc' } });
    await app.ready();
    const gosc = zalozKonto(db, { login: 'gosc', imie: 'Gość', haslo: 'test', rola: 'sprzedaz' });
    ustawUprawnienia(db, gosc, ['magazyn']);
    const headers = {
      origin: 'http://localhost',
      cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz('gosc', wczytajSekret(db), Date.now(), 0)}`,
    };
    const id = karta(1);
    informacja(id, null);
    const r = await post('/magazyn/oferty/podglad', { konto: KONTO, zaznaczone: [id] }, headers);
    expect(r.statusCode).toBe(200);
    expect(linia(r.body, 'Wpisz informację')).toBe(
      `<p class="pasek-blokada">Odmowa: Wpisz informację o bezpieczeństwie na karcie albo tekst domyślny konta Świetlik. ${NA_KARCIE(id)} · (tekst domyślny konta ustawia administrator: Ustawienia → Integracje → Allegro → konto Świetlik → krok Oferty)</p>`,
    );
    expect(r.body).not.toContain('/ustawienia/integracje/allegro/');
  });
});

describe('ekran wyniku po zatwierdzeniu', () => {
  const SZKICE =
    'Na koncie Świetlik oferty powstają jako nieaktywne szkice — włączysz je przyciskiem „Aktywuj w Allegro — szkice zaznaczonych” w Magazynie albo na karcie.';
  const AKTYWNE = 'Oferty staną się aktywne, gdy Allegro je sprawdzi.';
  const wynikUrl = (karty, konto = KONTO) => `/magazyn/oferty/wynik?konto=${konto}&karty=${karty.join(',')}`;
  const wiersz = (body, id) =>
    body.match(new RegExp(`<tr>(?:(?!</tr>)[\\s\\S])*?href="/magazyn/${id}#produkty-karty"[\\s\\S]*?</tr>`))?.[0] ?? '';

  it('do wysłania → aktywna → problem: stan, numer oferty z odnośnikiem do Allegro i tekst problemu', async () => {
    const id = karta(1);
    const w = await zatwierdz(await podglad([id]), [id]);
    expect(w.statusCode).toBe(200);
    for (const tekst of [
      '<h1>Oferty — Świetlik</h1>',
      '<p class="pasek-info" role="status">W kolejce do wysłania: 1. OMS wysyła oferty w tle co 5 minut — ta strona pokazuje ich stan.',
      SZKICE,
      `<a href="/magazyn/${id}#produkty-karty">Lampa stołowa Gliwka 1</a>`,
      `<a class="btn" href="${wynikUrl([id]).replace(`&`, `&amp;`)}">Odśwież stan</a>`,
      '<a class="btn" href="/magazyn">← Magazyn</a>',
    ])
      expect(w.body).toContain(tekst);
    expect(wiersz(w.body, id)).toContain(
      '<td>do wysłania<p class="pasek-uwaga">Czeka: konto Świetlik ma oferty wstrzymane',
    );
    expect(wiersz(w.body, id)).toContain('<td>—</td>');
    expect(w.body).not.toContain(KONTO + '<');
    expect(w.body).not.toContain('Odmówiono');

    const [o] = ofertyKarty(db, id);
    przypiszIdZewnetrzne(db, o.id, '17000000000555');
    zmienOferte(db, o.id, { stan: 'aktywna' });
    const a = await get(wynikUrl([id]));
    expect(a.body).toContain('Wszystkie oferty z tej partii zostały już wysłane.');
    expect(a.body).not.toContain('W kolejce do wysłania');
    expect(wiersz(a.body, id)).toContain('<td>aktywna</td>');
    expect(wiersz(a.body, id)).toContain(
      '<a href="https://allegro.pl/oferta/17000000000555" target="_blank" rel="noopener">17000000000555</a>',
    );

    zmienOferte(db, o.id, { stan: 'problem', problemy: [{ kod: 'kategoria', tekst: 'Allegro odrzuciło kategorię.' }] });
    const p = await get(wynikUrl([id]));
    expect(wiersz(p.body, id)).toContain('problem');
    expect(wiersz(p.body, id)).toContain('<p class="pasek-uwaga">Allegro odrzuciło kategorię.</p>');
  });

  it('konto z „Aktywuj po sprawdzeniu” → zdanie o aktywacji zamiast szkiców', async () => {
    zapiszUstawieniaOfertKonta(db, KONTO, { aktywujPoSprawdzeniu: true }, { teraz: T0 });
    const id = karta(1);
    const w = await zatwierdz(await podglad([id]), [id]);
    expect(w.body).toContain(AKTYWNE);
    expect(w.body).not.toContain('nieaktywne szkice');
  });

  it('karta bez oferty na tym koncie i oferta tej karty na innym koncie → „nie wysłano”, cudza oferta niewidoczna; same odmowy nie są „wysłane”', async () => {
    const id = karta(1);
    wstawOferte(db, {
      kartaId: id,
      kanal: BEZ_ZGODY,
      idZewnetrzne: '17000000000999',
      stan: 'do_wyslania',
      pochodzenie: 'oms',
      tryb: 'zarzadzana',
    });
    const w = await get(wynikUrl([id, 999999]));
    expect(w.statusCode).toBe(200);
    expect(w.body).toContain('W kolejce do wysłania: 0.');
    expect(w.body).not.toContain('już wysłane');
    expect(w.body).not.toContain('17000000000999');
    expect(wiersz(w.body, id)).toContain('nie wysłano — popraw błędy z podglądu');
    expect(wiersz(w.body, 999999)).toContain('nie wysłano — popraw błędy z podglądu');
  });

  it('GET wyniku tylko czyta: liczba wierszy i prób bez zmian, kanał nie wołany', async () => {
    const id = karta(1);
    const r = await podglad([id]);
    await post('/magazyn/oferty/zatwierdz', decyzja(r, [id]));
    const stan = () =>
      db.prepare('SELECT COUNT(*) AS n, SUM(liczba_prob) AS p, MAX(zmieniono_at) AS z FROM oferty_kanalow').get();
    const przed = stan();
    for (let i = 0; i < 3; i++) expect((await get(wynikUrl([id]))).statusCode).toBe(200);
    expect(stan()).toEqual(przed);
    expect(wywolania(klienci[KONTO])).toEqual(['podgladOplat']);
  });

  it('przekierowanie niesie wszystkie karty z formularza, posortowane', async () => {
    const a = karta(1);
    const b = karta(2);
    const r = await podglad([b, a]);
    const w = await post('/magazyn/oferty/zatwierdz', decyzja(r, [b, a]));
    expect(w.statusCode).toBe(303);
    expect(w.headers.location).toBe(wynikUrl([a, b]));
    expect((await get(w.headers.location)).body).toContain('W kolejce do wysłania: 2.');
  });

  it('błędne parametry → 400; nie-admin → 403', async () => {
    const id = karta(1);
    const zbyt = Array.from({ length: 201 }, (_, i) => i + 1);
    for (const url of [
      `/magazyn/oferty/wynik?konto=${KONTO}&karty=abc`,
      `/magazyn/oferty/wynik?konto=${KONTO}&karty=1,,2`,
      `/magazyn/oferty/wynik?konto=${KONTO}`,
      wynikUrl(zbyt),
      wynikUrl([id], 'allegro_obce'),
      `/magazyn/oferty/wynik?karty=${id}`,
    ])
      expect((await get(url)).statusCode, url).toBe(400);
    expect((await get(wynikUrl(zbyt.slice(0, 200)))).statusCode).toBe(200);
    zalozKonto(db, { login: 'admin', imie: 'Admin', haslo: 'test', rola: 'admin', admin: true });
    const user = zalozKonto(db, { login: 'czytelnik', imie: 'Czytelnik', haslo: 'test', rola: 'operator' });
    ustawUprawnienia(db, user, ['magazyn']);
    const ciastko = (login) => ({
      origin: 'http://localhost',
      cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz(login, wczytajSekret(db), Date.now(), 0)}`,
    });
    expect((await get(wynikUrl([id]), ciastko('czytelnik'))).statusCode).toBe(403);
    expect((await get(wynikUrl([id]), ciastko('admin'))).statusCode).toBe(200);
  });

  it('podgląd nie mówi już o ilości z ustawień konta ani o etapie 4', async () => {
    const r = await podglad([karta(1)]);
    expect(r.body).not.toContain('Ilość w ofertach: stała');
    expect(r.body).not.toContain('etapie 4');
    expect(r.body).not.toContain('W kolejce:');
  });
});
