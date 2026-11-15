// PRZ-160 E3.14 — „Wystaw na…” Allegro: podgląd, zatwierdzenie, lista, akcje (D16, D30, D40, D43).
// Klienci Allegro to atrapy; jedyne „wyjście” w podglądzie to prowizja (D40) — reszta nie woła kanału.
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { definicjeKanalowHistoryczne } from '../../pomoc/kanaly-historyczne-fixture.js';
import { utworzKarte, zapiszProduktSklepowy, powiazProdukt } from '../../../src/oms/db/magazyn.js';
import { ofertyKarty, wstawOferte, zmienOferte, ofertaPoId, zapiszUstawieniaOfertKonta } from '../../../src/oms/db/oferty-kanalow.ts';
import { opisKategorii } from '../../../src/domena/tresc-oferty-allegro.js';
import { kategoriaAllegroDemo, parametryKategoriiAllegroDemo } from '../../../scripts/demo-dane-katalog.mjs';
import { BRAK_ZGODY_OFERT } from '../../../src/moduly/kanaly/services/oferty-allegro-ustawienia.ts';
import { PROWIZJA_NIE_POLICZONO, PROWIZJA_NIEDOSTEPNA } from '../../../src/moduly/magazyn/services/oplaty-allegro.js';
import { zalozKonto, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import slowniki from '../../fixtures/allegro/e3-dok-slowniki.json' with { type: 'json' };

const KONTO = 'allegro_swietlik';      // zgoda na oferty
const BEZ_ZGODY = 'allegro_polcien2';  // token bez zakresów ofert
const ERLI = 'erli-polcien';
const T0 = '2026-11-14T08:00:00.000Z';
const OFERTY = ['allegro:api:sale:offers:write', 'allegro:api:sale:settings:read'];
const jwt = scope => ['e30', Buffer.from(JSON.stringify({ scope })).toString('base64url'), 'podpis'].join('.');
const auth = { authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`, origin: 'http://localhost' };

let db, app, klienci, kontaAllegro;
const post = (url, payload, headers = auth) => app.inject({ method: 'POST', url, payload, headers });
const get = (url, headers = auth) => app.inject({ method: 'GET', url, headers });
const podglad = (zaznaczone, konto = KONTO) => post('/magazyn/oferty/podglad', { konto, zaznaczone });
const decyzja = (r, zaznaczone, konto = KONTO) => ({ konto, zaznaczone, podglad: /name="podglad" value="([^"]+)"/.exec(r.body)?.[1] });
const wywolania = k => Object.entries(k).filter(([, f]) => f.mock.calls.length).map(([n]) => n);
const atrapa = () => ({
  podgladOplat: vi.fn(async () => structuredClone(slowniki.podgladOplat)),
  utworzOferte: vi.fn(), zmienOferte: vi.fn(), zmienStatusOferty: vi.fn(), komendaIlosci: vi.fn(), komendaCeny: vi.fn(),
  pobierzOferte: vi.fn(), wgrajZdjecie: vi.fn(),
});
const tokeny = (kanal, scope) => db.prepare(`INSERT OR REPLACE INTO tokeny_kanalu (kanal, access_token, refresh_token, wygasa_at, refresh_wygasa_at, zaktualizowane_at)
  VALUES (?, ?, 'REFRESH-ATRAPA', '2026-11-14T11:00:00Z', '2027-01-01T00:00:00Z', '2026-11-14T10:00:00Z')`).run(kanal, jwt(scope));

/** Karta gotowa do wystawienia na Allegro (kategoria z mapy, reguły, marka, GPSR konta, 3 zdjęcia). */
function karta(n, { cena_gr = 5900 } = {}) {
  const id = utworzKarte(db, { nazwa: `Lampa stołowa Gliwka ${n}`, sku: `GLW-${n}`, cena_gr, stawka_vat: '23',
    marka: 'Pracownia Półcień', kategoria_glowna: 'Lampy stołowe', szerokosc_mm: 255,
    opis_sekcje_json: JSON.stringify({ sekcje: [{ elementy: [{ typ: 'tekst', html: '<p>Lampa z mlecznym kloszem.</p>' }] }] }) },
  { at: T0 });
  db.prepare('UPDATE karty_produktow SET informacja_bezpieczenstwa = ? WHERE id = ?')
    .run(JSON.stringify({ typ: 'TEXT', tekst: 'Nie zostawiaj włączonej lampy bez nadzoru.' }), id);
  const zdj = db.prepare(`INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, sha256, typ, ai, ai_reczne, utworzono_at)
    VALUES (?, ?, 'reczne', ?, NULL, 'image/jpeg', 0, 1, ?)`);
  for (let i = 0; i < 3; i++) zdj.run(id, i, `https://polcien.example.invalid/gliwka-${id}-${i + 1}.jpg`, T0);
  return id;
}

