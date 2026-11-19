// Oferta, którą ktoś usunął w Allegro (problem `brak-w-allegro`), nie wisi na karcie na zawsze: admin usuwa jej
// zapis z OMS po potwierdzeniu. Klient Allegro to atrapa — żadna z tych tras nie woła kanału.
// Dane zmyślone: lampy „Pracownia Półcień”.
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { definicjeKanalowHistoryczne } from '../../pomoc/przykladowe-definicje-kanalow.js';
import { szyfrTestowy } from '../../pomoc/sejf-testowy.ts';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import {
  wstawOferte,
  zmienOferte,
  ofertaPoId,
  zapiszUstawieniaOfertKonta,
} from '../../../src/oms/db/oferty-kanalow.ts';
import { opisKategorii } from '../../../src/domena/tresc-oferty-allegro.js';
import { kategoriaAllegroDemo, parametryKategoriiAllegroDemo } from '../../../scripts/demo-dane-katalog.mjs';
import { ODMOWA_BRAK_W_ALLEGRO } from '../../../src/moduly/magazyn/oferty.js';
import { zalozKonto, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import slowniki from '../../fixtures/allegro/e3-dok-slowniki.json' with { type: 'json' };

const KONTO = 'allegro_swietlik';
const T0 = '2026-11-14T08:00:00.000Z';
const auth = {
  authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`,
  origin: 'http://localhost',
};
const jwt = (scope) => ['e30', Buffer.from(JSON.stringify({ scope })).toString('base64url'), 'podpis'].join('.');

let db, app, klient;
const post = (url, payload = {}, headers = auth) => app.inject({ method: 'POST', url, payload, headers });
const get = (url, headers = auth) => app.inject({ method: 'GET', url, headers });

/** Karta gotowa do wystawienia na Allegro (kategoria z mapy, reguły, marka, GPSR konta, 3 zdjęcia). */
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

const BRAK = [{ kod: 'brak-w-allegro', tekst: 'Allegro nie zwraca tej oferty — sprawdź ją w panelu Allegro.' }];
/** Oferta zarządzana z numerem Allegro w podanym stanie. */
function oferta(kartaId, numer, { stan = 'problem', problemy = BRAK, wyslanePola } = {}) {
  const o = wstawOferte(db, { kartaId, kanal: KONTO, idZewnetrzne: numer, tryb: 'zarzadzana', stan: 'wyslana' });
  return zmienOferte(db, o.id, { stan, problemy, ...(wyslanePola ? { wyslanePola } : {}) });
}

const ciastko = (login) => ({
  origin: 'http://localhost',
  cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz(login, wczytajSekret(db), Date.now(), 0)}`,
});
/** Admin i zwykły operator z dostępem do Magazynu — logowanie ciasteczkiem jak w panelu. */
function konta() {
  zalozKonto(db, { login: 'admin', imie: 'Admin', haslo: 'test', rola: 'admin', admin: true });
  const user = zalozKonto(db, { login: 'magazynier', imie: 'Magazynier', haslo: 'test', rola: 'operator' });
  ustawUprawnienia(db, user, ['magazyn']);
  return { admin: ciastko('admin'), magazynier: ciastko('magazynier') };
}

const PRZYCISK = (kartaId, ofertaId) => `href="/magazyn/${kartaId}?usun-oferte=${ofertaId}#potwierdz-usuniecie-oferty"`;
const AKCJA = (kartaId, ofertaId) => `action="/magazyn/${kartaId}/oferty/${ofertaId}/usun"`;
const ODMOWA_409 = 'Oferta jest w Allegro albo pętla jeszcze tego nie potwierdziła — nic nie usunięto.';

