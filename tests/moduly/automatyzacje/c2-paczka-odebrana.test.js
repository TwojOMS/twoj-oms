// PRZ-108.09 (zmiana C2 planu automatyzacji, właściciel 21.10): zdarzenie „Kurier odebrał paczkę”. Numery w opisach =
// numery testów z planu (sekcja 8, „C2. Testy najpierw”).
//
// Droga faktu jest PRAWDZIWA: status kuriera zapisuje `odswiezStatusKuriera` (ta sama funkcja co czuwacz i karta), a
// klient kuriera oddaje odpowiedź w kształcie prawdziwych klientów (DPD: najnowsze zdarzenie + historia; InPost: najnowsze
// zdarzenie z naszym opisem stanu). Chwila odbioru = pierwszy zapis dowodu z białej listy (`przesylki.odebrana_at`,
// migracja rdzen/0008) — nie czas zdarzenia u kuriera (DPD oddaje go bez strefy, a czuwacz widzi go do godziny później).
//
// Czas: `vi.useFakeTimers({ toFake: ['Date'] })` — zapis statusu, paczki i silnik liczą czas z tego samego zegara.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { MODULY } from '../../../src/moduly/lista.ts';
import { kolejnoscBudowy } from '../../../src/core/sprawdz-moduly.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zarejestrujPrzesylkeReczna } from '../../../src/moduly/wysylka/db/przesylki.js';
import { odswiezStatusKuriera } from '../../../src/moduly/wysylka/services/status-kuriera.js';
import { createWiadomosci } from '../../../src/moduly/wiadomosci/services/wiadomosci.js';
import { createSilnikAutomatyzacji } from '../../../src/moduly/automatyzacje/services/silnik.js';
import { ZDARZENIA } from '../../../src/moduly/automatyzacje/zdarzenia/index.js';
import { zdarzeniePaczkaOdebrana } from '../../../src/moduly/automatyzacje/zdarzenia/paczka-odebrana.js';
import { utworzAkcje } from '../../../src/moduly/automatyzacje/akcje/index.js';
import { sprawdzanieWarunkow } from '../../../src/moduly/automatyzacje/services/warunki.js';
import { utworzRegule, wlaczRegule, wyslijZalegle } from '../../../src/moduly/automatyzacje/db/reguly.js';
import { OPISY_STANOW } from '../../../src/oms/kurierzy/inpost.js';
import { createAtrapaDpd } from '../../../deploy/proba/atrapy/dpd.mjs';

const MIN = 60_000;
const START = Date.parse('2026-10-21T12:00:00.000Z');
const otwarte = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(START); });
afterEach(() => {
  vi.useRealTimers();
  for (const db of otwarte.splice(0)) { try { db.close(); } catch { /* już zamknięta */ } }
});
const przesun = (ms) => vi.setSystemTime(Date.now() + ms);

// Zapisane odpowiedzi kurierów (kształt prawdziwych klientów; opisy DPD z sondy 23.08 i fikstury info-events-ok.xml).
const DPD_ZAREJESTROWANA = 'Zarejestrowano dane przesyłki, przesyłka jeszcze nie nadana';
const DPD_ODEBRANA = 'Przesyłka odebrana przez Kuriera';
const DPD_DORECZONA = 'Przesyłka doręczona';
const dpdBezStrefy = (ms) => new Date(ms + 2 * 3600_000).toISOString().replace('Z', ''); // eventTime DPD: czas warszawski bez strefy
function odpowiedzDpd(...opisy) {
  const historia = opisy.map((opis, i) => ({ opis, at: dpdBezStrefy(Date.now() - (opisy.length - i) * MIN) }));
  return { ...historia[historia.length - 1], historia };
}
// Odpowiedź DPD z odbiorem u kuriera w chwili `odbiorMs` (najnowsze zdarzenie = ten odbiór).
const odpowiedzDpdZOdbiorem = (odbiorMs) => {
  const historia = [{ opis: DPD_ZAREJESTROWANA, at: dpdBezStrefy(odbiorMs - 10 * MIN) }, { opis: DPD_ODEBRANA, at: dpdBezStrefy(odbiorMs) }];
  return { ...historia[1], historia };
};
const odpowiedzInpost = (opis) => ({ opis, at: new Date(Date.now() - MIN).toISOString() });

