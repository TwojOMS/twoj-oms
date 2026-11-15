// PRZ-160 E4.25 — N2: odrzucona treść (4xx na PATCH) ma limit prób i nie wstrzymuje komend ilości;
// N8: odzysk D31 porównuje nazwy po zdjęciu encji HTML (lista ofert Allegro oddaje „&amp;”).
// Szkielet środowiska: odbior-e3c-petla-prz160e3.test.js (atrapa ofert Allegro + prawdziwy rejestr i klient).
// Żadnej sieci. Dane zmyślone: lampy „Pracownia Półcień”.
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { ENV_DEMO } from '../../../scripts/demo-dane.mjs';
import { eanDemo, kategoriaAllegroDemo, parametryKategoriiAllegroDemo } from '../../../scripts/demo-dane-katalog.mjs';
import { opisKategorii } from '../../../src/domena/tresc-oferty-allegro.js';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { zapiszUstawieniaOfertKonta, wstawOferte, ofertaPoId, zmienOferte, ofertyDoDecyzji } from '../../../src/oms/db/oferty-kanalow.ts';
import { zmianyPonowienia } from '../../../src/moduly/magazyn/oferty.js';
import { znakInstalacji } from '../../../src/moduly/magazyn/services/oferty-wspolne.js';
import { createAllegroClient } from '../../../src/oms/allegro/client.js';
import { katalogAllegro, wezlyAllegro } from '../../../src/integracje/kanal-modul.ts';
import { createSerwerOfertAllegro, API_ATRAPY_ALLEGRO } from '../../../deploy/proba/atrapy/allegro-oferty.mjs';
import { fixtureAllegro, daneAllegro, aktorAllegro } from '../../pomoc/allegro-konfigurator.ts';
import { createRejestrKanalow } from '../../../src/moduly/kanaly/services/rejestr-kanalow.ts';
import { createPetlaOfertAllegro } from '../../../src/moduly/magazyn/services/petla-ofert-allegro.js';

const T0 = Date.parse('2026-11-01T12:00:00.000Z');
const BEZPIECZENSTWO = JSON.stringify({ typ: 'TEXT', tekst: 'Nie zostawiaj włączonej lampy bez nadzoru.' });
const MIN = 60_000;

const sprzatanie = [];
afterEach(() => { for (const f of sprzatanie.splice(0)) f(); });

const zawies = (signal) => new Promise((_r, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
});

/** Karta z kategorią z mapy, regułami, marką, GPSR konta, `n` zdjęciami i EAN demo (D34 → katalog-id). */
function karta(db, konto, { nazwa = 'Lampa stołowa Gliwka z kloszem', n = 2 } = {}) {
  const id = utworzKarte(db, { nazwa, cena_gr: 5900, stawka_vat: '23', marka: 'Pracownia Półcień',
    kategoria_glowna: 'Lampy stołowe', szerokosc_mm: 255,
    opis_sekcje_json: JSON.stringify({ sekcje: [{ elementy: [{ typ: 'tekst', html: '<p>Lampa z mlecznym kloszem.</p>' }] }] }) },
  { at: new Date(T0).toISOString() });
  db.prepare('UPDATE karty_produktow SET informacja_bezpieczenstwa = ?, ean = ? WHERE id = ?').run(BEZPIECZENSTWO, eanDemo(1), id);
  const zdj = db.prepare(`INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, sha256, typ, ai, ai_reczne, utworzono_at)
    VALUES (?, ?, 'reczne', ?, NULL, 'image/jpeg', 0, 1, ?)`);
  for (let i = 0; i < n; i++) zdj.run(id, i, `https://polcien.example.invalid/gliwka-${id}-${i + 1}.jpg`, new Date(T0).toISOString());
  // Opis kategorii 257 (wersja 2) w pamięci konta — ten sam zapis, co `opisKategoriiAllegro` po pobraniu.
  const opis = opisKategorii(['5', '256', '257'].map(kategoriaAllegroDemo), parametryKategoriiAllegroDemo('257'));
  db.prepare(`INSERT OR IGNORE INTO kanaly_kategorie (polaczenie, kategoria_id, sciezka_json, parametry_json, pobrano_at) VALUES (?, '257', ?, ?, ?)`)
    .run(konto, JSON.stringify(opis.sciezka), JSON.stringify({ wersja: opis.wersja, lisc: opis.lisc, tworzenieProduktu: opis.tworzenieProduktu, parametry: opis.parametry }), new Date(T0).toISOString());
  db.prepare(`INSERT OR IGNORE INTO allegro_mapa_kategorii (kategoria_karty, srodowisko, kategoria_allegro_id) VALUES ('Lampy stołowe', 'produkcja', '257')`).run();
  const regula = db.prepare(`INSERT OR IGNORE INTO allegro_reguly_parametrow (srodowisko, kategoria_allegro_id, parametr_id, rodzaj,
    wartosc_json, pole, zmieniono_at) VALUES ('produkcja', '257', ?, ?, ?, ?, ?)`);
  regula.run('11323', 'stala', JSON.stringify({ valuesIds: ['11323_1'] }), null, new Date(T0).toISOString());
  regula.run('248811', 'pole', null, 'marka', new Date(T0).toISOString());
  db.prepare(`INSERT OR IGNORE INTO allegro_marki (marka, srodowisko, parametr_id, wartosc_id, kategorie_sprawdzone_json, zmieniono_at)
    VALUES ('Pracownia Półcień', 'produkcja', '248811', '248811_9001', '["257"]', ?)`).run(new Date(T0).toISOString());
  db.prepare(`INSERT OR IGNORE INTO allegro_marki_gpsr (marka, konto, zrodlo, zmieniono_at) VALUES ('Pracownia Półcień', ?, 'konto', ?)`)
    .run(konto, new Date(T0).toISOString());
  const wiersz = wstawOferte(db, { kartaId: id, kanal: konto, idZewnetrzne: `ext:${znakInstalacji(db)}-K${id}`, tryb: 'zarzadzana', stan: 'do_wyslania' },
    { teraz: new Date(T0).toISOString() });
  return { kartaId: id, ofertaId: wiersz.id };
}

