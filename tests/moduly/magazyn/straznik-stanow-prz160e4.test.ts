// PRZ-160 E4.15 — strażnik stanów (D57): odcisk zmian co 30 s i przyspieszenie pętli ERLI, Allegro i Woo.
// Pętle ERLI/Allegro w testach odcisku to atrapy (licznik `przyspiesz`); odstęp 60 s i „po bieżącym” sprawdza
// prawdziwa pętla Woo na sztucznym zegarze. Żadnego żądania do prawdziwego kanału.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { ENV_DEMO } from '../../../scripts/demo-dane.mjs';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { zapiszZamowienie, dodajPozycjeReczna, zapiszNadpisaniaPozycji } from '../../../src/oms/db/zamowienia.js';
import { przelaczStany, przelacznikStanow, zapiszOtwarcie, dodajRuch } from '../../../src/oms/db/stany-magazynowe.js';
import { zapiszZatwierdzenieStanow } from '../../../src/oms/db/oferty-kanalow.ts';
import { createPetlaStanowWoo } from '../../../src/moduly/magazyn/services/petla-stanow-woo.js';
import { createStraznikStanow, ODSTEP_STRAZNIKA_MS } from '../../../src/moduly/magazyn/services/straznik-stanow.js';
import { createPetlaOfertAllegro } from '../../../src/moduly/magazyn/services/petla-ofert-allegro.js';
import { ponowOferte } from '../../../src/moduly/magazyn/oferty.js';
import { wstawOferte, zmienOferte, ofertaPoId, zapiszUstawieniaOfertKonta } from '../../../src/oms/db/oferty-kanalow.ts';

const GRANICA = '2026-11-14T08:00:00.000Z';
const T1 = '2026-11-14T09:00:00.000Z';
let db: any, numer = 0, ruchNr = 0;

beforeEach(() => { db = openOmsDb(':memory:', { moduly: modulyDla(ENV_DEMO) } as any); numer = 0; ruchNr = 0; });
afterEach(() => { vi.useRealTimers(); db.close(); });

const atrapa = () => ({ przebieg: vi.fn(async () => {}), przyspiesz: vi.fn() });
function straznik() {
  const petle = { erli: atrapa(), allegro: atrapa(), woo: atrapa() };
  const log = vi.fn();
  const s = createStraznikStanow({ db, petle, log });
  const przyspieszenia = () => Object.values(petle).reduce((suma, p) => suma + p.przyspiesz.mock.calls.length, 0);
  return { s, petle, log, przyspieszenia };
}
const wlacz = () => przelaczStany(db, { wlacz: true, at: GRANICA });
const karta = () => utworzKarte(db, { nazwa: 'Lampa Półcień', sku: `LMP-${++numer}`, cena_gr: 10000, stawka_vat: '23' });
const ruch = (kartaId: number, ilosc: number) => dodajRuch(db, { kartaId, rodzaj: 'przyjecie', ilosc, klucz: `t-${++ruchNr}`, at: T1 });
/** `n` podane = ten sam numer w sklepie, czyli ponowny zapis zamówienia przez poller (pozycje sklepowe od nowa). */
function zamowienie({ status = 'processing', utworzone = T1, ilosc = 1, produkt = '501', wariant = null as string | null, n = ++numer } = {}) {
  return zapiszZamowienie(db, 'woo_polcien', { zrodlo_id: `z${n}`, numer: `W-${n}`, klient: {}, dostawa: {},
    utworzone_at: utworzone, kwota_brutto: '20.00', metoda_wysylki: 'odbior', chce_fakture: 0, kwota_pobrania: null,
    nip: null, oplacone_at: null, status_woo: status, anulowane: 0, pozycje: [{ zrodlo_id: 'p1', produkt_id: produkt,
      wariant_id: wariant, oferta_id: null, sku: null, zdjecie_url: null, nazwa: 'Lampa Półcień', ilosc, cena_brutto: '10.00', vat: '23' }] }, {});
}