const KANALY_ZNANE = ['sklep', 'allegro', 'reczne', 'indywidualne'];
let nr = 0;
function zamowienie(db, { sklep = 'sklep', metoda = 'dpd' } = {}) {
  nr += 1;
  return zapiszZamowienie(db, sklep, {
    zrodlo_id: 6000 + nr, numer: `O-${nr}`,
    klient: { first_name: 'Anna', last_name: 'Nowak', email: 'kupujacy@example.invalid', phone: '' },
    dostawa: { first_name: 'Anna', last_name: 'Nowak', address_1: 'Lipowa 7', postcode: '00-950', city: 'Warszawa' },
    metoda_wysylki: metoda, kwota_pobrania: null, chce_fakture: 0, nip: null,
    kwota_brutto: '189.00', koszt_dostawy_brutto: '19.00', koszt_dostawy_netto: '15.45', status_woo: 'processing',
    oplacone_at: null, anulowane: 0, utworzone_at: '2026-10-20T09:00:00',
    pozycje: [{ zrodlo_id: 8000 + nr, nazwa: 'Lampa stołowa Grzybek 30 cm', sku: 'LMP-GRZ-30', ilosc: 1, cena_brutto: '189.00',
      cena_netto: '153.66', brutto_linii: '189.00', netto_linii: '153.66', vat: null }],
  });
}
let numerListu = 500;
function paczka(db, id, { kurier = 'dpd' } = {}) {
  numerListu += 1;
  const n = kurier === 'inpost' ? `0000${String(numerListu).padStart(20, '0')}` : `00000000${numerListu}U`;
  return zarejestrujPrzesylkeReczna(db, id, { kurier,
    kolejnosc: Number(db.prepare('SELECT COUNT(*) AS n FROM przesylki WHERE zamowienie_id = ?').get(id).n) + 1, numerListu: n });
}

function srodowisko({ poczta = true } = {}) {
  const db = openOmsDb(':memory:', { moduly: kolejnoscBudowy(MODULY) });
  otwarte.push(db);
  const listy = [];
  const wiadomosci = createWiadomosci({ db, mailer: { sendMail: async (m) => { listy.push(m); } }, config: { klienciZbiorczy: [],
    oprawaPoczty: { podpis: 'Pracownia Przykładowa', footer: 'Stopka przykładowa' } } });
  const silnik = createSilnikAutomatyzacji({ db, zdarzenia: ZDARZENIA, akcje: utworzAkcje({ wiadomosci: () => wiadomosci }),
    sprawdzWarunki: sprawdzanieWarunkow, pocztaGotowa: () => poczta });
  // Atrapa kuriera na poziomie metod: numer listu → odpowiedź (null = brak zdarzeń, jak świeża paczka).
  const stany = new Map();
  const klient = { statusPrzesylki: async (numer) => stany.get(numer) ?? null };
  const kurierzy = { dpd: klient, inpost: klient };
  /** Czuwacz widzi nowy stan paczki: ta sama ścieżka co zegar i karta. Godzina mija, żeby dławik puścił pytanie. */
  async function kurierMowi(p, odpowiedz) {
    stany.set(p.numer_listu, odpowiedz);
    przesun(61 * MIN);
    const wiersz = db.prepare('SELECT * FROM przesylki WHERE id = ?').get(p.id);
    return odswiezStatusKuriera(db, kurierzy, pobierzZamowienie(db, p.zamowienie_id), wiersz);
  }
  return { db, listy, silnik, kurierzy, kurierMowi, przebieg: () => silnik.przebieg() };
}
const WARUNKI = (o = {}) => ({ kanaly: ['sklep'], kanalyZnane: KANALY_ZNANE, statusy: [], maNumerListu: true, metody: [],
  pobranie: 'dowolne', ...o });
function regula(e, o = {}) {
  const id = utworzRegule(e.db, { nazwa: 'Kurier odebrał — sklep', zdarzenie: 'paczka_odebrana', zdarzenie_json: {},
    warunki: WARUNKI(), akcja: 'mail_kupujacy', akcja_json: { szablon: 'wyslane' }, opoznienie_min: 0, limit_na_godzine: 20, ...o },
  { login: 'adam' });
  wlaczRegule(e.db, id, { login: 'adam' });
  return id;
}
const wykonania = (db) => db.prepare('SELECT * FROM automatyzacje_wykonania ORDER BY id').all();
const przesylka = (db, id) => db.prepare('SELECT * FROM przesylki WHERE id = ?').get(id);
const log = (db, id) => db.prepare('SELECT akcja, wynik FROM log WHERE zamowienie_id = ? ORDER BY id').all(id);

