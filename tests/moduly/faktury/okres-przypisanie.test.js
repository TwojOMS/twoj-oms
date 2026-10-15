import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { przypiszDoOkresu } from '../../../src/moduly/faktury/services/okres.js';
import {
  zapewnijOkres, zamknijOkres, pobierzOkres, znajdzOkres, zamowieniaOkresu,
} from '../../../src/oms/db/okresy.js';
import { STAN } from '../../../src/domena/okres-rozliczeniowy.js';
import { parsujNoweZamowienie } from '../../../src/domena/nowe-zamowienie.js';
import { utworzZamowienieReczne } from '../../../src/oms/db/zamowienia-reczne.js';
import { pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { dopiszKlientaZbiorczego } from './_klient-zbiorczy-pomocniki.js';

const CONFIG = {};

// ⚠️ Od 24.08.2026 klient zbiorczy jest WIERSZEM BAZY, nie wpisem w konfiguracji —
// `openOmsDb` z klientem to minimalne srodowisko tych testow.
function bazaZKlientem(sciezka) {
  const db = sciezka ? openOmsDb(sciezka) : openOmsDb();
  dopiszKlientaZbiorczego(db);
  return db;
}

// Biezacy rok i miesiac TAK, JAK WIDZI GO CZLOWIEK W POLSCE — czyli to samo, czego trasa
// ma uzyc, ale policzone NIEZALEZNIE OD IMPLEMENTACJI. Wczesniejsza wersja tych testow
// brala `new Date().getUTCMonth() + 1`, czyli sprawdzala kod tym samym bledem, ktory mial
// wykryc: przez pierwsze godziny kazdego pierwszego dnia miesiaca (UTC jest o 1–2 h za
// Polska) oba wyliczenia mylily sie zgodnie i test przechodzil (recenzja 2026-08-01).
function terazWarszawa() {
  const czesci = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit',
  }).formatToParts(new Date());
  const g = (t) => Number(czesci.find((x) => x.type === t).value);
  return { rok: g('year'), miesiac: g('month') };
}

