// „Problemy ofert”: blokady ilości (filtr „Ilość”, przyciski według kodu), Ponów i Wznów przy
// włączonych stanach. Trasy zapisują tylko rejestr i ruch magazynowy — do kanałów nic nie idzie (klienci to atrapy).
// Dane zmyślone („Pracownia Półcień”).
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
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
  zapiszZatwierdzenieStanow,
} from '../../../src/oms/db/oferty-kanalow.ts';
import {
  przelaczStany,
  przelacznikStanow,
  dodajRuch,
  stanKarty,
  migawkaStanow,
  wyjasnieniaOfert,
} from '../../../src/oms/db/stany-magazynowe.js';
import { iloscOferty } from '../../../src/moduly/magazyn/services/tresc-oferty.js';
import { ustawieniaOfertKonta } from '../../../src/oms/db/oferty-kanalow.ts';
import { PROBLEMY_ILOSCI, ocenRozjazdu, skokIlosci } from '../../../src/domena/ilosc-kanalu.js';
import { zalozKonto, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';

const KONTO = 'allegro_swietlik';
const ERLI = 'erli-polcien';
const WOO = 'pro';
const WOO_POZA = 'sklep-poza-konfiguracja';
const GRANICA = '2026-11-01T08:00:00.000Z';
const T0 = '2026-11-02T08:00:00.000Z';
const ADRES = '/magazyn/problemy-ofert';
const OFERTY = ['allegro:api:sale:offers:write', 'allegro:api:sale:settings:read'];
const jwt = (scope) => ['e30', Buffer.from(JSON.stringify({ scope })).toString('base64url'), 'podpis'].join('.');
const auth = {
  authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`,
  origin: 'http://localhost',
};

let db,
  app,
  klienci,
  klientWoo,
  nr = 0;
const post = (url, payload = {}, headers = auth) => app.inject({ method: 'POST', url, payload, headers });
const get = (url, headers = auth) => app.inject({ method: 'GET', url, headers });
const wywolania = () =>
  Object.values(klienci).flatMap((k) =>
    Object.entries(k)
      .filter(([, f]) => f.mock.calls.length)
      .map(([n]) => n),
  );
const atrapa = () => ({
  podgladOplat: vi.fn(),
  utworzOferte: vi.fn(),
  zmienOferte: vi.fn(),
  zmienStatusOferty: vi.fn(),
  komendaIlosci: vi.fn(),
  komendaCeny: vi.fn(),
  pobierzOferte: vi.fn(),
  wgrajZdjecie: vi.fn(),
});
const karta = () => {
  nr += 1;
  return utworzKarte(db, {
    nazwa: `Kinkiet Zmierzch ${nr}`,
    sku: `ZMR-${nr}`,
    cena_gr: 8900,
    stawka_vat: '23',
    marka: 'Pracownia Półcień',
  });
};
const oferta = (kanal, { stan = 'aktywna', kartaId = karta(), id = `TEST-${kanal}-${nr}`, ...zmiany } = {}) => {
  const o = wstawOferte(
    db,
    { kartaId, kanal, idZewnetrzne: id, stan, pochodzenie: 'oms', tryb: 'zarzadzana' },
    { teraz: T0 },
  );
  return zmienOferte(db, o.id, zmiany, { teraz: T0 });
};
const problemIlosci = (kod, dane = {}) => ({ ...PROBLEMY_ILOSCI[kod], od: T0, ...dane });
const wlaczStany = () => {
  przelaczStany(db, { wlacz: true, at: GRANICA });
  zapiszZatwierdzenieStanow(
    db,
    { przelaczenieId: przelacznikStanow(db).przelaczenieId, zatwierdzil: 'operator', ofert: 1, skrot: 'skrot-testu' },
    { teraz: T0 },
  );
};
let ruchNr = 0;
// „Wyślij zera” niesie listę ofert, którą formularz pokazał (ukryte pole `oferty`, id rosnąco po przecinku).
const listaZer = (body, konto) => {
  const formularz =
    new RegExp(`<form[^>]*action="${ADRES}/konto/${konto}/wyslij-zera"[^>]*>([\\s\\S]*?)</form>`).exec(body)?.[1] ?? '';
  return /<input type="hidden" name="oferty" value="([^"]*)">/.exec(formularz)?.[1];
};
const idsZer = (lista) =>
  lista
    .map((o) => o.id)
    .sort((a, b) => a - b)
    .join(',');
const ruch = (kartaId, ilosc, rodzaj = 'przyjecie') =>
  dodajRuch(db, { kartaId, rodzaj, ilosc, klucz: `test-${(ruchNr += 1)}`, at: T0 });
const ruchyKarty = (kartaId) =>
  db
    .prepare("SELECT ilosc, rodzaj, powod FROM ruchy_magazynowe WHERE karta_id = ? AND rodzaj = 'korekta'")
    .all(kartaId);
const ciasteczko = (login) => ({
  origin: 'http://localhost',
  cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz(login, wczytajSekret(db), Date.now(), 0)}`,
});
const wiersz = (body, o) => new RegExp(`<tr[^>]*id="oferta-${o.id}"[^>]*>([\\s\\S]*?)</tr>`).exec(body)?.[1] ?? '';
const zakonczona = (zmiany = {}) =>
  oferta(KONTO, {
    stan: 'problem',
    odczytStatus: 'ENDED',
    odczytIlosc: 0,
    problemy: [{ kod: 'zakonczona', sztuk: 0, tekst: 'Oferta zakończona ręcznie.' }],
    ...zmiany,
  });

