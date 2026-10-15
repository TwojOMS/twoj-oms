// =====================================================================================
// Z4 — KWOTA POBRANIA EDYTOWALNA NA EKRANIE NADANIA.
//
// ⚠️ TO SĄ PRAWDZIWE PIENIĄDZE. Kwota pobrania to gotówka, którą kurier inkasuje od
// klienta przy doręczeniu; po nadaniu nie da się jej odkręcić inaczej niż w panelu DPD.
// Dlatego ten plik pilnuje nie tego, że pole „działa", tylko czterech rzeczy, których
// złamanie kosztuje pieniądze klienta:
//
//  1. pole ISTNIEJE wyłącznie przy pobraniu i wyłącznie na paczce nr 1 (przy paczce N > 1
//     kurier zainkasowałby od klienta DRUGI RAZ);
//  2. PUSTE pole to ODMOWA, nigdy „bez pobrania" — DPD przy braku kwoty po prostu nie
//     wstawia <cod>, więc paczka pojechałaby jak przedpłacona i NIGDZIE nie byłoby błędu;
//  3. kwota FAKTYCZNIE UŻYTA ląduje w logu zamówienia — bez górnego progu (decyzja
//     właściciela 04.08) to jedyna droga, żeby po miesiącu odpowiedzieć, ile kurier miał
//     zainkasować, gdy ktoś wpisze „31033" zamiast „310,33";
//  4. zamówienie BEZ pobrania dostaje kopertę bez <cod>, choćby ktoś podrzucił pole
//     w żądaniu — inaczej przesyłkę przedpłaconą dałoby się zamienić w pobraniową.
// =====================================================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { rozpocznijPrzesylke } from '../../../src/moduly/wysylka/db/przesylki.js';
import { createNadanie } from '../../../src/moduly/wysylka/services/nadanie.js';
import { createDpdClient } from '../../../src/oms/kurierzy/dpd.js';
import { createInpostClient } from '../../../src/oms/kurierzy/inpost.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { parsujNadpisanieKwotyPobrania } from '../../../src/domena/pobranie-nadania.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => readFileSync(join(__dir, 'fixtures', 'dpd', n), 'utf8');
const odp = (status, tekst) => ({ status, ok: status >= 200 && status < 300, text: async () => tekst });

const config = { auth: { user: 'adam', pass: 'x' } };
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };
const NADAWCA = { nazwa: 'Lumina', ulica: 'ul. 1 Maja 5', kod: '00-650', miasto: 'Pęki', kraj: 'PL', phone: '338451234', email: 'sklep@szkicownia.pl' };

// Adres odbiorcy zgodny z `zmapowane()` niżej — POST wymaga go w formularzu.
const ADRES = {
  nazwa: 'Jan Kowalski', ulica: 'Polna 1', kod: '00-650', miasto: 'Pęki',
  phone: '+48500600700', email: 'j@k.pl',
};
// Formularz taki, jaki odesłałaby PRAWDZIWA przeglądarka z ekranu nadania zamówienia
// ZA POBRANIEM: pole kwoty jest w nim wypełnione dzisiejszą kwotą efektywną.
const PACZKA = { waga: '1', dlugosc: '110', szerokosc: '75', wysokosc: '1', kolejnosc: '1', ...ADRES };
const PACZKA_Z_POBRANIEM = { ...PACZKA, kwota_pobrania: '212.90' };