describe('przypiszDoOkresu', () => {
  // 20:00Z to 22:00 czasu polskiego 31 lipca — lipiec bez watpliwosci. Pierwsza wersja brala
  // 22:00Z, czyli w Polsce juz 1 sierpnia 00:00, i „potwierdzala" lipiec tylko dlatego,
  // ze kod tez liczyl w UTC (recenzja 2026-08-01).
  it('drop klienta zbiorczego dostaje okres z daty zlozenia', () => {
    const db = bazaZKlientem();
    const id = przypiszDoOkresu({
      db, nip: '1000001017', dataZlozenia: '2026-07-31T20:00:00.000Z', hurt: false,
    });
    const o = pobierzOkres(db, id);
    expect(o.rok).toBe(2026);
    expect(o.miesiac).toBe(7);
  });

  it('HURT nie trafia do okresu wcale', () => {
    const db = bazaZKlientem();
    expect(przypiszDoOkresu({
      db, nip: '1000001017', dataZlozenia: '2026-07-15T10:00:00.000Z', hurt: true,
    })).toBeNull();
  });

  it('obcy klient nie trafia do okresu', () => {
    const db = bazaZKlientem();
    expect(przypiszDoOkresu({
      db, nip: '1234567890', dataZlozenia: '2026-07-15T10:00:00.000Z', hurt: false,
    })).toBeNull();
  });

  it('zamkniety okres ODMAWIA, zamiast cicho przeniesc na kolejny miesiac', () => {
    const db = bazaZKlientem();
    const o = zapewnijOkres(db, { klientKlucz: 'zetaklient', rok: 2026, miesiac: 7 });
    zamknijOkres(db, o.id);
    expect(() => przypiszDoOkresu({
      db, nip: '1000001017', dataZlozenia: '2026-07-20T10:00:00.000Z', hurt: false,
    })).toThrow(/lipiec 2026/i);
  });

  // ⚠️ ODMOWA NIE MOZE ZOSTAWIC PO SOBIE OKRESU SIERPNIOWEGO. Gdyby straz stala PO
  // `zapewnijOkres`, zamkniety lipiec i tak dostalby probe zapisu, a przy odwrotnym bledzie
  // (przypisanie po dacie „teraz") powstalby lewy okres kolejnego miesiaca.
  it('odmowa nie zaklada zadnego innego okresu', () => {
    const db = bazaZKlientem();
    const o = zapewnijOkres(db, { klientKlucz: 'zetaklient', rok: 2026, miesiac: 7 });
    zamknijOkres(db, o.id);
    try {
      przypiszDoOkresu({
        db, nip: '1000001017', dataZlozenia: '2026-07-20T10:00:00.000Z', hurt: false,
      });
    } catch { /* odmowa sprawdzona wyzej */ }
    expect(db.prepare('SELECT COUNT(*) AS ile FROM okresy_rozliczeniowe').get().ile).toBe(1);
    expect(pobierzOkres(db, o.id).stan).toBe(STAN.ZAMKNIETY);
  });

  // Okres juz zafakturowany jest ZAMKNIETY na amen — dopisanie do niego zamowienia znaczy
  // fakture w KSeF, ktora nie zgadza sie z baza, i korekte jako jedyne wyjscie.
  it('okres zafakturowany tez ODMAWIA', () => {
    const db = bazaZKlientem();
    const o = zapewnijOkres(db, { klientKlucz: 'zetaklient', rok: 2026, miesiac: 7 });
    db.prepare('UPDATE okresy_rozliczeniowe SET stan = ? WHERE id = ?').run(STAN.ZAFAKTUROWANY, o.id);
    expect(() => przypiszDoOkresu({
      db, nip: '1000001017', dataZlozenia: '2026-07-20T10:00:00.000Z', hurt: false,
    })).toThrow(/lipiec 2026/i);
  });

  // Ten sam okres dla drugiego zamowienia z tego samego miesiaca — inaczej kazde zamowienie
  // dostaloby wlasna fakture, czyli dokladnie to, co ten spec ma zlikwidowac.
  it('drugie zamowienie tego miesiaca trafia do TEGO SAMEGO okresu', () => {
    const db = bazaZKlientem();
    const a = przypiszDoOkresu({
      db, nip: '1000001017', dataZlozenia: '2026-07-02T08:00:00.000Z', hurt: false,
    });
    const b = przypiszDoOkresu({
      db, nip: '100-000-10-17', dataZlozenia: '2026-07-29T08:00:00.000Z', hurt: false,
    });
    expect(b).toBe(a);
    expect(db.prepare('SELECT COUNT(*) AS ile FROM okresy_rozliczeniowe').get().ile).toBe(1);
  });

  // ⚠️ PRZYPISANIE IDZIE PO DACIE ZLOZENIA. Brak daty to blad programisty (trasa zawsze
  // podstawia „teraz"), a nie powod do cichego wrzucenia zamowienia w biezacy miesiac —
  // takie zamowienie wyladowaloby na fakturze nie tego miesiaca, co trzeba.
  it('brak daty zlozenia RZUCA, zamiast wziac dzisiejsza', () => {
    const db = bazaZKlientem();
    expect(() => przypiszDoOkresu({
      db, nip: '1000001017', dataZlozenia: undefined, hurt: false,
    })).toThrow(/data złożenia/i);
    expect(db.prepare('SELECT COUNT(*) AS ile FROM okresy_rozliczeniowe').get().ile).toBe(0);
  });

  // Baza bez ani jednego klienta zbiorczego to POPRAWNY tryb panelu, nie awaria — tak samo
  // jak do 24.08.2026 poprawnym trybem byl brak sekcji `OMS_KLIENCI_ZBIORCZY`.
  it('baza bez klientow zbiorczych nie wywala trasy', () => {
    expect(przypiszDoOkresu({
      db: openOmsDb(), nip: '1000001017', dataZlozenia: '2026-07-15T10:00:00.000Z', hurt: false,
    })).toBeNull();
  });

  // ⚠️ GRANICA, KTOREJ WCZESNIEJ NIE BYLO: klient JEST w bazie stalych klientow, ale nie ma
  // umowy zbiorczej. Jego zamowienie ma dostac wlasna fakture, nie wpasc do cudzego okresu.
  it('staly klient BEZ rozliczenia zbiorczego nie dostaje okresu', () => {
    const db = openOmsDb();
    dopiszKlientaZbiorczego(db, {
      rozliczenie_zbiorcze: 0,
      prog_darmowej_dostawy_gr: null,
      oplata_obslugi_gr: null,
      oplata_kurierska_gr: null,
    });
    expect(przypiszDoOkresu({
      db, nip: '1000001017', dataZlozenia: '2026-07-15T10:00:00.000Z', hurt: false,
    })).toBeNull();
  });
});