beforeEach(async () => {
  db = openOmsDb(':memory:');
  klienci = { [KONTO]: atrapa(), [BEZ_ZGODY]: atrapa(), [ERLI]: { utworzProdukt: vi.fn(), zmienProdukt: vi.fn() } };
  kontaAllegro = [
    { klucz: KONTO, nazwa: 'Świetlik', autoryzacja: 'polaczone', srodowisko: 'produkcja' },
    { klucz: BEZ_ZGODY, nazwa: 'Półcień Druga', autoryzacja: 'polaczone', srodowisko: 'produkcja' },
  ];
  app = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'atrapa' },
    definicje: [...definicjeKanalowHistoryczne, { klucz: ERLI, typ: 'erli', prefiks: 'ERLI_POLCIEN', etykieta: 'ERLI Półcień' }] },
    magazyn: { stan: () => ({ trwa: false, kanaly: [] }) },
    nadpisania: { 'kanaly.klienciKanalow': klienci, 'kanaly.repozytoriumKanalow': {
      listaTypu: typ => (typ === 'allegro' ? kontaAllegro : typ === 'erli' ? [{ klucz: ERLI, nazwa: 'Półcień' }] : []),
      zapisyZablokowane: () => false, konfliktKlucza: () => false,
    } },
  });
  await app.ready();
  tokeny(KONTO, ['allegro:api:orders:read', ...OFERTY]);
  tokeny(BEZ_ZGODY, ['allegro:api:orders:read']);
  db.prepare(`INSERT INTO allegro_mapa_kategorii (kategoria_karty, srodowisko, kategoria_allegro_id) VALUES ('Lampy stołowe', 'produkcja', '257')`).run();
  const regula = db.prepare(`INSERT INTO allegro_reguly_parametrow (srodowisko, kategoria_allegro_id, parametr_id, rodzaj,
    wartosc_json, pole, zmieniono_at) VALUES ('produkcja', '257', ?, ?, ?, ?, ?)`);
  regula.run('11323', 'stala', JSON.stringify({ valuesIds: ['11323_1'] }), null, T0);
  regula.run('248811', 'pole', null, 'marka', T0);
  db.prepare(`INSERT INTO allegro_marki (marka, srodowisko, parametr_id, wartosc_id, kategorie_sprawdzone_json, zmieniono_at)
    VALUES ('Pracownia Półcień', 'produkcja', '248811', '248811_9001', '["257"]', ?)`).run(T0);
  const opis = opisKategorii(['5', '256', '257'].map(kategoriaAllegroDemo), parametryKategoriiAllegroDemo('257'));
  for (const k of [KONTO, BEZ_ZGODY]) {
    db.prepare(`INSERT INTO allegro_marki_gpsr (marka, konto, zrodlo, zmieniono_at) VALUES ('Pracownia Półcień', ?, 'konto', ?)`).run(k, T0);
    db.prepare(`INSERT INTO kanaly_kategorie (polaczenie, kategoria_id, sciezka_json, parametry_json, pobrano_at) VALUES (?, '257', ?, ?, ?)`)
      .run(k, JSON.stringify(opis.sciezka), JSON.stringify({ wersja: opis.wersja, lisc: opis.lisc, tworzenieProduktu: opis.tworzenieProduktu, parametry: opis.parametry }), T0);
    zapiszUstawieniaOfertKonta(db, k, { narzutProcent: 0, stalaIlosc: 5, czasWysylkiDni: 2, cennikDostaw: 'cennik-1',
      stawkaVat: '23', zwrotyId: 'zwrot-1', reklamacjeId: 'rekl-1', producentId: 'prod-konta' }, { teraz: T0 });
  }
});
afterEach(async () => { await app.close(); db.close(); vi.useRealTimers(); });