const zmapowane = (nad = {}) => ({
  zrodlo_id: 1267, numer: '1267',
  klient: { email: 'j@k.pl', phone: '+48500600700' },
  dostawa: { first_name: 'Jan', last_name: 'Kowalski', address_1: 'Polna 1', postcode: '00-650', city: 'Pęki', country: 'PL' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '212.90',
  status_woo: 'processing', oplacone_at: '2026-07-29T13:00:00', anulowane: 0,
  utworzone_at: '2026-07-29T13:19:52', pozycje: [], ...nad,
});

const POBRANIE = { metoda_wysylki: 'dpd', pobranie: 1, kwota_pobrania: '212.90' };

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

const kopertyV10 = (fetchImpl) => fetchImpl.mock.calls
  .map((c) => c[1].body)
  .filter((b) => b.includes('generatePackagesNumbersV10'));

let db;
beforeEach(() => {
  db = openOmsDb(':memory:');
});

function zServerem({ nad = {}, dpd } = {}) {
  const katalogEtykiet = mkdtempSync(join(tmpdir(), 'oms-pobranie-'));
  const dpdKl = dpd ?? dpdKlient().dpd;
  const klienci = { pro: { dodajNotatke: vi.fn().mockResolvedValue({}) } };
  const nadanie = createNadanie({ db, kurierzy: { dpd: dpdKl }, klienci, katalogEtykiet });
  const serwer = buildOmsServer({ db, config, poller, nadanie });
  const id = zapiszZamowienie(db, 'pro', zmapowane(nad), {});
  return { serwer, id, nadanie };
}

const przesylki = (id) => db.prepare('SELECT * FROM przesylki WHERE zamowienie_id = ?').all(id);
const logi = (id) => db.prepare('SELECT akcja, wynik FROM log WHERE zamowienie_id = ? ORDER BY id').all(id);

// =====================================================================================
// A. REGUŁA BEZ SIECI I BEZ BAZY — domain/pobranie-nadania.js
// =====================================================================================

describe('parsujNadpisanieKwotyPobrania — pole istnieje tylko tam, gdzie ma prawo istnieć', () => {
  // ⚠️ Zamówienie bez pobrania: nadpisania NIE MA, choćby pole przyszło w żądaniu.
  // Inaczej przesyłkę przedpłaconą dałoby się zamienić w pobraniową jednym polem formularza.
  it('bez pobrania → brak nadpisania, nawet gdy ktoś podrzucił pole', () => {
    const w = parsujNadpisanieKwotyPobrania({ kwota_pobrania: '999.00' }, { pobranie: 0, kolejnosc: 1 });
    expect(w.blad).toBeUndefined();
    expect(w.kwotaPobrania).toBeUndefined();
  });

  // ⚠️ Paczka N > 1: kwota należy do ZAMÓWIENIA, nie do paczki. Warunek „COD tylko na
  // paczce nr 1" mieszka w kurierzy/dpd.js i nadpisanie nie ma prawa go obejść — tu
  // pilnujemy, żeby wartość w ogóle nie wyruszyła w tamtą stronę.
  it('paczka nr 2 → brak nadpisania, nawet gdy ktoś podrzucił pole', () => {
    const w = parsujNadpisanieKwotyPobrania({ kwota_pobrania: '999.00' }, { pobranie: 1, kolejnosc: 2 });
    expect(w.blad).toBeUndefined();
    expect(w.kwotaPobrania).toBeUndefined();
  });

  // ZAMIENNIK WYRZUCONEJ ETYKIETY (04.09.2026). Gdy operator ŚWIADOMIE każe pobraniu pojechać
  // na paczce nr 2, pole na ekranie ISTNIEJE — więc jego wartość musi przejść, a nie zostać
  // po cichu zignorowana. Cichy zwrot `undefined` byłby tu najgorszym z możliwych wyników:
  // paczka pojechałaby z kwotą Z ZAMÓWIENIA (74 zł zamiast 123 zł) i nikt by się nie dowiedział.
  it('paczka nr 2 z decyzją operatora → nadpisanie przechodzi', () => {
    const w = parsujNadpisanieKwotyPobrania(
      { kwota_pobrania: '123.00' },
      { pobranie: 1, kolejnosc: 2, pobranieNaTejPaczce: true },
    );
    expect(w.blad).toBeUndefined();
    expect(w.kwotaPobrania).toBe('123.00');
  });

  // ⚠️ Decyzja operatora NIE zamienia zamówienia przedpłaconego w pobraniowe — `pobranie`
  // zostaje pierwszym i nadrzędnym warunkiem.
  it('przedpłata + decyzja operatora → nadal brak nadpisania', () => {
    const w = parsujNadpisanieKwotyPobrania(
      { kwota_pobrania: '999.00' },
      { pobranie: 0, kolejnosc: 2, pobranieNaTejPaczce: true },
    );
    expect(w.blad).toBeUndefined();
    expect(w.kwotaPobrania).toBeUndefined();
  });

  // Puste pole przy świadomej decyzji to ODMOWA, dokładnie jak na paczce nr 1 — inaczej
  // zamiennik pojechałby jako przedpłacony i kurier nie zainkasowałby ani złotówki.
  it('paczka nr 2 z decyzją operatora, pusta kwota → odmowa', () => {
    const w = parsujNadpisanieKwotyPobrania(
      { kwota_pobrania: '  ' },
      { pobranie: 1, kolejnosc: 2, pobranieNaTejPaczce: true },
    );
    expect(w.blad).toMatch(/pusta/i);
    expect(w.kwotaPobrania).toBeUndefined();
  });
});

describe('parsujNadpisanieKwotyPobrania — walidacja kwoty', () => {
  const parsuj = (kwota) => parsujNadpisanieKwotyPobrania(
    kwota === undefined ? {} : { kwota_pobrania: kwota },
    { pobranie: 1, kolejnosc: 1 },
  );

  it('kwota ze sklepu przechodzi ZNAK W ZNAK', () => {
    expect(parsuj('212.90')).toEqual({ kwotaPobrania: '212.90' });
  });

  it('przecinek dziesiętny jest normalny, nie błędny', () => {
    expect(parsuj('310,33')).toEqual({ kwotaPobrania: '310.33' });
  });

  it('białe znaki wokół kwoty są przycinane', () => {
    expect(parsuj('  212.90  ')).toEqual({ kwotaPobrania: '212.90' });
  });

  // ⚠️ NAJWAŻNIEJSZY TEST W TYM PLIKU. DPD przy pustej kwocie po prostu nie wstawia <cod>:
  // paczka jedzie jak przedpłacona, kurier nie inkasuje nic i NIGDZIE nie ma błędu.
  it.each([
    ['puste pole', ''],
    ['same spacje', '   '],
    ['pole w ogóle nieprzysłane', undefined],
  // ⚠️ Odmowa ma być CZYTELNA, nie byle jaka. Bez tej asercji mutacja kasująca gałąź pustej
  // wartości PRZEŻYWA: pusty napis wpada wtedy do gałęzi „nie umiem odczytać" i operator
  // dostaje komunikat cytujący pustkę („nie umiem odczytać kwoty pobrania: „""), zamiast
  // zdania mówiącego wprost, że puste pole NIE znaczy „nadaj bez pobrania".
  ])('%s → ODMOWA, nigdy „bez pobrania", i to CZYTELNA', (_nazwa, wejscie) => {
    const w = parsuj(wejscie);
    expect(w.kwotaPobrania).toBeUndefined();
    expect(w.blad).toMatch(/pusta/i);
    expect(w.blad).toMatch(/bez pobrania/i);
  });

  it.each([
    ['zero', '0'],
    ['zero z groszami', '0,00'],
    ['ujemna', '-310.33'],
    ['tekst', 'dużo'],
    ['tekst z jednostką', '310 zł'],
    ['notacja wykładnicza', '1e3'],
    ['zapis szesnastkowy', '0x10'],
  ])('%s → ODMOWA, kwota nie rusza w stronę kuriera', (_nazwa, wejscie) => {
    const w = parsuj(wejscie);
    expect(w.kwotaPobrania).toBeUndefined();
    expect(w.blad).toBeTruthy();
  });

  // ⚠️ BEZ GÓRNEGO PROGU — świadoma decyzja właściciela 04.08. Literówka „31033" zamiast
  // „310,33" MA przejść do kuriera; jedyną obroną jest wpis w logu zamówienia (sekcja D).
  it('kwota podejrzanie wysoka PRZECHODZI — progu nie ma i nie ma go być', () => {
    expect(parsuj('31033')).toEqual({ kwotaPobrania: '31033' });
  });
});

// =====================================================================================
// B. EKRAN — pole widać dokładnie tam, gdzie wolno
// =====================================================================================

describe('GET /zamowienia/:id/nadaj — pole kwoty pobrania', () => {
  it('pobranie + paczka nr 1 → pole edytowalne, wypełnione dzisiejszą kwotą', async () => {
    const { serwer, id } = zServerem({ nad: POBRANIE });
    await serwer.ready();
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('name="kwota_pobrania"');
    expect(r.body).toMatch(/name="kwota_pobrania"[^>]*value="212\.90"|value="212\.90"[^>]*name="kwota_pobrania"/);
  });

  // ⚠️ ZMIANA DECYZJI 04.09.2026 (właściciel, po zamówieniu 1385). Do tego dnia pola tu NIE
  // BYŁO ANI ŚLADU, bo pobranie na paczce N > 1 było niemożliwe. Zdarzenie pokazało brakujący
  // przypadek: paczka nr 2 bywa ZAMIENNIKIEM pierwszej (wyrzucona etykieta), nie dosyłką obok
  // niej — i wtedy pobranie MUSI móc pojechać, bo inaczej kurier nie zainkasuje ani złotówki.
  //
  // Ostrzeżenie zostaje i dalej mówi, że DOMYŚLNIE ta paczka jedzie bez pobrania; pole kwoty
  // jest widoczne, ale bezczynne do chwili jawnego zaznaczenia. Sama widoczność pola NIE
  // wystarcza za dowód bezpieczeństwa — dlatego test niżej sprawdza, że bez zaznaczenia
  // wartość naprawdę nie dojeżdża do kuriera.
  it('pobranie + paczka nr 2 → ostrzeżenie zostaje, pole kwoty jest, ale wymaga zaznaczenia', async () => {
    const { serwer, id } = zServerem({ nad: POBRANIE });
    await serwer.ready();
    rozpocznijPrzesylke(db, id, 'dpd', 1);
    db.prepare("UPDATE przesylki SET status = 'nadana', numer_listu = 'X1' WHERE zamowienie_id = ?").run(id);

    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/BEZ POBRANIA/);
    expect(r.body).toContain('name="pobranie_na_tej_paczce"');
    expect(r.body).toContain('name="kwota_pobrania"');
    // ⚠️ DRUGI PAS, NIEZALEZNY OD PIENIEDZY: kolejna paczka do tego samego zamowienia jest
    // sytuacja rzadka i kosztowna (poprzednie JUZ ISTNIEJA u kuriera), wiec ekran ma ja nazwac
    // wprost, zamiast wygladac jak zwykle nadanie. Bez tej asercji zdanie dalo sie usunac
    // bez ani jednej czerwieni — zmierzone mutacja 01.09.2026.
    expect(r.body).toMatch(/KOLEJNA paczka do tego zamówienia/);
  });

  it('zamówienie bez pobrania → pola NIE MA', async () => {
    const { serwer, id } = zServerem();
    await serwer.ready();
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });
    expect(r.body).not.toContain('name="kwota_pobrania"');
  });

  // Podpowiedź pod polem mówi to, czego z samego pola nie widać: poprawka dotyczy TEJ
  // paczki i nie zapisuje się do zamówienia (wzorzec kodu paczkomatu).
  it('pole mówi wprost, że zmiana dotyczy tylko tej paczki', async () => {
    const { serwer, id } = zServerem({ nad: POBRANIE });
    await serwer.ready();
    const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers: naglowek });
    expect(r.body).toMatch(/tylko tej paczki/i);
  });
});