describe('utworzZamowienieReczne zapisuje okres', () => {
  it('zapisuje przekazany identyfikator okresu', () => {
    const db = bazaZKlientem();
    const okres = zapewnijOkres(db, { klientKlucz: 'zetaklient', rok: 2026, miesiac: 7 });
    const id = utworzZamowienieReczne(db, { nip: '1000001017' }, okres.id);
    expect(pobierzZamowienie(db, id).okres_rozliczeniowy_id).toBe(okres.id);
    expect(zamowieniaOkresu(db, okres.id)).toEqual([id]);
  });

  // Zamowienia spoza rozliczenia zbiorczego ida ta trasa tysiacami — brak trzeciego
  // argumentu nie moze niczego zepsuc ani wpisac `undefined` do kolumny.
  it('bez trzeciego argumentu kolumna zostaje pusta', () => {
    const db = bazaZKlientem();
    const id = utworzZamowienieReczne(db, {});
    expect(pobierzZamowienie(db, id).okres_rozliczeniowy_id).toBe(null);
  });
});

describe('parsujNoweZamowienie — hurt', () => {
  // Pole wyboru: przegladarka przysyla je WYLACZNIE gdy zaznaczone.
  it('niezaznaczone pole to drop', () => {
    expect(parsujNoweZamowienie({}).hurt).toBe(false);
  });

  it('zaznaczone pole to hurt', () => {
    expect(parsujNoweZamowienie({ hurt: 'on' }).hurt).toBe(true);
  });
});

