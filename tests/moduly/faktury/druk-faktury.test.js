import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import {
  dodajFaktureDoKolejki, fakturyDoWziecia, oznaczBladDrukuFaktury, ostatniaPozycjaDlaFaktury,
  PROG_ZAJECIA_MS,
} from '../../../src/moduly/faktury/db/kolejka-druku-faktur.js';

// ⚠️ DRUK FAKTURY NA BROTHERZE (2026-08-09, prośba właściciela: przycisk „Drukuj" obok
// „Pobierz PDF").
//
// ⚠️⚠️ SEDNO, ZMIERZONE PRZED BUDOWĄ: **Brother MFC-J6510DW nie przyjmuje PDF-a.** Jego IPP
// ogłasza `document-format-supported`: image/urf, application/octet-stream,
// application/vnd.brother-hbp — bez `application/pdf`, bez PostScriptu, bez PCL-a. Surowy
// tekst na port 9100 nie wydrukował ani jednej strony (licznik stron drukarki bez zmian).
// Dlatego druk MUSI iść przez sterownik Windows, czyli przez komputer — panel stoi na NAS-ie.
//
// ⚠️ I DLATEGO OSOBNA KOLEJKA I OSOBNY ADRES. Na komputerze produkcyjnym chodzi STARY czuwacz
// etykiet, który KAŻDĄ pozycję z `/kolejka-druku` wysyła na Zebrę w trybie RAW. Faktura w tamtej
// kolejce znaczyłaby PDF wysłany jako ZPL. Testy niżej pilnują tego rozdziału wprost.

const config = { auth: { user: 'adam', pass: 'x' } };
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };

const PDF = Buffer.from('%PDF-1.4 udawany dokument');

let db, app, faktura, id;
beforeEach(async () => {
  db = openOmsDb(':memory:');
  faktura = { pdf: vi.fn().mockResolvedValue({ numer: 'FV/21/08/2026', bajty: PDF }) };
  app = buildOmsServer({ db, config, poller, faktura });
  await app.ready();
  id = zapiszZamowienie(db, 'pro', {
    zrodlo_id: 4242, numer: '4242', klient: { first_name: 'Jan' }, dostawa: { city: 'Pęki' },
    metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: '6762432557',
    kwota_brutto: '123.00', koszt_dostawy_brutto: '23.00', status_woo: 'processing',
    oplacone_at: null, anulowane: 0, utworzone_at: '2026-08-01T09:00:00',
    pozycje: [{ nazwa: 'Szablon STOP', sku: 'PRO-1', ilosc: 1, cena_brutto: '100.00', brutto_linii: '100.00', vat: null }],
  }, {});
});

const zFaktura = (nad = {}) => {
  db.prepare(
    'INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?, ?, ?, ?)',
  ).run(id, nad.uuid === undefined ? 'u1' : nad.uuid, nad.numer ?? 'FV/21/08/2026', '2026-08-07T10:00:00');
  return db.prepare('SELECT * FROM faktury WHERE zamowienie_id = ?').get(id);
};
const karta = async () => (await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek })).body;
const wyslij = (url, payload) => app.inject({ method: 'POST', url, headers: naglowek, payload });

