import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { rozpocznijPrzesylke, nastepnaKolejnosc, zywePrzesylki } from '../../../src/moduly/wysylka/db/przesylki.js';
import { createNadanie } from '../../../src/moduly/wysylka/services/nadanie.js';
import { createDpdClient } from '../../../src/oms/kurierzy/dpd.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { wyliczStatus, doZrobienia } from '../../../src/domena/status.js';
import { sprawyZamowienia, mozliwaKolejnaPaczka, PROG_ZAWIESZONEGO_NADANIA_MS } from '../../../src/domena/przesylka-stan.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => readFileSync(join(__dir, 'fixtures', 'dpd', n), 'utf8');
const odp = (status, tekst) => ({ status, ok: status >= 200 && status < 300, text: async () => tekst });

const config = { auth: { user: 'adam', pass: 'x' } };
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };
const NADAWCA = { nazwa: 'Lumina', ulica: 'ul. 1 Maja 5', kod: '00-650', miasto: 'Pęki', kraj: 'PL' };
// Adres odbiorcy zgodny z `zmapowane().dostawa/klient` niżej — od Zadania „adres edytowalny"
// trasa POST wymaga go W FORMULARZU (puste pole wymagane blokuje zatwierdzenie, patrz
// domain/adres-formularza.js), więc każdy POST w tym pliku musi go nieść, tak jak niosłaby
// go prawdziwa przeglądarka odsyłająca wartości, którymi GET wypełnił formularz.
const ADRES = {
  nazwa: 'Jan Kowalski', ulica: 'Polna 1', kod: '00-650', miasto: 'Pęki', phone: '+48500600700', email: 'j@k.pl',
};
const PACZKA = { waga: '1', dlugosc: '110', szerokosc: '75', wysokosc: '1', ...ADRES };

