import {
  describe, it, expect, beforeEach, vi,
} from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { rozpocznijPrzesylke, zakonczPrzesylke, zapiszStatusDpd } from '../../../src/moduly/wysylka/db/przesylki.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

// FILTRY NAD LISTA /przesylki (data utworzenia od-do, przewoznik, zrodlo zamowienia).
//
// ⚠️ Osobny plik od web-przesylki.test.js celowo: tamten pilnuje CHIPOW (`pokaz=`), czyli
// nawigacji po stanach paczki, a ten pilnuje FILTROW, czyli zawezenia zbioru. To dwa
// rozne wymiary tego samego ekranu i mieszanie ich w jednym pliku konczy sie testem,
// ktory zmienia sie przy kazdej zmianie po drugiej stronie.
//
// ⚠️ Dzien liczymy `dzienWarszawa` — TA SAMA funkcja, co drukuje date w wierszu
// (niezmiennik 4.13b). Dlatego dane maja znaczniki UTC, a oczekiwania sa w dniach
// warszawskich: 2026-08-21T10:00Z to 21.08 (12:00 CEST), a 2026-08-24T23:30Z to
// juz 25.08 — ten drugi przypadek jest w tescie po to, zeby druga implementacja
// liczaca dzien z UTC rozjechala sie o jeden wiersz.

const AUTH = { authorization: `Basic ${Buffer.from('adam:x').toString('base64')}` };
const CONFIG = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] };

const zmapowane = (nr) => ({
  zrodlo_id: nr,
  numer: `Z-${nr}`,
  klient: { first_name: 'Jan', last_name: 'Testowy', email: 'j@k.pl' },
  dostawa: {},
  metoda_wysylki: 'dpd',
  kwota_pobrania: null,
  chce_fakture: 0,
  nip: null,
  kwota_brutto: '50.00',
  status_woo: 'processing',
  oplacone_at: null,
  anulowane: 0,
  utworzone_at: '2026-08-20T10:00:00Z',
  pozycje: [],
});

function nadana(db, zamowienieId, kurier, numer, { status = null, statusAt = null, utworzona } = {}) {
  const p = rozpocznijPrzesylke(db, zamowienieId, kurier);
  zakonczPrzesylke(db, p.id, { numerListu: numer, etykietaSciezka: '/tmp/e.pdf', surowa: '<x/>' });
  db.prepare('UPDATE przesylki SET utworzona_at = ? WHERE id = ?').run(utworzona, p.id);
  if (status) zapiszStatusDpd(db, p.id, { opis: status, at: statusAt });
  return p.id;
}

// Numery listow sa mowiace, zeby asercje czytalo sie bez zagladania do beforeEach.
let db; let app;
beforeEach(() => {
  // ⚠️ Fejkujemy WYLACZNIE `Date` — pelne useFakeTimers() wiesza POST-y w Fastify
  // (ta sama forma i ten sam powod, co w web-przesylki.test.js).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-08-27T10:00:00Z'));
  db = openOmsDb(':memory:');

  const id1 = zapiszZamowienie(db, 'pro', zmapowane(1), {});
  nadana(db, id1, 'dpd', 'DPD-21', { utworzona: '2026-08-21T10:00:00.000Z' });

  const id2 = zapiszZamowienie(db, 'pro', zmapowane(2), {});
  nadana(db, id2, 'dpd', 'DPD-22', { utworzona: '2026-08-22T08:00:00.000Z' });

  const id3 = zapiszZamowienie(db, 'allegro_szkicownia', zmapowane(3), {});
  // 23:30 UTC = 25.08 o 01:30 czasu warszawskiego. Wiersz-pulapka na liczenie dnia z UTC.
  nadana(db, id3, 'allegro_wza', 'WZA-25', { utworzona: '2026-08-24T23:30:00.000Z' });

  app = buildOmsServer({ db, config: CONFIG });
});

const pobierz = (url) => app.inject({ method: 'GET', url, headers: AUTH });

describe('filtr daty utworzenia', () => {
  it('zakres od-do zostawia paczki z tych dni, reszte odcina', async () => {
    const r = await pobierz('/przesylki?pokaz=wszystkie&od=2026-08-21&do=2026-08-22');
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('DPD-21');
    expect(r.body).toContain('DPD-22');
    expect(r.body).not.toContain('WZA-25');
  });

  it('dzien liczy sie po warszawsku, nie po UTC — paczka z 24.08 23:30Z nalezy do 25.08', async () => {
    const wDniuUtc = await pobierz('/przesylki?pokaz=wszystkie&od=2026-08-24&do=2026-08-24');
    expect(wDniuUtc.body).not.toContain('WZA-25');

    const wDniuWarszawskim = await pobierz('/przesylki?pokaz=wszystkie&od=2026-08-25&do=2026-08-25');
    expect(wDniuWarszawskim.body).toContain('WZA-25');
  });

  it('granice zakresu sa domkniete obustronnie', async () => {
    const r = await pobierz('/przesylki?pokaz=wszystkie&od=2026-08-22&do=2026-08-25');
    expect(r.body).not.toContain('DPD-21');
    expect(r.body).toContain('DPD-22');
    expect(r.body).toContain('WZA-25');
  });

  it('filtr daty siega POZA okno 60 dni, bo inaczej bylby ozdoba', async () => {
    const stare = zapiszZamowienie(db, 'pro', zmapowane(9), {});
    nadana(db, stare, 'dpd', 'DPD-STARA', { utworzona: '2026-01-15T10:00:00.000Z' });

    const bezFiltra = await pobierz('/przesylki?pokaz=wszystkie');
    expect(bezFiltra.body).not.toContain('DPD-STARA');

    const zFiltrem = await pobierz('/przesylki?pokaz=wszystkie&od=2026-01-01&do=2026-01-31');
    expect(zFiltrem.body).toContain('DPD-STARA');
  });

  it('niepoprawna data to 400, nie cicha pusta lista', async () => {
    const r = await pobierz('/przesylki?od=wczoraj&do=2026-08-22');
    expect(r.statusCode).toBe(400);
  });

  it('od pozniejsze niz do to 400', async () => {
    const r = await pobierz('/przesylki?od=2026-08-25&do=2026-08-21');
    expect(r.statusCode).toBe(400);
  });

  it('data nieistniejaca w kalendarzu to 400, mimo poprawnego ksztaltu', async () => {
    const r = await pobierz('/przesylki?od=2026-02-30&do=2026-03-01');
    expect(r.statusCode).toBe(400);
  });
});