// =====================================================================================
// C. KOPERTA SOAP — asertujemy TREŚĆ tego, co poszło do DPD, nie sam fakt wywołania
// =====================================================================================

describe('POST /zamowienia/:id/nadaj — kwota z formularza jedzie do koperty', () => {
  it('zmieniona kwota → <cod> z KWOTĄ Z FORMULARZA, nie z zamówienia', async () => {
    const { dpd, fetchImpl } = dpdKlient();
    const { serwer, id } = zServerem({ dpd, nad: POBRANIE });
    await serwer.ready();
    const r = await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek,
      payload: { ...PACZKA_Z_POBRANIEM, kwota_pobrania: '310.33' },
    });
    expect(r.statusCode).toBe(302);
    const koperta = kopertyV10(fetchImpl)[0];
    expect(koperta).toContain('<cod><amount>310.33</amount><currency>PLN</currency></cod>');
    expect(koperta).not.toContain('212.90');
  });

  it('przecinek dziesiętny w kwocie („310,33") jedzie do DPD z KROPKĄ', async () => {
    const { dpd, fetchImpl } = dpdKlient();
    const { serwer, id } = zServerem({ dpd, nad: POBRANIE });
    await serwer.ready();
    const r = await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek,
      payload: { ...PACZKA_Z_POBRANIEM, kwota_pobrania: '310,33' },
    });
    expect(r.statusCode).toBe(302);
    expect(kopertyV10(fetchImpl)[0]).toContain('<cod><amount>310.33</amount><currency>PLN</currency></cod>');
  });

  // Kwota NIEZMIENIONA (operator tylko zatwierdził to, co panel wpisał) musi dać kopertę
  // DOKŁADNIE taką, jaką panel wysyłał przed tą zmianą.
  it('kwota niezmieniona → koperta identyczna z dzisiejszą', async () => {
    const { dpd, fetchImpl } = dpdKlient();
    const { serwer, id } = zServerem({ dpd, nad: POBRANIE });
    await serwer.ready();
    await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: PACZKA_Z_POBRANIEM,
    });
    expect(kopertyV10(fetchImpl)[0]).toContain('<cod><amount>212.90</amount><currency>PLN</currency></cod>');
  });

  // ⚠️ Ochrona przed zamianą przesyłki PRZEDPŁACONEJ w pobraniową. Żądanie spreparowane:
  // zamówienie nie jest za pobraniem, a pole mimo to przychodzi.
  it('zamówienie BEZ pobrania + podrzucone pole → koperta BEZ <cod>', async () => {
    const { dpd, fetchImpl } = dpdKlient();
    const { serwer, id } = zServerem({ dpd });
    await serwer.ready();
    const r = await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek,
      payload: { ...PACZKA, kwota_pobrania: '999.00' },
    });
    expect(r.statusCode).toBe(302);
    const koperta = kopertyV10(fetchImpl)[0];
    expect(koperta).not.toContain('<cod>');
    expect(koperta).not.toContain('999.00');
    expect(koperta).toContain('<services></services>');
  });

  // ⚠️ Warunek „COD tylko na paczce nr 1" stoi w kurierzy/dpd.js i nadpisanie ma być
  // WARTOŚCIĄ, nigdy obejściem tego warunku.
  it('paczka nr 2 + podrzucone pole → koperta BEZ <cod>', async () => {
    const { dpd, fetchImpl } = dpdKlient();
    const { serwer, id } = zServerem({ dpd, nad: POBRANIE });
    await serwer.ready();
    await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: PACZKA_Z_POBRANIEM,
    });
    await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek,
      payload: { ...PACZKA_Z_POBRANIEM, kolejnosc: '2', kwota_pobrania: '999.00' },
    });
    const druga = kopertyV10(fetchImpl)[1];
    expect(druga).not.toContain('<cod>');
    expect(druga).not.toContain('999.00');
  });

  // ⚠️⚠️ DODATNI ODPOWIEDNIK TESTU WYŻEJ (04.09.2026) — i te dwa razem są całą treścią tej
  // zmiany: to samo żądanie, różniące się WYŁĄCZNIE jawnym zaznaczeniem, ma dać raz kopertę
  // bez <cod>, a raz z <cod>. Bez tej pary „usunęliśmy blokadę" znaczyłoby tyle, co
  // „przepuszczamy wszystko".
  it('paczka nr 2 z jawnym zaznaczeniem → koperta Z <cod> i kwotą z formularza', async () => {
    const { dpd, fetchImpl } = dpdKlient();
    const { serwer, id } = zServerem({ dpd, nad: POBRANIE });
    await serwer.ready();
    await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: PACZKA_Z_POBRANIEM,
    });
    const r = await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek,
      payload: {
        ...PACZKA_Z_POBRANIEM, kolejnosc: '2', kwota_pobrania: '999.00', pobranie_na_tej_paczce: 'tak',
      },
    });
    expect(r.statusCode).toBe(302);
    const druga = kopertyV10(fetchImpl)[1];
    expect(druga).toContain('<cod><amount>999.00</amount><currency>PLN</currency></cod>');
    // Referencja MUSI nieść sufiks — bez niego DPD odrzuci zamiennik jako duplikat.
    expect(druga).toContain('/2');
  });

  // ⚠️ Zamówienie PRZEDPŁACONE nie zamienia się w pobraniowe przez samo zaznaczenie pola —
  // `pobranie` zostaje pierwszym i nadrzędnym warunkiem, tak jak przy paczce nr 1.
  it('zamówienie BEZ pobrania + zaznaczenie na paczce nr 2 → koperta BEZ <cod>', async () => {
    const { dpd, fetchImpl } = dpdKlient();
    const { serwer, id } = zServerem({ dpd });
    await serwer.ready();
    await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: PACZKA,
    });
    await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek,
      payload: { ...PACZKA, kolejnosc: '2', kwota_pobrania: '999.00', pobranie_na_tej_paczce: 'tak' },
    });
    const druga = kopertyV10(fetchImpl)[1];
    expect(druga).not.toContain('<cod>');
    expect(druga).not.toContain('999.00');
  });
});