const zmapowane = (nad = {}) => ({
  zrodlo_id: 1267, numer: '1267',
  klient: { email: 'j@k.pl', phone: '+48500600700' },
  dostawa: { first_name: 'Jan', last_name: 'Kowalski', address_1: 'Polna 1', postcode: '00-650', city: 'Pęki', country: 'PL' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '212.90',
  status_woo: 'processing', oplacone_at: '2026-07-29T13:00:00', anulowane: 0,
  utworzone_at: '2026-07-29T13:19:52', pozycje: [], ...nad,
});

// Klient DPD na PRAWDZIWYCH fiksturach z Zadania 8, bez ani jednego żądania sieciowego:
// `fetchImpl` nigdy nie dotyka dpdservices.dpd.com.pl. Numer listu podmieniamy w fiksturze,
// żeby dwie paczki tego samego zamówienia miały różne numery — inaczej test nie odróżniłby
// „druga paczka" od „ta sama paczka policzona dwa razy".
function dpdKlient({ paczek = 2 } = {}) {
  const v10 = fixture('v10-ok.xml');
  const fetchImpl = vi.fn();
  for (let i = 0; i < paczek; i += 1) {
    fetchImpl
      .mockResolvedValueOnce(odp(200, v10.replace(/1000000000001U/g, `104806948802${i}U`)))
      .mockResolvedValueOnce(odp(200, fixture('v4-ok.xml')))
      .mockResolvedValueOnce(odp(200, fixture('v4-ok-zpl.xml')));
  }
  const dpd = createDpdClient({ url: 'https://dpd/api', login: '99999999', haslo: 'x', fid: '278216', nadawca: NADAWCA, fetchImpl });
  return { dpd, fetchImpl };
}

// Ciała żądań V10 (nadania), w kolejności wysłania — po jednym na paczkę.
const kopertyV10 = (fetchImpl) => fetchImpl.mock.calls
  .map((c) => c[1].body)
  .filter((b) => b.includes('generatePackagesNumbersV10'));

let db;
beforeEach(() => {
  db = openOmsDb(':memory:');
});

function zServerem({ nad = {}, dpd, woo } = {}) {
  const katalogEtykiet = mkdtempSync(join(tmpdir(), 'oms-paczki-'));
  const dpdKl = dpd ?? dpdKlient().dpd;
  const wooKl = woo ?? { dodajNotatke: vi.fn().mockResolvedValue({}) };
  const nadanie = createNadanie({ db, kurierzy: { dpd: dpdKl }, woo: wooKl, katalogEtykiet });
  const serwer = buildOmsServer({ db, config, poller, nadanie });
  const id = zapiszZamowienie(db, 'pro', zmapowane(nad), {});
  return { serwer, id, nadanie };
}

const przesylki = (id) => db.prepare('SELECT * FROM przesylki WHERE zamowienie_id = ? ORDER BY kolejnosc').all(id);

// =====================================================================================
// A. Numer kolejny paczki — indeks w bazie
// =====================================================================================

describe('indeks: jedna żywa paczka na PARĘ (zamówienie, numer kolejny)', () => {
  const zZamowieniem = () => {
    db.prepare("INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, utworzone_at) VALUES ('pro', 1, '1', '10.00', '2026-07-29')").run();
    return 1;
  };

  it('dwie żywe paczki o TYM SAMYM numerze kolejnym → baza odrzuca', () => {
    zZamowieniem();
    const wstaw = (k) => db.prepare(
      "INSERT INTO przesylki (zamowienie_id, kurier, status, kolejnosc, utworzona_at) VALUES (1, 'dpd', 'nadana', ?, '2026-07-29')",
    ).run(k);
    wstaw(1);
    expect(() => wstaw(1)).toThrow(/UNIQUE constraint failed: przesylki\.zamowienie_id, przesylki\.kolejnosc/);
  });

  // Cały sens zadania: druga paczka CHCIANA ma przejść.
  it('dwie żywe paczki o RÓŻNYCH numerach kolejnych → baza przyjmuje', () => {
    zZamowieniem();
    const wstaw = (k) => db.prepare(
      "INSERT INTO przesylki (zamowienie_id, kurier, status, kolejnosc, utworzona_at) VALUES (1, 'dpd', 'nadana', ?, '2026-07-29')",
    ).run(k);
    wstaw(1);
    expect(() => wstaw(2)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) c FROM przesylki').get().c).toBe(2);
  });

  // Warunek `status <> 'blad'` zostaje w całości: nieudane nadanie MUSI zwalniać miejsce,
  // inaczej zamówienie zostałoby bez paczki na zawsze.
  it('paczka na statusie „blad" nie zajmuje numeru kolejnego', () => {
    zZamowieniem();
    db.prepare("INSERT INTO przesylki (zamowienie_id, kurier, status, kolejnosc, utworzona_at) VALUES (1, 'dpd', 'blad', 1, '2026-07-29')").run();
    expect(() => db.prepare(
      "INSERT INTO przesylki (zamowienie_id, kurier, status, kolejnosc, utworzona_at) VALUES (1, 'dpd', 'nadana', 1, '2026-07-29')",
    ).run()).not.toThrow();
  });

  it('domyślny numer kolejny to 1 — wiersz bez jawnej wartości nie wymyka się indeksowi', () => {
    zZamowieniem();
    const wstaw = () => db.prepare(
      "INSERT INTO przesylki (zamowienie_id, kurier, status, utworzona_at) VALUES (1, 'dpd', 'nadana', '2026-07-29')",
    ).run();
    wstaw();
    expect(wstaw).toThrow(/UNIQUE constraint failed/);
  });
});

describe('nastepnaKolejnosc', () => {
  const zZamowieniem = () => {
    db.prepare("INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, utworzone_at) VALUES ('pro', 1, '1', '10.00', '2026-07-29')").run();
    return 1;
  };

  it('bez paczek → 1', () => {
    zZamowieniem();
    expect(nastepnaKolejnosc(db, 1)).toBe(1);
  });

  it('z jedną żywą paczką → 2', () => {
    zZamowieniem();
    rozpocznijPrzesylke(db, 1, 'dpd', 1);
    expect(nastepnaKolejnosc(db, 1)).toBe(2);
  });

  // Nieudane nadanie zwalnia numer — inaczej ponowienie dostawałoby numer 2 i jechało
  // do DPD z referencją „1267/2", mimo że żadna pierwsza paczka nigdy nie powstała.
  it('paczka na statusie „blad" nie podbija numeru', () => {
    zZamowieniem();
    const p = rozpocznijPrzesylke(db, 1, 'dpd', 1);
    db.prepare("UPDATE przesylki SET status = 'blad' WHERE id = ?").run(p.id);
    expect(nastepnaKolejnosc(db, 1)).toBe(1);
  });

  it('paczka „do wyjaśnienia" NUMER ZAJMUJE — paczka u kuriera fizycznie istnieje', () => {
    zZamowieniem();
    const p = rozpocznijPrzesylke(db, 1, 'dpd', 1);
    db.prepare("UPDATE przesylki SET status = 'do_wyjasnienia', numer_listu = 'X1' WHERE id = ?").run(p.id);
    expect(nastepnaKolejnosc(db, 1)).toBe(2);
  });
});

// =====================================================================================
// Ochrona przed paczką NIECHCIANĄ — dwa niezależne mechanizmy
// =====================================================================================

describe('POST /nadaj — numer kolejny z formularza pilnuje podwójnego kliknięcia', () => {
  it('dwa wysłania tego samego formularza (ten sam numer kolejny) → JEDNA paczka', async () => {
    const { dpd, fetchImpl } = dpdKlient();
    const { serwer, id } = zServerem({ dpd });
    await serwer.ready();

    const pierwsze = await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: { ...PACZKA, kolejnosc: '1' },
    });
    const drugie = await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: { ...PACZKA, kolejnosc: '1' },
    });

    expect(pierwsze.statusCode).toBe(302);
    expect(drugie.statusCode).toBe(400);
    expect(przesylki(id).filter((p) => p.status !== 'blad')).toHaveLength(1);
    expect(kopertyV10(fetchImpl)).toHaveLength(1);
  });

  // Karta otwarta, gdy paczek było mniej: panel spodziewa się numeru 2, formularz niesie 1.
  // Odmowa MA BYĆ czytelna, a nie ciche podstawienie numeru 2 — inaczej stara karta
  // w drugiej zakładce nadawałaby paczki, o których operator nie wie.
  it('numer kolejny inny niż spodziewany → 400 z czytelnym komunikatem, DPD NIETKNIĘTE', async () => {
    const { dpd, fetchImpl } = dpdKlient();
    const { serwer, id } = zServerem({ dpd });
    await serwer.ready();
    await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: { ...PACZKA, kolejnosc: '1' } });
    const przedProba = kopertyV10(fetchImpl).length;

    const r = await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: { ...PACZKA, kolejnosc: '1' },
    });
    expect(r.statusCode).toBe(400);
    // Komunikat ma nazwać OBA numery — przysłany i spodziewany. Bez nich operator nie wie,
    // czy panel odmówił, bo paczka już poszła, czy dlatego, że coś się zepsuło.
    expect(r.body).toMatch(/nr 1/);
    expect(r.body).toMatch(/nr 2/);
    expect(r.body).toMatch(/odśwież|otwórz/i);
    expect(kopertyV10(fetchImpl)).toHaveLength(przedProba);
  });

  it('numer kolejny z przyszłości (formularz podrobiony) → 400 i ani jednej przesyłki', async () => {
    const { dpd, fetchImpl } = dpdKlient();
    const { serwer, id } = zServerem({ dpd });
    await serwer.ready();
    const r = await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: { ...PACZKA, kolejnosc: '7' },
    });
    expect(r.statusCode).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(przesylki(id)).toHaveLength(0);
  });

  it('brak numeru kolejnego w formularzu → 400, nie ciche podstawienie', async () => {
    const { dpd, fetchImpl } = dpdKlient();
    const { serwer, id } = zServerem({ dpd });
    await serwer.ready();
    const r = await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: PACZKA });
    expect(r.statusCode).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(przesylki(id)).toHaveLength(0);
  });

  it('numer kolejny nieliczbowy → 400', async () => {
    const { dpd, fetchImpl } = dpdKlient();
    const { serwer, id } = zServerem({ dpd });
    await serwer.ready();
    const r = await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: { ...PACZKA, kolejnosc: 'druga' },
    });
    expect(r.statusCode).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // Cel całego zadania: druga paczka CHCIANA (operator otworzył kartę na nowo i zobaczył
  // numer 2) ma przejść.
  it('świadome nadanie paczki nr 2 → obie paczki żyją, każda z własnym numerem listu', async () => {
    const { dpd } = dpdKlient();
    const { serwer, id } = zServerem({ dpd });
    await serwer.ready();
    await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: { ...PACZKA, kolejnosc: '1' } });
    const r = await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: { ...PACZKA, kolejnosc: '2' } });

    expect(r.statusCode).toBe(302);
    const p = przesylki(id);
    expect(p).toHaveLength(2);
    expect(p.map((w) => w.kolejnosc)).toEqual([1, 2]);
    expect(p[0].numer_listu).not.toBe(p[1].numer_listu);
    expect(p.every((w) => w.status === 'nadana')).toBe(true);
  });
});