describe('rejestr modułu', () => {
  it('„Kurier odebrał paczkę” jest w rejestrze zdarzeń, w grupie Przesyłka', () => {
    expect(ZDARZENIA.map((z) => z.klucz)).toContain('paczka_odebrana');
    expect(zdarzeniePaczkaOdebrana).toMatchObject({ klucz: 'paczka_odebrana', grupa: 'przesylka', etykieta: 'Kurier odebrał paczkę' });
    expect(zdarzeniePaczkaOdebrana.opis).toMatch(/DPD/u);
    expect(zdarzeniePaczkaOdebrana.opis).toMatch(/InPost/u);
  });
});

describe('2. detektor', () => {
  it('paczka po granicy w stanie zarejestrowanym → 0; po zapisie „odebrana przez Kuriera” → 1 wykonanie i mail; doręczenie potem → nic nowego', async () => {
    const e = srodowisko();
    regula(e);
    przesun(MIN);
    const id = zamowienie(e.db);
    const p = paczka(e.db, id);
    await e.kurierMowi(p, odpowiedzDpd(DPD_ZAREJESTROWANA));
    await e.przebieg();
    expect(przesylka(e.db, p.id).odebrana_at).toBeNull();
    expect(wykonania(e.db)).toEqual([]);

    await e.kurierMowi(p, odpowiedzDpd(DPD_ZAREJESTROWANA, DPD_ODEBRANA));
    const odebrana = przesylka(e.db, p.id);
    expect(odebrana.odebrana_at).toBe(new Date().toISOString());
    expect(odebrana.odebrana_dowod).toBe('dpd:ODEBRANA_PRZEZ_KURIERA');
    przesun(MIN);
    await e.przebieg();
    expect(wykonania(e.db).map((w) => [w.zamowienie_id, w.przesylka_id, w.zdarzenie_at, w.stan]))
      .toEqual([[id, p.id, odebrana.odebrana_at, 'wyslane']]);
    expect(e.listy).toHaveLength(1);
    expect(e.listy[0].text).toContain(p.numer_listu);

    await e.kurierMowi(p, odpowiedzDpd(DPD_ZAREJESTROWANA, DPD_ODEBRANA, DPD_DORECZONA));
    expect(przesylka(e.db, p.id).odebrana_at).toBe(odebrana.odebrana_at); // pierwsza chwila zostaje
    przesun(MIN);
    await e.przebieg();
    expect(wykonania(e.db)).toHaveLength(1);
    expect(e.listy).toHaveLength(1);
  });

  it('paczka sprzed granicy (włączenia), odebrana po włączeniu → 0', async () => {
    const e = srodowisko();
    const id = zamowienie(e.db);
    const p = paczka(e.db, id);
    przesun(MIN);
    regula(e);
    await e.kurierMowi(p, odpowiedzDpd(DPD_ZAREJESTROWANA, DPD_ODEBRANA));
    expect(przesylka(e.db, p.id).odebrana_at).not.toBeNull();
    przesun(MIN);
    await e.przebieg();
    expect(wykonania(e.db)).toEqual([]);
    expect(e.listy).toEqual([]);
  });

  // Recenzja 08, usterka 1 — WSPÓLNY warunek wykonania C1 (`historiaPrzedGranica`, kod `przed_granica`) obejmuje też odbiór:
  // paczka powstała po granicy, ale ZAMÓWIENIE jest stare (karta dociąga numer Allegro sprzed miesięcy, ktoś rejestruje
  // ręcznie dawną paczkę, a czuwacz zaraz czyta jej stan „doręczona”) → pominięte z powodem, zero maili.
  it('zamówienie złożone dawniej niż 14 dni przed granicą, paczka zarejestrowana i odebrana po włączeniu → pominięte „przed_granica”, 0 maili', async () => {
    const e = srodowisko();
    const id = zamowienie(e.db);
    e.db.prepare('UPDATE zamowienia SET utworzone_at = ? WHERE id = ?').run('2026-08-05T10:00:00', id);
    regula(e);
    przesun(MIN);
    const p = paczka(e.db, id);
    await e.kurierMowi(p, odpowiedzDpd(DPD_ZAREJESTROWANA, DPD_ODEBRANA, DPD_DORECZONA));
    expect(przesylka(e.db, p.id).odebrana_at).not.toBeNull();
    przesun(MIN);
    await e.przebieg();
    expect(wykonania(e.db).map((w) => [w.zamowienie_id, w.stan, w.powod_kod])).toEqual([[id, 'pominiete', 'przed_granica']]);
    expect(wykonania(e.db)[0].powod).toMatch(/ponad 14 dni przed włączeniem reguły/u);
    expect(e.listy).toEqual([]);
  });

  it('zamówienie z paczką z numerem sprzed granicy: druga paczka odebrana po włączeniu → pominięte „przed_granica”, 0 maili', async () => {
    const e = srodowisko();
    const id = zamowienie(e.db);
    paczka(e.db, id);
    przesun(MIN);
    regula(e);
    przesun(MIN);
    const druga = paczka(e.db, id);
    await e.kurierMowi(druga, odpowiedzDpd(DPD_ZAREJESTROWANA, DPD_ODEBRANA));
    przesun(MIN);
    await e.przebieg();
    expect(wykonania(e.db).map((w) => [w.przesylka_id, w.stan, w.powod_kod])).toEqual([[druga.id, 'pominiete', 'przed_granica']]);
    expect(wykonania(e.db)[0].powod).toMatch(/paczkę z numerem listu sprzed/u);
    expect(e.listy).toEqual([]);
  });

  it('paczka bez śledzenia (kurier, którego OMS nie pyta) → 0, bez wpisu w historii zamówienia', async () => {
    const e = srodowisko();
    regula(e);
    przesun(MIN);
    const id = zamowienie(e.db);
    const p = paczka(e.db, id, { kurier: 'inny_przewoznik' });
    const przedLog = log(e.db, id).length;
    const wynik = await e.kurierMowi(p, odpowiedzDpd(DPD_ZAREJESTROWANA, DPD_ODEBRANA));
    expect(wynik).toEqual({ bezSledzenia: true });
    przesun(MIN);
    await e.przebieg();
    expect(przesylka(e.db, p.id).odebrana_at).toBeNull();
    expect(wykonania(e.db)).toEqual([]);
    expect(log(e.db, id)).toHaveLength(przedLog);
  });

  it('InPost: nieznany stan → 0; „Przyjęta w oddziale nadawczym” → 1', async () => {
    const e = srodowisko();
    regula(e);
    przesun(MIN);
    const id = zamowienie(e.db, { metoda: 'paczkomat' });
    const p = paczka(e.db, id, { kurier: 'inpost' });
    await e.kurierMowi(p, odpowiedzInpost(OPISY_STANOW.confirmed));
    await e.kurierMowi(p, odpowiedzInpost('InPost: nieznany stan „collected_from_sender”'));
    przesun(MIN);
    await e.przebieg();
    expect(wykonania(e.db)).toEqual([]);
    await e.kurierMowi(p, odpowiedzInpost(OPISY_STANOW.adopted_at_source_branch));
    przesun(MIN);
    await e.przebieg();
    expect(wykonania(e.db).map((w) => [w.zamowienie_id, w.stan])).toEqual([[id, 'wyslane']]);
    expect(przesylka(e.db, p.id).odebrana_dowod).toBe('inpost:adopted_at_source_branch');
  });

  it('dwie paczki jednego zamówienia odebrane → 1 wykonanie, 1 mail (przedmiot = zamówienie)', async () => {
    const e = srodowisko();
    regula(e, { opoznienie_min: 30 });
    przesun(MIN);
    const id = zamowienie(e.db);
    const p1 = paczka(e.db, id);
    const p2 = paczka(e.db, id);
    await e.kurierMowi(p1, odpowiedzDpd(DPD_ZAREJESTROWANA, DPD_ODEBRANA));
    await e.kurierMowi(p2, odpowiedzDpd(DPD_ZAREJESTROWANA, DPD_ODEBRANA));
    przesun(MIN);
    await e.przebieg();
    przesun(31 * MIN);
    await e.przebieg();
    expect(wykonania(e.db).map((w) => [w.przedmiot, w.stan])).toEqual([[`zamowienie:${id}`, 'wyslane']]);
    expect(e.listy).toHaveLength(1);
    expect(e.listy[0].text).toContain(p1.numer_listu);
    expect(e.listy[0].text).toContain(p2.numer_listu);
  });

  it('kanał: reguła tylko na „sklep”; paczka zamówienia Allegro odebrana → 0 wykonań, 0 wpisów automatyzacji', async () => {
    const e = srodowisko();
    regula(e);
    przesun(MIN);
    const id = zamowienie(e.db, { sklep: 'allegro' });
    const p = paczka(e.db, id);
    await e.kurierMowi(p, odpowiedzDpd(DPD_ZAREJESTROWANA, DPD_ODEBRANA));
    przesun(MIN);
    await e.przebieg();
    expect(wykonania(e.db)).toEqual([]);
    expect(log(e.db, id).some((l) => l.akcja.startsWith('automatyzacja'))).toBe(false);
  });
});