beforeEach(async () => {
  db = openOmsDb(':memory:');
  klient = {
    podgladOplat: vi.fn(async () => structuredClone(slowniki.podgladOplat)),
    utworzOferte: vi.fn(),
    zmienOferte: vi.fn(),
    zmienStatusOferty: vi.fn(),
    komendaIlosci: vi.fn(),
    komendaCeny: vi.fn(),
    pobierzOferte: vi.fn(),
    wgrajZdjecie: vi.fn(),
  };
  app = buildOmsServer({
    db,
    config: { auth: { user: 'operator', pass: 'atrapa' }, definicje: definicjeKanalowHistoryczne },
    magazyn: { stan: () => ({ trwa: false, kanaly: [] }) },
    nadpisania: {
      'kanaly.klienciKanalow': { [KONTO]: klient },
      'kanaly.repozytoriumKanalow': {
        listaTypu: (typ) =>
          typ === 'allegro'
            ? [{ klucz: KONTO, nazwa: 'Świetlik', autoryzacja: 'polaczone', srodowisko: 'produkcja' }]
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
    szyfrTestowy(
      db,
      'tokeny_kanalu',
      'access_token',
      KONTO,
      jwt(['allegro:api:sale:offers:write', 'allegro:api:sale:settings:read']),
    ),
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
    },
    { teraz: T0 },
  );
});
afterEach(async () => {
  await app.close();
  db.close();
});

describe('oferta usunięta w Allegro — „Usuń z OMS”', () => {
  it('odmowa przy ofercie, której nie ma w Allegro, kieruje do „Usuń z OMS”, nie do wycofania karty', () => {
    expect(ODMOWA_BRAK_W_ALLEGRO).toContain(
      'Sprawdź ją w panelu Allegro. Jeśli usunąłeś ją celowo, użyj „Usuń z OMS” — karta zostaje, a ofertę możesz wystawić od nowa.',
    );
    expect(ODMOWA_BRAK_W_ALLEGRO).not.toContain('wycofaj kartę ze sprzedaży');
  });

  it('przycisk widzi tylko admin: na karcie i na ekranie problemów; operator magazynu nie ma ani przycisku, ani potwierdzenia', async () => {
    const id = karta(1);
    const o = oferta(id, '7700123456');
    const { admin, magazynier } = konta();

    const kartaAdmina = await get(`/magazyn/${id}`, admin);
    expect(kartaAdmina.statusCode).toBe(200);
    expect(kartaAdmina.body).toContain(PRZYCISK(id, o.id));
    expect(kartaAdmina.body).toContain('Usuń z OMS');
    const problemy = await get('/magazyn/problemy-ofert', admin);
    expect(problemy.statusCode).toBe(200);
    expect(problemy.body).toContain(PRZYCISK(id, o.id));

    const kartaOperatora = await get(`/magazyn/${id}`, magazynier);
    expect(kartaOperatora.statusCode).toBe(200);
    expect(kartaOperatora.body).not.toContain('Usuń z OMS');
    const potwierdzenie = await get(`/magazyn/${id}?usun-oferte=${o.id}`, magazynier);
    expect(potwierdzenie.statusCode).toBe(200);
    expect(potwierdzenie.body).not.toContain(AKCJA(id, o.id));
  });

  it('potwierdzenie mówi, co zostaje, i ma „Usuń z OMS” (POST) oraz „Anuluj”', async () => {
    const id = karta(1);
    const o = oferta(id, '7700123456');
    const r = await get(`/magazyn/${id}?usun-oferte=${o.id}`);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('id="potwierdz-usuniecie-oferty"');
    expect(r.body).toContain(
      'Usunąć z OMS zapis oferty 7700123456 na koncie Świetlik? W Allegro tej oferty już nie ma. Karta, jej produkty w sklepach i inne oferty zostają. Po usunięciu możesz wystawić kartę na tym koncie od nowa.',
    );
    expect(r.body).toMatch(new RegExp(`<form method="post" ${AKCJA(id, o.id)}`));
    expect(r.body).toMatch(/<button type="submit" class="btn btn--groza">Usuń z OMS<\/button>/);
    expect(r.body).toMatch(new RegExp(`<a class="btn btn--cichy" href="/magazyn/${id}#produkty-karty">Anuluj</a>`));
    // GET tylko pokazuje pytanie — wiersz zostaje.
    expect(ofertaPoId(db, o.id)).not.toBeNull();
  });

  it('POST admina usuwa zapis, wpisuje go do dziennika zmian w kanałach i wraca na kartę z komunikatem; podgląd wystawiania nie odmawia już', async () => {
    const id = karta(1);
    const o = oferta(id, '7700123456');
    const inna = oferta(karta(2), '7700999888', { stan: 'aktywna', problemy: [] });
    const przed = await post('/magazyn/oferty/podglad', { konto: KONTO, zaznaczone: [id] });
    expect(przed.body).toContain('Karta ma już ofertę na tym koncie.');

    const r = await post(`/magazyn/${id}/oferty/${o.id}/usun`);
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe(`/magazyn/${id}?ok=oferta-usunieta&oferta=7700123456#produkty-karty`);
    expect(ofertaPoId(db, o.id)).toBeNull();
    expect(ofertaPoId(db, inna.id)).not.toBeNull();
    // Dziennik ma w bazie CHECK na `pole` (cena/status/steruj_cena), więc usunięcie to zmiana statusu
    // oferty na „usunięta z OMS” — bez migracji tabeli.
    const wpisy = db.prepare(`SELECT * FROM zmiany_w_kanalach`).all();
    expect(wpisy).toEqual([
      expect.objectContaining({
        kanal: KONTO,
        karta_id: id,
        cel: 'oferta:7700123456',
        pole: 'status',
        stara: 'problem',
        nowa: 'usunięta z OMS',
        kto: 'operator',
        wynik: 'ok',
      }),
    ]);

    const ekran = await get(r.headers.location);
    expect(ekran.statusCode).toBe(200);
    expect(ekran.body).toContain('<p class="pasek-info" role="status">Usunięto z OMS zapis oferty 7700123456.</p>');
    expect(ekran.body).not.toContain('Usuń z OMS');

    const po = await post('/magazyn/oferty/podglad', { konto: KONTO, zaznaczone: [id] });
    expect(po.statusCode).toBe(200);
    expect(po.body).not.toContain('Karta ma już ofertę na tym koncie.');
    expect(Object.values(klient).flatMap((f) => (f === klient.podgladOplat ? [] : f.mock.calls))).toEqual([]);
  });

  it('komunikat o usunięciu bierze się z dziennika, nie z samego adresu', async () => {
    const id = karta(1);
    const r = await get(`/magazyn/${id}?ok=oferta-usunieta&oferta=7700123456`);
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('Usunięto z OMS zapis oferty');
  });

  it('oferta aktywna, nieaktywna albo zakończona: brak przycisku, POST → 409 i wiersz zostaje', async () => {
    const zakonczona = [{ kod: 'zakonczona', tekst: 'Oferta zakończona w Allegro.', sztuk: 3 }];
    // Jedna oferta na konto na kartę — każdy stan na osobnej karcie.
    const oferty = [
      oferta(karta(1), '7700000001', { stan: 'aktywna', problemy: [] }),
      oferta(karta(2), '7700000002', { stan: 'nieaktywna', problemy: [], wyslanePola: { szkic: true } }),
      oferta(karta(3), '7700000003', { stan: 'problem', problemy: zakonczona }),
    ];
    for (const o of oferty) {
      const id = o.kartaId;
      const ekran = await get(`/magazyn/${id}`);
      expect(ekran.body, o.idZewnetrzne).not.toContain('Usuń z OMS');
      const potwierdzenie = await get(`/magazyn/${id}?usun-oferte=${o.id}`);
      expect(potwierdzenie.body, o.stan).not.toContain(AKCJA(id, o.id));
      const r = await post(`/magazyn/${id}/oferty/${o.id}/usun`);
      expect(r.statusCode, o.idZewnetrzne).toBe(409);
      expect(r.body).toContain(ODMOWA_409);
      expect(ofertaPoId(db, o.id), o.idZewnetrzne).toEqual(o);
    }
    expect(db.prepare(`SELECT COUNT(*) AS n FROM zmiany_w_kanalach`).get().n).toBe(0);
  });

  it('POST sprawdza stan na świeżym odczycie: oferta wróciła do Allegro po otwarciu potwierdzenia → 409', async () => {
    const id = karta(1);
    const o = oferta(id, '7700123456');
    expect((await get(`/magazyn/${id}?usun-oferte=${o.id}`)).body).toContain(AKCJA(id, o.id));
    const wrocila = zmienOferte(db, o.id, { stan: 'aktywna', problemy: [] });
    const r = await post(`/magazyn/${id}/oferty/${o.id}/usun`);
    expect(r.statusCode).toBe(409);
    expect(ofertaPoId(db, o.id)).toEqual(wrocila);
  });

  it('operator bez prawa admina → 403, oferta innej karty → 404; wiersz zostaje', async () => {
    const id = karta(1);
    const obca = karta(2);
    const o = oferta(id, '7700123456');
    const { admin, magazynier } = konta();
    const r403 = await post(`/magazyn/${id}/oferty/${o.id}/usun`, {}, magazynier);
    expect(r403.statusCode).toBe(403);
    const r404 = await post(`/magazyn/${obca}/oferty/${o.id}/usun`, {}, admin);
    expect(r404.statusCode).toBe(404);
    expect((await post(`/magazyn/${id}/oferty/999999/usun`, {}, admin)).statusCode).toBe(404);
    expect(ofertaPoId(db, o.id)).toEqual(o);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM zmiany_w_kanalach`).get().n).toBe(0);
  });
});
