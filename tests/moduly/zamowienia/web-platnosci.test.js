import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { dodajWplateReczna, platnosciZamowienia } from '../../../src/oms/db/platnosci.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { saldoWplat } from '../../../src/domena/platnosci.js';
import { dzienWarszawa } from '../../../src/domena/format-daty.js';

const config = { auth: { user: 'adam', pass: 'x' } };
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: '2026-07-29T12:00:00', ostatni_blad: null }) };

const zmapowane = (nad = {}) => ({
  zrodlo_id: 1301, numer: '1301', klient: { first_name: 'Jan', email: 'j@k.pl' }, dostawa: { city: 'Pęki' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '212.90',
  koszt_dostawy_brutto: '0.00', status_woo: 'processing', oplacone_at: null, anulowane: 0,
  utworzone_at: '2026-07-29T13:19:52',
  pozycje: [{ nazwa: 'STOP', sku: 'PRO-STOP-001', ilosc: 2, cena_brutto: '106.45', brutto_linii: '212.90', vat: null }],
  ...nad,
});

let db, app;
beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config, poller });
  await app.ready();
});

// Liczniki AUTOINCREMENT roznych tabel zbiegaja sie w swiezej bazie (przewodnik OMS, 6.3),
// wiec bez wypelniaczy `id` zamowienia rownaloby sie `id` wplaty i pomylka argumentu
// w trasie /platnosci/:platnoscId/usun przeszlaby niezauwazona.
function zamowienieZRozjechanymiLicznikami(nad = {}) {
  for (let i = 0; i < 4; i += 1) zapiszZamowienie(db, 'pro', zmapowane({ zrodlo_id: 9000 + i, numer: `900${i}` }), {});
  return zapiszZamowienie(db, 'pro', zmapowane(nad), {});
}

const log = (id) => db.prepare('SELECT * FROM log WHERE zamowienie_id = ? ORDER BY id').all(id);
// Karta z opcjonalnym parametrem — formularz wplaty siedzi za `?edytuj=wplata`.
const karta = (id, query = '') => app.inject({ method: 'GET', url: `/zamowienia/${id}${query}`, headers: naglowek });