beforeEach(async () => {
  nr = 0;
  db = openOmsDb(':memory:');
  klienci = { [KONTO]: atrapa(), [ERLI]: { utworzProdukt: vi.fn(), zmienProdukt: vi.fn(), pobierzProdukt: vi.fn() } };
  klientWoo = { pobierzProdukt: vi.fn(), zmienProdukt: vi.fn(), zmienStan: vi.fn() };
  const kontaAllegro = [{ klucz: KONTO, nazwa: 'Świetlik', autoryzacja: 'polaczone', srodowisko: 'produkcja' }];
  app = buildOmsServer({
    db,
    config: {
      auth: { user: 'operator', pass: 'atrapa' },
      definicje: [
        ...definicjeKanalowHistoryczne,
        { klucz: ERLI, typ: 'erli', prefiks: 'ERLI_POLCIEN', etykieta: 'ERLI Półcień' },
      ],
    },
    magazyn: { stan: () => ({ trwa: false, kanaly: [] }) },
    sklepy: { [WOO]: klientWoo, [WOO_POZA]: { pobierzProdukt: vi.fn(), zmienProdukt: vi.fn(), zmienStan: vi.fn() } },
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
  await app.ready();
  db.prepare(
    `INSERT OR REPLACE INTO tokeny_kanalu (kanal, access_token, refresh_token, wygasa_at, refresh_wygasa_at, zaktualizowane_at)
    VALUES (?, ?, ?, '2026-11-14T11:00:00Z', '2027-01-01T00:00:00Z', '2026-11-14T10:00:00Z')`,
  ).run(
    KONTO,
    szyfrTestowy(db, 'tokeny_kanalu', 'access_token', KONTO, jwt(['allegro:api:orders:read', ...OFERTY])),
    szyfrTestowy(db, 'tokeny_kanalu', 'refresh_token', KONTO, 'REFRESH-ATRAPA'),
  );
});
afterEach(async () => {
  await app.close();
  db.close();
});

it('filtr „Ilość”: tylko alarmy ilości, opis po polsku (odczyt, cel, zakres, od), przycisk według kodu', async () => {
  wlaczStany();
  const kRozjazd = karta();
  ruch(kRozjazd, 7);
  const rozjazd = oferta(ERLI, {
    kartaId: kRozjazd,
    iloscProblem: problemIlosci('rozjazd-dol', { cel: 7, odczyt: 4, zakres: { min: 6, max: 9 } }),
  });
  const brat = oferta(KONTO, { kartaId: kRozjazd, id: 'TEST-brat' });
  const skok = oferta(ERLI, { iloscProblem: problemIlosci('skok', { cel: 12, odczyt: 3 }) });
  const gora = oferta(ERLI, { iloscProblem: problemIlosci('rozjazd-gora', { cel: 2, odczyt: 8 }) });
  const brak = oferta(ERLI, { iloscProblem: problemIlosci('brak-stanu') });
  const zamrozona = oferta(ERLI, { iloscProblem: problemIlosci('zamrozona-ilosc') });
  const kCzeste = karta();
  ruch(kCzeste, 2);
  const czeste = zakonczona({ kartaId: kCzeste, iloscProblem: problemIlosci('czeste-wznawianie') });
  const zwykly = oferta(ERLI, { stan: 'blad', blad: 'ERLI nie odpowiada' });
  const karencja = oferta(ERLI, { iloscProblem: problemIlosci('karencja') });

  const wszystkie = await get(ADRES);
  expect(wszystkie.statusCode).toBe(200);
  expect(wiersz(wszystkie.body, zwykly)).toContain('ERLI nie odpowiada');
  expect(wiersz(wszystkie.body, rozjazd)).toContain('poniżej');
  expect(wszystkie.body).toMatch(
    /<a class="chip chip--aktywny" href="\/magazyn\/problemy-ofert" aria-current="page">Wszystkie \(7\)<\/a>/,
  );
  expect(wszystkie.body).toMatch(/href="\/magazyn\/problemy-ofert\?filtr=ilosc">Ilość \(6\)<\/a>/);
  expect(wiersz(wszystkie.body, karencja)).toBe('');

  const r = await get(`${ADRES}?filtr=ilosc`);
  expect(r.statusCode).toBe(200);
  expect(r.body).toMatch(/href="\/magazyn\/problemy-ofert\?filtr=ilosc" aria-current="page">Ilość \(6\)/);
  expect(wiersz(r.body, zwykly)).toBe('');
  expect(wiersz(r.body, brat)).toBe('');
  const w = wiersz(r.body, rozjazd);
  expect(w).toContain('Stan kanału poniżej wyjaśnionego zakresu');
  expect(w).toMatch(/odczyt 4 szt\..*cel 7 szt\..*zakres 6–9 szt\./s);
  expect(w).toContain('02.11.2026');
  expect(w).toContain(`action="${ADRES}/${rozjazd.id}/ilosc/wyslij-stan-oms"`);
  expect(w).toContain(`action="${ADRES}/${rozjazd.id}/ilosc/przyjmij-stan-kanalu"`);
  expect(w).toContain(`zmieni się też w: ${KONTO}`);
  expect(wiersz(r.body, skok)).toContain('>Potwierdź skok</button>');
  expect(wiersz(r.body, gora)).toContain('>Przyjąłem</button>');
  expect(wiersz(r.body, brak)).toContain('href="/magazyn/stany/otwarcie"');
  expect(wiersz(r.body, brak)).not.toContain('<button');
  expect(wiersz(r.body, zamrozona)).toContain('Ilość oferty jest zamrożona');
  expect(wiersz(r.body, zamrozona)).not.toContain('<button');
  expect(wiersz(r.body, czeste)).toContain('ponad 3 razy na dobę');
  expect(wiersz(r.body, czeste)).toContain(`action="${ADRES}/${czeste.id}/wznow"`);
  expect(wywolania()).toEqual([]);
});

it('„Przyjmij stan kanału” przy odczycie 4 i stanie 7 → ruch −3 z powodem „rozjazd: <konto>”, alarm zdjęty, drugi klik nic nie robi', async () => {
  wlaczStany();
  const k = karta();
  ruch(k, 7);
  const o = oferta(ERLI, {
    kartaId: k,
    wyslanaIlosc: 7,
    iloscProblem: problemIlosci('rozjazd-dol', { cel: 7, odczyt: 4 }),
  });
  const r = await post(`${ADRES}/${o.id}/ilosc/przyjmij-stan-kanalu`);
  expect(r.statusCode).toBe(303);
  expect(ruchyKarty(k)).toEqual([{ ilosc: -3, rodzaj: 'korekta', powod: `rozjazd: ${ERLI}` }]);
  expect(stanKarty(db, k).stan).toBe(4);
  const po = ofertaPoId(db, o.id);
  expect(po.iloscProblem).toBeNull();
  expect(po.wyslanaIlosc).toBe(4);
  expect((await post(`${ADRES}/${o.id}/ilosc/przyjmij-stan-kanalu`)).statusCode).toBe(303);
  expect(ruchyKarty(k)).toHaveLength(1);
  expect(wywolania()).toEqual([]);
});

it('„Wyślij stan OMS”, „Potwierdź skok” i „Przyjąłem” zdejmują alarm bez ruchu; zły przycisk do kodu → 409 bez zmian', async () => {
  wlaczStany();
  const k = karta();
  ruch(k, 7);
  const dol = oferta(ERLI, {
    kartaId: k,
    wyslanaIlosc: 7,
    iloscProblem: problemIlosci('rozjazd-dol', { cel: 7, odczyt: 4 }),
  });
  const skok = oferta(KONTO, {
    kartaId: k,
    id: 'TEST-skok',
    stanKartyWyslany: 20,
    iloscProblem: problemIlosci('skok', { cel: 7, odczyt: 20 }),
  });
  const gora = oferta(ERLI, { wyslanaIlosc: 2, iloscProblem: problemIlosci('rozjazd-gora', { cel: 2, odczyt: 8 }) });

  expect((await post(`${ADRES}/${dol.id}/ilosc/potwierdz-skok`)).statusCode).toBe(409);
  expect(ofertaPoId(db, dol.id).iloscProblem?.kod).toBe('rozjazd-dol');

  expect((await post(`${ADRES}/${dol.id}/ilosc/wyslij-stan-oms`)).statusCode).toBe(303);
  expect(ofertaPoId(db, dol.id)).toMatchObject({ iloscProblem: null, wyslanaIlosc: 4 });
  expect((await post(`${ADRES}/${skok.id}/ilosc/potwierdz-skok`)).statusCode).toBe(303);
  expect(ofertaPoId(db, skok.id)).toMatchObject({ iloscProblem: null, stanKartyWyslany: 7 });
  expect((await post(`${ADRES}/${gora.id}/ilosc/przyjalem`)).statusCode).toBe(303);
  expect(ofertaPoId(db, gora.id)).toMatchObject({ iloscProblem: null, wyslanaIlosc: 8 });
  expect(ruchyKarty(k)).toEqual([]);
  expect(wywolania()).toEqual([]);
});

it('„Wyślij zera” — jeden przycisk na konto z liczbą ofert, odblokowuje tylko to konto', async () => {
  wlaczStany();
  const allegro = [1, 2, 3].map((i) =>
    oferta(KONTO, { id: `TEST-zero-${i}`, iloscProblem: problemIlosci('zero-masowe', { cel: 0, odczyt: 2 }) }),
  );
  const erli = oferta(ERLI, { iloscProblem: problemIlosci('zero-masowe', { cel: 0, odczyt: 5 }) });
  const r = await get(`${ADRES}?filtr=ilosc`);
  expect(r.body.match(new RegExp(`action="${ADRES}/konto/${KONTO}/wyslij-zera"`, 'g'))).toHaveLength(1);
  expect(r.body).toMatch(new RegExp(`Wyślij zera — ${KONTO} \\(3 oferty\\)`));
  expect(r.body).toMatch(new RegExp(`Wyślij zera — ${ERLI} \\(1 oferta\\)`));
  expect(listaZer(r.body, KONTO)).toBe(idsZer(allegro));
  expect(listaZer(r.body, ERLI)).toBe(idsZer([erli]));

  expect((await post(`${ADRES}/konto/${KONTO}/wyslij-zera`, { oferty: listaZer(r.body, KONTO) })).statusCode).toBe(303);
  // Potwierdzenie niesie bieżące przełączenie stanów — po wyłączeniu i włączeniu jest nieważne.
  const { przelaczenieId } = przelacznikStanow(db);
  expect(przelaczenieId).toEqual(expect.any(Number));
  for (const o of allegro) {
    const po = ofertaPoId(db, o.id);
    expect(po.iloscProblem).toBeNull();
    expect(po.wyslanePola.zeraPotwierdzone).toMatchObject({ login: 'operator', przelaczenieId });
  }
  expect(ofertaPoId(db, erli.id).iloscProblem?.kod).toBe('zero-masowe');
  expect(ofertaPoId(db, erli.id).wyslanePola?.zeraPotwierdzone).toBeUndefined();
  expect((await post(`${ADRES}/konto/nieznane/wyslij-zera`)).statusCode).toBe(404);
  expect(wywolania()).toEqual([]);
});

it('E4.30: oferta Woo ma akcje ilości jak ERLI — „Potwierdź skok” 303 zdejmuje alarm, „Wyślij zera” na konto Woo 303', async () => {
  wlaczStany();
  const k = karta();
  ruch(k, 7);
  const skok = oferta(WOO, { kartaId: k, iloscProblem: problemIlosci('skok', { cel: 7, odczyt: 20 }) });
  const zera = [1, 2, 3].map((i) =>
    oferta(WOO, { id: `TEST-woo-zero-${i}`, iloscProblem: problemIlosci('zero-masowe', { cel: 0, odczyt: 4 }) }),
  );
  const odlaczona = oferta('swietlik', { iloscProblem: problemIlosci('skok', { cel: 7, odczyt: 20 }) });

  const r = await get(`${ADRES}?filtr=ilosc`);
  const w = wiersz(r.body, skok);
  expect(w).toContain('<td>WooCommerce</td>');
  expect(w).toContain(`action="${ADRES}/${skok.id}/ilosc/potwierdz-skok"`);
  expect(w).not.toMatch(/\/ponow"|\/wznow"|\/potwierdz-cene"/);
  expect(wiersz(r.body, odlaczona)).toContain('<td>konto odłączone</td>');
  expect(r.body).toMatch(new RegExp(`action="${ADRES}/konto/${WOO}/wyslij-zera"`));
  expect(r.body).toMatch(new RegExp(`Wyślij zera — ${WOO} \\(3 oferty\\)`));

  expect((await post(`${ADRES}/${skok.id}/ilosc/potwierdz-skok`)).statusCode).toBe(303);
  expect(ofertaPoId(db, skok.id)).toMatchObject({ iloscProblem: null, stanKartyWyslany: 7, wyslanaIlosc: 20 });
  expect(listaZer(r.body, WOO)).toBe(idsZer(zera));
  expect((await post(`${ADRES}/konto/${WOO}/wyslij-zera`, { oferty: listaZer(r.body, WOO) })).statusCode).toBe(303);
  const { przelaczenieId } = przelacznikStanow(db);
  for (const o of zera)
    expect(ofertaPoId(db, o.id)).toMatchObject({
      iloscProblem: null,
      wyslanePola: { zeraPotwierdzone: { login: 'operator', przelaczenieId } },
    });
  // Konto Woo bez klienta (niepodłączone) dalej jest „odłączone”.
  expect((await post(`${ADRES}/${odlaczona.id}/ilosc/potwierdz-skok`)).statusCode).toBe(409);
  expect((await post(`${ADRES}/konto/swietlik/wyslij-zera`)).statusCode).toBe(404);
  // E4.30p N1: klient sklepu spoza konfiguracji sklepów — pętla go nie obsługuje, więc trasa też nie (404, bez zapisu).
  const pozaKonfiguracja = oferta(WOO_POZA, { iloscProblem: problemIlosci('zero-masowe', { cel: 0, odczyt: 4 }) });
  expect((await post(`${ADRES}/konto/${WOO_POZA}/wyslij-zera`)).statusCode).toBe(404);
  expect(ofertaPoId(db, pozaKonfiguracja.id).wyslanePola?.zeraPotwierdzone).toBeUndefined();
  // Ponów i potwierdzenie ceny nie są dla Woo (bez zmiany zachowania).
  const blad = oferta(WOO, { stan: 'blad', blad: 'Błąd komunikacji z kanałem' });
  expect((await post(`${ADRES}/${blad.id}/ponow`)).statusCode).toBe(409);
  expect(wywolania()).toEqual([]);
  expect(Object.values(klientWoo).filter((f) => f.mock.calls.length)).toEqual([]);
});

it('Ponów przy włączonych stanach: po zmianie stanu wiersz nie ma komendaIlosci ani celu w toku — następny cel z migawki, nie stary', async () => {
  wlaczStany();
  const k = karta();
  ruch(k, 9);
  const erli = oferta(ERLI, {
    kartaId: k,
    stan: 'blad',
    blad: 'ERLI nie odpowiada',
    liczbaProb: 5,
    iloscWToku: { cel: 9, at: T0 },
    wyslanePola: {
      komendaIlosci: { id: 'k-1', wartosc: 9, at: T0 },
      komendaCeny: { id: 'c-1', wartoscGr: 9900, at: T0 },
    },
  });
  const ext = oferta(KONTO, {
    kartaId: k,
    id: 'ext:5',
    stan: 'blad',
    blad: 'Allegro nie odpowiada',
    liczbaProb: 3,
    wyslanePola: { komendaIlosci: { id: 'k-2', wartosc: 9, at: T0 } },
  });
  ruch(k, -5, 'korekta');
  for (const o of [erli, ext]) expect((await post(`${ADRES}/${o.id}/ponow`)).statusCode).toBe(303);
  const poErli = ofertaPoId(db, erli.id);
  expect(poErli).toMatchObject({ stan: 'do_wyslania', liczbaProb: 0, iloscWToku: null });
  expect(poErli.wyslanePola.komendaIlosci).toBeUndefined();
  expect(poErli.wyslanePola.komendaCeny).toEqual({ id: 'c-1', wartoscGr: 9900, at: T0 });
  const poExt = ofertaPoId(db, ext.id);
  expect(poExt).toMatchObject({ stan: 'do_wyslania', liczbaProb: 0 });
  expect(poExt.wyslanePola?.komendaIlosci).toBeUndefined();
  expect(iloscOferty(migawkaStanow(db), k, ustawieniaOfertKonta(db, ERLI)).ilosc).toBe(4);
  expect(wywolania()).toEqual([]);
});

it('stany wyłączone: Ponów i Wznów jak w E3.2x (komenda zostaje, Wznów bez liczenia ilości)', async () => {
  zapiszUstawieniaOfertKonta(db, KONTO, { stalaIlosc: 5 });
  const erli = oferta(ERLI, {
    stan: 'blad',
    blad: 'ERLI nie odpowiada',
    iloscWToku: { cel: 9, at: T0 },
    wyslanePola: { komendaIlosci: { id: 'k-1', wartosc: 9, at: T0 } },
  });
  expect((await post(`${ADRES}/${erli.id}/ponow`)).statusCode).toBe(303);
  expect(ofertaPoId(db, erli.id)).toMatchObject({
    stan: 'do_wyslania',
    iloscWToku: { cel: 9, at: T0 },
    wyslanePola: { komendaIlosci: { id: 'k-1', wartosc: 9, at: T0 } },
  });
  const z = zakonczona({ problemy: [{ kod: 'zakonczona', sztuk: 0, tekst: 'Oferta zakończona ręcznie.' }] });
  expect((await post(`${ADRES}/${z.id}/wznow`)).statusCode).toBe(303);
  const wznow = ofertaPoId(db, z.id).wyslanePola.wznow;
  expect(wznow).toMatchObject({ login: 'operator' });
  expect(wznow).not.toHaveProperty('ilosc');
});

it('Wznów przy stanach: stan 0 → odmowa „karta nie ma sztuk” (także przy stałej ilości konta); brak stanu i aktywny problem ilości → odmowa', async () => {
  wlaczStany();
  zapiszUstawieniaOfertKonta(db, KONTO, { stalaIlosc: 5 });
  const kZero = karta();
  ruch(kZero, 2);
  ruch(kZero, -2, 'korekta');
  const zero = zakonczona({ kartaId: kZero });
  const r = await post(`${ADRES}/${zero.id}/wznow`);
  expect(r.statusCode).toBe(409);
  expect(r.body).toContain('Karta nie ma sztuk');
  expect(ofertaPoId(db, zero.id).wyslanePola?.wznow).toBeUndefined();
  expect(wiersz((await get(ADRES)).body, zero)).not.toContain('/wznow"');

  const nieznana = zakonczona({ id: 'TEST-nieznana' });
  expect((await post(`${ADRES}/${nieznana.id}/wznow`)).statusCode).toBe(409);

  const kSa = karta();
  ruch(kSa, 3);
  const zProblemem = zakonczona({
    kartaId: kSa,
    id: 'TEST-problem',
    iloscProblem: problemIlosci('rozjazd-dol', { cel: 3, odczyt: 1 }),
  });
  const zp = await post(`${ADRES}/${zProblemem.id}/wznow`);
  expect(zp.statusCode).toBe(409);
  expect(zp.body).toContain('problem ilości');
  expect(ofertaPoId(db, zProblemem.id).wyslanePola?.wznow).toBeUndefined();
  expect(wywolania()).toEqual([]);
});

it('Wznów przy stanach: ilość z iloscDlaKanalu (stan − bufor) w znaczniku; „czeste-wznawianie” wznawia ręcznie i zdejmuje alarm', async () => {
  wlaczStany();
  zapiszUstawieniaOfertKonta(db, KONTO, { stalaIlosc: 50, buforSzt: 1 });
  const k = karta();
  ruch(k, 4);
  const z = zakonczona({ kartaId: k });
  expect((await post(`${ADRES}/${z.id}/wznow`)).statusCode).toBe(303);
  expect(ofertaPoId(db, z.id).wyslanePola.wznow).toMatchObject({ login: 'operator', ilosc: 3 });

  const k2 = karta();
  ruch(k2, 6);
  const czeste = zakonczona({ kartaId: k2, id: 'TEST-czeste', iloscProblem: problemIlosci('czeste-wznawianie') });
  expect((await post(`${ADRES}/${czeste.id}/wznow`)).statusCode).toBe(303);
  const po = ofertaPoId(db, czeste.id);
  expect(po.iloscProblem).toBeNull();
  expect(po.wyslanePola.wznow).toMatchObject({ ilosc: 5 });
  expect(wywolania()).toEqual([]);
});

it('nie-admin z prawem magazynu i obcy Origin dostają 403 na nowych trasach; nic się nie zmienia', async () => {
  wlaczStany();
  const k = karta();
  ruch(k, 7);
  const o = oferta(ERLI, { kartaId: k, iloscProblem: problemIlosci('rozjazd-dol', { cel: 7, odczyt: 4 }) });
  const zera = oferta(KONTO, { iloscProblem: problemIlosci('zero-masowe', { cel: 0, odczyt: 2 }) });
  const posty = ['przyjmij-stan-kanalu', 'wyslij-stan-oms', 'potwierdz-skok', 'przyjalem']
    .map((a) => `${ADRES}/${o.id}/ilosc/${a}`)
    .concat(`${ADRES}/konto/${KONTO}/wyslij-zera`);
  for (const url of posty)
    expect((await post(url, {}, { ...auth, origin: 'https://obcy.example' })).statusCode).toBe(403);
  zalozKonto(db, { login: 'admin', imie: 'Admin', haslo: 'test', rola: 'admin', admin: true });
  const user = zalozKonto(db, { login: 'czytelnik', imie: 'Czytelnik', haslo: 'test', rola: 'operator' });
  ustawUprawnienia(db, user, ['magazyn']);
  expect((await get(`${ADRES}?filtr=ilosc`, ciasteczko('czytelnik'))).statusCode).toBe(403);
  for (const url of posty) expect((await post(url, {}, ciasteczko('czytelnik'))).statusCode).toBe(403);
  expect(ofertaPoId(db, o.id).iloscProblem?.kod).toBe('rozjazd-dol');
  expect(ofertaPoId(db, zera.id).iloscProblem?.kod).toBe('zero-masowe');
  expect(ruchyKarty(k)).toEqual([]);
});

it('B1: „Przyjmij stan kanału” po zmianie stanu karty od alarmu → korekta o różnicę z alarmu (odczyt − cel), nie o cel liczony teraz', async () => {
  wlaczStany();
  const k = karta();
  ruch(k, 7);
  const o = oferta(ERLI, {
    kartaId: k,
    wyslanaIlosc: 7,
    iloscProblem: problemIlosci('rozjazd-dol', { cel: 7, odczyt: 4 }),
  });
  ruch(k, -1, 'korekta');
  expect((await post(`${ADRES}/${o.id}/ilosc/przyjmij-stan-kanalu`)).statusCode).toBe(303);
  expect(ruchyKarty(k).filter((r) => r.powod)).toEqual([{ ilosc: -3, rodzaj: 'korekta', powod: `rozjazd: ${ERLI}` }]);
  expect(stanKarty(db, k).stan).toBe(3);
  const bezCelu = karta();
  ruch(bezCelu, 7);
  const o2 = oferta(ERLI, { kartaId: bezCelu, iloscProblem: problemIlosci('rozjazd-dol', { odczyt: 4 }) });
  expect((await post(`${ADRES}/${o2.id}/ilosc/przyjmij-stan-kanalu`)).statusCode).toBe(303);
  expect(stanKarty(db, bezCelu).stan).toBe(4);
  expect(wywolania()).toEqual([]);
});

it('B2 (D14): stany nigdy niewłączone → bez paska filtrów i napisów etapu 4, także z ?filtr=ilosc; po pierwszym włączeniu pasek jest', async () => {
  oferta(ERLI, { stan: 'blad', blad: 'ERLI nie odpowiada' });
  for (const url of [ADRES, `${ADRES}?filtr=ilosc`]) {
    const r = await get(url);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('ERLI nie odpowiada');
    expect(r.body).not.toContain('Filtr problemów ofert');
    expect(r.body).not.toContain('chipy-filtrow');
    expect(r.body).not.toMatch(/Ilość \(|href="[^"]*filtr=ilosc|aria-current="page">Wszystkie|Wyślij zera|stan kanału/);
  }
  przelaczStany(db, { wlacz: true, at: GRANICA });
  przelaczStany(db, { wlacz: false, at: T0 });
  expect((await get(ADRES)).body).toContain('aria-label="Filtr problemów ofert"');
});

it('N1/N2: po wyłączeniu stanów zalegający alarm ma opis bez przycisków; „Wyślij zera” → 409 bez zapisu', async () => {
  wlaczStany();
  const skok = oferta(ERLI, { iloscProblem: problemIlosci('skok', { cel: 12, odczyt: 3 }) });
  const zera = oferta(KONTO, { iloscProblem: problemIlosci('zero-masowe', { cel: 0, odczyt: 2 }) });
  przelaczStany(db, { wlacz: false, at: T0 });
  const r = await get(`${ADRES}?filtr=ilosc`);
  expect(wiersz(r.body, skok)).toContain('odczyt 3 szt.');
  expect(wiersz(r.body, skok)).not.toContain('/ilosc/');
  expect(r.body).not.toContain('wyslij-zera');
  const z = await post(`${ADRES}/konto/${KONTO}/wyslij-zera`);
  expect(z.statusCode).toBe(409);
  expect(z.body).toContain('Stany magazynowe są wyłączone');
  expect(ofertaPoId(db, zera.id)).toMatchObject({ iloscProblem: { kod: 'zero-masowe' } });
  expect(ofertaPoId(db, zera.id).wyslanePola?.zeraPotwierdzone).toBeUndefined();
});

it('E4.31 (N2): włączenie po wyłączeniu przed zatwierdzeniem → „Wyślij zera” 409 bez flag; po zatwierdzeniu działa', async () => {
  wlaczStany();
  const zera = [1, 2].map((i) =>
    oferta(KONTO, { id: `TEST-n2-${i}`, iloscProblem: problemIlosci('zero-masowe', { cel: 0, odczyt: 2 }) }),
  );
  przelaczStany(db, { wlacz: false, at: T0 });
  przelaczStany(db, { wlacz: true, at: '2026-11-03T08:00:00.000Z' });
  const z = await post(`${ADRES}/konto/${KONTO}/wyslij-zera`);
  expect(z.statusCode).toBe(409);
  expect(z.body).toContain('nie są jeszcze zatwierdzone');
  for (const o of zera) {
    expect(ofertaPoId(db, o.id)).toMatchObject({ iloscProblem: { kod: 'zero-masowe' } });
    expect(ofertaPoId(db, o.id).wyslanePola?.zeraPotwierdzone).toBeUndefined();
  }
  const { przelaczenieId } = przelacznikStanow(db);
  zapiszZatwierdzenieStanow(
    db,
    { przelaczenieId, zatwierdzil: 'operator', ofert: 1, skrot: 'skrot-n2' },
    { teraz: '2026-11-03T09:00:00.000Z' },
  );
  expect((await post(`${ADRES}/konto/${KONTO}/wyslij-zera`, { oferty: idsZer(zera) })).statusCode).toBe(303);
  for (const o of zera)
    expect(ofertaPoId(db, o.id)).toMatchObject({
      iloscProblem: null,
      wyslanePola: { zeraPotwierdzone: { login: 'operator', przelaczenieId } },
    });
  expect(wywolania()).toEqual([]);
});

// Przycisk potwierdza tylko listę, którą człowiek widział.
it('E4.32a: „Wyślij zera” ze starą listą po dojściu 40 nowych zer → 409 bez flag; bez listy odmowa; z aktualną listą działa', async () => {
  wlaczStany();
  const pierwsze = [1, 2, 3].map((i) =>
    oferta(KONTO, { id: `TEST-e432-${i}`, iloscProblem: problemIlosci('zero-masowe', { cel: 0, odczyt: 2 }) }),
  );
  const r = await get(`${ADRES}?filtr=ilosc`);
  const stara = listaZer(r.body, KONTO);
  expect(stara).toBe(idsZer(pierwsze));
  const nowe = Array.from({ length: 40 }, (_, i) =>
    oferta(KONTO, { id: `TEST-e432-n${i}`, iloscProblem: problemIlosci('zero-masowe', { cel: 0, odczyt: 3 }) }),
  );
  const wszystkie = [...pierwsze, ...nowe];
  const flagi = () => wszystkie.filter((o) => ofertaPoId(db, o.id).wyslanePola?.zeraPotwierdzone).length;

  const z = await post(`${ADRES}/konto/${KONTO}/wyslij-zera`, { oferty: stara });
  expect(z.statusCode).toBe(409);
  expect(z.body).toContain('Doszły nowe oferty do zera — odśwież');
  expect(flagi()).toBe(0);
  for (const brak of [{}, { oferty: '' }]) {
    expect((await post(`${ADRES}/konto/${KONTO}/wyslij-zera`, brak)).statusCode).toBeGreaterThanOrEqual(400);
    expect(flagi()).toBe(0);
  }
  for (const o of wszystkie) expect(ofertaPoId(db, o.id).iloscProblem?.kod).toBe('zero-masowe');

  const aktualna = listaZer((await get(`${ADRES}?filtr=ilosc`)).body, KONTO);
  expect(aktualna).toBe(idsZer(wszystkie));
  // Oferta z listy, która w międzyczasie wyszła z zera masowego, jest pomijana — potwierdza część wspólną.
  zmienOferte(db, nowe[0].id, { iloscProblem: null });
  expect((await post(`${ADRES}/konto/${KONTO}/wyslij-zera`, { oferty: aktualna })).statusCode).toBe(303);
  expect(flagi()).toBe(42);
  expect(ofertaPoId(db, nowe[0].id).wyslanePola?.zeraPotwierdzone).toBeUndefined();
  expect(wywolania()).toEqual([]);
});

it('N3: stany włączone, ale niezatwierdzone → Wznów i Przyjmij mówią o zatwierdzeniu, nie o braku sztuk', async () => {
  przelaczStany(db, { wlacz: true, at: GRANICA });
  const k = karta();
  ruch(k, 7);
  const z = zakonczona({ kartaId: k });
  const w = await post(`${ADRES}/${z.id}/wznow`);
  expect(w.statusCode).toBe(409);
  expect(w.body).toContain('nie są jeszcze zatwierdzone');
  expect(w.body).not.toContain('Karta nie ma sztuk');
  const o = oferta(ERLI, { kartaId: k, iloscProblem: problemIlosci('rozjazd-dol', { odczyt: 4 }) });
  const p = await post(`${ADRES}/${o.id}/ilosc/przyjmij-stan-kanalu`);
  expect(p.statusCode).toBe(409);
  expect(p.body).toContain('nie są jeszcze zatwierdzone');
  expect(ruchyKarty(k)).toEqual([]);
});

it('N5: dwa powody w jednej komórce łączy „; ” bez spacji przed średnikiem', async () => {
  wlaczStany();
  const o = oferta(ERLI, {
    stan: 'problem',
    problemy: [{ kod: 'zakonczona', sztuk: 0, tekst: 'Za dużo ofert.' }],
    iloscProblem: problemIlosci('skok', { cel: 12, odczyt: 3 }),
  });
  const w = wiersz((await get(ADRES)).body, o).replace(/<[^>]+>/g, '');
  expect(w).toMatch(/Za dużo ofert\.; \S/);
});

it('„Potwierdź skok” i „Wyślij stan OMS” przesuwają T: stanKartyWyslany = stan karty, wyslanaIlosc = odczyt, iloscWyslanaAt = teraz', async () => {
  wlaczStany();
  const k = karta();
  ruch(k, 7);
  const skok = oferta(KONTO, {
    kartaId: k,
    id: 'TEST-skok',
    stanKartyWyslany: 20,
    wyslanaIlosc: 20,
    iloscWyslanaAt: T0,
    iloscProblem: problemIlosci('skok', { cel: 7, odczyt: 18 }),
  });
  const dol = oferta(ERLI, {
    kartaId: k,
    stanKartyWyslany: 9,
    wyslanaIlosc: 7,
    iloscWyslanaAt: T0,
    iloscProblem: problemIlosci('rozjazd-dol', { cel: 7, odczyt: 4 }),
  });
  expect((await post(`${ADRES}/${skok.id}/ilosc/potwierdz-skok`)).statusCode).toBe(303);
  expect((await post(`${ADRES}/${dol.id}/ilosc/wyslij-stan-oms`)).statusCode).toBe(303);
  for (const [o, odczyt] of [
    [skok, 18],
    [dol, 4],
  ]) {
    const po = ofertaPoId(db, o.id);
    expect(po).toMatchObject({ iloscProblem: null, stanKartyWyslany: 7, wyslanaIlosc: odczyt });
    expect(po.iloscWyslanaAt > T0).toBe(true);
  }
  expect(ruchyKarty(k)).toEqual([]);
});

// E4.13p2 — następny przebieg po kliknięciu (domena E4.07: ocenRozjazdu, skokIlosci, wyjasnieniaOfert).
const nastepnaOcena = (po, odczyt, cel, sprzedaneOd = 0) =>
  ocenRozjazdu({
    wyslanaIlosc: po.wyslanaIlosc,
    odczyt,
    cel,
    wyjasnienie: { sprzedaneOd, anulowaneOd: 0 },
    odczytanoAt: new Date(Date.now() + 60000).toISOString(),
    alarmOd: null,
    poller: null,
    policzonoAt: null,
    pollerMs: 0,
  });

it('B2 r2: sprzedaż w kanale między alarmem a kliknięciem — baza W ze świeżego odczytu, następna ocena pozwala wysłać (rozjazd i skok)', async () => {
  wlaczStany();
  const k1 = karta();
  ruch(k1, 7);
  const dol = oferta(ERLI, {
    kartaId: k1,
    wyslanaIlosc: 7,
    iloscWyslanaAt: T0,
    stanKartyWyslany: 7,
    iloscProblem: problemIlosci('rozjazd-dol', { cel: 7, odczyt: 4 }),
  });
  ruch(k1, -1, 'korekta'); // 1 szt. sprzedana w kanale po alarmie: karta 6, kanał 3
  zmienOferte(db, dol.id, { odczytIlosc: 3 });
  expect((await post(`${ADRES}/${dol.id}/ilosc/wyslij-stan-oms`)).statusCode).toBe(303);
  const poDol = ofertaPoId(db, dol.id);
  expect(poDol.wyslanaIlosc).toBe(3);
  // E4.13p3 N4: następny odczyt 2 przy 1 szt. sprzedanej po T (W ≠ R) — w zakresie tylko przy W = 3, nie przy W = 4 z alarmu.
  expect(nastepnaOcena(poDol, 2, 6, 1)).toMatchObject({ wolnoWyslac: true, problem: null });

  const k2 = karta();
  ruch(k2, 20);
  const skok = oferta(ERLI, {
    kartaId: k2,
    wyslanaIlosc: 5,
    iloscWyslanaAt: T0,
    stanKartyWyslany: 5,
    iloscProblem: problemIlosci('skok', { cel: 20, odczyt: 5 }),
  });
  ruch(k2, -2, 'korekta'); // 2 szt. sprzedane po alarmie: karta 18, kanał 3
  zmienOferte(db, skok.id, { odczytIlosc: 3 });
  expect((await post(`${ADRES}/${skok.id}/ilosc/potwierdz-skok`)).statusCode).toBe(303);
  const poSkok = ofertaPoId(db, skok.id);
  expect(poSkok).toMatchObject({ wyslanaIlosc: 3, stanKartyWyslany: 18 });
  expect(nastepnaOcena(poSkok, 2, 18, 1)).toMatchObject({ wolnoWyslac: true, problem: null });
});

it('B2 r2: T bazy to chwila świeżego odczytu kanału (odczytanoAt), nie chwila kliknięcia', async () => {
  wlaczStany();
  const k = karta();
  ruch(k, 7);
  const odczytanoAt = '2026-11-03T09:30:00.000Z';
  const o = oferta(ERLI, {
    kartaId: k,
    wyslanaIlosc: 7,
    iloscWyslanaAt: T0,
    stanKartyWyslany: 7,
    iloscProblem: problemIlosci('rozjazd-dol', { cel: 7, odczyt: 4 }),
    odczytIlosc: 4,
    odczytanoAt,
  });
  expect((await post(`${ADRES}/${o.id}/ilosc/wyslij-stan-oms`)).statusCode).toBe(303);
  expect(ofertaPoId(db, o.id)).toMatchObject({ wyslanaIlosc: 4, iloscWyslanaAt: odczytanoAt });
});

it('B1 r2: „Przyjmij stan kanału” z korektą ponad próg przesuwa stanKartyWyslany — następny przebieg nie widzi skoku', async () => {
  wlaczStany();
  const k = karta();
  ruch(k, 7);
  const o = oferta(ERLI, {
    kartaId: k,
    wyslanaIlosc: 7,
    iloscWyslanaAt: T0,
    stanKartyWyslany: 7,
    iloscProblem: problemIlosci('rozjazd-dol', { cel: 7, odczyt: 1 }),
  });
  expect((await post(`${ADRES}/${o.id}/ilosc/przyjmij-stan-kanalu`)).statusCode).toBe(303);
  const po = ofertaPoId(db, o.id);
  const stan = stanKarty(db, k).stan;
  expect(stan).toBe(1);
  expect(po).toMatchObject({ stanKartyWyslany: 1, wyslanaIlosc: 1 });
  const w = wyjasnieniaOfert(db, [
    { id: po.id, kanal: ERLI, kartaId: k, od: po.iloscWyslanaAt, oferta: po.idZewnetrzne, regula: 'zlozone' },
  ]).get(po.id);
  expect(
    skokIlosci({ stan, stanKartyWyslany: po.stanKartyWyslany, wyjasnioneKarty: w?.wyjasnioneKarty ?? 0, prog: 5 }),
  ).toBeNull();
});

const skokPo = (k, po) => {
  const w = wyjasnieniaOfert(db, [
    { id: po.id, kanal: ERLI, kartaId: k, od: po.iloscWyslanaAt, oferta: po.idZewnetrzne, regula: 'zlozone' },
  ]).get(po.id);
  return skokIlosci({
    stan: stanKarty(db, k).stan,
    stanKartyWyslany: po.stanKartyWyslany,
    wyjasnioneKarty: w?.wyjasnioneKarty ?? 0,
    prog: 5,
  });
};
/** Przyjmij przy stanie 20 i alarmie {cel 20, odczyt 14} (korekta −6); `odczytanoAt` null = T to chwila kliknięcia. */
const przyjmijZOdczytem = async (odczytanoAt) => {
  const k = karta();
  ruch(k, 20);
  const o = oferta(ERLI, {
    kartaId: k,
    wyslanaIlosc: 20,
    iloscWyslanaAt: T0,
    stanKartyWyslany: 20,
    iloscProblem: problemIlosci('rozjazd-dol', { cel: 20, odczyt: 14 }),
    odczytIlosc: 14,
    ...(odczytanoAt ? { odczytanoAt } : {}),
  });
  expect((await post(`${ADRES}/${o.id}/ilosc/przyjmij-stan-kanalu`)).statusCode).toBe(303);
  return { k, po: ofertaPoId(db, o.id) };
};

it('N1 r3 (R3-1): „Przyjmij” przy świeżym odczycie nie liczy korekty dwa razy — skok po kliknięciu wykryty jak przy T = kliknięcie, w obie strony', async () => {
  wlaczStany();
  const odczytanoAt = new Date(Date.now() - 60000).toISOString();
  for (const zmiana of [9, -9]) {
    for (const t of [odczytanoAt, null]) {
      const { k, po } = await przyjmijZOdczytem(t);
      expect(po.iloscWyslanaAt).toBe(t ?? po.iloscWyslanaAt);
      expect(skokPo(k, po)).toBeNull(); // REC8: samo przyjęcie nie jest skokiem
      ruch(k, zmiana); // niewyjaśniona zmiana stanu karty (data sprzed T)
      expect(skokPo(k, po)).not.toBeNull();
    }
  }
});

it('N2 r3 (R3-2): W i T z tego samego odczytu (odczytIlosc + odczytanoAt), nie ze starego odczytIloscKanalu', async () => {
  wlaczStany();
  const k = karta();
  ruch(k, 7);
  const odczytanoAt = new Date(Date.now() - 60000).toISOString();
  const o = oferta(ERLI, {
    kartaId: k,
    wyslanaIlosc: 7,
    iloscWyslanaAt: T0,
    stanKartyWyslany: 7,
    iloscProblem: problemIlosci('rozjazd-dol', { cel: 7, odczyt: 4 }),
    odczytIloscKanalu: 4,
    odczytIlosc: 3,
    odczytanoAt,
  });
  ruch(k, -1, 'korekta');
  expect((await post(`${ADRES}/${o.id}/ilosc/wyslij-stan-oms`)).statusCode).toBe(303);
  const po = ofertaPoId(db, o.id);
  expect(po).toMatchObject({ wyslanaIlosc: 3, iloscWyslanaAt: odczytanoAt });
  // E4.13p4 N3: następny odczyt 2 po 1 szt. sprzedanej po T (W ≠ R) — w zakresie przy W = 3, poza nim przy starym W = 4.
  expect(nastepnaOcena(po, 2, 6, 1)).toMatchObject({ wolnoWyslac: true, problem: null });
  expect(nastepnaOcena({ ...po, wyslanaIlosc: 4 }, 2, 6, 1).problem).not.toBeNull();
});

it('N3 r3: odczytanoAt późniejsze niż kliknięcie (rozjechany zegar) → T = chwila kliknięcia', async () => {
  wlaczStany();
  const k = karta();
  ruch(k, 7);
  const przyszly = new Date(Date.now() + 3600000).toISOString();
  const o = oferta(ERLI, {
    kartaId: k,
    wyslanaIlosc: 7,
    iloscWyslanaAt: T0,
    stanKartyWyslany: 7,
    iloscProblem: problemIlosci('rozjazd-dol', { cel: 7, odczyt: 4 }),
    odczytIlosc: 4,
    odczytanoAt: przyszly,
  });
  const przed = new Date().toISOString();
  expect((await post(`${ADRES}/${o.id}/ilosc/wyslij-stan-oms`)).statusCode).toBe(303);
  const po = ofertaPoId(db, o.id);
  expect(po.wyslanaIlosc).toBe(4);
  expect(po.iloscWyslanaAt >= przed && po.iloscWyslanaAt <= new Date().toISOString()).toBe(true);
});

it('„Potwierdź skok” bez żadnego odczytu (alarm bez odczytu, brak odczytIlosc) → 409 „Brak odczytu…”, nic nie zapisuje', async () => {
  wlaczStany();
  const k = karta();
  ruch(k, 7);
  const o = oferta(ERLI, {
    kartaId: k,
    wyslanaIlosc: 20,
    iloscWyslanaAt: T0,
    stanKartyWyslany: 20,
    iloscProblem: problemIlosci('skok', { cel: 7 }),
  });
  const przed = ofertaPoId(db, o.id);
  const r = await post(`${ADRES}/${o.id}/ilosc/potwierdz-skok`);
  expect(r.statusCode).toBe(409);
  expect(r.body).toContain('Brak odczytu ilości z kanału');
  expect(ofertaPoId(db, o.id)).toEqual(przed);
});

// Korekta z chwilą kliknięcia; własna korekta oferty nie jest jej wyjaśnieniem.
const skokOferty = (k, po) => {
  const w = wyjasnieniaOfert(db, [
    { id: po.id, kanal: po.kanal, kartaId: k, od: po.iloscWyslanaAt, ofertaId: po.idZewnetrzne, regula: 'zlozone' },
  ]).get(po.id);
  return skokIlosci({
    stan: stanKarty(db, k).stan,
    stanKartyWyslany: po.stanKartyWyslany,
    wyjasnioneKarty: w?.wyjasnioneKarty ?? 0,
    prog: 5,
  });
};

it('R4-2: druga oferta karty zsynchronizowana między odczytem A a kliknięciem — po „Przyjmij” na A bez skoku na B', async () => {
  wlaczStany();
  const k = karta();
  ruch(k, 20);
  const tA = new Date(Date.now() - 60000).toISOString();
  const tB = new Date(Date.now() - 30000).toISOString();
  const a = oferta(ERLI, {
    kartaId: k,
    wyslanaIlosc: 20,
    iloscWyslanaAt: T0,
    stanKartyWyslany: 20,
    iloscProblem: problemIlosci('rozjazd-dol', { cel: 20, odczyt: 14 }),
    odczytIlosc: 14,
    odczytanoAt: tA,
  });
  const b = oferta(KONTO, {
    kartaId: k,
    id: 'TEST-B',
    wyslanaIlosc: 20,
    iloscWyslanaAt: tB,
    stanKartyWyslany: 20,
    odczytIlosc: 20,
    odczytanoAt: tB,
  });
  expect(skokOferty(k, ofertaPoId(db, b.id))).toBeNull();
  const przed = new Date().toISOString();
  expect((await post(`${ADRES}/${a.id}/ilosc/przyjmij-stan-kanalu`)).statusCode).toBe(303);
  const [korekta] = db
    .prepare("SELECT ilosc, utworzono_at FROM ruchy_magazynowe WHERE karta_id = ? AND rodzaj = 'korekta'")
    .all(k);
  expect(korekta.ilosc).toBe(-6);
  expect(korekta.utworzono_at >= przed).toBe(true); // chwila kliknięcia, nie odczytu
  expect(stanKarty(db, k).stan).toBe(14);
  expect(skokOferty(k, ofertaPoId(db, b.id))).toBeNull(); // korekta człowieka jest dla B wyjaśniona
  const poA = ofertaPoId(db, a.id);
  expect(poA).toMatchObject({ iloscWyslanaAt: tA, stanKartyWyslany: 14 });
  expect(skokOferty(k, poA)).toBeNull();
});

it('R4-1: odczytanoAt sprzed bieżącej granicy stanów — korekta wchodzi w stan karty (14) i jej historię', async () => {
  wlaczStany();
  const k = karta();
  ruch(k, 20);
  const tA = new Date(Date.now() - 120000).toISOString();
  const o = oferta(ERLI, {
    kartaId: k,
    wyslanaIlosc: 20,
    iloscWyslanaAt: T0,
    stanKartyWyslany: 20,
    iloscProblem: problemIlosci('rozjazd-dol', { cel: 20, odczyt: 14 }),
    odczytIlosc: 14,
    odczytanoAt: tA,
  });
  przelaczStany(db, { wlacz: false, at: new Date(Date.now() - 90000).toISOString() });
  przelaczStany(db, { wlacz: true, at: new Date(Date.now() - 60000).toISOString() });
  zapiszZatwierdzenieStanow(
    db,
    { przelaczenieId: przelacznikStanow(db).przelaczenieId, zatwierdzil: 'operator', ofert: 1, skrot: 'skrot-r4' },
    { teraz: new Date().toISOString() },
  );
  dodajRuch(db, {
    kartaId: k,
    rodzaj: 'przyjecie',
    ilosc: 20,
    klucz: 'r4-ponownie',
    at: new Date(Date.now() - 50000).toISOString(),
  });
  expect(stanKarty(db, k).stan).toBe(20);
  expect((await post(`${ADRES}/${o.id}/ilosc/przyjmij-stan-kanalu`)).statusCode).toBe(303);
  expect(stanKarty(db, k).stan).toBe(14);
  expect(ofertaPoId(db, o.id).stanKartyWyslany).toBe(14);
});