// =====================================================================================
// B. Referencja dla DPD — druga, niezależna siatka
// =====================================================================================

describe('referencja wysyłana do DPD', () => {
  it('paczka nr 1 leci z gołym numerem zamówienia — bez zmian wobec dzisiaj', async () => {
    const { dpd, fetchImpl } = dpdKlient();
    const { serwer, id } = zServerem({ dpd });
    await serwer.ready();
    await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: { ...PACZKA, kolejnosc: '1' } });

    const koperta = kopertyV10(fetchImpl)[0];
    expect(koperta).toContain('<reference>1267</reference>');
    expect(koperta).toContain('<ref1>1267</ref1>');
    expect(koperta).not.toContain('1267/');
  });

  // Bez sufiksu DPD odrzuciłoby drugą paczkę jako DUPLICATED_PARCEL_SEARCH_KEY.
  it('paczka nr 2 leci z referencją „<numer>/2" w KAŻDYM polu referencji', async () => {
    const { dpd, fetchImpl } = dpdKlient();
    const { serwer, id } = zServerem({ dpd });
    await serwer.ready();
    await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: { ...PACZKA, kolejnosc: '1' } });
    await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: { ...PACZKA, kolejnosc: '2' } });

    const druga = kopertyV10(fetchImpl)[1];
    expect(druga).toContain('<parcels><reference>1267/2</reference>');
    expect(druga).toContain('<ref1>1267/2</ref1>');
    expect(druga).toContain('<reference>1267/2</reference>');
    // Goła referencja nie ma prawa zostać nigdzie w kopercie drugiej paczki.
    expect(druga).not.toMatch(/<reference>1267<\/reference>/);
    expect(druga).not.toMatch(/<ref1>1267<\/ref1>/);
  });

  it('paczka nr 3 → „<numer>/3"', async () => {
    const { dpd, fetchImpl } = dpdKlient({ paczek: 3 });
    const { serwer, id } = zServerem({ dpd });
    await serwer.ready();
    for (const k of ['1', '2', '3']) {
      await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: { ...PACZKA, kolejnosc: k } });
    }
    expect(kopertyV10(fetchImpl)[2]).toContain('<reference>1267/3</reference>');
  });
});

// =====================================================================================
// C. ⚠️ POBRANIE TYLKO NA PIERWSZEJ PACZCE — jedyna zmiana, która kosztuje pieniądze
//    klienta, gdy jest zła.
// =====================================================================================