describe('sekcja Płatności na karcie', () => {
  it('pokazuje wpłaty z datą, kwotą, metodą i uwagą', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    dodajWplateReczna(db, id, { kwota: '50.00', data: '2026-08-01', metoda: 'BLIK', uwaga: 'dopłata za szablon' });
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Płatności');
    expect(r.body).toContain('2026-08-01');
    expect(r.body).toContain('50.00');
    expect(r.body).toContain('BLIK');
    expect(r.body).toContain('dopłata za szablon');
  });

  // ⚠️ PRZEBUDOWA 2026-08-07 (prosba wlasciciela: „zmien sposob dodawania nowych platnosci
  // na wygodniejszy"): formularz stoi NA STALE pod tabela wplat. Do tej pory trzeba bylo
  // kliknac „+ Dodaj wplate" i przeladowac strone przez `?edytuj=wplata` — trzy kroki do
  // czynnosci wykonywanej codziennie.
  it('formularz wpłaty stoi na karcie OD RAZU, bez klikania „Dodaj wpłatę”', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).toContain(`action="/zamowienia/${id}/platnosci"`);
    expect(r.body).toContain('Zaksięguj');
    expect(r.body).toContain('name="kwota" type="number" step="0.01" min="0.01" required');
    expect(r.body).not.toContain('+ Dodaj wpłatę');
    // ⚠️ METODA JEST WYMAGANA (audyt 22.08.2026) i stoi w GLOWNYM rzedzie jako pole wyboru —
    // `required` schowane w zamknietym <details> byloby odmowa przegladarki bez widocznego
    // powodu. Uwaga zostaje opcjonalna, w rozwijanym (czysty HTML, bez JavaScriptu).
    expect(r.body).toMatch(/<select name="metoda" required/);
    expect(r.body).toContain('name="uwaga"');
    expect(r.body).toMatch(/<details class="wiecej">[\s\S]*name="uwaga"/);
  });

  // Stary adres ma dalej dzialac (zakladki, odnosniki w logu) — po prostu niczego nie przelacza.
  it('adres ?edytuj=wplata dalej otwiera kartę, a formularz jest ten sam', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}?edytuj=wplata`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(`action="/zamowienia/${id}/platnosci"`);
  });

  // ⚠️ Niedoplaty nie wolno chowac: to pieniadze, ktorych nie ma.
  it('suma mniejsza od kwoty → widoczna NIEDOPŁATA z kwotą braku', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    dodajWplateReczna(db, id, { kwota: '150.00', data: '2026-07-30' });
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).toContain('NIEDOPŁATA');
    expect(r.body).toContain('62.90');
    // I odwrotna strona tej samej monety: zamowienie NIE wyglada na oplacone.
    expect(pobierzZamowienie(db, id).oplacone_at).toBeNull();
    // ⚠️ AKAPIT „Zamówienie NIE jest opłacone" ZDJETY 2026-08-07 („mozesz zmniejszyc ilosc
    // komunikatow") — to samo zdanie niesie PASEK SPRAW na gorze karty, i to on jest miejscem,
    // w ktorym operator szuka rzeczy do zrobienia. Pasek salda tuz obok podaje te sama liczbe.
    const sprawy = r.body.slice(r.body.indexOf('class="sprawy"'), r.body.indexOf('class="metryczka"'));
    expect(sprawy).toMatch(/Niedopłata 62\.90 zł/);
  });

  // ⚠️ Nadplaty tez nie wolno chowac: to pieniadze klienta.
  //
  // Do 2026-08-01 slowo „NADPŁATA" krzyczalo wersalikami z belki na gorze karty. Belka
  // zostala odchudzona (powtarzala fakty z sekcji nizej), wiec test sprawdza teraz DWA
  // miejsca, w ktorych nadplata zostala — i to jest mocniejsze niz poprzednia wersja:
  // pasek spraw widac od razu po otwarciu karty, a saldo stoi przy samych wplatach.
  it('suma większa od kwoty → nadpłata widoczna i w pasku spraw, i przy wpłatach', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    dodajWplateReczna(db, id, { kwota: '212.90', data: '2026-07-30' });
    dodajWplateReczna(db, id, { kwota: '50.00', data: '2026-08-01' });
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });

    const sprawy = r.body.slice(r.body.indexOf('class="sprawy"'), r.body.indexOf('class="metryczka"'));
    expect(sprawy, 'nadpłata musi być w pasku spraw').toMatch(/Nadpłata 50\.00 zł/);

    const platnosci = r.body.slice(r.body.indexOf('id="platnosci"'));
    expect(platnosci, 'saldo przy wpłatach musi mówić o nadpłacie').toMatch(/nadpłata 50\.00 zł/);
    // ⚠️ Zdanie „sprawdź, czy nadwyżki…" zostalo TYLKO w pasku spraw (2026-08-07) — patrz
    // asercja wyzej. Trzy kopie tego samego na jednym ekranie zamienialy je w tlo.
    expect(platnosci).not.toContain('sprawdź, czy nadwyżki nie trzeba zwrócić klientowi');
  });

  it('kwota pokryta co do grosza → ani niedopłaty, ani nadpłaty', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    dodajWplateReczna(db, id, { kwota: '35.65', data: '2026-07-28' });
    dodajWplateReczna(db, id, { kwota: '35.65', data: '2026-07-29' });
    dodajWplateReczna(db, id, { kwota: '141.60', data: '2026-07-30' });
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.body).not.toContain('NIEDOPŁATA');
    expect(r.body).not.toContain('NADPŁATA');
    expect(pobierzZamowienie(db, id).oplacone_at).toBe('2026-07-30');
  });

  it('wpłata ze sklepu NIE MA przycisku usuwania, ręczna ma', async () => {
    const zeSklepu = zamowienieZRozjechanymiLicznikami({ oplacone_at: '2026-07-29T13:21:26' });
    const sklepowa = platnosciZamowienia(db, zeSklepu)[0];
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${zeSklepu}`, headers: naglowek });
    expect(r.body).not.toContain(`/platnosci/${sklepowa.id}/usun`);

    dodajWplateReczna(db, zeSklepu, { kwota: '50.00', data: '2026-08-01' });
    const reczna = platnosciZamowienia(db, zeSklepu).find((w) => w.zrodlo === 'reczna');
    const r2 = await app.inject({ method: 'GET', url: `/zamowienia/${zeSklepu}`, headers: naglowek });
    expect(r2.body).toContain(`/platnosci/${reczna.id}/usun`);
  });
});