// Trasa, nie sam serwis: mutacja usuwajaca wywolanie z POST /zamowienia/nowe nie ma jak
// wpasc na testy jednostkowe wyzej.
describe('trasa zakładania przypisuje okres', () => {
  const config = { auth: { user: 'adam', pass: 'x' }, ...CONFIG };
  const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
  const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };

  async function serwer() {
    const db = bazaZKlientem(':memory:');
    const app = buildOmsServer({ db, config, poller });
    await app.ready();
    return { db, app };
  }

  async function zaloz(payload) {
    const { db, app } = await serwer();
    const r = await app.inject({ method: 'POST', url: '/zamowienia/nowe', headers: naglowek, payload });
    expect(r.statusCode).toBe(302);
    return { db, z: pobierzZamowienie(db, Number(r.headers.location.split('/').pop())) };
  }

  const towar = (brutto) => ({
    poz_nazwa: ['Szablon', '', '', '', ''],
    poz_sku: ['', '', '', '', ''],
    poz_ilosc: ['1', '', '', '', ''],
    poz_cena_netto: ['', '', '', '', ''],
    poz_cena_brutto: [brutto, '', '', '', ''],
  });

  it('formularz ma pole wyboru hurtu', async () => {
    const { app } = await serwer();
    const r = await app.inject({ method: 'GET', url: '/zamowienia/nowe', headers: naglowek });
    expect(r.body).toContain('name="hurt"');
  });

  it('drop klienta zbiorczego dostaje okres biezacego miesiaca', async () => {
    const { db, z } = await zaloz({ f_nip: '1000001017', ...towar('100,00') });
    expect(z.okres_rozliczeniowy_id).not.toBe(null);
    const { rok, miesiac } = terazWarszawa();
    const o = pobierzOkres(db, z.okres_rozliczeniowy_id);
    expect(o.klient_klucz).toBe('zetaklient');
    expect(o.rok).toBe(rok);
    expect(o.miesiac).toBe(miesiac);
  });

  it('HURT tego samego klienta NIE dostaje okresu', async () => {
    const { db, z } = await zaloz({ f_nip: '1000001017', hurt: 'on', ...towar('100,00') });
    expect(z.okres_rozliczeniowy_id).toBe(null);
    expect(db.prepare('SELECT COUNT(*) AS ile FROM okresy_rozliczeniowe').get().ile).toBe(0);
  });

  // ⚠️ SAM BRAK OKRESU TO ZA MALO. Zamowienie do siedziby klienta i zamowienie, ktore
  // z okresu wypadlo przez pomylke, maja identyczny wiersz: `okres_rozliczeniowy_id = NULL`
  // przy tym samym NIP-ie. Dopiero ta kolumna mowi, ze fakture wystawiamy OD RAZU,
  // z terminem platnosci (spec §3) — bez niej panel nie ma o tym skad wiedziec.
  it('HURT zostawia slad w kolumnie do_siedziby_klienta', async () => {
    const { z } = await zaloz({ f_nip: '1000001017', hurt: 'on', ...towar('100,00') });
    expect(z.do_siedziby_klienta).toBe(1);
  });

  it('zwykly drop ma do_siedziby_klienta wyzerowane', async () => {
    const { z } = await zaloz({ f_nip: '1000001017', ...towar('100,00') });
    expect(z.do_siedziby_klienta).toBe(0);
  });

  it('obcy klient nie zaklada okresu', async () => {
    const { db, z } = await zaloz({ f_nip: '1234567890', ...towar('100,00') });
    expect(z.okres_rozliczeniowy_id).toBe(null);
    expect(db.prepare('SELECT COUNT(*) AS ile FROM okresy_rozliczeniowe').get().ile).toBe(0);
  });

  // ⚠️ ODMOWA MA BYC BEZ ZAMOWIENIA. Zalozone mimo odmowy zostaloby na liscie z nadanym
  // numerem, bez okresu i bez faktury — czyli po cichu wypadloby z rozliczenia.
  it('zamkniety okres odmawia zapisu i NIE zaklada zamowienia', async () => {
    const { db, app } = await serwer();
    const o = zapewnijOkres(db, { klientKlucz: 'zetaklient', ...terazWarszawa() });
    zamknijOkres(db, o.id);
    const r = await app.inject({
      method: 'POST', url: '/zamowienia/nowe', headers: naglowek,
      payload: { f_nip: '1000001017', ...towar('100,00') },
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('rozliczony');
    expect(db.prepare("SELECT COUNT(*) AS ile FROM zamowienia WHERE sklep = 'reczne'").get().ile).toBe(0);
  });

  // Opłata (Zadanie 4B) i okres sa niezalezne — ale obie musza zadzialac na tym samym
  // zamowieniu, a nie jedna zamiast drugiej.
  it('drop dostaje i okres, i opłatę', async () => {
    const { z } = await zaloz({ f_nip: '1000001017', ...towar('100,00') });
    expect(z.okres_rozliczeniowy_id).not.toBe(null);
    expect(z.pozycje.map((p) => p.nazwa)).toContain('Usługa kurierska');
  });

  it('okres nie psuje zwyklego zamowienia bez NIP-u', async () => {
    const { db, z } = await zaloz({ ...towar('100,00') });
    expect(z.okres_rozliczeniowy_id).toBe(null);
    expect(db.prepare('SELECT COUNT(*) AS ile FROM okresy_rozliczeniowe').get().ile).toBe(0);
  });
});