describe('pobranie (COD) jedzie WYŁĄCZNIE na pierwszej paczce', () => {
  const zPobraniem = { metoda_wysylki: 'dpd', pobranie: 1, kwota_pobrania: '212.90' };
  // ⚠️ ZMIANA Z4 (2026-08-05): przy zamówieniu ZA POBRANIEM formularz paczki nr 1 niesie
  // teraz pole `kwota_pobrania`, wypełnione dzisiejszą kwotą efektywną — a jego brak jest
  // ODMOWĄ, nie „nadaniem bez pobrania" (paczka pojechałaby jako przedpłacona i nikt by się
  // o tym nie dowiedział). Payloady poniżej odsyłają je tak, jak odesłałaby prawdziwa
  // przeglądarka — dokładnie tą samą drogą, którą wcześniej dołożono tu adres i `kolejnosc`.
  // Paczka nr 2 pola NIE niesie, bo ekran go przy niej nie pokazuje.
  const PACZKA_POBRANIE = { ...PACZKA, kwota_pobrania: '212.90' };

  it('paczka nr 1 przy pobraniu → <cod> z kwotą', async () => {
    const { dpd, fetchImpl } = dpdKlient();
    const { serwer, id } = zServerem({ dpd, nad: zPobraniem });
    await serwer.ready();
    await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: { ...PACZKA_POBRANIE, kolejnosc: '1' } });
    expect(kopertyV10(fetchImpl)[0]).toContain('<cod><amount>212.90</amount><currency>PLN</currency></cod>');
  });

  // Powtórzenie kwoty znaczy, że kurier zainkasuje ją od klienta DRUGI RAZ.
  it('paczka nr 2 przy pobraniu → ANI ŚLADU <cod> ani kwoty', async () => {
    const { dpd, fetchImpl } = dpdKlient();
    const { serwer, id } = zServerem({ dpd, nad: zPobraniem });
    await serwer.ready();
    await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: { ...PACZKA_POBRANIE, kolejnosc: '1' } });
    await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: { ...PACZKA, kolejnosc: '2' } });

    const druga = kopertyV10(fetchImpl)[1];
    expect(druga).not.toContain('<cod>');
    expect(druga).not.toContain('212.90');
    expect(druga).toContain('<services></services>');
  });

  it('paczka nr 3 przy pobraniu → też bez <cod>', async () => {
    const { dpd, fetchImpl } = dpdKlient({ paczek: 3 });
    const { serwer, id } = zServerem({ dpd, nad: zPobraniem });
    await serwer.ready();
    for (const k of ['1', '2', '3']) {
      await serwer.inject({
        method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek,
        // Pole kwoty niesie WYŁĄCZNIE paczka nr 1 — przy kolejnych ekran go nie pokazuje.
        payload: k === '1' ? { ...PACZKA_POBRANIE, kolejnosc: k } : { ...PACZKA, kolejnosc: k },
      });
    }
    expect(kopertyV10(fetchImpl)[2]).not.toContain('<cod>');
  });

  // Ekran nadania ma to POWIEDZIEĆ WPROST, zanim operator kliknie: kwota pobrania widnieje
  // na zamówieniu, więc bez tego zdania operator ma prawo sądzić, że jedzie na obu paczkach.
  it('ekran nadania kolejnej paczki mówi WPROST, że ta paczka jedzie bez pobrania', async () => {
    const { serwer, id } = zServerem({ nad: zPobraniem });
    await serwer.ready();
    rozpocznijPrzesylke(db, id, 'dpd', 1);
    db.prepare("UPDATE przesylki SET status = 'nadana', numer_listu = 'X1' WHERE zamowienie_id = ?").run(id);

    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/BEZ POBRANIA/);
  });

  it('ekran nadania PIERWSZEJ paczki przy pobraniu nadal pokazuje kwotę do zainkasowania', async () => {
    const { serwer, id } = zServerem({ nad: zPobraniem });
    await serwer.ready();
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });
    expect(r.body).toContain('212.90');
    expect(r.body).not.toMatch(/BEZ POBRANIA/);
  });
});

// =====================================================================================
// D. Model danych i statusy
// =====================================================================================

describe('pobierzZamowienie oddaje LISTĘ przesyłek', () => {
  it('bez paczek → pusta lista, nie null', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    expect(pobierzZamowienie(db, id).przesylki).toEqual([]);
  });

  it('lista jest uporządkowana po numerze kolejnym', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    db.prepare("INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, kolejnosc, utworzona_at) VALUES (?, 'dpd', 'nadana', 'B', 2, '2026-07-29')").run(id);
    db.prepare("INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, kolejnosc, utworzona_at) VALUES (?, 'dpd', 'nadana', 'A', 1, '2026-07-29')").run(id);
    expect(pobierzZamowienie(db, id).przesylki.map((p) => p.numer_listu)).toEqual(['A', 'B']);
  });

  it('paczki na statusie „blad" nie wchodzą na listę', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    db.prepare("INSERT INTO przesylki (zamowienie_id, kurier, status, kolejnosc, utworzona_at) VALUES (?, 'dpd', 'blad', 1, '2026-07-29')").run(id);
    expect(pobierzZamowienie(db, id).przesylki).toEqual([]);
  });
});

describe('status zamówienia z wieloma paczkami', () => {
  // ⚠️ ZMIANA 2026-07-31: status wyslany wynika z `wyslane_at`, nie z istnienia paczki.
  const zam = (przesylki, nad = {}) => ({
    anulowane: 0, zwrot_at: null, w_realizacji_at: null, wyslane_at: null, przesylki, faktura: null, ...nad,
  });
  const nadana = (nad = {}) => ({
    status: 'nadana', kolejnosc: 1, numer_listu: 'X1', etykieta_sciezka: '/e/1.pdf',
    utworzona_at: new Date().toISOString(), ...nad,
  });

  it('sama nadana paczka to jeszcze NIE „wysłane" — etykieta to nie wyjazd paczki', () => {
    expect(wyliczStatus(zam([nadana()]))).not.toBe('wyslane');
  });

  it('„wysłane" bierze sie z daty wysylki, niezaleznie od liczby paczek', () => {
    expect(wyliczStatus(zam([nadana()], { wyslane_at: '2026-07-31' }))).toBe('wyslane');
  });

  it('paczka nr 1 nadana, nr 2 dopiero w trakcie → nadal „wysłane"', () => {
    const wTrakcie = { status: 'w_trakcie', kolejnosc: 2, utworzona_at: new Date().toISOString() };
    expect(wyliczStatus(zam([nadana(), wTrakcie], { wyslane_at: '2026-07-31' }))).toBe('wyslane');
  });

  it('żadna paczka nie jest nadana → nie „wysłane"', () => {
    expect(wyliczStatus(zam([{ status: 'do_wyjasnienia', kolejnosc: 1, numer_listu: 'X1', utworzona_at: new Date().toISOString() }])))
      .not.toBe('wyslane');
  });
});