describe('kontrakt kandydatów (zdarzenia/index.js)', () => {
  function wstaw(e, n, chwila, { sklep = 'sklep' } = {}) {
    const zam = e.db.prepare(`INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, utworzone_at)
      VALUES (?, ?, ?, '10.00', '2026-10-20T09:00:00')`);
    const pacz = e.db.prepare(`INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, kolejnosc, utworzona_at,
      odebrana_at, odebrana_dowod) VALUES (?, 'dpd', 'nadana', ?, 1, ?, ?, 'dpd:ODEBRANA_PRZEZ_KURIERA')`);
    const ids = [];
    e.db.exec('BEGIN');
    for (let i = 0; i < n; i += 1) {
      nr += 1;
      const zid = Number(zam.run(sklep, 90000 + nr, `M-${nr}`).lastInsertRowid);
      ids.push(Number(pacz.run(zid, `M${nr}`, chwila, chwila).lastInsertRowid));
    }
    e.db.exec('COMMIT');
    return ids;
  }

  it('granica (id paczki), `od`, kanały w SQL, sortowanie (odebrana_at, id), `po` ściśle po (at, id), limit', () => {
    const e = srodowisko();
    const t1 = new Date(START).toISOString();
    const t2 = new Date(START + MIN).toISOString();
    const [stara] = wstaw(e, 1, t2);
    const granica = { at: new Date(START - MIN).toISOString(), przesylki: stara };
    const [a, b] = wstaw(e, 2, t2);
    const [c] = wstaw(e, 1, t1);
    const [obca] = wstaw(e, 1, t1, { sklep: 'allegro' });
    const [dawna] = wstaw(e, 1, new Date(START - 10 * MIN).toISOString());
    const k = (o = {}) => zdarzeniePaczkaOdebrana.kandydaci(e.db, { granica, od: granica.at, limit: 100, kanaly: ['sklep'], ...o })
      .map((w) => w.id);
    expect(k()).toEqual([c, a, b]);
    expect(obca).toBeGreaterThan(stara);
    expect(k({ kanaly: ['allegro'] })).toEqual([obca]);
    expect(k({ limit: 2 })).toEqual([c, a]);
    expect(k({ po: { at: t2, id: a } })).toEqual([b]);
    expect(k({ po: { at: t1, id: c } })).toEqual([a, b]);
    expect(k({ od: t2 })).toEqual([a, b]);
    expect(dawna).toBeGreaterThan(stara); // po granicy id, ale odebrana przed `od` — nie wraca
    const [w] = zdarzeniePaczkaOdebrana.kandydaci(e.db, { granica, od: granica.at, limit: 1, kanaly: ['sklep'] });
    expect(w).toEqual({ id: c, zamowienie_id: przesylka(e.db, c).zamowienie_id, sklep: 'sklep', przesylka_id: c, zdarzenie_at: t1 });
  });

  it('1100 odbiorów zapisanych w tej samej sekundzie → wszystkie wykryte w kolejnych przebiegach, późniejszy też', async () => {
    const e = srodowisko({ poczta: false });
    const id = regula(e, { warunki: WARUNKI({ maNumerListu: false }), limit_na_godzine: 200 });
    przesun(MIN);
    const masowe = wstaw(e, 1100, new Date().toISOString());
    przesun(MIN);
    await e.przebieg();
    expect(wykonania(e.db)).toHaveLength(1000);
    let nowa = null;
    for (let i = 0; i < 5; i += 1) {
      wyslijZalegle(e.db, id, {});
      przesun(MIN);
      if (i === 1) [nowa] = wstaw(e, 1, new Date().toISOString());
      await e.przebieg();
    }
    const wykryte = new Set(wykonania(e.db).map((w) => w.przesylka_id));
    expect(masowe.filter((m) => !wykryte.has(m))).toEqual([]);
    expect(wykryte.has(nowa)).toBe(true);
    expect(wykryte.size).toBe(1101);
  });

  it('symulacja „30 dni”: bieżący stan paczki z białej listy, jedna na zamówienie, zero zapisów', async () => {
    const e = srodowisko();
    const id = zamowienie(e.db);
    const p = paczka(e.db, id);
    const id2 = zamowienie(e.db);
    const p2 = paczka(e.db, id2);
    await e.kurierMowi(p, odpowiedzDpd(DPD_ZAREJESTROWANA, DPD_ODEBRANA, DPD_DORECZONA));
    await e.kurierMowi(p2, odpowiedzDpd(DPD_ZAREJESTROWANA));
    // Paczka sprzed migracji: status z białej listy, ale bez `odebrana_at` — podgląd liczy z bieżącego stanu.
    const id3 = zamowienie(e.db);
    const p3 = paczka(e.db, id3);
    e.db.prepare("UPDATE przesylki SET status_kuriera = 'Przyjęcie przesyłki w oddziale DPD' WHERE id = ?").run(p3.id);
    const przed = e.db.prepare('SELECT total_changes() AS n').get().n;
    const wynik = zdarzeniePaczkaOdebrana.symulacja(e.db, new Date(Date.now() - 30 * 24 * 60 * MIN).toISOString());
    expect(e.db.prepare('SELECT total_changes() AS n').get().n).toBe(przed);
    expect(wynik.map((w) => w.zamowienie_id).sort()).toEqual([id, id3].sort());
    expect(wynik.every((w) => w.sklep === 'sklep' && w.zdarzenie_at)).toBe(true);
  });
});