describe('POST /zamowienia/:id/nadaj — odmowa PRZED dotknięciem kuriera', () => {
  // ⚠️ Puste pole to NIE jest „nadaj bez pobrania". Paczka pojechałaby jak przedpłacona,
  // kurier nie zainkasowałby ani złotówki i nikt by się o tym nie dowiedział.
  it.each([
    ['puste pole', ''],
    ['same spacje', '   '],
    ['zero', '0'],
    ['ujemna', '-310.33'],
    ['tekst', 'dużo'],
  ])('%s → 400, DPD NIETKNIĘTE, żadna przesyłka nie powstaje', async (_nazwa, wejscie) => {
    const { dpd, fetchImpl } = dpdKlient();
    const { serwer, id } = zServerem({ dpd, nad: POBRANIE });
    await serwer.ready();
    const r = await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek,
      payload: { ...PACZKA_Z_POBRANIEM, kwota_pobrania: wejscie },
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/kwot/i);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(przesylki(id)).toEqual([]);
  });

  // Zamówienie za pobraniem, a pola w żądaniu nie ma w ogóle (stara karta w drugiej
  // zakładce, żądanie spreparowane): odmowa, nie ciche pominięcie <cod>.
  it('pole w ogóle nieprzysłane przy pobraniu → 400, DPD NIETKNIĘTE', async () => {
    const { dpd, fetchImpl } = dpdKlient();
    const { serwer, id } = zServerem({ dpd, nad: POBRANIE });
    await serwer.ready();
    const r = await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: PACZKA,
    });
    expect(r.statusCode).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(przesylki(id)).toEqual([]);
  });
});