// Zniknięcie sprawy z listy roboczej było już raz naprawianą wadą — przy dwóch paczkach
// wróciłaby, gdyby panel patrzył tylko na pierwszą.
describe('sprawy liczą się PER PACZKA', () => {
  const teraz = () => new Date().toISOString();
  const nadana = (nad = {}) => ({
    status: 'nadana', kolejnosc: 1, numer_listu: 'X1', etykieta_sciezka: '/e/1.pdf', utworzona_at: teraz(), ...nad,
  });

  it('sprawa na DRUGIEJ paczce wypycha zamówienie na listę roboczą', () => {
    const z = {
      anulowane: 0, zwrot_at: null, w_realizacji_at: null, wyslane_at: teraz(), faktura: null,
      przesylki: [nadana(), nadana({ kolejnosc: 2, numer_listu: 'X2', sync_woo_blad: 'notatka: sklep padł' })],
    };
    expect(wyliczStatus(z)).toBe('wyslane');
    expect(doZrobienia(z)).toBe(true);
  });

  it('obie paczki czyste → zamówienie schodzi z listy roboczej', () => {
    const z = {
      anulowane: 0, zwrot_at: null, w_realizacji_at: null, wyslane_at: teraz(), faktura: null,
      przesylki: [nadana(), nadana({ kolejnosc: 2, numer_listu: 'X2' })],
    };
    expect(doZrobienia(z)).toBe(false);
  });

  it('sprawyZamowienia przy JEDNEJ paczce daje gołe etykiety, jak dotąd', () => {
    expect(sprawyZamowienia([nadana({ etykieta_sciezka: null })])).toEqual(['brak etykiety']);
  });

  it('sprawyZamowienia przy WIELU paczkach mówi, KTÓREJ paczki dotyczy sprawa', () => {
    const sprawy = sprawyZamowienia([nadana(), nadana({ kolejnosc: 2, numer_listu: 'X2', etykieta_sciezka: null })]);
    expect(sprawy).toEqual(['paczka 2: brak etykiety']);
  });
});

// =====================================================================================
// E. Obsługa z panelu
// =====================================================================================

describe('karta zamówienia — akcja nadania', () => {
  const nadanaPaczka = (id, kolejnosc, numerListu) => db.prepare(
    'INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, etykieta_sciezka, kolejnosc, utworzona_at)'
    + " VALUES (?, 'dpd', 'nadana', ?, '/e/1.pdf', ?, '2026-07-29')",
  ).run(id, numerListu, kolejnosc);

  it('bez żywej paczki → „Nadaj paczkę", BEZ „Nadaj kolejną paczkę"', async () => {
    const { serwer, id } = zServerem();
    await serwer.ready();
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).toContain('Nadaj paczkę');
    expect(r.body).not.toContain('Nadaj kolejną paczkę');
  });

  // „Inna akcja, świadomie wybrana": przypadkowe kliknięcie w to samo miejsce nie ma prawa
  // stworzyć drugiego listu, więc etykieta MUSI się różnić.
  it('z żywą paczką → „Nadaj kolejną paczkę" zamiast „Nadaj paczkę"', async () => {
    const { serwer, id } = zServerem();
    await serwer.ready();
    nadanaPaczka(id, 1, 'X1');
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).toContain('Nadaj kolejną paczkę');
    expect(r.body).not.toContain('>Nadaj paczkę');
  });

  it('nadanie w toku → ŻADNEJ propozycji nadania (to jest okno podwójnego kliknięcia)', async () => {
    const { serwer, id } = zServerem();
    await serwer.ready();
    rozpocznijPrzesylke(db, id, 'dpd', 1);
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).not.toContain('Nadaj kolejną paczkę');
    expect(r.body).not.toContain('Nadaj paczkę');
    // Milczenie byłoby gorsze niż brak przycisku: karta pokazywałaby nagłówek „Paczka 1"
    // i pod nim pustkę, co czyta się jak awaria widoku, a nie jak trwające wywołanie.
    expect(r.body).toMatch(/właśnie trwa/i);
  });

  it('nadanie zawieszone → ŻADNEJ propozycji nadania, dopóki człowiek nie sprawdzi w DPD', async () => {
    const { serwer, id } = zServerem();
    await serwer.ready();
    const dawno = new Date(Date.now() - PROG_ZAWIESZONEGO_NADANIA_MS - 60_000).toISOString();
    db.prepare("INSERT INTO przesylki (zamowienie_id, kurier, status, kolejnosc, utworzona_at) VALUES (?, 'dpd', 'w_trakcie', 1, ?)").run(id, dawno);
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).not.toContain('Nadaj kolejną paczkę');
    expect(r.body).toContain('ZAWIESZONE');
  });

  it('karta pokazuje WSZYSTKIE paczki: numer kolejny, numer listu, link do śledzenia', async () => {
    const { serwer, id } = zServerem();
    await serwer.ready();
    nadanaPaczka(id, 1, '1000000000001U');
    nadanaPaczka(id, 2, '1048069488099X');
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).toContain('1000000000001U');
    expect(r.body).toContain('1048069488099X');
    expect(r.body).toMatch(/Paczka 1/);
    expect(r.body).toMatch(/Paczka 2/);
    expect(r.body).toContain('tracktrace.dpd.com.pl/parcelDetails?p1=1048069488099X');
  });

  it('każda paczka ma WŁASNY link „Pobierz" wskazujący konkretną przesyłkę', async () => {
    const { serwer, id } = zServerem();
    await serwer.ready();
    nadanaPaczka(id, 1, 'X1');
    nadanaPaczka(id, 2, 'X2');
    const ids = przesylki(id).map((p) => p.id);
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).toContain(`/zamowienia/${id}/przesylki/${ids[0]}/etykieta`);
    expect(r.body).toContain(`/zamowienia/${id}/przesylki/${ids[1]}/etykieta`);
  });
});