/** Atrapa + prawdziwy rejestr kanałów + prawdziwy klient + baza OMS. `awaria(metoda, sciezka)` wstrzykuje usterki. */
function srodowisko({ ustawienia = {}, zgoda = true, tylkoOdczyt = () => false } = {}) {
  let czas = T0;
  const teraz = () => new Date(czas);
  const f = fixtureAllegro();
  const s = f.szkic();
  const k = daneAllegro(f.repo.zapiszZmiane(s.klucz, s.wersja, { autoryzacja: 'polaczone', kontoId: '123' }, aktorAllegro));
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
      try { ciala.push({ zdarzenie: `${metoda} ${sciezka}`, cialo: JSON.parse(init.body) }); } catch { /* ciało nie-JSON */ }
    }
    const a = st.awaria?.(metoda, sciezka, adres);
    if (a === 'zgubiona-odpowiedz') { await serwer.fetchImpl(url, init); return zawies(init.signal); }
    if (a === 'bez-dotarcia') return zawies(init.signal);
    if (a instanceof Response) return a;
    return serwer.fetchImpl(url, init);
  }
  const rejestr = createRejestrKanalow({ repozytorium: f.repo, fetchImpl, limitCzasuMs: 200, teraz,
    fabryki: ({ http }) => ({
      klient: createAllegroClient({ ustawienia: { api: API_ATRAPY_ALLEGRO, userAgent: 'test/1 (+https://x.invalid)' },
        tokeny: { waznyToken: async () => 'token-atrapy-e308a' }, http }),
      poller: { stan: () => null, przebieg: async () => {} },
    }) });
  const klient = rejestr.klient(KONTO);
  const db = openOmsDb(':memory:', { moduly: modulyDla(ENV_DEMO) });
  sprzatanie.push(() => { db.close(); dbAtrapy.close(); f.db.close(); });
  zapiszUstawieniaOfertKonta(db, KONTO, { czynne: true, aktywujPoSprawdzeniu: true, narzutProcent: 0, stalaIlosc: 5,
    czasWysylkiDni: 2, cennikDostaw: 'cennik-1', stawkaVat: '23', zwrotyId: 'zwrot-1', reklamacjeId: 'rekl-1',
    producentId: 'prod-konta', ...ustawienia }, { teraz: new Date(T0).toISOString() });
  const konto = { klucz: KONTO, nazwa: 'Półcień Allegro', srodowisko: 'produkcja', zgoda, tylkoOdczyt,
    katalog: katalogAllegro(klient), allegro: { ...wezlyAllegro(klient) } };
  const petla = () => createPetlaOfertAllegro({ db, konta: () => [konto], teraz,
    zwolnijOperacje: (klucz, metoda, zasob) => f.repo.zwolnijOperacje(klucz, metoda, zasob),
    czytajZdjecie: async (z) => new Uint8Array([7, z.id, z.kolejnosc + 1]) });
  const przesun = (ms) => { czas += ms; f.setCzas(new Date(czas).toISOString()); };
  const ile = (wzor) => zdarzenia.filter((z) => wzor.test(z)).length;
  const ofertyAtrapy = (ext) => dbAtrapy.prepare('SELECT dane_json FROM atrapa_allegro_oferty WHERE kanal = ?').all(KONTO)
    .map((w) => JSON.parse(w.dane_json)).filter((o) => o.external?.id === ext);
  const wstawDoAtrapy = (o) => dbAtrapy.prepare('INSERT INTO atrapa_allegro_oferty (kanal, id, dane_json) VALUES (?, ?, ?)')
    .run(KONTO, String(o.id), JSON.stringify(o));
  const ofertaWAtrapie = (id) => JSON.parse(dbAtrapy.prepare('SELECT dane_json FROM atrapa_allegro_oferty WHERE kanal = ? AND id = ?')
    .get(KONTO, String(id)).dane_json);
  const zmienWAtrapie = (id, f) => dbAtrapy.prepare('UPDATE atrapa_allegro_oferty SET dane_json = ? WHERE kanal = ? AND id = ?')
    .run(JSON.stringify(f(ofertaWAtrapie(id))), KONTO, String(id));
  return { db, f, KONTO, st, zdarzenia, ciala, petla, przesun, ile, ofertyAtrapy, wstawDoAtrapy, ofertaWAtrapie, zmienWAtrapie, teraz, konto };
}