describe('E4.15 — odcisk strażnika (D57)', () => {
  it('odstęp strażnika to 30 s', () => {
    expect(ODSTEP_STRAZNIKA_MS).toBe(30_000);
  });

  it('odcisk bez zmian → 0 przyspieszeń (pierwszy przebieg tylko zapamiętuje odcisk)', () => {
    wlacz(); zamowienie();
    const { s, przyspieszenia } = straznik();
    s.przebieg(); s.przebieg(); s.przebieg();
    expect(przyspieszenia()).toBe(0);
  });

  it('przebieg pollera bez nowych zamówień (tylko zmienione_at i puls pollera) → 0 przyspieszeń', () => {
    wlacz(); const id = zamowienie();
    const { s, przyspieszenia } = straznik();
    s.przebieg();
    db.prepare('UPDATE zamowienia SET zmienione_at = ? WHERE id = ?').run('2026-11-14T12:00:00.000Z', id);
    db.prepare('INSERT OR REPLACE INTO stan_pollera (sklep, ostatni_przebieg_at) VALUES (?, ?)').run('woo_polcien', '2026-11-14T12:00:00.000Z');
    s.przebieg();
    expect(przyspieszenia()).toBe(0);
  });

  it('nowe zamówienie → 3 × przyspiesz() (ERLI, Allegro, Woo po razie), następny przebieg bez zmian → nic', () => {
    wlacz();
    const { s, petle, przyspieszenia } = straznik();
    s.przebieg();
    zamowienie();
    s.przebieg();
    for (const p of Object.values(petle)) expect(p.przyspiesz).toHaveBeenCalledTimes(1);
    s.przebieg();
    expect(przyspieszenia()).toBe(3);
  });

  it.each([
    ['ruch magazynowy', () => ruch(karta(), 5)],
    ['stan otwarcia', () => zapiszOtwarcie(db, { kartaId: karta(), ilosc: 4, zrodlo: 'reczne', at: T1 })],
    ['zatwierdzenie stanów', () => zapiszZatwierdzenieStanow(db, { przelaczenieId: przelacznikStanow(db).przelaczenieId as number,
      zatwierdzil: 'operator', ofert: 1, skrot: 'skrot-polcien' }, { teraz: T1 })],
    ['anulowanie zamówienia od granicy', (id: number) => db.prepare('UPDATE zamowienia SET anulowane = 1 WHERE id = ?').run(id)],
    ['ręczne anulowanie', (id: number) => db.prepare('UPDATE zamowienia SET anulowane_recznie = 1 WHERE id = ?').run(id)],
    ['poprawka pozycji', (id: number) => db.prepare('UPDATE zamowienia SET pozycje_reczne_json = ? WHERE id = ?').run('{"p1":{"ilosc":2}}', id)],
    // N4: liczy się tylko wejście w status bez rozchodu (STATUSY_WOO_BEZ_ROZCHODU), nie każda zmiana statusu.
    ['status Woo failed', (id: number) => db.prepare("UPDATE zamowienia SET status_woo = 'failed' WHERE id = ?").run(id)],
    ['status Woo trash', (id: number) => db.prepare("UPDATE zamowienia SET status_woo = 'trash' WHERE id = ?").run(id)],
    // N3: „dodaj z magazynu” i edycja pozycji przez poller.
    // dodajPozycjeReczna (JS bez JSDoc) ma produkt_id wywnioskowany z domyślnego null — luźny typ wywołania.
    ['dodaj z magazynu (pozycja ręczna z produktem)', (id: number) => (dodajPozycjeReczna as (...a: unknown[]) => unknown)(db, id,
      { nazwa: 'Lampa Półcień', ilosc: 2, cena_brutto: '10.00', brutto_linii: '20.00', produkt_id: '501' })],
    ['poller: ilość pozycji 1 → 2', () => zamowienie({ n: 1, ilosc: 2 })],
    ['poller: inny produkt, ta sama ilość', () => zamowienie({ n: 1, produkt: '502' })],
  ] as [string, (id: number) => unknown][])('zmiana „%s” → przyspieszenie wszystkich trzech pętli', (_nazwa, zmien) => {
    wlacz(); const id = zamowienie();
    const { s, przyspieszenia } = straznik();
    s.przebieg();
    zmien(Number(id));
    s.przebieg();
    expect(przyspieszenia()).toBe(3);
  });

  it('N2: poprawka pozycji 2 → 3 szt. (ta sama długość JSON) → przyspieszenie', () => {
    wlacz(); const id = Number(zamowienie());
    const { s, przyspieszenia } = straznik();
    zapiszNadpisaniaPozycji(db, id, { sp1: { ilosc: 2 } });
    s.przebieg();
    zapiszNadpisaniaPozycji(db, id, { sp1: { ilosc: 3 } });
    s.przebieg();
    expect(przyspieszenia()).toBe(3);
  });

  it('N2 (recenzja E4.15): poller zapisuje zamówienie z innym wariantem tego samego produktu → przyspieszenie', () => {
    wlacz(); expect(zamowienie({ wariant: '601' })).toBe(1);
    const { s, przyspieszenia } = straznik();
    s.przebieg();
    zamowienie({ n: 1, wariant: '602' });
    s.przebieg();
    expect(przyspieszenia()).toBe(3);
  });

  it.each([
    ['status Woo processing → completed (rozchód bez zmian)', () => db.prepare("UPDATE zamowienia SET status_woo = 'completed' WHERE id = 1").run()],
    ['poller zapisuje to samo zamówienie jeszcze raz (pozycje sklepowe od nowa, nowe id)', () => zamowienie({ n: 1 })],
  ] as [string, () => unknown][])('„%s” → 0 przyspieszeń (bez szumu)', (_nazwa, zmien) => {
    wlacz(); expect(zamowienie()).toBe(1);
    const { s, przyspieszenia } = straznik();
    s.przebieg();
    zmien();
    s.przebieg();
    expect(przyspieszenia()).toBe(0);
  });

  it('zamówienie sprzed granicy: zmiana anulowania i statusu nie liczy się do odcisku', () => {
    wlacz(); const id = zamowienie({ utworzone: '2026-11-01T08:00:00.000Z' });
    const { s, przyspieszenia } = straznik();
    s.przebieg();
    db.prepare("UPDATE zamowienia SET anulowane = 1, status_woo = 'cancelled' WHERE id = ?").run(id);
    s.przebieg();
    expect(przyspieszenia()).toBe(0);
  });

  it('błąd pętli Woo nie zatrzymuje ERLI i Allegro; Woo zostaje „brudna” i dostaje przyspieszenie w następnym przebiegu', () => {
    wlacz();
    const { s, petle, log } = straznik();
    s.przebieg();
    petle.woo.przyspiesz.mockImplementationOnce(() => { throw new Error('Woo nie odpowiada'); });
    zamowienie();
    expect(() => s.przebieg()).not.toThrow();
    expect(petle.erli.przyspiesz).toHaveBeenCalledTimes(1);
    expect(petle.allegro.przyspiesz).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Woo nie odpowiada'));
    s.przebieg();
    expect(petle.woo.przyspiesz).toHaveBeenCalledTimes(2);
    expect(petle.erli.przyspiesz).toHaveBeenCalledTimes(1);
    s.przebieg();
    expect(petle.woo.przyspiesz).toHaveBeenCalledTimes(2);
  });

  it('stany wyłączone (D14) → strażnik nic nie robi: bez zapytania o odcisk i bez przyspieszeń; po włączeniu — przyspiesza', () => {
    const { s, przyspieszenia } = straznik();
    const prepare = vi.spyOn(db, 'prepare');
    s.przebieg();
    zamowienie();
    s.przebieg();
    przelaczStany(db, { wlacz: true, at: GRANICA });
    przelaczStany(db, { wlacz: false, at: T1 });
    zamowienie();
    s.przebieg();
    expect(przyspieszenia()).toBe(0);
    expect(prepare.mock.calls.filter(([sql]) => /AS bezRozchodu/.test(String(sql)))).toEqual([]);
    wlacz();
    s.przebieg();
    expect(przyspieszenia()).toBe(3);
  });

  it('błąd odczytu odcisku trafia do logu, przebieg nie rzuca', () => {
    wlacz();
    const { s, log } = straznik();
    db.exec('DROP TABLE stany_zatwierdzenia');
    expect(() => s.przebieg()).not.toThrow();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^straznik-stanow: /));
  });
});