describe('POST /zamowienia/:id/platnosci', () => {
  it('dopisuje wpłatę ręczną i wpisuje ją do logu', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    const r = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/platnosci`, headers: naglowek,
      payload: { kwota: '50.00', data: '2026-08-01', metoda: 'BLIK', uwaga: 'dopłata' },
    });
    expect(r.statusCode).toBeLessThan(400);
    const wplaty = platnosciZamowienia(db, id);
    expect(wplaty).toHaveLength(1);
    // ⚠️ Data WSTECZNA dostaje godzine zero (od 07.08.2026) — `oplacone_at` czyta sie z niej
    // jako znacznik czasu, a godziny przeoczonego przelewu nie znamy, wiec jej nie zmyslamy.
    expect(wplaty[0]).toMatchObject({
      zrodlo: 'reczna', kwota: '50.00', data: '2026-08-01T00:00:00', metoda: 'BLIK', uwaga: 'dopłata',
    });
    expect(log(id).at(-1).wynik).toMatch(/Ręcznie \(adam\).*50\.00/);
  });

  it('dwie wpłaty na jedno zamówienie — sedno całego zadania', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    await app.inject({ method: 'POST', url: `/zamowienia/${id}/platnosci`, headers: naglowek, payload: { kwota: '162.90', metoda: 'Przelew' } });
    await app.inject({ method: 'POST', url: `/zamowienia/${id}/platnosci`, headers: naglowek, payload: { kwota: '50.00', metoda: 'BLIK', uwaga: 'dopłata za dodatkowy szablon' } });
    expect(platnosciZamowienia(db, id)).toHaveLength(2);
    expect(pobierzZamowienie(db, id).oplacone_at).toBeTruthy();
  });

  it('brak kwoty → 400 z czytelną odmową i BEZ zapisu', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    const r = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/platnosci`, headers: naglowek, payload: { data: '2026-08-01' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/Podaj kwotę wpłaty/);
    expect(platnosciZamowienia(db, id)).toHaveLength(0);
  });

  it('nieistniejące zamówienie → 404', async () => {
    const r = await app.inject({ method: 'POST', url: '/zamowienia/999/platnosci', headers: naglowek, payload: { kwota: '10.00' } });
    expect(r.statusCode).toBe(404);
  });

  it('bez nagłówka Origin → odmowa CSRF', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    const r = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/platnosci`, payload: { kwota: '10.00' },
      headers: { authorization: naglowek.authorization },
    });
    expect(r.statusCode).toBe(403);
  });
});

describe('POST /zamowienia/:id/platnosci/:platnoscId/usun', () => {
  it('usuwa wpłatę ręczną i ZAPISUJE TO DO LOGU jako decyzję człowieka', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    dodajWplateReczna(db, id, { kwota: '50.00', data: '2026-08-01' });
    const wplata = platnosciZamowienia(db, id)[0];
    expect(wplata.id).not.toBe(id);

    const r = await app.inject({ method: 'POST', url: `/zamowienia/${id}/platnosci/${wplata.id}/usun`, headers: naglowek });
    expect(r.statusCode).toBeLessThan(400);
    expect(platnosciZamowienia(db, id)).toHaveLength(0);

    const wpis = log(id).at(-1);
    expect(wpis.akcja).toBe('platnosc.usunieta');
    expect(wpis.wynik).toMatch(/Ręcznie \(adam\)/);
    expect(wpis.wynik).toMatch(/50\.00/);
  });

  it('wpłaty ze sklepu usunąć się NIE DA → 400 i wiersz zostaje', async () => {
    const id = zamowienieZRozjechanymiLicznikami({ oplacone_at: '2026-07-29T13:21:26' });
    const wplata = platnosciZamowienia(db, id)[0];
    expect(wplata.zrodlo).toBe('sklep');

    const r = await app.inject({ method: 'POST', url: `/zamowienia/${id}/platnosci/${wplata.id}/usun`, headers: naglowek });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/Wpłaty ze sklepu nie da się usunąć/);
    expect(platnosciZamowienia(db, id)).toHaveLength(1);
  });

  it('wpłata z innego zamówienia → 400, cudzy wiersz zostaje', async () => {
    const a = zamowienieZRozjechanymiLicznikami({ zrodlo_id: 1301, numer: '1301' });
    const b = zapiszZamowienie(db, 'pro', zmapowane({ zrodlo_id: 1302, numer: '1302' }), {});
    dodajWplateReczna(db, b, { kwota: '50.00', data: '2026-08-01' });
    const cudza = platnosciZamowienia(db, b)[0];

    const r = await app.inject({ method: 'POST', url: `/zamowienia/${a}/platnosci/${cudza.id}/usun`, headers: naglowek });
    expect(r.statusCode).toBe(400);
    expect(platnosciZamowienia(db, b)).toHaveLength(1);
  });
});

describe('POST /zamowienia/:id/wplata („Zaksięguj wpłatę")', () => {
  it('dopisuje wpłatę na brakującą kwotę i zamówienie staje się opłacone', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    dodajWplateReczna(db, id, { kwota: '100.00', data: '2026-07-28' });
    const r = await app.inject({ method: 'POST', url: `/zamowienia/${id}/wplata`, headers: naglowek });
    expect(r.statusCode).toBeLessThan(400);
    expect(platnosciZamowienia(db, id).map((w) => w.kwota)).toEqual(['100.00', '112.90']);
    expect(pobierzZamowienie(db, id).oplacone_at).toBeTruthy();
  });

  it('przy kwocie już pokrytej → 400, bez wpłaty na zero', async () => {
    const id = zamowienieZRozjechanymiLicznikami({ oplacone_at: '2026-07-29T13:21:26' });
    const r = await app.inject({ method: 'POST', url: `/zamowienia/${id}/wplata`, headers: naglowek });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/pokrywające całą kwotę/);
    expect(platnosciZamowienia(db, id)).toHaveLength(1);
  });
});

// ——— FORMULARZ WPŁATY: DWA POLA Z WARTOŚCIAMI DOMYŚLNYMI (2026-08-07) ————————————————
//
// Prośba właściciela: „powinny być dwa pola, jedno z datą, drugie z kwotą […] domyślnie
// data dzisiejsza i cała kwota, bo tak jest najczęściej". Pole daty ISTNIAŁO, ale było
// jednym z czterech identycznych okienek z podpowiedzią w środku — nie do odróżnienia,
// więc wyglądało na nieobecne.
describe('formularz „Dodaj wpłatę” — pola i wartości domyślne', () => {
  const formularz = (body) => body.match(/<form[^>]*\/platnosci"[\s\S]*?<\/form>/)[0];

  it('kwota i data mają etykiety, a nie same podpowiedzi w środku', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    const f = formularz((await karta(id, '?edytuj=wplata')).body);
    expect(f).toMatch(/Kwota \(zł\)/);
    expect(f).toMatch(/Data wpłaty/);
  });

  // ⚠️ SEDNO: pole daty jest PRAWDZIWYM polem daty, a nie tekstem. Do 07.08 do bazy szło
  // to, co człowiek wpisał, znak w znak — a z tej daty wylicza się „opłacone".
  it('data to pole typu date, domyślnie dzisiejsze i bez przyszłości', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    const f = formularz((await karta(id, '?edytuj=wplata')).body);
    // ⚠️ „DZISIAJ" LICZONE PO WARSZAWSKU, TA SAMA FUNKCJA CO W APLIKACJI. Do 11.08.2026
    // stalo tu `new Date().toISOString().slice(0, 10)`, czyli dzien w UTC — a panel
    // swiadomie trzyma Europe/Warsaw (`domain/format-daty.js`), bo kontener chodzi na UTC.
    // Miedzy polnoca a druga w nocy czasu warszawskiego obie strony roznily sie o DOBE
    // i test padal. Nie bylo to losowe: to deterministyczne okno dwoch godzin na dobe,
    // w ktorym master byl czerwony. Wada byla w tescie — aplikacja miala racje.
    const dzis = dzienWarszawa(new Date().toISOString());
    expect(f).toContain('name="data" type="date"');
    expect(f).toContain(`value="${dzis}"`);
    // Wpłata „z przyszłości" psuje `oplacone_at` w sposób, którego nikt nie zauważy.
    expect(f).toContain(`max="${dzis}"`);
  });

  // ⚠️ KWOTA TO BRAKUJĄCA RESZTA, nie kwota zamówienia — inaczej dopłata po wpłacie
  // częściowej byłaby nadpłatą wpisaną jednym kliknięciem.
  it('kwota podstawia BRAKUJĄCĄ resztę, nie całość zamówienia', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    await app.inject({
      method: 'POST', url: `/zamowienia/${id}/platnosci`, headers: naglowek, payload: { kwota: '100.00', metoda: 'Przelew' },
    });
    const f = formularz((await karta(id, '?edytuj=wplata')).body);
    const saldo = saldoWplat(pobierzZamowienie(db, id));
    expect(saldo.stan).toBe('niedoplata');
    expect(f).toContain(`value="${saldo.roznicaZl}"`);
    expect(f).not.toContain('value="212.90"');
  });

  // Pole zostaje EDYTOWALNE — klient potrafi zapłacić przez pomyłkę mniej.
  it('kwota jest edytowalna, a niepełna wpłata pokazuje brakującą część', async () => {
    const id = zamowienieZRozjechanymiLicznikami();
    const r = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/platnosci`, headers: naglowek, payload: { kwota: '12.34', metoda: 'Przelew' },
    });
    expect(r.statusCode).toBeLessThan(400);
    const body = (await karta(id)).body;
    expect(body).toMatch(/NIEDOPŁATA: brakuje/);
    expect(body).toContain(saldoWplat(pobierzZamowienie(db, id)).roznicaZl);
  });
});