const odczytaj = (e, k) => ofertaPoId(e.db, k.ofertaId);
const wycofaj = (e, k) => e.db.prepare('UPDATE karty_produktow SET wycofana = 1 WHERE id = ?').run(k.kartaId);
const patche = e => e.ciala.filter(x => x.zdarzenie.startsWith('PATCH /sale/product-offers/')).map(x => x.cialo);
async function krok(e, ms = MIN) { e.przesun(ms); await e.petla().przebieg(); }
async function czynna(e) {
  const k = karta(e.db, e.KONTO);
  for (let i = 0; i < 10 && odczytaj(e, k).stan !== 'aktywna'; i++) await krok(e);
  expect(odczytaj(e, k).stan).toBe('aktywna');
  e.ciala.length = 0;
  return k;
}
function sprawdzana(e, k, etap = 'tresc') {
  zmienOferte(e.db, k.ofertaId, { stan: 'sprawdzana', nastepnaProbaAt: null,
    wyslanePola: { ...odczytaj(e, k).wyslanePola, etap, operacja: '/operacja-testowa', operacjaOd: e.teraz().toISOString() } });
}


const DOBA = 24 * 3600 * 1000;
const json = (status, cialo) => new Response(JSON.stringify(cialo), { status, headers: { 'Content-Type': 'application/json' } });
const ODMOWA = { errors: [{ code: 'IllegalOfferUpdateException', message: 'Opis zawiera niedozwolony znacznik.',
  userMessage: 'Opis zawiera niedozwolony znacznik.' }] };
const trescPatche = (e) => patche(e).filter((x) => x.name);
const komendyIlosci = (e) => e.ciala.filter((x) => x.zdarzenie.startsWith('PUT /sale/offer-quantity-change-commands/')).length;
/** Allegro odrzuca każdy PATCH treści (z nazwą) od razu 422 — inne PATCH przechodzą. Ciało jest już w `e.ciala`. */
const odrzucajTresc = (e) => {
  e.st.awaria = (m, s) => (m === 'PATCH' && s.startsWith('/sale/product-offers/') && e.ciala.at(-1)?.cialo?.name ? json(422, ODMOWA) : null);
};
/** Sprzedaż w Allegro: odczyt ilości inny niż stała ilość konta (5) → komenda ilości. */
const sprzedaz = (e, k, n) => e.zmienWAtrapie(odczytaj(e, k).idZewnetrzne, (o) => ({ ...o, stock: { ...o.stock, available: n } }));
const zmienNazwe = (e, k, nazwa) => e.db.prepare('UPDATE karty_produktow SET nazwa = ? WHERE id = ?').run(nazwa, k.kartaId);

/** Czynna oferta, nowa treść karty, Allegro odrzuca ją 422 aż do limitu. */
async function poLimicie(e) {
  const k = await czynna(e);
  zmienNazwe(e, k, 'Lampa stołowa Gliwka z mlecznym kloszem');
  odrzucajTresc(e);
  for (let i = 0; i < 12; i++) await krok(e, DOBA);
  return k;
}