describe('ekran nadania kolejnej paczki', () => {
  const nadanaPaczka = (id) => db.prepare(
    "INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, kolejnosc, utworzona_at) VALUES (?, 'dpd', 'nadana', 'X1', 1, '2026-07-29')",
  ).run(id);

  it('niesie numer kolejny w formularzu — to on pilnuje podwójnego kliknięcia', async () => {
    const { serwer, id } = zServerem();
    await serwer.ready();
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });
    expect(r.body).toContain('name="kolejnosc" value="1"');
  });

  it('przy istniejącej paczce niesie numer 2 i mówi, że to paczka nr 2', async () => {
    const { serwer, id } = zServerem();
    await serwer.ready();
    nadanaPaczka(id);
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });
    expect(r.body).toContain('name="kolejnosc" value="2"');
    expect(r.body).toMatch(/paczk[ai] nr 2/i);
  });

  // Zadanie 5 (plan „ekran nadania", decyzja właściciela 04.08): pole „Komentarz" zostało
  // USUNIĘTE z ekranu — zarówno przy pierwszej, jak i przy kolejnej paczce. POST i
  // `nadanie.nadaj()` zostają nietknięte (patrz testy niżej: komentarz przesłany w
  // payloadzie POST-a nadal trafia do logu, mimo że pola na ekranie już nie ma).
  it('pole Komentarz NIE istnieje ani przy pierwszej, ani przy kolejnej paczce (Zadanie 5)', async () => {
    const { serwer, id } = zServerem();
    await serwer.ready();
    const pierwsza = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });
    expect(pierwsza.body).not.toContain('name="komentarz"');
    expect(pierwsza.body).not.toContain('name="powod"');

    nadanaPaczka(id);
    const kolejna = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });
    expect(kolejna.body).not.toContain('name="komentarz"');
  });

  // Karta tu nie prowadzi, gdy nadanie innej paczki wisi — ale adres da się wpisać z ręki
  // albo mieć otwarty w drugiej zakładce. Ekran, który zapewnia „zatwierdzenie nada paczkę
  // nr 2", podczas gdy usługa i tak odmówi, kłamałby operatorowi.
  it('nadanie innej paczki w toku → ekran nadania odmawia, zamiast obiecywać paczkę nr 2', async () => {
    const { serwer, id } = zServerem();
    await serwer.ready();
    rozpocznijPrzesylke(db, id, 'dpd', 1);
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toContain('name="kolejnosc"');
  });

  it('oba przyciski zatwierdzające zostają także przy kolejnej paczce', async () => {
    const { serwer, id } = zServerem();
    await serwer.ready();
    nadanaPaczka(id);
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });
    expect(r.body).toContain('name="zatwierdzenie" value="nadaj">Nadaj przesyłkę<');
    expect(r.body).toContain('name="zatwierdzenie" value="nadaj_i_drukuj">Nadaj i drukuj<');
  });

  it('komentarz kolejnej paczki trafia do logu zamówienia', async () => {
    const { dpd } = dpdKlient();
    const { serwer, id } = zServerem({ dpd });
    await serwer.ready();
    await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: { ...PACZKA, kolejnosc: '1' } });
    await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek,
      payload: { ...PACZKA, kolejnosc: '2', komentarz: 'zamiennik za zgubioną' },
    });
    const wpisy = db.prepare("SELECT * FROM log WHERE zamowienie_id = ? AND akcja = 'nadanie.kolejna'").all(id);
    expect(wpisy).toHaveLength(1);
    expect(wpisy[0].wynik).toContain('zamiennik za zgubioną');
    expect(wpisy[0].wynik).toContain('2');
  });

  // Komentarz przy PIERWSZEJ paczce (dostępny od Zadania „adres edytowalny") trafia do
  // logu pod OSOBNĄ akcją ('nadanie.komentarz'), nie 'nadanie.kolejna' — ta ostatnia mówi
  // wyłącznie o paczkach N > 1.
  it('komentarz przy PIERWSZEJ paczce trafia do logu zamówienia', async () => {
    const { dpd } = dpdKlient();
    const { serwer, id } = zServerem({ dpd });
    await serwer.ready();
    await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek,
      payload: { ...PACZKA, kolejnosc: '1', komentarz: 'klient prosił o kartonik z watą' },
    });
    const wpisy = db.prepare("SELECT * FROM log WHERE zamowienie_id = ?").all(id);
    expect(wpisy.some((w) => w.wynik.includes('klient prosił o kartonik z watą'))).toBe(true);
  });

  it('komentarz pusty przy kolejnej paczce → log i tak zapamiętuje, że powodu NIE PODANO', async () => {
    const { dpd } = dpdKlient();
    const { serwer, id } = zServerem({ dpd });
    await serwer.ready();
    await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: { ...PACZKA, kolejnosc: '1' } });
    await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: { ...PACZKA, kolejnosc: '2' } });
    const wpis = db.prepare("SELECT * FROM log WHERE zamowienie_id = ? AND akcja = 'nadanie.kolejna'").get(id);
    expect(wpis.wynik).toMatch(/nie podano/i);
  });

  it('przy PIERWSZEJ paczce wpisu „nadanie.kolejna" w logu nie ma', async () => {
    const { dpd } = dpdKlient();
    const { serwer, id } = zServerem({ dpd });
    await serwer.ready();
    await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: { ...PACZKA, kolejnosc: '1' } });
    expect(db.prepare("SELECT COUNT(*) c FROM log WHERE akcja = 'nadanie.kolejna'").get().c).toBe(0);
  });
});