// =====================================================================================
// D. LOG ZAMÓWIENIA — jedyna droga odtworzenia, ile kurier miał zainkasować
// =====================================================================================

describe('kwota FAKTYCZNIE UŻYTA trafia do logu zamówienia', () => {
  it('zmieniona kwota jest w logu', async () => {
    const { dpd } = dpdKlient();
    const { serwer, id } = zServerem({ dpd, nad: POBRANIE });
    await serwer.ready();
    await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek,
      payload: { ...PACZKA_Z_POBRANIEM, kwota_pobrania: '310,33' },
    });
    const wpis = logi(id).find((w) => w.akcja === 'nadanie.pobranie');
    expect(wpis).toBeTruthy();
    expect(wpis.wynik).toContain('310.33');
  });

  // ⚠️ Bez górnego progu literówka przechodzi do kuriera — i wtedy log jest JEDYNYM
  // miejscem, w którym po miesiącu widać, ile kurier miał zainkasować.
  it('literówka „31033" też jest w logu — to cała obrona przed brakiem progu', async () => {
    const { dpd } = dpdKlient();
    const { serwer, id } = zServerem({ dpd, nad: POBRANIE });
    await serwer.ready();
    await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek,
      payload: { ...PACZKA_Z_POBRANIEM, kwota_pobrania: '31033' },
    });
    expect(logi(id).find((w) => w.akcja === 'nadanie.pobranie').wynik).toContain('31033');
  });

  it('kwota niezmieniona też ląduje w logu — po miesiącu kolumna może już nieść co innego', async () => {
    const { dpd } = dpdKlient();
    const { serwer, id } = zServerem({ dpd, nad: POBRANIE });
    await serwer.ready();
    await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: PACZKA_Z_POBRANIEM,
    });
    expect(logi(id).find((w) => w.akcja === 'nadanie.pobranie').wynik).toContain('212.90');
  });

  it('zamówienie bez pobrania NIE zaśmieca logu wpisem o pobraniu', async () => {
    const { dpd } = dpdKlient();
    const { serwer, id } = zServerem({ dpd });
    await serwer.ready();
    await serwer.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek, payload: PACZKA });
    expect(logi(id).some((w) => w.akcja === 'nadanie.pobranie')).toBe(false);
  });
});

// =====================================================================================
// E. ŚCIEŻKI, KTÓRYCH TA ZMIANA NIE MA PRAWA DOTKNĄĆ
// =====================================================================================

describe('nadpisanie jest JEDNORAZOWE — nie zapisuje się do zamówienia', () => {
  it('po nadaniu kolumna kwota_pobrania i nadpisanie wysyłki są nietknięte', async () => {
    const { dpd } = dpdKlient();
    const { serwer, id } = zServerem({ dpd, nad: POBRANIE });
    await serwer.ready();
    await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek,
      payload: { ...PACZKA_Z_POBRANIEM, kwota_pobrania: '310.33' },
    });
    const w = db.prepare('SELECT kwota_pobrania, wysylka_reczna_json FROM zamowienia WHERE id = ?').get(id);
    expect(w.kwota_pobrania).toBe('212.90');
    expect(w.wysylka_reczna_json).toBeNull();
  });
});