describe('E4.25 N2 — treść odrzucona od razu (4xx na PATCH)', () => {
  it('przerwa po 4xx treści nie wstrzymuje komendy ilości i nie rusza licznika komend', async () => {
    const e = srodowisko(); const k = await czynna(e);
    zmienNazwe(e, k, 'Lampa stołowa Gliwka z mlecznym kloszem');
    odrzucajTresc(e);
    await krok(e);
    expect(trescPatche(e)).toHaveLength(1);
    expect(odczytaj(e, k)).toMatchObject({ liczbaProb: 0, nastepnaProbaAt: null, blad: expect.stringContaining('niedozwolony znacznik') });
    sprzedaz(e, k, 1);
    await krok(e, 1000);
    expect(komendyIlosci(e)).toBe(1);
    expect(trescPatche(e)).toHaveLength(1);
  });

  it('4xx treści 5 razy → problem „odczyt”, bez kolejnych PATCH; komenda ilości dalej idzie', async () => {
    const e = srodowisko();
    const k = await poLimicie(e);
    expect(trescPatche(e)).toHaveLength(5);
    const o = odczytaj(e, k);
    expect(o.stan).toBe('problem');
    expect(o.problemy).toMatchObject([{ kod: 'odczyt', tekst: expect.stringContaining('5 razy odrzuciło zmianę treści') }]);
    expect(o.problemy[0].tekst).toContain('niedozwolony znacznik');
    expect(o.nastepnaProbaAt).toBeNull();
    const przed = komendyIlosci(e);
    sprzedaz(e, k, 2);
    await krok(e, 1000);
    expect(komendyIlosci(e)).toBe(przed + 1);
    for (let i = 0; i < 3; i++) await krok(e, DOBA);
    expect(trescPatche(e)).toHaveLength(5);
  });

  it('po limicie nowa treść karty dostaje pełny limit, a przyjęta zdejmuje problem', async () => {
    const e = srodowisko();
    const k = await poLimicie(e);
    zmienNazwe(e, k, 'Lampa stołowa Gliwka z kloszem opal');
    await krok(e);
    expect(trescPatche(e)).toHaveLength(6);
    expect(odczytaj(e, k).wyslanePola.probyOdczytu).toBe(1);
    e.st.awaria = null;
    await krok(e, DOBA);
    expect(trescPatche(e)).toHaveLength(7);
    expect(odczytaj(e, k)).toMatchObject({ stan: 'aktywna', problemy: [], blad: null });
    expect(odczytaj(e, k).wyslanePola.probyOdczytu).toBeUndefined();
  });

  it('po limicie nowa treść karty przyjęta od razu zdejmuje problem „odczyt”', async () => {
    const e = srodowisko();
    const k = await poLimicie(e);
    zmienNazwe(e, k, 'Lampa stołowa Gliwka z kloszem opal');
    e.st.awaria = null;
    await krok(e);
    expect(trescPatche(e)).toHaveLength(6);
    expect(odczytaj(e, k)).toMatchObject({ stan: 'aktywna', problemy: [], blad: null });
  });
});
describe('E4.26 N2/N3 — licznik odrzuconej treści', () => {
  it('N2: treść A odrzucona 3×, potem treść B 2× → brak problemu; B 5× → problem', async () => {
    const e = srodowisko(); const k = await czynna(e);
    zmienNazwe(e, k, 'Lampa stołowa Gliwka A');
    odrzucajTresc(e);
    for (let i = 0; i < 3; i++) await krok(e, DOBA);
    expect(trescPatche(e)).toHaveLength(3);
    zmienNazwe(e, k, 'Lampa stołowa Gliwka B');
    for (let i = 0; i < 2; i++) await krok(e, DOBA);
    expect(trescPatche(e)).toHaveLength(5);
    expect(odczytaj(e, k).wyslanePola.probyOdczytu).toBe(2);
    expect((odczytaj(e, k).problemy ?? []).map((x) => x.kod)).not.toContain('odczyt');
    for (let i = 0; i < 5; i++) await krok(e, DOBA);
    expect(trescPatche(e)).toHaveLength(8);
    expect(odczytaj(e, k).problemy).toMatchObject([{ kod: 'odczyt', tekst: expect.stringContaining('5 razy odrzuciło') }]);
  });

  it('N2: po limicie nowa treść odrzucona raz zdejmuje stary problem „5 razy”', async () => {
    const e = srodowisko();
    const k = await poLimicie(e);
    zmienNazwe(e, k, 'Lampa stołowa Gliwka z kloszem opal');
    await krok(e);
    expect(trescPatche(e)).toHaveLength(6);
    expect(odczytaj(e, k).wyslanePola.probyOdczytu).toBe(1);
    expect((odczytaj(e, k).problemy ?? []).map((x) => x.kod)).not.toContain('odczyt');
  });

  it('N2: wiersz po limicie sprzed E4.26 (bez skrótu odrzuconej) — nowa treść dalej liczy od 1', async () => {
    const e = srodowisko();
    const k = await poLimicie(e);
    const { skrotOdrzuconej: _s, ...bezSkrotu } = odczytaj(e, k).wyslanePola;
    zmienOferte(e.db, k.ofertaId, { wyslanePola: bezSkrotu });
    zmienNazwe(e, k, 'Lampa stołowa Gliwka z kloszem opal');
    await krok(e);
    expect(trescPatche(e)).toHaveLength(6);
    expect(odczytaj(e, k).wyslanePola.probyOdczytu).toBe(1);
  });

  it('N3: 401 na PATCH treści 6× → bez problemu „odczyt”, licznik treści 0', async () => {
    const e = srodowisko(); const k = await czynna(e);
    zmienNazwe(e, k, 'Lampa stołowa Gliwka z mlecznym kloszem');
    e.st.awaria = (m, s) => (m === 'PATCH' && s.startsWith('/sale/product-offers/') && e.ciala.at(-1)?.cialo?.name
      ? json(401, { errors: [{ code: 'Unauthorized', message: 'Token wygasł.', userMessage: 'Token wygasł.' }] }) : null);
    for (let i = 0; i < 6; i++) await krok(e, DOBA);
    expect(trescPatche(e)).toHaveLength(6);
    const o = odczytaj(e, k);
    expect((o.problemy ?? []).map((x) => x.kod)).not.toContain('odczyt');
    expect(o.wyslanePola.probyOdczytu ?? 0).toBe(0);
  });
  it('N3: 401 przy odczycie operacji treści po 4 odrzuceniach → bez „Popraw kartę”, treść pójdzie ponownie', async () => {
    const e = srodowisko(); const k = await czynna(e);
    sprawdzana(e, k, 'tresc');
    zmienOferte(e.db, k.ofertaId, { wyslanePola: { ...odczytaj(e, k).wyslanePola, probyOdczytu: 4 } });
    e.konto.allegro.stanOperacji = async () => { throw Object.assign(new Error('Token wygasł.'), { status: 401 }); };
    await krok(e);
    const o = odczytaj(e, k);
    expect(o.problemy.map((x) => x.tekst).join(' ')).not.toMatch(/odrzuciło zmianę treści|Popraw kartę/);
    expect(o.wyslanySkrot).toBeNull();
    expect(o.wyslanePola.odczytPo).not.toBeNull();
  });
});
describe('E4.25 N8 — odzysk D31 a encje w nazwie', () => {
  it('lista ofert oddaje „&amp;” w nazwie → odzysk znajduje własną ofertę, bez drugiego POST', async () => {
    const e = srodowisko();
    const k = karta(e.db, e.KONTO, { nazwa: 'Lampa Gliwka & klosz opal' });
    let raz = true;
    e.st.awaria = (m, s) => {
      if (m === 'POST' && s === '/sale/product-offers' && raz) { raz = false; return 'zgubiona-odpowiedz'; }
      if (m === 'GET' && s === '/sale/offers') {
        // Zmyślona odpowiedź listy ofert po sygnaturze: nazwa zakodowana encjami jak w Allegro.
        const ext = odczytaj(e, k).wyslanePola.externalId;
        const offers = e.ofertyAtrapy(ext).map((o) => ({ ...o, name: o.name.replaceAll('&', '&amp;') }));
        return json(200, { offers, count: offers.length, totalCount: offers.length });
      }
      return null;
    };
    await krok(e);
    expect(odczytaj(e, k).stan).toBe('wyslana');
    expect(e.ofertyAtrapy(odczytaj(e, k).wyslanePola.externalId)[0].name).toBe('Lampa Gliwka & klosz opal');
    for (let i = 0; i < 4; i++) await krok(e, 10 * MIN);
    const o = odczytaj(e, k);
    expect(o.idZewnetrzne).toBe(String(e.ofertyAtrapy(o.wyslanePola.externalId)[0].id));
    expect(o.stan).not.toBe('do_wyslania');
    expect(e.ile(/^POST \/sale\/product-offers$/)).toBe(1);
  });
});
