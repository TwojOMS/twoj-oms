import {
  describe, it, expect, beforeEach, vi,
} from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { zapewnijOkres, zamknijOkres } from '../../../src/oms/db/okresy.js';
import { pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { dopiszKlientaZbiorczego } from './_klient-zbiorczy-pomocniki.js';

const naglowek = {
  authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'),
  origin: 'http://localhost',
};

// ⚠️ Od 24.08.2026 klient zbiorczy jest WIERSZEM TABELY `klienci`, nie wpisem w konfiguracji.
const KLIENT = {
  klucz: 'zetaklient', nazwa: 'Zetaklient sp. z o.o.', nip: '1000001017',
  rabat_procent: 10, prog_darmowej_dostawy_gr: 30000,
  oplata_obslugi_gr: 400, oplata_kurierska_gr: 1900,
};
const config = { auth: { user: 'adam', pass: 'x' } };

let db;
let okres;
let app;

// ⚠️ ASERCJE CELUJA W WIERSZ, NIE W CALE CIALO ODPOWIEDZI — arkusz stylow jedzie w <style>
// ukladu, wiec `body).toMatch(/odepnij/i)` przechodziloby takze dla tabeli bez ani jednego
// przycisku. Ta sama pulapka jest opisana w okresy-trasy.test.js.
const wierszZamowienia = (body, numer) => {
  const wiersz = body.split('<tr').find((w) => w.includes(`>${numer}<`));
  if (!wiersz) throw new Error(`Tabela nie ma wiersza zamówienia ${numer}.`);
  return wiersz.split('</tr>')[0];
};

// Sekcja „Faktura" karty zamowienia — jedyne miejsce, w ktorym ma stac przycisk przypisania.
const sekcjaFaktury = (body) => {
  const m = body.match(/<section class="panel" id="faktura">[\s\S]*?<\/section>/);
  if (!m) throw new Error('Karta zamówienia nie ma sekcji „Faktura” — nie ma czego sprawdzać.');
  return m[0];
};

function dodajZamowienie({ numer, kwota = '100.00', okresId = null, nip = KLIENT.nip, hurt = 0 }) {
  // ⚠️ NIP idzie do kolumny `nip` — to z niej czyta `daneFaktury()`, czyli to samo zrodlo,
  // ktore widzi trasa. Pierwsza wersja tej fikstury wpisywala nieistniejaca `faktura_json`
  // i wywalala WSZYSTKIE 15 testow bledem SQL — czyli czerwien, ktora nic nie mowila
  // o kodzie produkcyjnym.
  db.prepare(
    'INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, okres_rozliczeniowy_id,'
    + ' do_siedziby_klienta, chce_fakture, nip, klient_json, utworzone_at)'
    + " VALUES ('reczne', ?, ?, ?, ?, ?, 1, ?, ?, '2026-07-10T10:00:00.000Z')",
  ).run(
    Number(String(numer).replace(/\D/g, '')), numer, kwota, okresId, hurt, nip,
    JSON.stringify({ first_name: 'Jan', last_name: 'Kowalski', company: 'Zetaklient sp. z o.o.' }),
  );
  const id = db.prepare('SELECT id FROM zamowienia WHERE numer = ?').get(numer).id;
  db.prepare(
    'INSERT INTO pozycje (zamowienie_id, nazwa, ilosc, cena_brutto, brutto_linii, zrodlo)'
    + " VALUES (?, 'STOP 70x100', 1, ?, ?, 'reczna')",
  ).run(id, kwota, kwota);
  return id;
}

// Okres z WYSTAWIONA faktura — kolumny ustawiane tak, jak robi to `zakonczFaktureOkresu`.
const zafakturuj = (okresId) => db.prepare(
  "UPDATE okresy_rozliczeniowe SET stan = 'zafakturowany', infakt_uuid = 'u-1',"
  + " numer = 'FV/7/2026', ksef_status = NULL WHERE id = ?",
).run(okresId);

beforeEach(async () => {
  db = openOmsDb();
  dopiszKlientaZbiorczego(db, KLIENT);
  okres = zapewnijOkres(db, { klientKlucz: 'zetaklient', rok: 2026, miesiac: 7 });
  app = buildOmsServer({ db, config, infakt: { znajdzKlientaPoNip: vi.fn(), wystaw: vi.fn() } });
  await app.ready();
});

const get = (url) => app.inject({ method: 'GET', url, headers: naglowek });
const post = (url, payload) => app.inject({ method: 'POST', url, headers: naglowek, payload });

describe('POST /okresy/:id/zamowienia/:zamId/odepnij', () => {
  it('odpina zamowienie i wraca na ekran okresu', async () => {
    const id = dodajZamowienie({ numer: 'R/2026/001', okresId: okres.id });

    const odp = await post(`/okresy/${okres.id}/zamowienia/${id}/odepnij`);

    expect(odp.statusCode).toBe(302);
    expect(pobierzZamowienie(db, id).okres_rozliczeniowy_id).toBeNull();
  });

  // ⚠️ NAJWAZNIEJSZA BARIERA CALEJ ZMIANY. Faktura zbiorcza opiewa na konkretna liste zamowien.
  it('ODMAWIA, gdy za okres jest juz faktura — i nie rusza przynaleznosci', async () => {
    const id = dodajZamowienie({ numer: 'R/2026/002', okresId: okres.id });
    zafakturuj(okres.id);

    const odp = await post(`/okresy/${okres.id}/zamowienia/${id}/odepnij`);

    expect(odp.statusCode).toBe(400);
    expect(pobierzZamowienie(db, id).okres_rozliczeniowy_id).toBe(okres.id);
  });

  // ⚠️ Ukryty przycisk NIE JEST bariera — zadanie ze starej, otwartej karty omija widok
  // w calosci. Ten test pilnuje, ze odmowa siedzi w trasie, nie w szablonie.
  it('odmawia zamowieniu z INNEGO okresu, choc oba naleza do tego samego klienta', async () => {
    const sierpien = zapewnijOkres(db, { klientKlucz: 'zetaklient', rok: 2026, miesiac: 8 });
    const id = dodajZamowienie({ numer: 'R/2026/003', okresId: sierpien.id });

    const odp = await post(`/okresy/${okres.id}/zamowienia/${id}/odepnij`);

    expect(odp.statusCode).toBe(400);
    expect(pobierzZamowienie(db, id).okres_rozliczeniowy_id).toBe(sierpien.id);
  });

  it('zostawia slad w logu zamowienia', async () => {
    const id = dodajZamowienie({ numer: 'R/2026/004', okresId: okres.id });

    await post(`/okresy/${okres.id}/zamowienia/${id}/odepnij`);

    const wpisy = db.prepare('SELECT * FROM log WHERE zamowienie_id = ?').all(id);
    expect(wpisy.some((w) => /okres/i.test(w.akcja))).toBe(true);
  });
});

describe('ekran okresu — przycisk „Odepnij”', () => {
  it('okres bez faktury pokazuje przycisk w wierszu zamowienia', async () => {
    dodajZamowienie({ numer: 'R/2026/005', okresId: okres.id });

    const body = (await get(`/okresy/${okres.id}`)).body;

    expect(wierszZamowienia(body, 'R/2026/005')).toMatch(/Odepnij/);
  });

  // Odpowiednik zasady, ktora ekran okresu stosuje juz przy „Otwórz okres ponownie":
  // przycisku, ktory i tak dostanie odmowe, nie pokazujemy w ogole.
  it('okres z faktura NIE pokazuje przycisku', async () => {
    dodajZamowienie({ numer: 'R/2026/006', okresId: okres.id });
    zafakturuj(okres.id);

    const body = (await get(`/okresy/${okres.id}`)).body;

    expect(wierszZamowienia(body, 'R/2026/006')).not.toMatch(/Odepnij/);
  });

  it('okres ZAMKNIETY, ale bez faktury, dalej pokazuje przycisk', async () => {
    dodajZamowienie({ numer: 'R/2026/007', okresId: okres.id });
    zamknijOkres(db, okres.id);

    const body = (await get(`/okresy/${okres.id}`)).body;

    expect(wierszZamowienia(body, 'R/2026/007')).toMatch(/Odepnij/);
  });
});

describe('POST /zamowienia/:id/okres (przypisanie)', () => {
  it('dopisuje zamowienie do okresu jego miesiaca', async () => {
    const id = dodajZamowienie({ numer: 'R/2026/008', okresId: null });

    const odp = await post(`/zamowienia/${id}/okres`);

    expect(odp.statusCode).toBe(302);
    // Zamowienie ma date zlozenia 10.07.2026, wiec ma trafic do LIPCOWEGO okresu — tego,
    // ktory juz istnieje. Miesiac bierze sie z daty zlozenia, nie z dzisiejszej.
    expect(pobierzZamowienie(db, id).okres_rozliczeniowy_id).toBe(okres.id);
  });

  // ⚠️ DRUGI DOKUMENT ZA TE SAMA SPRZEDAZ — zamowienie z wlasna faktura pojechaloby
  // jeszcze raz na fakturze zbiorczej.
  // ⚠️ LOG MA NAZYWAC MIESIAC, NIE ID. Pierwsza wersja zapisywala „dopisane do okresu 1" —
  // czytajac to za pol roku nikt nie wie, o ktory miesiac chodzi, a log zamowienia jest
  // jedynym sladem tej zmiany. Odpiecie od poczatku pisalo „2026-08" i te dwa wpisy
  // stoja obok siebie w tym samym logu.
  it('zostawia w logu CZYTELNY miesiac, nie identyfikator okresu', async () => {
    const id = dodajZamowienie({ numer: 'R/2026/016', okresId: null });

    await post(`/zamowienia/${id}/okres`);

    const wpis = db.prepare("SELECT * FROM log WHERE zamowienie_id = ? AND akcja = 'okres.przypisz'").get(id);
    expect(wpis.wynik).toMatch(/2026-07/);
  });

  it('ODMAWIA zamowieniu, ktore ma juz wlasna fakture', async () => {
    const id = dodajZamowienie({ numer: 'R/2026/009', okresId: null });
    db.prepare(
      "INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, ksef_status, utworzona_at)"
      + " VALUES (?, 'u-9', 'FV/112/2026', NULL, '2026-07-11T10:00:00.000Z')",
    ).run(id);

    const odp = await post(`/zamowienia/${id}/okres`);

    expect(odp.statusCode).toBe(400);
    expect(pobierzZamowienie(db, id).okres_rozliczeniowy_id).toBeNull();
  });

  it('ODMAWIA zamowieniu oznaczonemu jako hurt do siedziby', async () => {
    const id = dodajZamowienie({ numer: 'R/2026/010', okresId: null, hurt: 1 });

    const odp = await post(`/zamowienia/${id}/okres`);

    expect(odp.statusCode).toBe(400);
    expect(pobierzZamowienie(db, id).okres_rozliczeniowy_id).toBeNull();
  });

  it('ODMAWIA, gdy NIP nie nalezy do klienta rozliczanego zbiorczo', async () => {
    const id = dodajZamowienie({ numer: 'R/2026/011', okresId: null, nip: '1234567890' });

    const odp = await post(`/zamowienia/${id}/okres`);

    expect(odp.statusCode).toBe(400);
    expect(pobierzZamowienie(db, id).okres_rozliczeniowy_id).toBeNull();
  });

  // Odmowa zamknietego miesiaca przychodzi z `przypiszDoOkresu` — tej samej funkcji, ktorej
  // uzywa zakladanie zamowienia. Panel ma ja przepuscic, a nie wymyslac wlasnej.
  it('ODMAWIA, gdy miesiac zamowienia jest juz rozliczony', async () => {
    const id = dodajZamowienie({ numer: 'R/2026/012', okresId: null });
    zafakturuj(okres.id);

    const odp = await post(`/zamowienia/${id}/okres`);

    expect(odp.statusCode).toBe(400);
    expect(pobierzZamowienie(db, id).okres_rozliczeniowy_id).toBeNull();
  });
});

describe('karta zamowienia — przycisk „Przypisz do okresu”', () => {
  it('zamowienie klienta zbiorczego bez okresu dostaje przycisk w sekcji Faktura', async () => {
    const id = dodajZamowienie({ numer: 'R/2026/013', okresId: null });

    const body = (await get(`/zamowienia/${id}`)).body;

    expect(sekcjaFaktury(body)).toMatch(/Przypisz do okresu/);
  });

  it('zamowienie zwyklego klienta nie widzi ani slowa o okresach', async () => {
    const id = dodajZamowienie({ numer: 'R/2026/014', okresId: null, nip: '1234567890' });

    const body = (await get(`/zamowienia/${id}`)).body;

    expect(sekcjaFaktury(body)).not.toMatch(/Przypisz do okresu/);
  });

  it('zamowienie JUZ w okresie nie dostaje drugiego przycisku', async () => {
    const id = dodajZamowienie({ numer: 'R/2026/015', okresId: okres.id });

    const body = (await get(`/zamowienia/${id}`)).body;

    expect(sekcjaFaktury(body)).not.toMatch(/Przypisz do okresu/);
  });
});
