// PRZ-109.12 (recenzja 22.10, poz. 07): po trzech nieudanych próbach automatu silnik dopisywał do logu zamówienia
// i do dziennika wykonań surowe `e.message` błędu poczty — a w nim odpowiedź serwera z loginem skrzynki. Wpis
// `wiadomosc.blad` był już czysty (PRZ-109.07), ale `automatyzacja.blad` / `automatyzacja.niepewna` i `powod`
// wykonania szły inną drogą. Teraz błąd transportu poczty opisuje `opisBleduPocztyDoLogu` (kod + zdanie).
import { it, expect, vi, afterEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { MODULY } from '../../../src/moduly/lista.ts';
import { kolejnoscBudowy } from '../../../src/core/sprawdz-moduly.ts';
import { zapiszZamowienie, pobierzZamowienie, zapiszFaktyStatusu } from '../../../src/oms/db/zamowienia.js';
import { faktyDlaStatusu } from '../../../src/domena/status-reczny.js';
import { zarejestrujPrzesylkeReczna } from '../../../src/moduly/wysylka/db/przesylki.js';
import { createWiadomosci } from '../../../src/moduly/wiadomosci/services/wiadomosci.js';
import { createSilnikAutomatyzacji } from '../../../src/moduly/automatyzacje/services/silnik.js';
import { ZDARZENIA } from '../../../src/moduly/automatyzacje/zdarzenia/index.js';
import { utworzAkcje } from '../../../src/moduly/automatyzacje/akcje/index.js';
import { sprawdzanieWarunkow } from '../../../src/moduly/automatyzacje/services/warunki.js';
import { utworzRegule, wlaczRegule } from '../../../src/moduly/automatyzacje/db/reguly.js';

const LOGIN = 'sekretny.login@firma.invalid';

afterEach(() => vi.useRealTimers());

function przygotuj(blad) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse('2026-10-21T12:00:00.000Z'));
  const db = openOmsDb(':memory:', { moduly: kolejnoscBudowy(MODULY) });
  const mailer = { sendMail: async () => { throw blad; } };
  const wiadomosci = createWiadomosci({ db, mailer, config: { klienciZbiorczy: [], oprawaPoczty: { podpis: 'P', footer: 'S' } } });
  const silnik = createSilnikAutomatyzacji({ db, zdarzenia: ZDARZENIA, akcje: utworzAkcje({ wiadomosci: () => wiadomosci }),
    sprawdzWarunki: sprawdzanieWarunkow, pocztaGotowa: () => true });
  const rid = utworzRegule(db, { nazwa: 'Wysłane', zdarzenie: 'status_zmieniony', zdarzenie_json: { status: 'wyslane' },
    warunki: { kanaly: ['sklep'], kanalyZnane: ['sklep'], statusy: ['wyslane'], maNumerListu: true, metody: [], pobranie: 'dowolne' },
    akcja: 'mail_kupujacy', akcja_json: { szablon: 'wyslane' }, opoznienie_min: 0, limit_na_godzine: 20 }, { login: 't' });
  wlaczRegule(db, rid, { login: 't' });
  vi.setSystemTime(Date.now() + 60_000);
  const id = zapiszZamowienie(db, 'sklep', {
    zrodlo_id: 7001, numer: 'L-1', klient: { first_name: 'A', last_name: 'N', email: 'k@example.invalid', phone: '' },
    dostawa: { first_name: 'A', last_name: 'N', address_1: 'Lipowa 7', postcode: '00-950', city: 'Warszawa' },
    metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '189.00',
    koszt_dostawy_brutto: '19.00', koszt_dostawy_netto: '15.45', status_woo: 'processing', oplacone_at: null, anulowane: 0,
    utworzone_at: '2026-10-20T09:00:00',
    pozycje: [{ zrodlo_id: 9001, nazwa: 'Lampa', sku: 'L', ilosc: 1, cena_brutto: '189.00', cena_netto: '153.66',
      brutto_linii: '189.00', netto_linii: '153.66', vat: null }],
  });
  zarejestrujPrzesylkeReczna(db, id, { kurier: 'dpd', kolejnosc: 1, numerListu: '00000000101U' });
  zapiszFaktyStatusu(db, id, { ...faktyDlaStatusu(pobierzZamowienie(db, id), 'wyslane'), kto: 't' });
  vi.setSystemTime(Date.now() + 60_000);
  return { db, silnik, id };
}

const czytaj = (db, id) => ({
  log: db.prepare('SELECT akcja, wynik FROM log WHERE zamowienie_id = ? ORDER BY id').all(id),
  wykonania: db.prepare('SELECT stan, powod FROM automatyzacje_wykonania').all(),
});

it('EAUTH z automatu: po 3 próbach ani log zamówienia, ani dziennik wykonań nie mają loginu z odpowiedzi serwera', async () => {
  const blad = Object.assign(new Error(`Invalid login: 535 5.7.8 Authentication failed for ${LOGIN}`),
    { code: 'EAUTH', response: `535 5.7.8 Authentication failed for ${LOGIN}` });
  const { db, silnik, id } = przygotuj(blad);
  await silnik.przebieg();
  for (let i = 0; i < 3; i += 1) { vi.setSystemTime(Date.now() + 16 * 60_000); await silnik.przebieg(); }
  const { log, wykonania } = czytaj(db, id);
  expect(log.some((w) => w.akcja === 'automatyzacja.blad')).toBe(true);
  expect(wykonania[0].stan).toBe('blad');
  for (const w of log) expect(w.wynik).not.toContain(LOGIN);
  for (const w of wykonania) expect(w.powod ?? '').not.toContain(LOGIN);
  expect(wykonania[0].powod).toContain('(EAUTH)');
  db.close();
});

it('błąd po przyjęciu treści (niepewne): wpis bez loginu, z kodem', async () => {
  const blad = Object.assign(new Error(`Unexpected socket close ${LOGIN}`), { code: 'ESOCKET', response: LOGIN });
  const { db, silnik, id } = przygotuj(blad);
  await silnik.przebieg();
  const { log, wykonania } = czytaj(db, id);
  for (const w of log) expect(w.wynik).not.toContain(LOGIN);
  for (const w of wykonania) expect(w.powod ?? '').not.toContain(LOGIN);
  expect(wykonania.map((w) => w.powod).join(' ')).toContain('ESOCKET');
  db.close();
});