describe('3. przebieg piaskownicy: atrapa DPD → czuwacz → reguła', () => {
  it('paczka zarejestrowana ręcznie; atrapa mówi „odebrana przez Kuriera” 10 min po nadaniu → 1 wykonanie, 1 mail', async () => {
    const e = srodowisko();
    const atrapa = createAtrapaDpd({ env: { OMS_TRYB: 'proba' }, baza: () => e.db })({});
    const kurierzy = { dpd: atrapa };
    regula(e);
    przesun(MIN);
    const id = zamowienie(e.db);
    const p = paczka(e.db, id);
    const odswiez = () => odswiezStatusKuriera(e.db, kurierzy, pobierzZamowienie(e.db, id), przesylka(e.db, p.id));
    przesun(5 * MIN);
    await odswiez(); // karta otwarta 5 min po nadaniu: zarejestrowana
    expect(przesylka(e.db, p.id)).toMatchObject({ status_kuriera: 'Zarejestrowano dane przesyłki, przesyłka jeszcze nie nadana', odebrana_at: null });
    await e.przebieg();
    expect(wykonania(e.db)).toEqual([]);
    przesun(61 * MIN);
    await odswiez(); // czuwacz godzinę później: odebrana
    expect(przesylka(e.db, p.id)).toMatchObject({ status_kuriera: 'Przesyłka odebrana przez Kuriera', odebrana_dowod: 'dpd:ODEBRANA_PRZEZ_KURIERA' });
    przesun(MIN);
    await e.przebieg();
    expect(wykonania(e.db).map((w) => [w.zamowienie_id, w.stan])).toEqual([[id, 'wyslane']]);
    expect(e.listy).toHaveLength(1);
  });
});

