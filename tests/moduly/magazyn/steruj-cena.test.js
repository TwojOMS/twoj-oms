// „Steruj ceną” / „Oddaj cenę Allegro”: włączenie tylko zmienia rejestr i dziennik — do Allegro nie idzie nic.
// Podgląd czyta stan oferty (GET), zatwierdzenie i oddanie nie wołają klienta wcale.
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { definicjeKanalowHistoryczne } from '../../pomoc/przykladowe-definicje-kanalow.js';
import { utworzKarte, zapiszProduktSklepowy, powiazProdukt } from '../../../src/oms/db/magazyn.js';
import {
  ofertaPoId,
  ofertaPoIdZewnetrznym,
  wstawOferte,
  zmienOferte,
  zapiszUstawieniaOfertKonta,
} from '../../../src/oms/db/oferty-kanalow.ts';
import { ustawCeneReczna } from '../../../src/oms/db/ceny-kanalow.js';
import { zalozKonto, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';

const KONTO = 'allegro_swietlik';
const WSTRZYMANE = 'allegro_polcien2';
const T0 = '2026-11-14T08:00:00.000Z';
const NAPIS = 'Włączenie niczego nie wysyła. Ceny wyślesz przyciskiem Wyślij ceny do kanałów.';
const auth = {
  authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`,
  origin: 'http://localhost',
};

let db, app, klienci;
const post = (url, payload, headers = auth) => app.inject({ method: 'POST', url, payload, headers });
const token = (r) => /name="podglad" value="([^"]+)"/.exec(r.body)?.[1];
const wywolania = (k) =>
  Object.entries(k)
    .filter(([, f]) => f.mock.calls.length)
    .map(([n]) => n);
const atrapa = (cena = '61.50') => ({
  pobierzOferte: vi.fn(async (id) => ({
    id,
    sellingMode: { price: { amount: cena, currency: 'PLN' } },
    publication: { status: 'ACTIVE' },
  })),
  utworzOferte: vi.fn(),
  edytujOferte: vi.fn(),
  zmienStatusOferty: vi.fn(),
  komendaIlosci: vi.fn(),
  komendaCeny: vi.fn(),
  wgrajZdjecie: vi.fn(),
  podgladOplat: vi.fn(),
});
const zapisy = () => Object.values(klienci).flatMap((k) => wywolania(k).filter((n) => n !== 'pobierzOferte'));
const dziennik = () =>
  db.prepare('SELECT kanal, karta_id, cel, pole, stara, nowa, kto, wynik FROM zmiany_w_kanalach ORDER BY id').all();

function karta(n, cena_gr = 5900) {
  return utworzKarte(db, { nazwa: `Lampa Półcień ${n}`, sku: `PLC-${n}`, cena_gr, stawka_vat: '23' }, { at: T0 });
}
/** Oferta Allegro w lustrze, powiązana z kartą; zwraca id wiersza Powiązań. */
function wLustrze(kartaId, produktId, kanal = KONTO) {
  const pid = zapiszProduktSklepowy(db, {
    kanal,
    produkt_id: produktId,
    wariant_id: '',
    nazwa: `Oferta ${produktId}`,
    status_publikacji: 'ACTIVE',
    odczytane_at: T0,
  });
  powiazProdukt(db, pid, kartaId);
  return pid;
}

beforeEach(async () => {
  db = openOmsDb(':memory:');
  klienci = { [KONTO]: atrapa(), [WSTRZYMANE]: atrapa('40.00') };
  const kontaAllegro = [
    { klucz: KONTO, nazwa: 'Świetlik', autoryzacja: 'polaczone', srodowisko: 'produkcja' },
    { klucz: WSTRZYMANE, nazwa: 'Półcień Druga', autoryzacja: 'polaczone', srodowisko: 'produkcja' },
  ];
  app = buildOmsServer({
    db,
    config: { auth: { user: 'operator', pass: 'atrapa' }, definicje: definicjeKanalowHistoryczne },
    magazyn: { stan: () => ({ trwa: false, kanaly: [] }) },
    nadpisania: {
      'kanaly.klienciKanalow': klienci,
      'kanaly.repozytoriumKanalow': {
        listaTypu: (typ) => (typ === 'allegro' ? kontaAllegro : []),
        zapisyZablokowane: () => false,
        konfliktKlucza: () => false,
      },
    },
  });
  await app.ready();
  zapiszUstawieniaOfertKonta(db, KONTO, { czynne: true, narzutProcent: 10, stalaIlosc: 5 }, { teraz: T0 });
  zapiszUstawieniaOfertKonta(db, WSTRZYMANE, { czynne: false, narzutProcent: 0, stalaIlosc: 5 }, { teraz: T0 });
});
afterEach(async () => {
  await app.close();
  db.close();
});

describe('hurtem z Powiązań', () => {
  it('podgląd → zatwierdzenie tworzy/ustawia wiersz rejestru bez żadnego wywołania Allegro; oddanie zeruje flagę; dziennik ma 2 wpisy', async () => {
    const a = karta(1);
    const b = karta(2);
    const pa = wLustrze(a, '17000000000101');
    const pb = wLustrze(b, '17000000000202');
    // Druga oferta ma już wiersz obserwowany (np. ze stanów) — włączenie tylko stawia flagę.
    const istniejaca = wstawOferte(db, {
      kartaId: b,
      kanal: KONTO,
      idZewnetrzne: '17000000000202',
      pochodzenie: 'przejeta',
      tryb: 'obserwowana',
      stan: 'aktywna',
    });
    ustawCeneReczna(db, { kartaId: b, kanal: KONTO, cenaGr: 10500, kto: 'operator', at: T0 });

    const r = await post('/magazyn/oferty/steruj-cena/podglad', { zaznaczone: [String(pa), String(pb)] });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(NAPIS);
    expect(r.body).toContain('Lampa Półcień 1');
    expect(r.body).toContain('61,50 zł'); // świeży odczyt z Allegro
    expect(r.body).toContain('64,90 zł'); // 59,00 zł + narzut 10%
    expect(r.body).toContain('105,00 zł'); // ręczna cena kanału wygrywa z narzutem
    expect(klienci[KONTO].pobierzOferte).toHaveBeenCalledTimes(2);
    expect(zapisy()).toEqual([]);
    expect(ofertaPoIdZewnetrznym(db, KONTO, '17000000000101')).toBeNull();
    expect(dziennik()).toEqual([]);

    for (const k of Object.values(klienci)) for (const f of Object.values(k)) f.mockClear();
    const z = await post('/magazyn/oferty/steruj-cena/zatwierdz', {
      zaznaczone: [String(pa), String(pb)],
      podglad: token(r),
    });
    expect(z.statusCode).toBe(200);
    expect(z.body).toContain('Sterowanie ceną włączone: 2');
    // Atrapa Allegro liczy wywołania przy włączeniu: zero, także odczytów.
    expect(Object.values(klienci).flatMap(wywolania)).toEqual([]);
    const nowa = ofertaPoIdZewnetrznym(db, KONTO, '17000000000101');
    expect(nowa).toMatchObject({ kartaId: a, tryb: 'obserwowana', pochodzenie: 'przejeta', cenaZOms: true });
    expect(nowa.iloscZOms).toBe(false);
    expect(ofertaPoId(db, istniejaca.id).cenaZOms).toBe(true);
    expect(dziennik()).toEqual([
      expect.objectContaining({
        kanal: KONTO,
        karta_id: a,
        cel: 'oferta:17000000000101',
        pole: 'steruj_cena',
        stara: '0',
        nowa: '1',
        wynik: 'ok',
      }),
      expect.objectContaining({
        kanal: KONTO,
        karta_id: b,
        cel: 'oferta:17000000000202',
        pole: 'steruj_cena',
        stara: '0',
        nowa: '1',
        wynik: 'ok',
      }),
    ]);

    // Ponowne włączenie nie ma czego zmienić — podgląd mówi dlaczego i nie daje podpisu.
    const ponownie = await post('/magazyn/oferty/steruj-cena/podglad', { zaznaczone: [String(pa)] });
    expect(ponownie.body).toContain('cena już z OMS');
    expect(token(ponownie)).toBeUndefined();
    for (const k of Object.values(klienci)) for (const f of Object.values(k)) f.mockClear();

    const o = await post('/magazyn/oferty/oddaj-cene', { zaznaczone: [String(pa)] });
    expect(o.statusCode).toBe(200);
    expect(o.body).toContain('Cenę oddano Allegro: 1');
    expect(Object.values(klienci).flatMap(wywolania)).toEqual([]);
    const po = ofertaPoIdZewnetrznym(db, KONTO, '17000000000101');
    expect(po.cenaZOms).toBe(false);
    expect(po.id).toBe(nowa.id); // wiersz rejestru zostaje
    const wpisyA = dziennik().filter((w) => w.cel === 'oferta:17000000000101');
    expect(wpisyA).toHaveLength(2);
    expect(wpisyA.map((w) => [w.stara, w.nowa])).toEqual([
      ['0', '1'],
      ['1', '0'],
    ]);
  });

  it('konto z wstrzymanymi ofertami: podgląd odmawia, zatwierdzenie nic nie zapisuje', async () => {
    const a = karta(1);
    const pa = wLustrze(a, '17000000000303', WSTRZYMANE);
    const r = await post('/magazyn/oferty/steruj-cena/podglad', { zaznaczone: [String(pa)] });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('oferty wstrzymane na koncie — włącz je w ustawieniach Allegro');
    expect(token(r)).toBeUndefined();
    const z = await post('/magazyn/oferty/steruj-cena/zatwierdz', { zaznaczone: [String(pa)], podglad: 'x.y' });
    expect(z.statusCode).toBe(409);
    expect(ofertaPoIdZewnetrznym(db, WSTRZYMANE, '17000000000303')).toBeNull();
    expect(dziennik()).toEqual([]);
    expect(zapisy()).toEqual([]);
  });

  it('wstrzymanie konta między podglądem a zatwierdzeniem: zatwierdzenie liczy z bazy i odmawia', async () => {
    const a = karta(1);
    const pa = wLustrze(a, '17000000000404');
    const r = await post('/magazyn/oferty/steruj-cena/podglad', { zaznaczone: [String(pa)] });
    expect(token(r)).toBeTruthy();
    zapiszUstawieniaOfertKonta(db, KONTO, { czynne: false }, { teraz: T0 });
    const z = await post('/magazyn/oferty/steruj-cena/zatwierdz', { zaznaczone: [String(pa)], podglad: token(r) });
    expect(z.statusCode).toBe(409);
    expect(z.body).toContain('oferty wstrzymane na koncie — włącz je w ustawieniach Allegro');
    expect(ofertaPoIdZewnetrznym(db, KONTO, '17000000000404')).toBeNull();
    expect(dziennik()).toEqual([]);
  });

  it('przepięcie oferty na inną kartę po podglądzie unieważnia podpis', async () => {
    const a = karta(1);
    const b = karta(2);
    const pa = wLustrze(a, '17000000000505');
    const r = await post('/magazyn/oferty/steruj-cena/podglad', { zaznaczone: [String(pa)] });
    powiazProdukt(db, pa, b);
    const z = await post('/magazyn/oferty/steruj-cena/zatwierdz', { zaznaczone: [String(pa)], podglad: token(r) });
    expect(z.statusCode).toBe(409);
    expect(ofertaPoIdZewnetrznym(db, KONTO, '17000000000505')).toBeNull();
  });
});

describe('pojedynczo na karcie', () => {
  it('podgląd i zatwierdzenie stawiają flagę; karta pokazuje znacznik „cena z OMS” i „Oddaj cenę Allegro”', async () => {
    const a = karta(1);
    const o = wstawOferte(db, {
      kartaId: a,
      kanal: KONTO,
      idZewnetrzne: '17000000000606',
      pochodzenie: 'przejeta',
      tryb: 'obserwowana',
      stan: 'aktywna',
    });
    const przed = await app.inject({ method: 'GET', url: `/magazyn/${a}`, headers: auth });
    expect(przed.body).toContain(`action="/magazyn/${a}/oferty/${o.id}/steruj-cena/podglad"`);
    expect(przed.body).not.toContain('cena z OMS');

    const r = await post(`/magazyn/${a}/oferty/${o.id}/steruj-cena/podglad`, {});
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(NAPIS);
    expect(r.body).toContain(`action="/magazyn/${a}/oferty/${o.id}/steruj-cena/zatwierdz"`);
    const z = await post(`/magazyn/${a}/oferty/${o.id}/steruj-cena/zatwierdz`, { podglad: token(r) });
    expect(z.statusCode).toBe(303);
    expect(ofertaPoId(db, o.id).cenaZOms).toBe(true);
    expect(zapisy()).toEqual([]);

    const po = await app.inject({ method: 'GET', url: `/magazyn/${a}`, headers: auth });
    expect(po.body).toContain('cena z OMS');
    expect(po.body).toContain(`action="/magazyn/${a}/oferty/${o.id}/oddaj-cene"`);
    const d = await post(`/magazyn/${a}/oferty/${o.id}/oddaj-cene`, {});
    expect(d.statusCode).toBe(303);
    expect(ofertaPoId(db, o.id).cenaZOms).toBe(false);
    expect(dziennik().map((w) => [w.pole, w.stara, w.nowa])).toEqual([
      ['steruj_cena', '0', '1'],
      ['steruj_cena', '1', '0'],
    ]);
  });
});

it('nie-admin dostaje 403 na każdej trasie sterowania ceną i niczego nie zmienia', async () => {
  const a = karta(1);
  const pa = wLustrze(a, '17000000000707');
  const o = wstawOferte(db, {
    kartaId: a,
    kanal: KONTO,
    idZewnetrzne: '17000000000707',
    pochodzenie: 'przejeta',
    tryb: 'obserwowana',
    stan: 'aktywna',
  });
  zmienOferte(db, o.id, { cenaZOms: true });
  zalozKonto(db, { login: 'admin', imie: 'Admin', haslo: 'test', rola: 'admin', admin: true });
  const user = zalozKonto(db, { login: 'czytelnik', imie: 'Czytelnik', haslo: 'test', rola: 'operator' });
  ustawUprawnienia(db, user, ['magazyn']);
  const headers = {
    origin: 'http://localhost',
    cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz('czytelnik', wczytajSekret(db), Date.now(), 0)}`,
  };
  const trasy = [
    '/magazyn/oferty/steruj-cena/podglad',
    '/magazyn/oferty/steruj-cena/zatwierdz',
    '/magazyn/oferty/oddaj-cene',
    `/magazyn/${a}/oferty/${o.id}/steruj-cena/podglad`,
    `/magazyn/${a}/oferty/${o.id}/steruj-cena/zatwierdz`,
    `/magazyn/${a}/oferty/${o.id}/oddaj-cene`,
  ];
  for (const url of trasy) expect((await post(url, { zaznaczone: [String(pa)] }, headers)).statusCode).toBe(403);
  expect(ofertaPoId(db, o.id).cenaZOms).toBe(true);
  expect(dziennik()).toEqual([]);
  expect(Object.values(klienci).flatMap(wywolania)).toEqual([]);
});