describe('wywołania spoza formularza zachowują się DOKŁADNIE jak dziś', () => {
  // Nadanie zbiorcze i wywołania wsadowe nie znają pola formularza — kwota ma dalej
  // pochodzić z zamówienia, bez ani jednej zmiany w kopercie.
  it('nadaj() bez nadpisania → <cod> z kwoty zamówienia', async () => {
    const { dpd, fetchImpl } = dpdKlient();
    const { id, nadanie } = zServerem({ dpd, nad: POBRANIE });
    await nadanie.nadaj(id, { waga: 1, dlugosc: 110, szerokosc: 75, wysokosc: 1 }, { kolejnosc: 1 });
    expect(kopertyV10(fetchImpl)[0]).toContain('<cod><amount>212.90</amount><currency>PLN</currency></cod>');
  });

  // ⚠️ Pobranie jest z nadania zbiorczego wykluczone podwójnie (domain/masowe.js) i tak
  // ma zostać — tu pilnujemy, że trasa zbiorcza dalej nadaje zamówienia BEZ pobrania,
  // nie żądając od nikogo kwoty.
  it('POST /zamowienia/masowe/nadaj nadal działa i nie wysyła żadnej kwoty', async () => {
    const { dpd, fetchImpl } = dpdKlient();
    const { serwer, id } = zServerem({ dpd });
    await serwer.ready();
    const r = await serwer.inject({
      method: 'POST', url: '/zamowienia/masowe/nadaj', headers: naglowek, payload: { id: String(id) },
    });
    expect(r.statusCode).toBe(200);
    const koperta = kopertyV10(fetchImpl)[0];
    expect(koperta).toBeTruthy();
    expect(koperta).not.toContain('<cod>');
  });
});