describe('mozliwaKolejnaPaczka', () => {
  const teraz = () => new Date().toISOString();

  it('bez paczek → prawda (to zwykłe pierwsze nadanie)', () => {
    expect(mozliwaKolejnaPaczka([])).toBe(true);
  });

  it('paczka nadana → prawda', () => {
    expect(mozliwaKolejnaPaczka([{ status: 'nadana', utworzona_at: teraz() }])).toBe(true);
  });

  it('nadanie w toku → fałsz (okno podwójnego kliknięcia)', () => {
    expect(mozliwaKolejnaPaczka([{ status: 'w_trakcie', utworzona_at: teraz() }])).toBe(false);
  });

  it('nadanie zawieszone → fałsz (nie wiemy, czy paczka u kuriera powstała)', () => {
    const dawno = new Date(Date.now() - PROG_ZAWIESZONEGO_NADANIA_MS - 60_000).toISOString();
    expect(mozliwaKolejnaPaczka([{ status: 'w_trakcie', utworzona_at: dawno }])).toBe(false);
  });

  it('jedna paczka nadana, druga w toku → fałsz', () => {
    expect(mozliwaKolejnaPaczka([
      { status: 'nadana', utworzona_at: teraz() },
      { status: 'w_trakcie', utworzona_at: teraz() },
    ])).toBe(false);
  });
});

// Nawet gdyby widok skusił operatora, usługa MUSI odmówić sama — karta pokazuje stan
// sprzed sekund (dokładnie ta sama zasada co przy zamówieniu anulowanym).
describe('rozpocznijPrzesylke — twarda odmowa przy nadaniu w toku', () => {
  const zZamowieniem = () => {
    db.prepare("INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, utworzone_at) VALUES ('pro', 1, '1', '10.00', '2026-07-29')").run();
    return 1;
  };

  it('kolejna paczka przy nadaniu w toku → odmowa, mimo INNEGO numeru kolejnego', () => {
    zZamowieniem();
    rozpocznijPrzesylke(db, 1, 'dpd', 1);
    expect(() => rozpocznijPrzesylke(db, 1, 'dpd', 2)).toThrow(/właśnie trwa/i);
    expect(db.prepare('SELECT COUNT(*) c FROM przesylki').get().c).toBe(1);
  });

  it('kolejna paczka przy nadaniu ZAWIESZONYM → odmowa z odesłaniem do panelu DPD', () => {
    zZamowieniem();
    const p = rozpocznijPrzesylke(db, 1, 'dpd', 1);
    const dawno = new Date(Date.now() - PROG_ZAWIESZONEGO_NADANIA_MS - 60_000).toISOString();
    db.prepare('UPDATE przesylki SET utworzona_at = ? WHERE id = ?').run(dawno, p.id);
    expect(() => rozpocznijPrzesylke(db, 1, 'dpd', 2)).toThrow(/panelu DPD/i);
  });

  it('kolejna paczka przy paczce NADANEJ → wolno', () => {
    zZamowieniem();
    const p = rozpocznijPrzesylke(db, 1, 'dpd', 1);
    db.prepare("UPDATE przesylki SET status = 'nadana', numer_listu = 'X1' WHERE id = ?").run(p.id);
    expect(() => rozpocznijPrzesylke(db, 1, 'dpd', 2)).not.toThrow();
    expect(zywePrzesylki(db, 1)).toHaveLength(2);
  });
});

// =====================================================================================
// Trasy per paczka — dziś zakładają jedną
// =====================================================================================

describe('trasy wskazują KONKRETNĄ paczkę', () => {
  const zDwiemaPaczkami = (id) => {
    db.prepare(
      'INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, etykieta_sciezka, etykieta_zpl_sciezka, kolejnosc, utworzona_at)'
      + " VALUES (?, 'dpd', 'nadana', 'X1', '/e/1.pdf', '/e/1.zpl', 1, '2026-07-29')",
    ).run(id);
    db.prepare(
      'INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, etykieta_sciezka, etykieta_zpl_sciezka, kolejnosc, utworzona_at)'
      + " VALUES (?, 'dpd', 'nadana', 'X2', '/e/2.pdf', '/e/2.zpl', 2, '2026-07-29')",
    ).run(id);
    return przesylki(id).map((p) => p.id);
  };

  it('druk wstawia do kolejki TĘ paczkę, którą wskazuje adres', async () => {
    const { serwer, id } = zServerem();
    await serwer.ready();
    const [, drugaId] = zDwiemaPaczkami(id);
    const r = await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/przesylki/${drugaId}/drukuj`, headers: naglowek });
    expect(r.statusCode).toBe(302);
    const wiersze = db.prepare('SELECT * FROM kolejka_druku').all();
    expect(wiersze).toHaveLength(1);
    expect(wiersze[0].przesylka_id).toBe(drugaId);
  });

  it('paczka z INNEGO zamówienia → 404, a nie cicha operacja na cudzej przesyłce', async () => {
    const { serwer, id } = zServerem();
    await serwer.ready();
    zDwiemaPaczkami(id);
    const obceId = zapiszZamowienie(db, 'pro', zmapowane({ zrodlo_id: 9999, numer: '9999' }), {});
    db.prepare("INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, etykieta_zpl_sciezka, kolejnosc, utworzona_at) VALUES (?, 'dpd', 'nadana', 'Y1', '/e/y.zpl', 1, '2026-07-29')").run(obceId);
    const obcaPrzesylka = db.prepare('SELECT id FROM przesylki WHERE zamowienie_id = ?').get(obceId).id;

    const r = await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/przesylki/${obcaPrzesylka}/drukuj`, headers: naglowek });
    expect(r.statusCode).toBe(404);
    expect(db.prepare('SELECT COUNT(*) c FROM kolejka_druku').get().c).toBe(0);
  });

  it('domknięcie dotyczy TEJ paczki, którą wskazuje adres — pierwsza zostaje nietknięta', async () => {
    const { serwer, id } = zServerem();
    await serwer.ready();
    const [pierwszaId, drugaId] = zDwiemaPaczkami(id);
    db.prepare("UPDATE przesylki SET status = 'do_wyjasnienia', blad_opis = 'NOT_FOUND' WHERE id = ?").run(drugaId);

    const r = await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/przesylki/${drugaId}/domknij`, headers: naglowek });
    expect(r.statusCode).toBe(302);
    expect(db.prepare('SELECT status FROM przesylki WHERE id = ?').get(drugaId).status).toBe('nadana');
    expect(db.prepare('SELECT status FROM przesylki WHERE id = ?').get(pierwszaId).status).toBe('nadana');
  });

  it('„załatwione ręcznie" zdejmuje sprawę TEJ paczki, nie pierwszej z brzegu', async () => {
    const { serwer, id } = zServerem();
    await serwer.ready();
    const [pierwszaId, drugaId] = zDwiemaPaczkami(id);
    db.prepare("UPDATE przesylki SET sync_woo_blad = 'notatka: sklep padł' WHERE id IN (?, ?)").run(pierwszaId, drugaId);

    await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/przesylki/${drugaId}/sprawa-zalatwiona`, headers: naglowek });
    expect(db.prepare('SELECT sync_woo_blad FROM przesylki WHERE id = ?').get(drugaId).sync_woo_blad).toBeNull();
    expect(db.prepare('SELECT sync_woo_blad FROM przesylki WHERE id = ?').get(pierwszaId).sync_woo_blad).not.toBeNull();
  });
});