// Recenzja 09, usterka 1 (KRYTYCZNA): pierwszy odczyt śledzenia po dniach (awaria czuwacza, kurier podłączony później,
// numer z Allegro dociągnięty przy otwarciu karty) zapisywał `odebrana_at` = dziś, więc „Kurier odebrał” szło dni po
// odbiorze. Teraz odbiór zapisuje się dla historii razem z czasem zdarzenia U KURIERA (`odebrana_kurier_at`), a reguła
// pomija wykonanie, gdy odbiór u kuriera był ponad ODBIOR_SPOZNIONY_H godzin przed chwilą zapisu.
describe('spóźniony dowód odbioru (recenzja 09, usterka 1)', () => {
  it('DPD: pierwszy odczyt 3 dni po odbiorze („doręczona”, odbiór w historii) → odbiór zapisany, pominięte „odbior_spozniony”, 0 maili', async () => {
    const e = srodowisko();
    regula(e);
    przesun(MIN);
    const id = zamowienie(e.db);
    const p = paczka(e.db, id);
    const odbior = Date.now() + 10 * MIN;
    przesun(3 * 24 * 60 * MIN); // czuwacz przez 3 dni nie zdołał odczytać statusu
    const historia = [
      { opis: DPD_ZAREJESTROWANA, at: dpdBezStrefy(odbior - 10 * MIN) },
      { opis: DPD_ODEBRANA, at: dpdBezStrefy(odbior) },
      { opis: DPD_DORECZONA, at: dpdBezStrefy(odbior + 20 * 60 * MIN) },
    ];
    await e.kurierMowi(p, { ...historia[2], historia });
    const w = przesylka(e.db, p.id);
    expect(w.odebrana_at).not.toBeNull();
    expect(w.odebrana_kurier_at).toBe(new Date(odbior).toISOString());
    przesun(MIN);
    await e.przebieg();
    expect(wykonania(e.db).map((x) => [x.zamowienie_id, x.stan, x.powod_kod])).toEqual([[id, 'pominiete', 'odbior_spozniony']]);
    expect(wykonania(e.db)[0].powod).toMatch(/Odbiór u kuriera .* godzin przed tym, jak OMS go zobaczył/u);
    expect(e.listy).toEqual([]);
  });

  it('DPD: odbiór u kuriera 40 h przed odczytem → mail wychodzi (próg 48 h)', async () => {
    const e = srodowisko();
    regula(e);
    przesun(MIN);
    const id = zamowienie(e.db);
    const p = paczka(e.db, id);
    const odbior = Date.now() + 10 * MIN;
    przesun(10 * MIN + 39 * 60 * MIN); // kurierMowi dokłada 61 min → odczyt 40 h po odbiorze
    await e.kurierMowi(p, odpowiedzDpdZOdbiorem(odbior));
    przesun(MIN);
    await e.przebieg();
    expect(wykonania(e.db).map((x) => x.stan)).toEqual(['wyslane']);
    expect(e.listy).toHaveLength(1);
  });

  it('r09 przypadek 2: Allegro, zamówienie po włączeniu, karta po 40 dniach — import numeru i od razu DELIVERED → 0 maili', async () => {
    const e = srodowisko();
    regula(e, { warunki: WARUNKI({ kanaly: ['allegro'] }) });
    przesun(2 * 24 * 60 * MIN);
    const id = zamowienie(e.db, { sklep: 'allegro' });
    e.db.prepare('UPDATE zamowienia SET utworzone_at = ? WHERE id = ?').run(new Date().toISOString().slice(0, 19), id);
    const odbior = Date.now() + 24 * 60 * MIN;
    przesun(40 * 24 * 60 * MIN);
    const p = zarejestrujPrzesylkeReczna(e.db, id, { kurier: 'allegro', kolejnosc: 1, numerListu: 'AD0001PL', zrodloNumeru: 'allegro', carrierAllegro: 'ALLEGRO' });
    const sledzenie = { allegro: { statusPrzesylki: async () => ({ opis: 'Doręczona', kod: 'DELIVERED', at: new Date(odbior + 24 * 60 * MIN).toISOString(),
      historia: [{ code: 'IN_TRANSIT', occurredAt: new Date(odbior).toISOString() }, { code: 'DELIVERED', occurredAt: new Date(odbior + 24 * 60 * MIN).toISOString() }] }) } };
    await odswiezStatusKuriera(e.db, sledzenie, pobierzZamowienie(e.db, id), przesylka(e.db, p.id));
    expect(przesylka(e.db, p.id).odebrana_kurier_at).toBe(new Date(odbior).toISOString());
    przesun(MIN);
    await e.przebieg();
    expect(wykonania(e.db).map((x) => x.stan)).toEqual(['pominiete']);
    expect(e.listy).toEqual([]);
  });
});