describe('filtr przewoznika i zrodla', () => {
  it('przewoznik zaweza do swoich paczek', async () => {
    db.prepare("UPDATE zamowienia SET metoda_wysylki = 'inpost_paczkomat' WHERE numer = 'Z-3'").run();
    const r = await pobierz('/przesylki?pokaz=wszystkie&kurier=inpost');
    expect(r.body).toContain('WZA-25');
    expect(r.body).not.toContain('DPD-21');
  });

  it('zrodlo zamowienia zaweza do swojego kanalu', async () => {
    const r = await pobierz('/przesylki?pokaz=wszystkie&sklep=pro');
    expect(r.body).toContain('DPD-21');
    expect(r.body).toContain('DPD-22');
    expect(r.body).not.toContain('WZA-25');
  });

  it('filtry lacza sie ze soba, a nie zastepuja', async () => {
    const r = await pobierz('/przesylki?pokaz=wszystkie&kurier=dpd&od=2026-08-22&do=2026-08-22');
    expect(r.body).toContain('DPD-22');
    expect(r.body).not.toContain('DPD-21');
    expect(r.body).not.toContain('WZA-25');
  });
});

describe('listy rozwijane filtrow', () => {
  // ⚠️ Niezmiennik 4.13b: lista wartosci filtra pochodzi z PELNEGO zbioru, nie z tego,
  // co zostalo po filtrze. Lista budowana po zawezeniu zatrzaskuje operatora na wybranej
  // wartosci — jedyna droga powrotu to „Wyczysc filtry", czyli utrata reszty filtrow.
  it('lista przewoznikow zostaje pelna po wybraniu jednego przewoznika', async () => {
    db.prepare("UPDATE zamowienia SET metoda_wysylki = 'inpost_paczkomat' WHERE numer = 'Z-3'").run();
    const r = await pobierz('/przesylki?pokaz=wszystkie&kurier=dpd');
    expect(r.body).toContain('value="inpost"');
    expect(r.body).toContain('value="dpd"');
  });

  it('lista zrodel zostaje pelna po wybraniu jednego zrodla', async () => {
    const r = await pobierz('/przesylki?pokaz=wszystkie&sklep=pro');
    expect(r.body).toContain('value="allegro_szkicownia"');
    expect(r.body).toContain('value="pro"');
  });

  it('lista przewoznikow nie gubi sie przy zawezeniu data', async () => {
    db.prepare("UPDATE zamowienia SET metoda_wysylki = 'inpost_paczkomat' WHERE numer = 'Z-3'").run();
    const r = await pobierz('/przesylki?pokaz=wszystkie&od=2026-08-21&do=2026-08-21');
    expect(r.body).toContain('value="inpost"');
  });
});

describe('filtry przezywaja nawigacje', () => {
  it('klikniecie chipu zachowuje filtry', async () => {
    const r = await pobierz('/przesylki?pokaz=wszystkie&kurier=dpd&od=2026-08-21&do=2026-08-22');
    expect(r.body).toContain('kurier=dpd');
    expect(r.body).toContain('od=2026-08-21');
    expect(r.body).toContain('do=2026-08-22');
  });

  it('ukrycie paczki wraca na te sama liste z filtrami', async () => {
    const id = db.prepare("SELECT id FROM przesylki WHERE numer_listu = 'DPD-21'").get().id;
    const r = await app.inject({
      method: 'POST',
      url: `/przesylki/${id}/ukryj`,
      headers: { ...AUTH, origin: 'http://localhost' },
      payload: {
        pokaz: 'wszystkie', kurier: 'dpd', od: '2026-08-21', do: '2026-08-22',
      },
    });
    expect(r.headers.location).toContain('pokaz=wszystkie');
    expect(r.headers.location).toContain('kurier=dpd');
    expect(r.headers.location).toContain('od=2026-08-21');
  });

  it('„Wyczysc filtry" zostawia sam chip, bez wartosci filtrow', async () => {
    const r = await pobierz('/przesylki?pokaz=doreczone&kurier=dpd&od=2026-08-21&do=2026-08-22');
    expect(r.body).toContain('href="/przesylki?pokaz=doreczone"');
  });
});