describe('E4.15 — przyspieszenie pętli (prawdziwa pętla Woo, sztuczny zegar)', () => {
  /** Pętla Woo bez kont: każdy przebieg przy włączonych stanach woła `konta()` raz — to licznik przebiegów. */
  function petlaWoo(wTrakcie: () => void = () => {}) {
    const konta = vi.fn(() => { wTrakcie(); return []; });
    const petla = createPetlaStanowWoo({ db, konta, log: () => {}, pollerMs: 120_000, czekaj: async () => {} });
    return { petla, przebiegi: () => konta.mock.calls.length };
  }

  it('dwa wywołania w 60 s → jeden przebieg, nie wcześniej niż 60 s od startu poprzedniego', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-14T12:00:00Z') });
    wlacz();
    const { petla, przebiegi } = petlaWoo();
    await petla.przebieg();
    await vi.advanceTimersByTimeAsync(10_000);
    petla.przyspiesz();
    await vi.advanceTimersByTimeAsync(10_000);
    petla.przyspiesz();
    await vi.advanceTimersByTimeAsync(39_999);
    expect(przebiegi()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(przebiegi()).toBe(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(przebiegi()).toBe(2);
  });

  it('wolna pętla po ≥ 60 s od startu poprzedniego rusza od razu', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-14T12:00:00Z') });
    wlacz();
    const { petla, przebiegi } = petlaWoo();
    await petla.przebieg();
    await vi.advanceTimersByTimeAsync(90_000);
    petla.przyspiesz();
    await vi.advanceTimersByTimeAsync(0);
    expect(przebiegi()).toBe(2);
  });

  it('zmiana w trakcie przebiegu → drugi przebieg po pierwszym (strażnik w trakcie przebiegu Woo)', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-14T12:00:00Z') });
    wlacz();
    let s: { przebieg: () => void } | null = null;
    let raz = true;
    const { petla, przebiegi } = petlaWoo(() => {
      if (!raz) return;
      raz = false; zamowienie(); s!.przebieg();
    });
    s = createStraznikStanow({ db, petle: { erli: atrapa(), allegro: atrapa(), woo: petla }, log: () => {} });
    s.przebieg();
    await petla.przebieg();
    expect(przebiegi()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(przebiegi()).toBe(2);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(przebiegi()).toBe(2);
  });
});