// =====================================================================================
// F. PACZKOMAT ZA POBRANIEM — TA SAMA GWARANCJA, CO PRZY DPD
// =====================================================================================
//
// ⚠️ DZIURA ZNALEZIONA W RECENZJI (05.08). `kurierzy/inpost.js` dostał parametr
// `kwotaPobrania` razem z Z4, ale NIC w `tests/` mu go nie przekazywało — cała ta ścieżka
// była pilnowana wyłącznie po stronie DPD. Skasowanie `nadpisanie ??` w inpost.js dawało
// więc cichą EDYCJĘ POZORNĄ: operator poprawia kwotę na ekranie nadania, ekran ją przyjmuje,
// a kurier inkasuje od klienta STARĄ kwotę z zamówienia — i cały zestaw zostaje zielony.
//
// Testy niżej idą przez PRAWDZIWY klient ShipX z atrapą `fetch` (nie przez atrapę klienta),
// bo pytanie brzmi „co poszło w ciele żądania do InPostu", a nie „czy funkcję wywołano".
describe('paczkomat za pobraniem — kwota z formularza jedzie do InPostu', () => {
  const NADAWCA_INPOST = { nazwa: 'Lumina', ulica: 'ul. 1 Maja 5', kod: '00-650', miasto: 'Pęki', kraj: 'PL', phone: '+48500600700', email: 'sklep@szkicownia.pl' };
  const PACZKOMAT = {
    metoda_wysylki: 'inpost_paczkomat', pobranie: 1, kwota_pobrania: '212.90',
    punkt_odbioru: 'SLN06M', punkt_odbioru_opis: 'Przy myjni',
  };
  // Formularz paczkomatowy: gabaryt A/B/C zamiast wymiarów (InPost nie zna wymiarów).
  const FORMULARZ = {
    waga: '1', gabaryt: 'A', kolejnosc: '1', kraj: 'PL', punkt_odbioru: 'SLN06M', ...ADRES,
  };

  // Atrapa `fetch` odpowiadająca jak ShipX: POST /shipments oddaje gotową przesyłkę,
  // GET etykiet oddaje pliki. ZERO żądań do prawdziwego InPostu.
  // ⚠️ ATRAPA ODSYLA POBRANIE, KTORE DOSTALA (poprawione 27.08.2026). Do tego dnia oddawala
  // przesylke BEZ pola `cod` — ksztalt, ktorego prawdziwy ShipX przy pobraniu nigdy nie daje,
  // a od 27.08 klient InPostu sprawdza, czy kurier POTWIERDZIL pobranie. Atrapa milcząca
  // o `cod` opisywalaby wiec przesylke, przy ktorej nikt nie zainkasuje pieniedzy.
  function inpostKlient() {
    const fetchImpl = vi.fn(async (adres, opcje) => {
      if (String(adres).includes('format=')) {
        return { status: 200, ok: true, arrayBuffer: async () => Buffer.from('%PDF-1.4\n', 'latin1') };
      }
      const zadanie = JSON.parse(opcje?.body ?? '{}');
      return {
        status: 201, ok: true,
        text: async () => JSON.stringify({
          id: 9993331,
          tracking_number: '520000123456789012345678',
          // Echo jak w prawdziwym ShipX: przesylka przedplacona niesie `cod` z pustymi polami.
          cod: zadanie.cod ?? { amount: null, currency: null },
        }),
      };
    });
    const inpost = createInpostClient({
      url: 'https://shipx.test/v1', token: 'eyJTESTOWY.TOKEN', organizacja: 13235,
      nadawca: NADAWCA_INPOST, fetchImpl,
    });
    return { inpost, fetchImpl };
  }

  // Ciało POST-a tworzącego przesyłkę — jedyne żądanie bez `format=` w adresie.
  const cialoPrzesylki = (fetchImpl) => JSON.parse(
    fetchImpl.mock.calls.find((c) => !String(c[0]).includes('format='))[1].body,
  );

  function zServeremInpost({ nad = {} } = {}) {
    const katalogEtykiet = mkdtempSync(join(tmpdir(), 'oms-pobranie-inpost-'));
    const { inpost, fetchImpl } = inpostKlient();
    const klienci = { pro: { dodajNotatke: vi.fn().mockResolvedValue({}) } };
    const nadanie = createNadanie({ db, kurierzy: { inpost }, klienci, katalogEtykiet });
    const serwer = buildOmsServer({ db, config, poller, nadanie });
    const id = zapiszZamowienie(db, 'pro', zmapowane({ ...PACZKOMAT, ...nad }), {});
    return { serwer, id, fetchImpl, nadanie };
  }

  it('zmieniona kwota → `cod` z KWOTĄ Z FORMULARZA, nie z zamówienia', async () => {
    const { serwer, id, fetchImpl } = zServeremInpost();
    await serwer.ready();
    const r = await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek,
      payload: { ...FORMULARZ, kwota_pobrania: '310.33' },
    });
    expect(r.statusCode).toBe(302);
    expect(cialoPrzesylki(fetchImpl).cod).toEqual({ amount: 310.33, currency: 'PLN' });
  });

  it('przecinek dziesiętny („310,33") dojeżdża do InPostu jako liczba', async () => {
    const { serwer, id, fetchImpl } = zServeremInpost();
    await serwer.ready();
    await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek,
      payload: { ...FORMULARZ, kwota_pobrania: '310,33' },
    });
    expect(cialoPrzesylki(fetchImpl).cod).toEqual({ amount: 310.33, currency: 'PLN' });
  });

  // Kwota NIEZMIENIONA musi dać żądanie DOKŁADNIE takie, jakie panel wysyłał przed Z4.
  it('kwota niezmieniona → `cod` z kwoty zamówienia', async () => {
    const { serwer, id, fetchImpl } = zServeremInpost();
    await serwer.ready();
    await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek,
      payload: { ...FORMULARZ, kwota_pobrania: '212.90' },
    });
    expect(cialoPrzesylki(fetchImpl).cod).toEqual({ amount: 212.9, currency: 'PLN' });
  });

  // Wywołania spoza formularza (nadanie wsadowe) nie znają nadpisania — kwota ma dalej
  // pochodzić z zamówienia. To ta sama gwarancja, co przy DPD wyżej.
  it('nadaj() bez nadpisania → `cod` z kwoty zamówienia', async () => {
    const { id, fetchImpl, nadanie } = zServeremInpost();
    await nadanie.nadaj(id, { waga: 1, gabaryt: 'A' }, { kolejnosc: 1 });
    expect(cialoPrzesylki(fetchImpl).cod).toEqual({ amount: 212.9, currency: 'PLN' });
  });

  // ⚠️ Kwota użyta MUSI trafić do logu także na tej ścieżce — bez tego po miesiącu nie da
  // się odtworzyć, ile kurier miał zainkasować (progu górnego nie ma).
  it('kwota użyta ląduje w logu zamówienia', async () => {
    const { serwer, id } = zServeremInpost();
    await serwer.ready();
    await serwer.inject({
      method: 'POST', url: `/zamowienia/${id}/nadaj`, headers: naglowek,
      payload: { ...FORMULARZ, kwota_pobrania: '310.33' },
    });
    expect(logi(id).some((w) => w.akcja === 'nadanie.pobranie' && w.wynik.includes('310.33'))).toBe(true);
  });

  // ⚠️⚠️ INPOST POŁKNĄŁ POBRANIE — GDZIE MA WYLĄDOWAĆ WIERSZ PRZESYŁKI (27.08.2026).
  //
  // Strażnik w `kurierzy/inpost.js` rzuca JUŻ PO utworzeniu przesyłki, więc wyjątek niesie
  // `shipmentId`. Sam ten fakt kierowałby wiersz do `oznaczTworzonaUKuriera`, czyli na stan
  // 'w_trakcie' z przyciskiem „Sprawdź ponownie" — a to kliknięcie dobiera numer i etykiety
  // i KOŃCZY nadanie POMIJAJĄC strażnika (`sprawdzPrzesylke` pobrania nie ogląda).
  //
  // Skutek byłby dokładnie taki, przed jakim strażnik miał bronić, tylko o jedno kliknięcie
  // dalej: paczka bez inkasa, zameldowana jako nadana. Dlatego niepotwierdzone pobranie musi
  // iść na 'do_wyjasnienia' — stan, z którego nie ma drogi „dokończ", tylko decyzja człowieka.
  function inpostBezPobrania() {
    const fetchImpl = vi.fn(async (adres) => {
      if (String(adres).includes('format=')) {
        return { status: 200, ok: true, arrayBuffer: async () => Buffer.from('%PDF-1.4\n', 'latin1') };
      }
      return {
        status: 201,
        ok: true,
        // InPost przyjmuje przesyłkę, oddaje numer listu i CICHO pomija pobranie.
        text: async () => JSON.stringify({
          id: 9993331,
          tracking_number: '520000123456789012345678',
          cod: { amount: null, currency: null },
        }),
      };
    });
    const inpost = createInpostClient({
      url: 'https://shipx.test/v1', token: 'eyJTESTOWY.TOKEN', organizacja: 13235,
      nadawca: NADAWCA_INPOST, fetchImpl,
    });
    const katalogEtykiet = mkdtempSync(join(tmpdir(), 'oms-pobranie-polkniete-'));
    const klienci = { pro: { dodajNotatke: vi.fn().mockResolvedValue({}) } };
    const nadanie = createNadanie({ db, kurierzy: { inpost }, klienci, katalogEtykiet });
    const id = zapiszZamowienie(db, 'pro', zmapowane({ ...PACZKOMAT }), {});
    return { nadanie, id };
  }

  const przesylkaWiersz = (id) => db.prepare('SELECT * FROM przesylki WHERE zamowienie_id = ?').get(id);

  it('InPost połknął pobranie → nadanie PADA, zamiast zameldować sukces', async () => {
    const { nadanie, id } = inpostBezPobrania();
    await expect(nadanie.nadaj(id, { waga: 1, gabaryt: 'A' }, { kolejnosc: 1 }))
      .rejects.toThrow(/pobrani/i);
  });

  it('wiersz idzie na `do_wyjasnienia`, a NIE na „Sprawdź ponownie"', async () => {
    const { nadanie, id } = inpostBezPobrania();
    await expect(nadanie.nadaj(id, { waga: 1, gabaryt: 'A' }, { kolejnosc: 1 })).rejects.toThrow();
    expect(przesylkaWiersz(id).status).toBe('do_wyjasnienia');
  });

  // Przesyłka u kuriera ISTNIEJE — bez zapisanego identyfikatora nie da się jej anulować,
  // a komunikat wprost każe operatorowi to zrobić.
  it('identyfikator przesyłki u kuriera jest zapisany, bo tylko nim da się ją anulować', async () => {
    const { nadanie, id } = inpostBezPobrania();
    await expect(nadanie.nadaj(id, { waga: 1, gabaryt: 'A' }, { kolejnosc: 1 })).rejects.toThrow();
    expect(String(przesylkaWiersz(id).id_przesylki_kuriera)).toBe('9993331');
  });

  it('log zamówienia mówi WPROST o niepotwierdzonym pobraniu', async () => {
    const { nadanie, id } = inpostBezPobrania();
    await expect(nadanie.nadaj(id, { waga: 1, gabaryt: 'A' }, { kolejnosc: 1 })).rejects.toThrow();
    expect(logi(id).some((w) => w.akcja === 'nadanie' && /pobrani/i.test(w.wynik))).toBe(true);
  });

  // ⚠️⚠️ PRZYPADEK, DLA KTOREGO FLAGA W OGOLE ISTNIEJE — i ktorego trzy testy wyzej NIE
  // odrozniaja. Tam InPost oddaje numer listu, wiec sprawa i tak trafia na 'do_wyjasnienia'
  // sciezka „mamy numer" — zdjecie flagi niczego by nie zmienilo i mutacja to pokazala.
  //
  // Tworzenie przesylki w ShipX bywa ASYNCHRONICZNE: POST oddaje identyfikator, a numer
  // listu dopiero za chwile. Wtedy `e.numerListu` jest puste i BEZ flagi sprawa spadalaby
  // na 'w_trakcie' z przyciskiem „Sprawdz ponownie" — czyli o jedno klikniecie od paczki
  // bez inkasa zameldowanej jako nadana. O stanie ma rozstrzygac POBRANIE, nie numer.
  function inpostBezPobraniaIBezNumeru() {
    const fetchImpl = vi.fn(async (adres) => {
      if (String(adres).includes('format=')) {
        return { status: 200, ok: true, arrayBuffer: async () => Buffer.from('%PDF-1.4\n', 'latin1') };
      }
      // Numeru listu JESZCZE nie ma — i pobrania nie ma W OGÓLE.
      return {
        status: 201,
        ok: true,
        text: async () => JSON.stringify({ id: 9993331, tracking_number: null, cod: { amount: null, currency: null } }),
      };
    });
    const inpost = createInpostClient({
      url: 'https://shipx.test/v1', token: 'eyJTESTOWY.TOKEN', organizacja: 13235,
      nadawca: NADAWCA_INPOST, fetchImpl,
    });
    const katalogEtykiet = mkdtempSync(join(tmpdir(), 'oms-pobranie-bez-numeru-'));
    const klienci = { pro: { dodajNotatke: vi.fn().mockResolvedValue({}) } };
    const nadanie = createNadanie({ db, kurierzy: { inpost }, klienci, katalogEtykiet });
    const id = zapiszZamowienie(db, 'pro', zmapowane({ ...PACZKOMAT }), {});
    return { nadanie, id };
  }

  it('połknięte pobranie BEZ numeru listu też idzie na `do_wyjasnienia`, nie na „Sprawdź ponownie"', async () => {
    const { nadanie, id } = inpostBezPobraniaIBezNumeru();
    await expect(nadanie.nadaj(id, { waga: 1, gabaryt: 'A' }, { kolejnosc: 1 })).rejects.toThrow(/pobrani/i);
    const w = przesylkaWiersz(id);
    expect(w.status).toBe('do_wyjasnienia');
    expect(w.numer_listu).toBeNull();
    expect(String(w.id_przesylki_kuriera)).toBe('9993331');
  });
});