describe('przycisk „Drukuj" przy fakturze', () => {
  it('stoi obok „Pobierz PDF", gdy dokument istnieje w inFakcie', async () => {
    zFaktura();
    const html = await karta();
    expect(html).toContain(`/zamowienia/${id}/faktura/pdf`);
    // ⚠️ CAŁY znacznik otwierający, nie sam adres: sprawdzenie po `action=` przepuszcza
    // formularz schowany atrybutem `hidden` — przycisk byłby w kodzie strony, a operator
    // nie zobaczyłby go nigdy. Weryfikacja mutacyjna złapała dokładnie ten przypadek.
    expect(html).toContain(`<form method="post" action="/zamowienia/${id}/faktura/drukuj" class="w-linii">`);
    expect(html).toMatch(/<button class="btn btn--maly">Drukuj<\/button>/);
  });

  // ⚠️ Wiersz w `faktury` istnieje TAKŻE jako REZERWACJA, przed powstaniem dokumentu
  // (domain/faktura-stan.js). Bez `infakt_uuid` nie ma czego pobrać z inFaktu, więc zadanie
  // wracałoby w kolejce w kółko.
  it('bez dokumentu w inFakcie przycisku nie ma, a trasa odmawia', async () => {
    zFaktura({ uuid: null });
    expect(await karta()).not.toContain('/faktura/drukuj');
    const r = await wyslij(`/zamowienia/${id}/faktura/drukuj`);
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/nie ma czego drukować/i);
  });

  it('kliknięcie wstawia zadanie do kolejki i zapisuje decyzję w logu', async () => {
    const f = zFaktura();
    const r = await wyslij(`/zamowienia/${id}/faktura/drukuj`);
    expect(r.statusCode).toBeLessThan(400);
    expect(ostatniaPozycjaDlaFaktury(db, f.id)).toMatchObject({ status: 'oczekuje', proby: 0 });
    const log = db.prepare('SELECT * FROM log WHERE zamowienie_id = ? ORDER BY id').all(id).at(-1);
    expect(log.wynik).toMatch(/DECYZJA CZŁOWIEKA \(adam\)/);
  });

  // Powtórny wydruk JEST dozwolony — papier się zaciął, wydruk wyszedł blady.
  it('drugie kliknięcie tworzy DRUGIE zadanie, nie odmawia', async () => {
    const f = zFaktura();
    await wyslij(`/zamowienia/${id}/faktura/drukuj`);
    await wyslij(`/zamowienia/${id}/faktura/drukuj`);
    expect(db.prepare('SELECT COUNT(*) AS ile FROM kolejka_druku_faktur WHERE faktura_id = ?').get(f.id).ile).toBe(2);
  });
});

describe('kolejka faktur jest ODDZIELONA od kolejki etykiet', () => {
  // ⚠️⚠️ NAJWAŻNIEJSZY TEST W TYM PLIKU. Stary czuwacz etykiet wysyła każdą pozycję
  // z `/kolejka-druku` na Zebrę w trybie RAW — faktura, która by tam trafiła, pojechałaby
  // jako ZPL.
  it('faktura NIE pojawia się w kolejce etykiet', async () => {
    zFaktura();
    await wyslij(`/zamowienia/${id}/faktura/drukuj`);
    const etykiety = await app.inject({ method: 'GET', url: '/kolejka-druku', headers: naglowek });
    expect(etykiety.json()).toEqual([]);
    const faktury = await app.inject({ method: 'GET', url: '/kolejka-druku-faktur', headers: naglowek });
    expect(faktury.json()).toHaveLength(1);
  });

  it('kolejka faktur oddaje pola, których oczekuje czuwacz', async () => {
    zFaktura();
    await wyslij(`/zamowienia/${id}/faktura/drukuj`);
    const [poz] = fakturyDoWziecia(db);
    // Kontrakt ze skryptem: $poz.id / $poz.numer / $poz.zamowienie.
    expect(poz).toMatchObject({ numer: 'FV/21/08/2026', zamowienie: '4242' });
    expect(typeof poz.id).toBe('number');
  });
});