describe('E4.15 — integracja: Ponów (E4.13) + strażnik + przebieg pętli Allegro (E4.08) → nowy cel', () => {
  /** Oferta obserwowana z flagą „ilość z OMS”, Allegro pokazuje 9, w wierszu wisi komenda ilości 9 bez znanego wyniku. */
  function srodowiskoAllegro() {
    przelaczStany(db, { wlacz: true, at: GRANICA });
    db.prepare(`INSERT INTO stany_zatwierdzenia (przelaczenie_id, zatwierdzono_at, ofert, skrot)
      VALUES (?, '2026-11-14T08:01:00.000Z', 1, 'polcien-allegro')`).run(przelacznikStanow(db).przelaczenieId);
    const kartaId = karta();
    dodajRuch(db, { kartaId, rodzaj: 'przyjecie', ilosc: 9, klucz: 'polcien-przyjecie', at: T1 });
    const o = wstawOferte(db, { kartaId, kanal: 'allegro-polcien', idZewnetrzne: '7700000015', tryb: 'obserwowana', stan: 'aktywna' });
    zmienOferte(db, o.id, { iloscZOms: true, odczytStatus: 'ACTIVE', odczytIlosc: 9, wyslanaIlosc: 9, odczytanoAt: T1,
      wyslanePola: { komendaIlosci: { id: 'k-1', wartosc: 9, at: T1 } } });
    zapiszUstawieniaOfertKonta(db, 'allegro-polcien', { czynne: true });
    const allegro = { komendaIlosci: vi.fn(async () => {}), komendaCeny: vi.fn(async () => {}), komendaPublikacji: vi.fn(async () => {}),
      wynikKomendy: vi.fn(async () => []), podgladOplat: vi.fn() };
    const katalog = { odczytOfert: vi.fn(async () => ({ ok: true, dane: { oferty: [{ id: '7700000015', publication: { status: 'ACTIVE' },
      stock: { available: 9 }, sellingMode: { price: { amount: '100.00' } } }] } })), zmienOferte: vi.fn(async () => ({ ok: true, dane: {} })) };
    const petla = createPetlaOfertAllegro({ db, konta: () => [{ klucz: 'allegro-polcien', zgoda: true, allegro, katalog }],
      pollerMs: 120_000, zwolnijOperacje: vi.fn(), czytajZdjecie: vi.fn(), log: () => {} });
    const s = createStraznikStanow({ db, petle: { erli: atrapa(), allegro: petla, woo: atrapa() }, log: () => {} });
    return { kartaId, oferta: () => ofertaPoId(db, o.id), allegro, s };
  }
  const ilosci = (allegro: any) => allegro.komendaIlosci.mock.calls.map((c: any[]) => c[1]);

  it('korekta −5 i Ponów → strażnik przyspiesza pętlę → komenda ilości 4 (nowy cel), nie zapamiętane 9', async () => {
    const e = srodowiskoAllegro();
    e.s.przebieg();
    dodajRuch(db, { kartaId: e.kartaId, rodzaj: 'korekta', ilosc: -5, klucz: 'polcien-korekta', at: T1 });
    ponowOferte(db, e.oferta(), true);
    expect((e.oferta() as any)?.wyslanePola?.komendaIlosci).toBeUndefined();
    e.s.przebieg();
    await vi.waitFor(() => expect(e.allegro.komendaIlosci).toHaveBeenCalled());
    expect(ilosci(e.allegro)).toEqual([[{ ofertaId: '7700000015', ilosc: 4 }]]);
  });
});