// =====================================================================================
// UKRYCIE PACZKI, KTORA ZASTAPILA KOLEJNA (04.09.2026, zgloszenie wlasciciela)
// =====================================================================================

describe('karta zamówienia — ukrywanie paczki zastąpionej przez kolejną', () => {
  const dwiePaczki = async () => {
    const { serwer, id, nadanie } = zServerem({ nad: {} });
    await serwer.ready();
    await nadanie.nadaj(id, { waga: 1, dlugosc: 110, szerokosc: 75, wysokosc: 1 }, { kolejnosc: 1 });
    await nadanie.nadaj(id, { waga: 1, dlugosc: 110, szerokosc: 75, wysokosc: 1 }, { kolejnosc: 2 });
    return { serwer, id };
  };

  it('ukrywa paczkę nr 1 i zostawia ślad w logu', async () => {
    const { serwer, id } = await dwiePaczki();
    const p1 = przesylki(id)[0];
    const r = await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/przesylki/${p1.id}/ukryj`, headers: naglowek, payload: {},
    });
    expect(r.statusCode).toBe(302);
    expect(przesylki(id)[0].ukryta_at).toBeTruthy();
    const log = db.prepare("SELECT * FROM log WHERE akcja = 'przesylka.ukryj'").all();
    expect(log).toHaveLength(1);
    expect(log[0].wynik).toMatch(/Ręcznie( \(|:)/);
  });

  // ⚠️ WIDOK NIE JEST BARIERA. Zadanie ze starej karty (albo zlozone z reki) na paczke,
  // ktorej nic nie zastapilo, musi sie odbic — inaczej „Ukryj" staje sie wylacznikiem
  // listy roboczej per paczka.
  it('odmawia ukrycia najnowszej paczki', async () => {
    const { serwer, id } = await dwiePaczki();
    const p2 = przesylki(id)[1];
    const r = await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/przesylki/${p2.id}/ukryj`, headers: naglowek, payload: {},
    });
    expect(r.statusCode).toBe(400);
    expect(przesylki(id)[1].ukryta_at).toBeFalsy();
  });

  it('odmawia ukrycia jedynej paczki zamówienia', async () => {
    const { serwer, id, nadanie } = zServerem({ nad: {} });
    await serwer.ready();
    await nadanie.nadaj(id, { waga: 1, dlugosc: 110, szerokosc: 75, wysokosc: 1 }, { kolejnosc: 1 });
    const p1 = przesylki(id)[0];
    const r = await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/przesylki/${p1.id}/ukryj`, headers: naglowek, payload: {},
    });
    expect(r.statusCode).toBe(400);
    expect(przesylki(id)[0].ukryta_at).toBeFalsy();
  });

  it('przywraca ukrytą paczkę', async () => {
    const { serwer, id } = await dwiePaczki();
    const p1 = przesylki(id)[0];
    await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/przesylki/${p1.id}/ukryj`, headers: naglowek, payload: {},
    });
    const r = await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/przesylki/${p1.id}/przywroc`, headers: naglowek, payload: {},
    });
    expect(r.statusCode).toBe(302);
    expect(przesylki(id)[0].ukryta_at).toBeFalsy();
    expect(przesylki(id)[0].ukryta_przez).toBeFalsy();
  });

  // Przycisk pokazuje sie WYLACZNIE przy paczce zastapionej — karta nie ma kusic akcja,
  // ktora i tak odbije sie od 400.
  it('karta pokazuje „Ukryj" tylko przy paczce nr 1', async () => {
    const { serwer, id } = await dwiePaczki();
    const [p1, p2] = przesylki(id);
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).toContain(`/przesylki/${p1.id}/ukryj`);
    expect(r.body).not.toContain(`/przesylki/${p2.id}/ukryj`);
  });
});
