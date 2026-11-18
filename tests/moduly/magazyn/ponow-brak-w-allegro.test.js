// „Ponów” przy problemie `brak-w-allegro` nie odtwarza oferty (bez POST —
// nowa oferta to opłaty i ryzyko duplikatu). Odmowa z tekstem; „Wycofaj ze sprzedaży” karty działa dalej.
// Wzór środowiska: problemy-ofert-petla.test.js.
// Atrapa ofert Allegro + prawdziwy rejestr kanałów i klient (środowisko jak w petla-ofert-allegro-pomiar.test.js).
// Żadnej sieci. Dane zmyślone: lampy „Pracownia Półcień”.
import { afterEach, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { ENV_DEMO } from '../../../scripts/demo-dane.mjs';
import { eanDemo, kategoriaAllegroDemo, parametryKategoriiAllegroDemo } from '../../../scripts/demo-dane-katalog.mjs';
import { opisKategorii } from '../../../src/domena/tresc-oferty-allegro.js';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { zapiszUstawieniaOfertKonta, wstawOferte, ofertaPoId } from '../../../src/oms/db/oferty-kanalow.ts';
import { znakInstalacji } from '../../../src/moduly/magazyn/services/oferty-wspolne.js';
import { createAllegroClient } from '../../../src/oms/allegro/client.js';
import { katalogAllegro, wezlyAllegro } from '../../../src/integracje/kanal-modul.ts';
import { createSerwerOfertAllegro, API_ATRAPY_ALLEGRO } from '../../../deploy/proba/atrapy/allegro-oferty.mjs';
import { fixtureAllegro, daneAllegro, aktorAllegro } from '../../pomoc/allegro-konfigurator.ts';
import { szyfrTestowy } from '../../pomoc/sejf-testowy.ts';
import { createRejestrKanalow } from '../../../src/moduly/kanaly/services/rejestr-kanalow.ts';
import { createPetlaOfertAllegro } from '../../../src/moduly/magazyn/services/petla-ofert-allegro.js';

import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';

const T0 = Date.parse('2026-11-01T12:00:00.000Z');
const BEZPIECZENSTWO = JSON.stringify({ typ: 'TEXT', tekst: 'Nie zostawiaj włączonej lampy bez nadzoru.' });
const MIN = 60_000;

const sprzatanie = [];
const aplikacje = [];
afterEach(async () => {
  for (const app of aplikacje.splice(0)) await app.close();
  for (const f of sprzatanie.splice(0)) f();
});

const zawies = (signal) =>
  new Promise((_r, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

/** Karta z kategorią z mapy, regułami, marką, GPSR konta, `n` zdjęciami i EAN demo (D34 → katalog-id). */
function karta(db, konto, { nazwa = 'Lampa stołowa Gliwka z kloszem', n = 2 } = {}) {
  const id = utworzKarte(
    db,
    {
      nazwa,
      cena_gr: 5900,
      stawka_vat: '23',
      marka: 'Pracownia Półcień',
      kategoria_glowna: 'Lampy stołowe',
      szerokosc_mm: 255,
      opis_sekcje_json: JSON.stringify({
        sekcje: [{ elementy: [{ typ: 'tekst', html: '<p>Lampa z mlecznym kloszem.</p>' }] }],
      }),
    },
    { at: new Date(T0).toISOString() },
  );
  db.prepare('UPDATE karty_produktow SET informacja_bezpieczenstwa = ?, ean = ? WHERE id = ?').run(
    BEZPIECZENSTWO,
    eanDemo(1),
    id,
  );
  const zdj =
    db.prepare(`INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, sha256, typ, ai, ai_reczne, utworzono_at)
    VALUES (?, ?, 'reczne', ?, NULL, 'image/jpeg', 0, 1, ?)`);
  for (let i = 0; i < n; i++)
    zdj.run(id, i, `https://polcien.example.invalid/gliwka-${id}-${i + 1}.jpg`, new Date(T0).toISOString());
  // Opis kategorii 257 (wersja 2) w pamięci konta — ten sam zapis, co `opisKategoriiAllegro` po pobraniu.
  const opis = opisKategorii(['5', '256', '257'].map(kategoriaAllegroDemo), parametryKategoriiAllegroDemo('257'));
  db.prepare(
    `INSERT OR IGNORE INTO kanaly_kategorie (polaczenie, kategoria_id, sciezka_json, parametry_json, pobrano_at) VALUES (?, '257', ?, ?, ?)`,
  ).run(
    konto,
    JSON.stringify(opis.sciezka),
    JSON.stringify({
      wersja: opis.wersja,
      lisc: opis.lisc,
      tworzenieProduktu: opis.tworzenieProduktu,
      parametry: opis.parametry,
    }),
    new Date(T0).toISOString(),
  );
  db.prepare(
    `INSERT OR IGNORE INTO allegro_mapa_kategorii (kategoria_karty, srodowisko, kategoria_allegro_id) VALUES ('Lampy stołowe', 'produkcja', '257')`,
  ).run();
  const regula =
    db.prepare(`INSERT OR IGNORE INTO allegro_reguly_parametrow (srodowisko, kategoria_allegro_id, parametr_id, rodzaj,
    wartosc_json, pole, zmieniono_at) VALUES ('produkcja', '257', ?, ?, ?, ?, ?)`);
  regula.run('11323', 'stala', JSON.stringify({ valuesIds: ['11323_1'] }), null, new Date(T0).toISOString());
  regula.run('248811', 'pole', null, 'marka', new Date(T0).toISOString());
  db.prepare(
    `INSERT OR IGNORE INTO allegro_marki (marka, srodowisko, parametr_id, wartosc_id, kategorie_sprawdzone_json, zmieniono_at)
    VALUES ('Pracownia Półcień', 'produkcja', '248811', '248811_9001', '["257"]', ?)`,
  ).run(new Date(T0).toISOString());
  db.prepare(
    `INSERT OR IGNORE INTO allegro_marki_gpsr (marka, konto, zrodlo, zmieniono_at) VALUES ('Pracownia Półcień', ?, 'konto', ?)`,
  ).run(konto, new Date(T0).toISOString());
  const wiersz = wstawOferte(
    db,
    {
      kartaId: id,
      kanal: konto,
      idZewnetrzne: `ext:${znakInstalacji(db)}-K${id}`,
      tryb: 'zarzadzana',
      stan: 'do_wyslania',
    },
    { teraz: new Date(T0).toISOString() },
  );
  return { kartaId: id, ofertaId: wiersz.id };
}

/** Atrapa + prawdziwy rejestr kanałów + prawdziwy klient + baza OMS. `awaria(metoda, sciezka)` wstrzykuje usterki. */
function srodowisko({ ustawienia = {}, zgoda = true, tylkoOdczyt = () => false } = {}) {
  let czas = T0;
  const teraz = () => new Date(czas);
  const f = fixtureAllegro();
  const s = f.szkic();
  const k = daneAllegro(
    f.repo.zapiszZmiane(s.klucz, s.wersja, { autoryzacja: 'polaczone', kontoId: '123' }, aktorAllegro),
  );
  const KONTO = k.klucz;
  const dbAtrapy = new DatabaseSync(':memory:');
  const serwer = createSerwerOfertAllegro({ db: dbAtrapy, kanal: KONTO, env: ENV_DEMO, teraz });
  const zdarzenia = [];
  const ciala = [];
  const st = { awaria: null };
  async function fetchImpl(url, init = {}) {
    const metoda = String(init.method ?? 'GET').toUpperCase();
    const adres = new URL(url);
    const sciezka = adres.pathname;
    zdarzenia.push(`${metoda} ${sciezka}`);
    if (typeof init.body === 'string') {
      try {
        ciala.push({ zdarzenie: `${metoda} ${sciezka}`, cialo: JSON.parse(init.body) });
      } catch {
        /* ciało nie-JSON */
      }
    }
    const a = st.awaria?.(metoda, sciezka, adres);
    if (a === 'zgubiona-odpowiedz') {
      await serwer.fetchImpl(url, init);
      return zawies(init.signal);
    }
    if (a === 'bez-dotarcia') return zawies(init.signal);
    if (a instanceof Response) return a;
    return serwer.fetchImpl(url, init);
  }
  const rejestr = createRejestrKanalow({
    repozytorium: f.repo,
    fetchImpl,
    limitCzasuMs: 200,
    teraz,
    fabryki: ({ http }) => ({
      klient: createAllegroClient({
        ustawienia: { api: API_ATRAPY_ALLEGRO, userAgent: 'test/1 (+https://x.invalid)' },
        tokeny: { waznyToken: async () => 'token-atrapy-e308a' },
        http,
      }),
      poller: { stan: () => null, przebieg: async () => {} },
    }),
  });
  const klient = rejestr.klient(KONTO);
  const db = openOmsDb(':memory:', { moduly: modulyDla(ENV_DEMO) });
  sprzatanie.push(() => {
    db.close();
    dbAtrapy.close();
    f.db.close();
  });
  zapiszUstawieniaOfertKonta(
    db,
    KONTO,
    {
      czynne: true,
      aktywujPoSprawdzeniu: true,
      narzutProcent: 0,
      stalaIlosc: 5,
      czasWysylkiDni: 2,
      cennikDostaw: 'cennik-1',
      stawkaVat: '23',
      zwrotyId: 'zwrot-1',
      reklamacjeId: 'rekl-1',
      producentId: 'prod-konta',
      ...ustawienia,
    },
    { teraz: new Date(T0).toISOString() },
  );
  const konto = {
    klucz: KONTO,
    nazwa: 'Półcień Allegro',
    srodowisko: 'produkcja',
    zgoda,
    tylkoOdczyt,
    katalog: katalogAllegro(klient),
    allegro: wezlyAllegro(klient),
  };
  const petla = () =>
    createPetlaOfertAllegro({
      db,
      konta: () => [konto],
      teraz,
      zwolnijOperacje: (klucz, metoda, zasob) => f.repo.zwolnijOperacje(klucz, metoda, zasob),
      czytajZdjecie: async (z) => new Uint8Array([7, z.id, z.kolejnosc + 1]),
    });
  const przesun = (ms) => {
    czas += ms;
    f.setCzas(new Date(czas).toISOString());
  };
  const ile = (wzor) => zdarzenia.filter((z) => wzor.test(z)).length;
  const ofertyAtrapy = (ext) =>
    dbAtrapy
      .prepare('SELECT dane_json FROM atrapa_allegro_oferty WHERE kanal = ?')
      .all(KONTO)
      .map((w) => JSON.parse(w.dane_json))
      .filter((o) => o.external?.id === ext);
  const wstawDoAtrapy = (o) =>
    dbAtrapy
      .prepare('INSERT INTO atrapa_allegro_oferty (kanal, id, dane_json) VALUES (?, ?, ?)')
      .run(KONTO, String(o.id), JSON.stringify(o));
  const ofertaWAtrapie = (id) =>
    JSON.parse(
      dbAtrapy.prepare('SELECT dane_json FROM atrapa_allegro_oferty WHERE kanal = ? AND id = ?').get(KONTO, String(id))
        .dane_json,
    );
  const zmienWAtrapie = (id, f) =>
    dbAtrapy
      .prepare('UPDATE atrapa_allegro_oferty SET dane_json = ? WHERE kanal = ? AND id = ?')
      .run(JSON.stringify(f(ofertaWAtrapie(id))), KONTO, String(id));
  return {
    db,
    f,
    klient,
    KONTO,
    st,
    zdarzenia,
    ciala,
    petla,
    przesun,
    ile,
    ofertyAtrapy,
    wstawDoAtrapy,
    ofertaWAtrapie,
    zmienWAtrapie,
    teraz,
    konto,
  };
}

/** Przebiegi co `krok` aż do stanu końcowego (najwyżej `n`). */
async function doKonca(e, p, ofertaId, { krok = 6000, n = 8 } = {}) {
  for (let i = 0; i < n && ['do_wyslania', 'wyslana', 'sprawdzana'].includes(ofertaPoId(e.db, ofertaId).stan); i++) {
    e.przesun(krok);
    await p.przebieg();
  }
  return ofertaPoId(e.db, ofertaId);
}

const ZAPISY = /^(POST|PUT|PATCH) \/sale\//;
const NOWA_OFERTA = /^POST \/sale\/product-offers$/;
const przebieg = async (e, p, ms = MIN) => {
  e.przesun(ms);
  await p.przebieg();
};
const auth = {
  authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`,
  origin: 'http://localhost',
};
const pustaLista = (m, s) =>
  m === 'GET' && s === '/sale/offers'
    ? new Response(JSON.stringify({ offers: [], count: 0, totalCount: 0 }), { status: 200 })
    : null;

async function ekran(e) {
  const konto = { klucz: e.KONTO, nazwa: 'Półcień', autoryzacja: 'polaczone', srodowisko: 'produkcja' };
  const app = buildOmsServer({
    db: e.db,
    config: {
      auth: { user: 'operator', pass: 'atrapa' },
      definicje: [{ klucz: e.KONTO, typ: 'allegro', prefiks: 'TEST_POLCIEN', etykieta: 'Półcień' }],
    },
    magazyn: { stan: () => ({ trwa: false, kanaly: [] }) },
    nadpisania: {
      'kanaly.klienciKanalow': { [e.KONTO]: e.klient },
      'kanaly.repozytoriumKanalow': {
        listaTypu: (typ) => (typ === 'allegro' ? [konto] : []),
        zapisyZablokowane: () => false,
        konfliktKlucza: () => false,
      },
    },
  });
  aplikacje.push(app);
  await app.ready();
  const scope = ['allegro:api:sale:offers:write', 'allegro:api:sale:settings:read'];
  const token = ['e30', Buffer.from(JSON.stringify({ scope })).toString('base64url'), 'podpis'].join('.');
  e.db
    .prepare(
      `INSERT INTO tokeny_kanalu (kanal, access_token, refresh_token, wygasa_at, zaktualizowane_at)
    VALUES (?, ?, ?, '2027-01-01T00:00:00Z', '2026-11-01T00:00:00Z')`,
    )
    .run(
      e.KONTO,
      szyfrTestowy(e.db, 'tokeny_kanalu', 'access_token', e.KONTO, token),
      szyfrTestowy(e.db, 'tokeny_kanalu', 'refresh_token', e.KONTO, 'REFRESH-ATRAPA'),
    );
  return {
    get: (url) => app.inject({ method: 'GET', url, headers: auth }),
    post: (url, payload = {}) => app.inject({ method: 'POST', url, payload, headers: auth }),
  };
}
const wiersz = (r, id) => new RegExp(`<tr[^>]*id="oferta-${id}"[^>]*>([\\s\\S]*?)</tr>`).exec(r.body)?.[1];
const ODMOWA = /Oferty nie ma już w Allegro/;

it('E4.22: brak-w-allegro → Ponów (ekran problemów i karta) odmawia 409 z tekstem, wiersz bez zmian, 0 POST; Wycofaj działa', async () => {
  const e = srodowisko();
  const { kartaId, ofertaId } = karta(e.db, e.KONTO);
  const p = e.petla();
  expect((await doKonca(e, p, ofertaId)).stan).toBe('aktywna');
  await przebieg(e, p);
  e.st.awaria = pustaLista;
  await przebieg(e, p);
  const przed = ofertaPoId(e.db, ofertaId);
  expect(przed).toMatchObject({ stan: 'problem', problemy: [{ kod: 'brak-w-allegro' }] });

  const web = await ekran(e);
  const lista = await web.get('/magazyn/problemy-ofert');
  expect(lista.statusCode).toBe(200);
  expect(wiersz(lista, ofertaId)).toMatch(ODMOWA);
  expect(wiersz(lista, ofertaId)).not.toContain(`/${ofertaId}/ponow`);
  const ekranKarty = await web.get(`/magazyn/${kartaId}`);
  expect(ekranKarty.statusCode).toBe(200);
  expect(ekranKarty.body).toMatch(ODMOWA);
  expect(ekranKarty.body).not.toContain(`/oferty/${ofertaId}/ponow`);
  expect(ekranKarty.body).toContain(`/magazyn/${kartaId}?wycofaj=tak`);

  const zdarzeniaPrzed = e.zdarzenia.length;
  for (const url of [`/magazyn/problemy-ofert/${ofertaId}/ponow`, `/magazyn/${kartaId}/oferty/${ofertaId}/ponow`]) {
    const r = await web.post(url);
    expect(r.statusCode, url).toBe(409);
    expect(r.body, url).toMatch(ODMOWA);
  }
  expect(ofertaPoId(e.db, ofertaId)).toEqual(przed);
  for (let i = 0; i < 3; i++) await przebieg(e, p, 20 * MIN);
  const po = e.zdarzenia.slice(zdarzeniaPrzed);
  expect(po.filter((z) => NOWA_OFERTA.test(z))).toEqual([]);
  expect(po.filter((z) => ZAPISY.test(z))).toEqual([]);
  expect(ofertaPoId(e.db, ofertaId)).toMatchObject({ stan: 'problem', problemy: [{ kod: 'brak-w-allegro' }] });

  // „Wycofaj ze sprzedaży” (istniejąca akcja karty) działa: karta wycofana, pętla nadal nic nie wysyła.
  const w = await web.post(`/magazyn/${kartaId}/wycofaj`, { potwierdz: 'tak' });
  expect(w.statusCode).toBe(303);
  expect(e.db.prepare('SELECT wycofana FROM karty_produktow WHERE id = ?').get(kartaId).wycofana).toBe(1);
  await przebieg(e, p, 20 * MIN);
  expect(e.zdarzenia.slice(zdarzeniaPrzed).filter((z) => ZAPISY.test(z))).toEqual([]);
});