describe('czuwacz pobiera PDF i potwierdza wydruk', () => {
  // ⚠️ PDF idzie z inFaktu NA ŚWIEŻO — panel nie trzyma kopii dokumentu, bo po korekcie
  // kopia kłamałaby przy drukarce.
  it('trasa PDF-u woła inFakt, a nie żaden zapisany plik', async () => {
    zFaktura();
    await wyslij(`/zamowienia/${id}/faktura/drukuj`);
    const [poz] = fakturyDoWziecia(db);
    const r = await app.inject({ method: 'GET', url: `/kolejka-druku-faktur/${poz.id}/pdf`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/application\/pdf/);
    expect(Buffer.from(r.rawPayload)).toEqual(PDF);
    expect(faktura.pdf).toHaveBeenCalledWith(id);
  });

  it('potwierdzenie zdejmuje pozycję z kolejki', async () => {
    const f = zFaktura();
    await wyslij(`/zamowienia/${id}/faktura/drukuj`);
    const [poz] = fakturyDoWziecia(db);
    const r = await wyslij(`/kolejka-druku-faktur/${poz.id}/wydrukowano`);
    expect(r.statusCode).toBeLessThan(400);
    expect(fakturyDoWziecia(db)).toEqual([]);
    expect(ostatniaPozycjaDlaFaktury(db, f.id).status).toBe('wydrukowano');
  });

  // ⚠️ Awaria NIE zdejmuje pozycji z kolejki, ale MUSI odsunąć kolejną próbę — bez tego
  // czuwacz dobijałby się co kilka sekund i zasypywał log.
  it('błąd zostawia zadanie w kolejce, ale odsuwa kolejną próbę', async () => {
    const f = zFaktura();
    await wyslij(`/zamowienia/${id}/faktura/drukuj`);
    const [poz] = fakturyDoWziecia(db);
    const r = await wyslij(`/kolejka-druku-faktur/${poz.id}/blad`, { powod: 'brak papieru' });
    expect(r.statusCode).toBeLessThan(400);

    const w = ostatniaPozycjaDlaFaktury(db, f.id);
    expect(w).toMatchObject({ status: 'oczekuje', proby: 1, ostatni_blad: 'brak papieru' });
    expect(w.nastepna_proba_at).toBeTruthy();
    // ...i dopóki czas nie minie, czuwacz jej NIE dostaje.
    expect(fakturyDoWziecia(db)).toEqual([]);
    expect(fakturyDoWziecia(db, '2999-01-01T00:00:00.000Z')).toHaveLength(1);
  });

  it('nieznana pozycja → 404, nie 500', async () => {
    expect((await app.inject({ method: 'GET', url: '/kolejka-druku-faktur/999/pdf', headers: naglowek })).statusCode).toBe(404);
    expect((await wyslij('/kolejka-druku-faktur/999/wydrukowano')).statusCode).toBe(404);
    expect((await wyslij('/kolejka-druku-faktur/999/blad', { powod: 'x' })).statusCode).toBe(404);
  });
});

// ⚠️⚠️ CZUWACZ WOLNO URUCHOMIC NA KILKU KOMPUTERACH NARAZ (prośba właściciela 2026-08-09:
// „na produkcyjnym też jest brother, czy można to na obu odpalić?"). Oba mają sterownik
// TEJ SAMEJ drukarki WiFi, więc bez zajmowania zadań każda faktura wyjechałaby tyle razy,
// ile czuwaczy akurat działa. To jest jedyna rzecz, która o tym decyduje — stąd te testy.
describe('dwa stanowiska nie drukują tego samego dwa razy', () => {
  const wezZadania = (stanowisko, terazIso) => fakturyDoWziecia(db, { stanowisko, terazIso });

  it('drugie stanowisko NIE dostaje zadania zajętego przez pierwsze', async () => {
    zFaktura();
    await wyslij(`/zamowienia/${id}/faktura/drukuj`);

    const pierwsze = wezZadania('produkcyjny', '2026-08-09T20:00:00.000Z');
    const drugie = wezZadania('laptop', '2026-08-09T20:00:05.000Z');

    expect(pierwsze).toHaveLength(1);
    expect(drugie, 'drugi czuwacz nie ma prawa zobaczyć tego samego zadania').toEqual([]);
  });

  it('to samo przez HTTP — dwa odpytania z różnych stanowisk', async () => {
    zFaktura();
    await wyslij(`/zamowienia/${id}/faktura/drukuj`);
    const a = await app.inject({ method: 'GET', url: '/kolejka-druku-faktur?stanowisko=produkcyjny', headers: naglowek });
    const b = await app.inject({ method: 'GET', url: '/kolejka-druku-faktur?stanowisko=laptop', headers: naglowek });
    expect(a.json()).toHaveLength(1);
    expect(b.json()).toEqual([]);
  });

  // ⚠️⚠️ DWA ODPYTANIA W TEJ SAMEJ MILISEKUNDZIE — i to jest jedyny przypadek, w którym
  // o wszystkim decyduje NAZWA STANOWISKA. Weryfikacja mutacyjna pokazała, że przy różnych
  // znacznikach czasu poprawność trzyma się sama (drugie odpytanie nie znajduje już wiersza
  // do zajęcia), więc podmiana nazwy na stałą przechodziła bez czerwonego testu. Przy
  // identycznym znaczniku ta druga siatka znika i zostaje sama nazwa: bez niej OBA
  // stanowiska zobaczyłyby ten sam wiersz i faktura wyszłaby dwa razy.
  it('dwa odpytania w TEJ SAMEJ chwili — zadanie dostaje tylko jedno stanowisko', () => {
    zFaktura();
    dodajFaktureDoKolejki(db, db.prepare('SELECT id FROM faktury').get().id);
    const chwila = '2026-08-09T20:00:00.000Z';

    const a = wezZadania('produkcyjny', chwila);
    const b = wezZadania('laptop', chwila);

    expect([a.length, b.length].sort()).toEqual([0, 1]);
  });

  // ⚠️ ZAJECIE MUSI WYGASAC. Komputer potrafi zasnąć w połowie wydruku — zadanie zajęte
  // NA ZAWSZE nie wydrukowałoby się nigdy, i to bez śladu.
  it('po wygaśnięciu zajęcia zadanie wraca do drugiego stanowiska', () => {
    zFaktura();
    dodajFaktureDoKolejki(db, db.prepare('SELECT id FROM faktury').get().id);

    const start = new Date('2026-08-09T20:00:00.000Z');
    expect(wezZadania('produkcyjny', start.toISOString())).toHaveLength(1);

    const tuzPrzed = new Date(start.getTime() + PROG_ZAJECIA_MS - 1000).toISOString();
    expect(wezZadania('laptop', tuzPrzed), 'przed progiem zadanie jest cudze').toEqual([]);

    const poProgu = new Date(start.getTime() + PROG_ZAJECIA_MS + 1000).toISOString();
    expect(wezZadania('laptop', poProgu), 'po progu wraca do puli').toHaveLength(1);
  });

  // Nieudana próba ma zwolnić zajęcie OD RAZU — inaczej drugie stanowisko (którego drukarka
  // może akurat działać) czekałoby na wygaśnięcie zajęcia zamiast na samo odroczenie.
  it('po błędzie zadanie wraca do puli, nie czeka na wygaśnięcie zajęcia', async () => {
    const f = zFaktura();
    await wyslij(`/zamowienia/${id}/faktura/drukuj`);
    const [poz] = wezZadania('produkcyjny', '2026-08-09T20:00:00.000Z');
    await wyslij(`/kolejka-druku-faktur/${poz.id}/blad`, { powod: 'brak papieru' });

    const w = ostatniaPozycjaDlaFaktury(db, f.id);
    expect(w.zajete_przez, 'zajęcie ma być zwolnione').toBeNull();
    // ...a po minięciu odroczenia bierze je ktokolwiek, kto pierwszy zapyta.
    expect(wezZadania('laptop', '2999-01-01T00:00:00.000Z')).toHaveLength(1);
  });

  // Stary czuwacz bez parametru dalej działa — po prostu jako jedno stanowisko.
  it('odpytanie bez `stanowisko` nie wywala się i dostaje zadanie', async () => {
    zFaktura();
    await wyslij(`/zamowienia/${id}/faktura/drukuj`);
    const r = await app.inject({ method: 'GET', url: '/kolejka-druku-faktur', headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toHaveLength(1);
  });
});

describe('stan wydruku na karcie i wyjście z zapętlenia', () => {
  it('po nieudanych próbach karta mówi ile i dlaczego, i daje „Porzuć"', async () => {
    const f = zFaktura();
    dodajFaktureDoKolejki(db, f.id);
    oznaczBladDrukuFaktury(db, ostatniaPozycjaDlaFaktury(db, f.id).id, 'drukarka offline');

    const html = await karta();
    expect(html).toMatch(/nie udał się 1 raz/);
    expect(html).toContain('drukarka offline');
    expect(html).toContain(`action="/zamowienia/${id}/faktura/druk-porzuc"`);
  });

  // ⚠️ Niezmiennik 4.9: panel nie może wchodzić w stan, z którego nie umie wyjść.
  it('„Porzuć" zdejmuje zadanie i zapisuje decyzję człowieka', async () => {
    const f = zFaktura();
    dodajFaktureDoKolejki(db, f.id);
    const r = await wyslij(`/zamowienia/${id}/faktura/druk-porzuc`);
    expect(r.statusCode).toBeLessThan(400);
    expect(ostatniaPozycjaDlaFaktury(db, f.id).status).toBe('porzucone');
    expect(fakturyDoWziecia(db)).toEqual([]);
    const log = db.prepare('SELECT * FROM log WHERE zamowienie_id = ? ORDER BY id').all(id).at(-1);
    expect(log.wynik).toMatch(/DECYZJA CZŁOWIEKA \(adam\)/);
  });

  it('po wydrukowaniu karta mówi kiedy — żeby nikt nie drukował drugi raz', async () => {
    const f = zFaktura();
    dodajFaktureDoKolejki(db, f.id);
    await wyslij(`/kolejka-druku-faktur/${ostatniaPozycjaDlaFaktury(db, f.id).id}/wydrukowano`);
    expect(await karta()).toMatch(/Wydrukowano/);
  });

  it('bez ani jednego zadania karta nic o wydruku nie mówi', async () => {
    zFaktura();
    const html = await karta();
    expect(html).not.toMatch(/czeka w kolejce druku/);
    expect(html).not.toMatch(/Porzuć wydruk/);
  });
});