it('„Wystaw na…” pokazuje konta obu typów; konto bez zgody jest wyszarzone z tekstem D21; jest „Aktywuj w Allegro”', async () => {
  karta(1);
  const r = await get('/magazyn');
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain(`>ERLI · ${ERLI}</option>`);
  expect(r.body).toContain(`<option value="${KONTO}">Allegro · ${KONTO}</option>`);
  expect(r.body).toMatch(new RegExp(`<option value="${BEZ_ZGODY}" disabled>Allegro · ${BEZ_ZGODY} — ${BRAK_ZGODY_OFERT}</option>`));
  expect(r.body).toContain('formaction="/magazyn/oferty/aktywuj"');
  expect(r.body).toContain('Aktywuj w Allegro');
});

it('podgląd Allegro: droga, kategoria, cena i prowizja; zatwierdzenie kładzie ext:… do wysłania; wysyła tylko podgląd prowizji', async () => {
  const id = karta(1);
  const r = await podglad([id]);
  expect(r.statusCode).toBe(200);
  // E3.25: nagłówek używa nazwy z konfiguracji, zamiast technicznego klucza konta.
  for (const tekst of ['Oferty Allegro', 'Allegro swietlik_pl', 'nowy produkt', 'Kategoria Allegro: 257', '59,00 zł', 'Prowizja: 19,00 zł', 'Ilość: 5']) expect(r.body).toContain(tekst);
  expect(r.body).not.toContain('Odmowa:');
  expect(ofertyKarty(db, id)).toHaveLength(0);
  expect(klienci[KONTO].podgladOplat).toHaveBeenCalledTimes(1);
  expect(klienci[KONTO].podgladOplat.mock.calls[0][0]).toEqual({ category: { id: '257' }, sellingMode: { format: 'BUY_NOW', price: { amount: '59.00', currency: 'PLN' } } });
  const w = await post('/magazyn/oferty/zatwierdz', decyzja(r, [id]));
  expect(w.statusCode).toBe(200);
  expect(w.body).toContain('W kolejce: 1. Odmówiono: 0.');
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

it('karta z ofertą Allegro w lustrze na tym koncie → odmowa liczona osobno', async () => {
  const a = karta(1);
  const b = karta(2);
  const pid = zapiszProduktSklepowy(db, { kanal: KONTO, produkt_id: '17000000000777', wariant_id: '', nazwa: 'Gliwka (poza OMS)',
    status_publikacji: 'ACTIVE', odczytane_at: T0 });
  powiazProdukt(db, pid, a);
  const r = await podglad([a, b]);
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain('Odmowa: Karta ma już ofertę na tym koncie.');
  const w = await post('/magazyn/oferty/zatwierdz', decyzja(r, [a, b]));
  expect(w.body).toContain('W kolejce: 1. Odmówiono: 1.');
  expect(ofertyKarty(db, a)).toHaveLength(0);
  expect(ofertyKarty(db, b)).toHaveLength(1);
});

it('karta z 2 ofertami na innych kontach → ostrzeżenie, nie odmowa', async () => {
  const id = karta(1);
  wstawOferte(db, { kartaId: id, kanal: BEZ_ZGODY, idZewnetrzne: '17000000000101', stan: 'aktywna', pochodzenie: 'oms', tryb: 'zarzadzana' });
  const pid = zapiszProduktSklepowy(db, { kanal: BEZ_ZGODY, produkt_id: '17000000000102', wariant_id: '', nazwa: 'Gliwka bis',
    status_publikacji: 'ACTIVE', odczytane_at: T0 });
  powiazProdukt(db, pid, id);
  const r = await podglad([id]);
  expect(r.body).toContain('Allegro nie pozwala na więcej niż dwie oferty');
  expect(r.body).not.toContain('Odmowa:');
  const w = await post('/magazyn/oferty/zatwierdz', decyzja(r, [id]));
  expect(w.body).toContain('W kolejce: 1. Odmówiono: 0.');
});

it('konto bez zgody na oferty → 400 z tekstem D21; konto spoza list → 400', async () => {
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
  expect(r.body.indexOf(`Prowizja: ${PROWIZJA_NIE_POLICZONO}`)).toBeGreaterThan(r.body.indexOf(`Lampa stołowa Gliwka 21<`));
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
  const w = await post('/magazyn/oferty/zatwierdz', decyzja(r, [id]));
  expect(w.body).toContain('W kolejce: 1. Odmówiono: 0.');
});

it('„Aktywuj” na szkicu zapisuje aktywuj = true i niczego nie wysyła; przycisk na karcie i hurtem', async () => {
  const id = karta(1);
  const drugi = karta(2);
  const szkic = (kartaId) => {
    const o = wstawOferte(db, { kartaId, kanal: KONTO, idZewnetrzne: `ext:TEST-K${kartaId}`, stan: 'nieaktywna', pochodzenie: 'oms', tryb: 'zarzadzana' });
    zmienOferte(db, o.id, { wyslanePola: { externalId: `TEST-K${kartaId}`, szkic: true, skrot: 'abc' } });
    return o;
  };
  const o = szkic(id);
  const k = await get(`/magazyn/${id}`);
  expect(k.body).toContain(`/magazyn/${id}/oferty/${o.id}/aktywuj`);
  expect(k.body).toContain('Aktywuj w Allegro');
  expect(k.body).toContain(`Allegro · ${KONTO}`);
  const r = await post(`/magazyn/${id}/oferty/${o.id}/aktywuj`, {});
  expect(r.statusCode).toBe(303);
  expect(ofertaPoId(db, o.id)).toMatchObject({ stan: 'nieaktywna', wyslanePola: { externalId: `TEST-K${id}`, szkic: true, skrot: 'abc', aktywuj: true } });
  const o2 = szkic(drugi);
  const h = await post('/magazyn/oferty/aktywuj', { konto: KONTO, zakres: 'zaznaczone', zaznaczone: [id, drugi] });
  expect(h.statusCode).toBe(200);
  expect(h.body).toContain('Do aktywacji: 1.');
  expect(ofertaPoId(db, o2.id).wyslanePola.aktywuj).toBe(true);
  expect(wywolania(klienci[KONTO])).toEqual([]);
});

it('„Aktywuj” na ofercie zdjętej (albo bez szkicu) → 409', async () => {
  const id = karta(1);
  const zakonczona = wstawOferte(db, { kartaId: id, kanal: KONTO, idZewnetrzne: `ext:TEST-K${id}`, stan: 'nieaktywna', pochodzenie: 'oms', tryb: 'zarzadzana' });
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
    const o = wstawOferte(db, { kartaId: id, kanal, idZewnetrzne: ext, stan: 'nieaktywna', pochodzenie: 'oms', tryb: 'zarzadzana' });
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

it('konto sandbox ma dopisek „(sandbox)” na liście „Wystaw na…” i w nagłówku podglądu', async () => {
  kontaAllegro[0] = { ...kontaAllegro[0], srodowisko: 'sandbox' };
  const id = karta(1);
  const l = await get('/magazyn');
  expect(l.body).toContain(`<option value="${KONTO}">Allegro · ${KONTO} (sandbox)</option>`);
  expect(l.body).toContain(`<option value="${BEZ_ZGODY}" disabled>Allegro · ${BEZ_ZGODY} — `);
  const r = await podglad([id]);
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain('Allegro swietlik_pl (sandbox)');
});

it('E3.25: aktywacja pokazuje nazwę konta zamiast klucza', async () => {
  const id = karta(1);
  const r = await post('/magazyn/oferty/aktywuj', {konto:KONTO, zaznaczone:[id]});
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain('Allegro swietlik_pl');
  expect(r.body).not.toContain('Allegro · Allegro');
  expect(r.body).not.toContain(`Allegro · ${KONTO}`);
});

it('„Zdejmij” na Allegro zapisuje tylko zamiar ENDED i zeruje liczniki zdejmowania; „Wyślij ponownie” działa dla Allegro', async () => {
  const id = karta(1);
  const o = wstawOferte(db, { kartaId: id, kanal: KONTO, idZewnetrzne: `ext:TEST-K${id}`, stan: 'aktywna', pochodzenie: 'oms', tryb: 'zarzadzana' });
  zmienOferte(db, o.id, { wyslanePola: { externalId: `TEST-K${id}`, skrot: 'abc', probyZdjecia: 5, bledyZdjecia: 2 } });
  const przed = ofertaPoId(db, o.id);
  const r = await post(`/magazyn/${id}/oferty/${o.id}/zdejmij`, {});
  expect(r.statusCode).toBe(303);
  const po = ofertaPoId(db, o.id);
  expect(po.wyslanePola).toEqual({ externalId: `TEST-K${id}`, skrot: 'abc', zdejmij: true });
  expect(po.stan).toBe(przed.stan);
  expect(wywolania(klienci[KONTO])).toEqual([]);
  const p = wstawOferte(db, { kartaId: karta(2), kanal: KONTO, idZewnetrzne: 'ext:TEST-K99', stan: 'problem', pochodzenie: 'oms', tryb: 'zarzadzana' });
  expect((await post(`/magazyn/${p.kartaId}/oferty/${p.id}/ponow`, {})).statusCode).toBe(303);
  expect(ofertaPoId(db, p.id).stan).toBe('do_wyslania');
});

it('E3.27: „Ponów” na ofercie z numerem Allegro wraca do synchronizacji, nie do wysłania (bez drugiego POST)', async () => {
  const id = karta(3);
  const o = wstawOferte(db, { kartaId: id, kanal: KONTO, idZewnetrzne: '7712001', stan: 'problem', pochodzenie: 'oms', tryb: 'zarzadzana' });
  zmienOferte(db, o.id, { odczytStatus: 'ACTIVE', liczbaProb: 5, problemy: [{ kod: 'komenda', rodzaj: 'ilosc', tekst: 'Odrzucona' }],
    wyslanePola: { komendaIlosci: { id: 'k-1', wartosc: 4 }, produktId: '42' } });
  expect((await post(`/magazyn/${id}/oferty/${o.id}/ponow`, {})).statusCode).toBe(303);
  expect(ofertaPoId(db, o.id)).toMatchObject({ stan: 'aktywna', liczbaProb: 0, problemy: [], wyslanePola: { produktId: '42' } });
  expect(ofertaPoId(db, o.id).wyslanePola.komendaIlosci).toBeUndefined();
  expect(wywolania(klienci[KONTO])).toEqual([]);
});

it('lista: oferta Allegro z rejestru ma plakietkę ze stanem; liczba zapytań nie rośnie z liczbą kart', async () => {
  const policz = async () => {
    const oryginal = db.prepare;
    let n = 0;
    db.prepare = function (...args) { n++; return oryginal.apply(this, args); };
    try { expect((await get('/magazyn')).statusCode).toBe(200); } finally { db.prepare = oryginal; }
    return n;
  };
  const dodaj = (ile, start) => {
    for (let i = 0; i < ile; i++) {
      const id = karta(start + i);
      wstawOferte(db, { kartaId: id, kanal: KONTO, idZewnetrzne: `ext:TEST-K${id}`, stan: 'do_wyslania', pochodzenie: 'oms', tryb: 'zarzadzana' });
      wstawOferte(db, { kartaId: id, kanal: ERLI, idZewnetrzne: `GLW-${id}`, stan: 'aktywna', pochodzenie: 'oms', tryb: 'zarzadzana' });
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
  const o = wstawOferte(db, { kartaId: id, kanal: KONTO, idZewnetrzne: `ext:TEST-K${id}`, stan: 'nieaktywna', pochodzenie: 'oms', tryb: 'zarzadzana' });
  zmienOferte(db, o.id, { wyslanePola: { szkic: true } });
  const trasy = ['/magazyn/oferty/podglad', '/magazyn/oferty/zatwierdz', '/magazyn/oferty/aktywuj', `/magazyn/${id}/oferty/${o.id}/aktywuj`, `/magazyn/${id}/oferty/${o.id}/zdejmij`];
  for (const url of trasy) expect((await post(url, { konto: KONTO, zaznaczone: [id] }, { ...auth, origin: 'https://obcy.example' })).statusCode).toBe(403);
  zalozKonto(db, { login: 'admin', imie: 'Admin', haslo: 'test', rola: 'admin', admin: true });
  const user = zalozKonto(db, { login: 'czytelnik', imie: 'Czytelnik', haslo: 'test', rola: 'operator' });
  ustawUprawnienia(db, user, ['magazyn']);
  const headers = { origin: 'http://localhost', cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz('czytelnik', wczytajSekret(db), Date.now(), 0)}` };
  for (const url of trasy) expect((await post(url, { konto: KONTO, zaznaczone: [id] }, headers)).statusCode).toBe(403);
  expect(ofertaPoId(db, o.id).wyslanePola.aktywuj).toBeUndefined();
  expect(wywolania(klienci[KONTO])).toEqual([]);
});

describe('PRZ-160.E3.29: Aktywuj z kontem ERLI w polu', () => {
  function szkice() {
    const id = karta(1);
    const drugaKarta = karta(2);
    const oferty = [[id, KONTO], [id, BEZ_ZGODY], [id, ERLI], [drugaKarta, KONTO]].map(([kartaId, kanal]) => {
      const o = wstawOferte(db, { kartaId, kanal, idZewnetrzne: `ext:TEST-K${kartaId}-${kanal}`,
        stan: 'nieaktywna', pochodzenie: 'oms', tryb: 'zarzadzana' });
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
