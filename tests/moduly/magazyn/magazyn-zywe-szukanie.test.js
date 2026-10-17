import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zapiszProduktSklepowy } from '../../../src/oms/db/magazyn.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

// ŻYWE SZUKANIE W MAGAZYNIE (21.08.2026, prośba właściciela: „wyszukiwanie na żywo
// w magazynie to super opcja").
//
// ⚠️ ZAKRES JEST WĄSKI I CELOWO: htmx obsługuje WYŁĄCZNIE odświeżanie WYNIKÓW. Dodanie
// pozycji zostaje zwykłym formularzem — szukanie jest odczytem, a dodanie zapisem.

const config = { auth: { user: 'adam', pass: 'x' } };
const naglowek = { authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`, origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: '2026-08-21T09:00:00', ostatni_blad: null }) };

const produkt = (nad = {}) => ({
  kanal: 'szkicownia', produkt_id: '28040', wariant_id: '', nazwa: 'Lampa wisząca Szpulka',
  sku_sklepu: 'LP-SZP-70', cena_gr: 7490, rozmiar_tekst: '70x100', kategorie: [], zdjecia: [],
  adres: 'https://sklep-polcien.example.invalid/produkt/szpulka', odczytane_at: '2026-08-21T08:00:00', ...nad,
});

const zmapowane = (nad = {}) => ({
  zrodlo_id: 7001, numer: '7001', klient: { first_name: 'Jan' }, dostawa: { city: 'Pęki' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '100.00',
  koszt_dostawy_brutto: '0.00', koszt_dostawy_netto: '0.00', status_woo: 'processing',
  oplacone_at: null, anulowane: 0, utworzone_at: '2026-08-21T09:00:00', pozycje: [], ...nad,
});

let db;
let app;
beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config, poller });
  await app.ready();
  zapiszProduktSklepowy(db, produkt());
});

const get = (url) => app.inject({ method: 'GET', url, headers: naglowek });

describe('fragment z wynikami — ekran zakładania', () => {
  const adres = '/zamowienia/nowe/magazyn/wyniki?magazyn=szpulka&cennik=szkicownia';

  it('oddaje SAM kawałek, bez koperty strony', async () => {
    const odp = await get(adres);
    expect(odp.statusCode).toBe(200);
    expect(odp.headers['content-type']).toMatch(/text\/html/);
    expect(odp.body).toContain('Lampa wisząca Szpulka');
    // ⚠️ Fragment oprawiony layoutem wjechałby do środka strony jako druga, zagnieżdżona
    // strona — z drugim <html>, drugim menu i drugim paskiem tytułu.
    expect(odp.body).not.toContain('<!doctype html>');
    expect(odp.body).not.toContain('<body');
    expect(odp.body).not.toContain('Stali klienci'); // pozycja menu bocznego
  });

  // ⚠️⚠️ NAJWAŻNIEJSZY TEST TEJ FUNKCJI. Fragment i strona wychodzą z JEDNEGO szablonu
  // (`_magazyn-wyniki-nowe.ejs`) i to jest cała ochrona przed rozjazdem. Gdyby fragment miał
  // własną kopię, lista „na żywo" pokazywałaby prędzej czy później inne ceny niż ta sama
  // strona po odświeżeniu — a operator nie miałby jak zgadnąć, która kłamie.
  it('mówi DOKŁADNIE to samo, co pełna strona', async () => {
    const kawalek = (await get(adres)).body.trim();
    const pelna = (await app.inject({
      method: 'POST',
      url: '/zamowienia/nowe/magazyn',
      headers: naglowek,
      payload: { magazyn: 'szpulka', cennik: 'szkicownia' },
    })).body;
    expect(kawalek.length).toBeGreaterThan(50);
    expect(pelna).toContain(kawalek);
  });

  // Szukanie jest ODCZYTEM — nie ma prawa niczego założyć ani zapisać.
  it('NIE zapisuje niczego', async () => {
    await get(adres);
    expect(db.prepare('SELECT COUNT(*) AS ile FROM zamowienia').get().ile).toBe(0);
  });

  it('pusta fraza oddaje pusty kawałek, a nie całą listę magazynu', async () => {
    const odp = await get('/zamowienia/nowe/magazyn/wyniki?magazyn=&cennik=szkicownia');
    expect(odp.statusCode).toBe(200);
    expect(odp.body.trim()).toBe('');
  });

  it('brak trafień mówi wprost, w którym cenniku szukano', async () => {
    const odp = await get('/zamowienia/nowe/magazyn/wyniki?magazyn=czegotakiegoniema&cennik=pro');
    expect(odp.body).toMatch(/Nic nie pasuje/);
    expect(odp.body).toContain('pro.szkicownia.pl');
  });

  // ⚠️ Allegro NIGDY nie jest cennikiem — ta sama reguła, co przy pełnym przeładowaniu.
  // Fragment nie może być tylną furtką do cen z prowizją.
  it('kanał spoza cenników wraca jako cennik detaliczny', async () => {
    zapiszProduktSklepowy(db, produkt({ kanal: 'allegro_szkicownia', produkt_id: '999', cena_gr: 9900 }));
    const odp = await get('/zamowienia/nowe/magazyn/wyniki?magazyn=szpulka&cennik=allegro_szkicownia');
    expect(odp.body).toContain('74.90 zł');
    expect(odp.body).not.toContain('99.00 zł');
  });
});

describe('fragment z wynikami — karta zamówienia', () => {
  it('mówi DOKŁADNIE to samo, co pełna karta', async () => {
    const id = zapiszZamowienie(db, 'reczne', zmapowane(), {});
    const kawalek = (await get(`/zamowienia/${id}/magazyn/wyniki?magazyn=szpulka&cennik=szkicownia`)).body.trim();
    const pelna = (await get(`/zamowienia/${id}?edytuj=pozycje&magazyn=szpulka&cennik=szkicownia`)).body;
    expect(kawalek.length).toBeGreaterThan(50);
    expect(pelna).toContain(kawalek);
  });

  // ⚠️ Na karcie „Dodaj" jest WŁASNYM formularzem POST (zamówienie już istnieje, pozycja
  // idzie wprost do bazy), a na ekranie zakładania — przyciskiem wielkiego formularza.
  // To dwie różne drogi pieniędzy i dlatego są dwa szablony, a nie jeden z warunkiem.
  it('niesie formularz POST, a nie formaction ekranu zakładania', async () => {
    const id = zapiszZamowienie(db, 'reczne', zmapowane(), {});
    const body = (await get(`/zamowienia/${id}/magazyn/wyniki?magazyn=szpulka`)).body;
    expect(body).toContain(`action="/zamowienia/${id}/pozycje/z-magazynu"`);
    expect(body).not.toContain('formaction=');
  });

  it('nieznane zamówienie → 404, a nie pusty kawałek', async () => {
    expect((await get('/zamowienia/9999/magazyn/wyniki?magazyn=szpulka')).statusCode).toBe(404);
  });
});

describe('wpięcie htmx', () => {
  // ⚠️ Z WŁASNEGO HOSTA, nigdy z CDN-u: panel chodzi w LAN-ie bez wyjścia na świat.
  it('biblioteka ładuje się z panelu, nie z sieci', async () => {
    const body = (await get('/zamowienia/nowe')).body;
    expect(body).toContain('src="/public/htmx.min.js"');
    expect(body).not.toMatch(/src="https?:\/\//);
  });

  it.each([
    ['/zamowienia/nowe', '/zamowienia/nowe/magazyn/wyniki'],
  ])('%s pyta o fragment i podmienia właściwy kawałek', async (url, cel) => {
    const body = (await get(url)).body;
    expect(body).toContain(`hx-get="${cel}"`);
    expect(body).toContain('hx-target="#magazyn-wyniki"');
    // ⚠️ Cel bez elementu NIE JEST błędem — htmx po prostu cicho nic nie podmienia.
    expect(body).toContain('id="magazyn-wyniki"');
  });

  // ⚠️ BIBLIOTEKA WCHODZI PO JEDNYM EKRANIE, nie globalnie — i to nie jest oszczędność bajtów,
  // tylko obrona cudzej decyzji: ekran zwrotu ma NIE MIEĆ ani jednego skryptu, bo jego
  // dwukrokowość bierze się stąd, że nic nie liczy się na żywo (tests/oms/web-zwroty.test.js).
  // Globalne wpięcie złamało tamten strażnik przy pierwszym uruchomieniu suity.
  // ⚠️⚠️ SELEKTOR `hx-include`, KTORY NIC NIE WSKAZUJE, JEST CICHY. htmx wysle wtedy zapytanie
  // BEZ cennika, serwer podstawi domyslny detal i operator dostanie ceny ze sklepu A,
  // choc na ekranie ma wybrane PRO. Zaden blad tego nie zglosi — ani w przegladarce, ani na
  // serwerze. To jedyne miejsce w tej funkcji, ktorego test serwerowy normalnie NIE widzi,
  // wiec sprawdzamy je wprost: czy to, co selektor wskazuje, w ogole na stronie istnieje.
  it('nowe zamówienie wskazuje oba pola wielkiego formularza', async () => {
    const body = (await get('/zamowienia/nowe')).body;
    for (const pole of ['cennik', 'magazyn']) {
      expect(body).toContain(`hx-include="[name='${pole}']"`);
      expect(body).toMatch(new RegExp(`name="${pole}"`));
    }
  });

  it('karta ogranicza oba selektory do paska razem z adresem powrotu', async () => {
    const id = zapiszZamowienie(db, 'reczne', zmapowane(), {});
    const body = (await get(`/zamowienia/${id}?edytuj=pozycje`)).body;
    const dopasowanie = body.match(/<form[^>]*id="magazyn-pasek"[^>]*>[\s\S]*?<\/form>/);
    expect(dopasowanie, 'brak formularza #magazyn-pasek na karcie').not.toBeNull();
    const pasek = dopasowanie[0];

    expect(pasek).toContain(
      `hx-include="#magazyn-pasek [name='cennik'], #magazyn-pasek [name='powrot']"`,
    );
    expect(pasek).toContain(
      `hx-include="#magazyn-pasek [name='magazyn'], #magazyn-pasek [name='powrot']"`,
    );
    for (const pole of ['cennik', 'magazyn', 'powrot']) {
      expect(pasek).toMatch(new RegExp(`name="${pole}"`));
    }
  });

  it('karta w trybie ODCZYTU nie wozi ze sobą htmx', async () => {
    const id = zapiszZamowienie(db, 'reczne', zmapowane(), {});
    expect((await get(`/zamowienia/${id}`)).body).not.toContain('htmx.min.js');
    expect((await get(`/zamowienia/${id}?edytuj=pozycje`)).body).toContain('htmx.min.js');
  });

  it('lista zamówień też nie', async () => {
    expect((await get('/')).body).not.toContain('htmx.min.js');
  });

  it('karta pyta o swój fragment, z numerem zamówienia w adresie', async () => {
    const id = zapiszZamowienie(db, 'reczne', zmapowane(), {});
    const body = (await get(`/zamowienia/${id}?edytuj=pozycje`)).body;
    expect(body).toContain(`hx-get="/zamowienia/${id}/magazyn/wyniki"`);
    expect(body).toContain('id="magazyn-wyniki"');
  });

  // ⚠️⚠️ HTMX JEST UŁATWIENIEM, NIE WARUNKIEM DZIAŁANIA. Przy wyłączonym JavaScripcie
  // (albo gdy plik się nie wczyta) ekran ma działać dokładnie jak dotąd — przyciskiem.
  it('„Szukaj" zostaje na obu ekranach', async () => {
    const id = zapiszZamowienie(db, 'reczne', zmapowane(), {});
    expect((await get('/zamowienia/nowe')).body).toContain('formaction="/zamowienia/nowe/magazyn#magazyn"');
    expect((await get(`/zamowienia/${id}?edytuj=pozycje`)).body).toMatch(/<button class="btn">Szukaj<\/button>/);
  });

  // Pasek szukania NIE jest podmieniany — gdyby wjeżdżał razem z wynikami, każde naciśnięcie
  // klawisza przerysowywałoby pole, w którym operator właśnie pisze.
  it('podmieniany kawałek nie zawiera pola szukania', async () => {
    const body = (await get('/zamowienia/nowe/magazyn/wyniki?magazyn=szpulka&cennik=szkicownia')).body;
    expect(body).not.toContain('name="magazyn"');
    expect(body).not.toContain('name="cennik"');
  });
});

describe('dodanie pozycji dalej idzie zwykłym formularzem', () => {
  // ⚠️ ŚWIADOMA GRANICA: szukanie to odczyt (htmx), dodanie pozycji to zapis (pełne
  // przeładowanie). Podmiana dwóch miejsc naraz — tabeli pozycji i wyników — po cichu
  // gubiłaby pozycję przy pierwszej nieudanej podmianie, a to są pieniądze.
  it('karta: „Dodaj" zapisuje do bazy i przeładowuje kartę', async () => {
    const id = zapiszZamowienie(db, 'reczne', zmapowane(), {});
    const odp = await app.inject({
      method: 'POST',
      url: `/zamowienia/${id}/pozycje/z-magazynu`,
      headers: naglowek,
      payload: { kanal: 'szkicownia', produkt_id: '28040', wariant_id: '', ilosc: '3' },
    });
    expect(odp.statusCode).toBe(302);
    expect(pobierzZamowienie(db, id).pozycje).toHaveLength(1);
  });
});
