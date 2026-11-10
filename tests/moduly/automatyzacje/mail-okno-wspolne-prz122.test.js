// PRZ-122.TFe: przypadki wspólne przeniesione z tests/moduly/automatyzacje/mail-okno-prz122.test.js; asercje bez zmian.
// PRZ-122.MAIL-OKNO — reguła automatyzacji „mail z fakturą” nie zamyka faktury, którą sprzedawca jeszcze poprawia.
// Zamiast `pobierzPdf` (w TwojeFaktury = wydanie nabywcy, zamyka dokument) wykonanie jest ODKŁADANE: zostaje
// `zaplanowane`, `nastepna_proba_at` = teraz + 15 min, powód „okno poprawek”, bez zjadania prób i bez wpisu w historii
// zamówienia. Dla faktury VAT „koniec okna” = numer KSeF (`zdanieCzekaniaNaKsef`). inFakt (bez `gotowyDoWydania`) — jak dotąd.
//
// Wszystko idzie przez silnik (`przebieg` → `wykonaj`), zegar sterowany przez `teraz` silnika. Reguła z szablonem
// „Faktura” wstawiona wprost do bazy (kreator jej nie da — zdarzenie „faktura wystawiona” jest „wkrótce”).
// Dane zmyślone („Pracownia Półcień”), poczta i program na atrapach; prawdziwy adapter TwojeFaktury bez sieci.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { MODULY } from '../../../src/moduly/lista.ts';
import { kolejnoscBudowy } from '../../../src/core/sprawdz-moduly.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { rozpocznijFakture, zakonczFakture } from '../../../src/moduly/faktury/db/faktury.js';
import { createModulFaktury } from '../../../src/moduly/faktury/modul.ts';
import { createWiadomosci } from '../../../src/moduly/wiadomosci/services/wiadomosci.js';
import { createSilnikAutomatyzacji, symulujRegule } from '../../../src/moduly/automatyzacje/services/silnik.js';
import { utworzAkcje } from '../../../src/moduly/automatyzacje/akcje/index.js';
import { sprawdzanieWarunkow } from '../../../src/moduly/automatyzacje/services/warunki.js';
import { utworzRegule, wlaczRegule, regulaRozpakowana } from '../../../src/moduly/automatyzacje/db/reguly.js';
import { zaplanuj, ponow, odloz } from '../../../src/moduly/automatyzacje/db/wykonania.js';
import { programTestowy } from '../../pomoc/program-testowy.js';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { nowyPanel, jako, get } from '../../pomoc/konta-prz068.js';

const MIN = 60_000;
const DZIEN = '2026-10-28T';
const o = (hhmm) => new Date(`${DZIEN}${hhmm}:00.000Z`);
const ODSTEP_MIN = 15;

const otwarte = [];
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Sieć zabroniona w teście MAIL-OKNO'); }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const db of otwarte.splice(0)) { try { db.close(); } catch { /* już zamknięta */ } }
});

/** Atrapa programu z oknem poprawek: wersja dokumentu przesuwana przez test, `pobierzPdf` to szpieg. */
function programZOknem() {
  const p = programTestowy({ id: 'twojefaktury' });
  const stan = { wersjaAt: o('10:00') };
  return Object.assign(p, {
    stan,
    gotowyDoWydania: vi.fn(async (_id, chwila) => new Date(chwila).getTime() >= stan.wersjaAt.getTime() + ODSTEP_MIN * MIN),
    zdanieCzekaniaNaKsef: vi.fn(async () => null),
  });
}

let nr = 0;
function zamowienieZFaktura(db, program, { uuid = 'dok-t1', numer = 'FV 1/10/2026' } = {}) {
  nr += 1;
  const id = zapiszZamowienie(db, 'sklep', {
    zrodlo_id: 8100 + nr, numer: `PP-${nr}`,
    klient: { first_name: 'Ida', last_name: 'Półcień', email: 'ida@polcien.invalid', phone: '' },
    dostawa: { first_name: 'Ida', last_name: 'Półcień', address_1: 'Lampowa 7', postcode: '00-950', city: 'Warszawa' },
    metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: null,
    kwota_brutto: '123.00', koszt_dostawy_brutto: '0.00', koszt_dostawy_netto: '0.00', status_woo: 'processing',
    oplacone_at: null, anulowane: 0, utworzone_at: '2026-10-27T09:00:00',
    pozycje: [{ zrodlo_id: 9100 + nr, nazwa: 'Klosz lniany Półcień', sku: 'KL-PC', ilosc: 1, cena_brutto: '123.00',
      cena_netto: '100.00', brutto_linii: '123.00', netto_linii: '100.00', vat: null }],
  });
  const f = rozpocznijFakture(db, id);
  zakonczFakture(db, f.id, { uuid, numer, ksefStatus: null }, { program: program.opis.id });
  return id;
}

/** Baza ze wszystkimi modułami, wiadomości z podanym programem, silnik z zegarem `z.chwila`. */
function srodowisko({ program = null, db = null, zgoda = null } = {}) {
  const baza = db ?? openOmsDb(':memory:', { moduly: kolejnoscBudowy(MODULY) });
  if (!db) otwarte.push(baza);
  const z = { chwila: o('10:00') };
  const listy = [];
  const mailer = { sendMail: vi.fn(async (m) => { listy.push(m); return {}; }) };
  const prog = typeof program === 'function' ? program(baza) : program;
  const wiadomosci = createWiadomosci({ db: baza, mailer, program: prog, teraz: () => z.chwila.toISOString(),
    config: { klienciZbiorczy: [], oprawaPoczty: { podpis: 'Pracownia Półcień', footer: 'Stopka przykładowa' } } });
  const oryginalneAkcje = utworzAkcje({ wiadomosci: () => wiadomosci });
  const akcje = zgoda ? oryginalneAkcje.map((a) => ({ ...a, zgoda })) : oryginalneAkcje;
  const teraz = () => new Date(z.chwila);
  const silnik = createSilnikAutomatyzacji({ db: baza, zdarzenia: [], akcje, sprawdzWarunki: sprawdzanieWarunkow,
    pocztaGotowa: () => true, teraz });
  const regulaId = utworzRegule(baza, { nazwa: 'Faktura do klienta', zdarzenie: 'status_zmieniony', zdarzenie_json: { status: 'wyslane' },
    warunki: { kanaly: ['sklep'], kanalyZnane: ['sklep'], statusy: [], maNumerListu: false, metody: [], pobranie: 'dowolne' },
    akcja: 'mail_kupujacy', akcja_json: { szablon: 'faktura' }, opoznienie_min: 5, limit_na_godzine: 20 }, { login: 'adam' });
  // PRZ-155: granica reguły na zegarze testu, nie systemowym — z prawdziwą datą zamówienie z 27.10 od 10.11
  // wypadało „ponad 14 dni przed włączeniem” (przed_granica) i 12 testów padało.
  wlaczRegule(baza, regulaId, { login: 'adam', teraz: () => o('09:00') });
  const zaplanujMail = (zamowienieId, terminAt = o('10:05')) => zaplanuj(baza, {
    regula_id: regulaId, przedmiot: `zamowienie:${zamowienieId}`, zamowienie_id: zamowienieId,
    zdarzenie_at: new Date(terminAt.getTime() - 5 * MIN).toISOString(), termin_at: terminAt.toISOString(), szablon: 'faktura',
    teraz: terminAt.toISOString(),
  });
  const przebieg = async (chwila) => { z.chwila = chwila; return silnik.przebieg(); };
  return { db: baza, z, listy, mailer, wiadomosci, akcje, silnik, regulaId, zaplanujMail, przebieg, program: prog };
}

const wiersz = (db) => db.prepare('SELECT * FROM automatyzacje_wykonania ORDER BY id DESC LIMIT 1').get();
const logAutomatu = (db, id) => db.prepare("SELECT akcja, wynik FROM log WHERE zamowienie_id = ? AND akcja LIKE 'automatyzacja.%'").all(id);

describe('MAIL-OKNO — atrapa programu z oknem poprawek (odstęp 15 min)', () => {
  it('10:05 w oknie wersji z 10:00 → odłożone do 10:20: zaplanowane, proby 0, powód „okno poprawek”, bez pobierzPdf i bez wpisu', async () => {
    const e = srodowisko({ program: programZOknem() });
    const id = zamowienieZFaktura(e.db, e.program);
    e.zaplanujMail(id);
    const wynik = await e.przebieg(o('10:05'));
    expect(wynik.wyniki).toEqual({ odlozone: 1 });
    const w = wiersz(e.db);
    expect(w).toMatchObject({ stan: 'zaplanowane', proby: 0, powod_kod: 'okno_poprawek', nastepna_proba_at: o('10:20').toISOString() });
    expect(w.powod).toMatch(/okno poprawek/i);
    expect(e.program.pobierzPdf).not.toHaveBeenCalled();
    expect(e.listy).toEqual([]);
    expect(logAutomatu(e.db, id)).toEqual([]);
    // Zegar silnika doszedł do pytania programu (sterowanie przez `teraz`, nie zegar systemowy).
    expect(new Date(e.program.gotowyDoWydania.mock.calls.at(-1)[1]).toISOString()).toBe(o('10:05').toISOString());
  });

  it('poprawka o 10:12 → przebieg 10:20 znów odkłada (do 10:35); 10:35 → wysłane, pobierzPdf raz, proby 0', async () => {
    const e = srodowisko({ program: programZOknem() });
    const id = zamowienieZFaktura(e.db, e.program);
    e.zaplanujMail(id);
    await e.przebieg(o('10:05'));
    e.program.stan.wersjaAt = o('10:12');
    await e.przebieg(o('10:12')); // przed nastepna_proba_at — wiersz nie jest należny
    expect(e.program.gotowyDoWydania).toHaveBeenCalledTimes(1);
    expect((await e.przebieg(o('10:20'))).wyniki).toEqual({ odlozone: 1 });
    expect(wiersz(e.db)).toMatchObject({ stan: 'zaplanowane', proby: 0, nastepna_proba_at: o('10:35').toISOString() });
    expect(e.program.pobierzPdf).not.toHaveBeenCalled();
    expect((await e.przebieg(o('10:35'))).wyniki).toEqual({ wyslane: 1 });
    expect(wiersz(e.db)).toMatchObject({ stan: 'wyslane', proby: 0, powod_kod: null, adresat: 'ida@polcien.invalid' });
    expect(e.program.pobierzPdf).toHaveBeenCalledTimes(1);
    expect(e.listy).toHaveLength(1);
    expect(e.listy[0].attachments.map((a) => a.filename)).toEqual(['Faktura_FV_1_10_2026.pdf']);
  });

  it('program bez gotowyDoWydania (inFakt) → wysłane od razu, jak dotąd', async () => {
    const e = srodowisko({ program: programTestowy({ id: 'infakt' }) });
    const id = zamowienieZFaktura(e.db, e.program);
    e.zaplanujMail(id);
    expect((await e.przebieg(o('10:05'))).wyniki).toEqual({ wyslane: 1 });
    expect(e.program.pobierzPdf).toHaveBeenCalledTimes(1);
  });

  it('wcześniejsza odmowa wygrywa: faktura już wysłana do zamówienia + okno → pominięte „juz_wyslany”', async () => {
    const e = srodowisko({ program: programZOknem() });
    const id = zamowienieZFaktura(e.db, e.program);
    e.db.prepare(`INSERT INTO wiadomosci (zamowienie_id, temat_id, adresat, temat, wyslana_at, kto) VALUES (?, 'faktura', ?, ?, ?, 'adam')`)
      .run(id, 'ida@polcien.invalid', 'Faktura', o('09:00').toISOString());
    e.zaplanujMail(id);
    expect((await e.przebieg(o('10:05'))).wyniki).toEqual({ pominiete: 1 });
    expect(wiersz(e.db)).toMatchObject({ stan: 'pominiete', powod_kod: 'juz_wyslany' });
    expect(e.program.gotowyDoWydania).not.toHaveBeenCalled();
  });

  it('przeterminowanie: odłożenia trwają do końca 48 h → powód okna z ostatnią informacją', async () => {
    const e = srodowisko({ program: programZOknem() });
    const id = zamowienieZFaktura(e.db, e.program);
    e.zaplanujMail(id);
    e.program.gotowyDoWydania.mockImplementation(async () => false);
    expect((await e.przebieg(o('10:05'))).wyniki).toEqual({ odlozone: 1 });
    expect((await e.przebieg(new Date(o('10:05').getTime() + (48 * 60 - 1) * MIN))).wyniki).toEqual({ odlozone: 1 });
    const poprzedniPowod = wiersz(e.db).powod;
    expect((await e.przebieg(new Date(o('10:05').getTime() + (48 * 60 + 15) * MIN))).wyniki).toEqual({ pominiete: 1 });
    expect(wiersz(e.db)).toMatchObject({ stan: 'pominiete', powod_kod: 'przeterminowane', proby: 0 });
    expect(wiersz(e.db).powod).toMatch(/^Faktura przez 48 godzin/);
    expect(wiersz(e.db).powod).toContain(`Ostatnio: ${poprzedniPowod}`);
    expect(e.program.pobierzPdf).not.toHaveBeenCalled();
  });

  it('przeterminowanie po 60 min ciszy od następnej próby → powód okna', async () => {
    const e = srodowisko({ program: programZOknem() });
    const id = zamowienieZFaktura(e.db, e.program);
    e.zaplanujMail(id);
    e.program.gotowyDoWydania.mockImplementation(async () => false);
    expect((await e.przebieg(o('10:05'))).wyniki).toEqual({ odlozone: 1 });
    expect((await e.przebieg(new Date(o('10:05').getTime() + (48 * 60 - 1) * MIN))).wyniki).toEqual({ odlozone: 1 });
    const odlozenie = wiersz(e.db);
    expect((await e.przebieg(new Date(new Date(odlozenie.nastepna_proba_at).getTime() + 60 * MIN))).wyniki).toEqual({ pominiete: 1 });
    expect(wiersz(e.db)).toMatchObject({ stan: 'pominiete', powod_kod: 'przeterminowane', proby: 0 });
    expect(wiersz(e.db).powod).toMatch(/^Faktura przez 48 godzin/);
    expect(wiersz(e.db).powod).toContain(`Ostatnio: ${odlozenie.powod}`);
    expect(e.program.pobierzPdf).not.toHaveBeenCalled();
  });

  it('przeterminowanie po 61 min ciszy od następnej próby → dotychczasowy powód', async () => {
    const e = srodowisko({ program: programZOknem() });
    const id = zamowienieZFaktura(e.db, e.program);
    e.zaplanujMail(id);
    e.program.gotowyDoWydania.mockImplementation(async () => false);
    expect((await e.przebieg(o('10:05'))).wyniki).toEqual({ odlozone: 1 });
    expect((await e.przebieg(new Date(o('10:05').getTime() + (48 * 60 - 1) * MIN))).wyniki).toEqual({ odlozone: 1 });
    const nastepna = new Date(wiersz(e.db).nastepna_proba_at);
    expect((await e.przebieg(new Date(nastepna.getTime() + 61 * MIN))).wyniki).toEqual({ pominiete: 1 });
    expect(wiersz(e.db)).toMatchObject({ stan: 'pominiete', powod_kod: 'przeterminowane', proby: 0,
      powod: 'Minęło ponad 48 godzin od planowanej chwili wysyłki (OMS był wyłączony?). Mail po takim czasie bardziej myli, niż pomaga.' });
    expect(e.program.pobierzPdf).not.toHaveBeenCalled();
  });

  it('przeterminowanie po jednym odłożeniu i 49 h ciszy → dotychczasowy powód', async () => {
    const e = srodowisko({ program: programZOknem() });
    const id = zamowienieZFaktura(e.db, e.program);
    e.zaplanujMail(id);
    expect((await e.przebieg(o('10:05'))).wyniki).toEqual({ odlozone: 1 });
    expect((await e.przebieg(new Date(o('10:05').getTime() + 49 * 60 * MIN))).wyniki).toEqual({ pominiete: 1 });
    expect(wiersz(e.db)).toMatchObject({ stan: 'pominiete', powod_kod: 'przeterminowane',
      powod: 'Minęło ponad 48 godzin od planowanej chwili wysyłki (OMS był wyłączony?). Mail po takim czasie bardziej myli, niż pomaga.' });
    expect(e.program.pobierzPdf).not.toHaveBeenCalled();
  });

  it('kod odłożenia pochodzi z akcji, a bez kodu domyślnie oznacza okno poprawek', async () => {
    const e = srodowisko({ program: programZOknem(), zgoda: async () => ({ odloz: true, kod: 'inny', powod: 'Inny powód' }) });
    const id = zamowienieZFaktura(e.db, e.program);
    e.zaplanujMail(id);
    expect((await e.przebieg(o('10:05'))).wyniki).toEqual({ odlozone: 1 });
    expect(wiersz(e.db).powod_kod).toBe('inny');
    odloz(e.db, wiersz(e.db), { nastepna: o('10:35').toISOString(), powod: 'Domyślny powód' });
    expect(wiersz(e.db).powod_kod).toBe('okno_poprawek');
  });

  it('przeterminowanie bez odłożenia zachowuje dotychczasowy powód', async () => {
    const e = srodowisko({ program: programZOknem() });
    const id = zamowienieZFaktura(e.db, e.program);
    e.zaplanujMail(id);
    await e.przebieg(new Date(o('10:05').getTime() + 49 * 60 * MIN));
    expect(wiersz(e.db)).toMatchObject({ stan: 'pominiete', powod_kod: 'przeterminowane',
      powod: 'Minęło ponad 48 godzin od planowanej chwili wysyłki (OMS był wyłączony?). Mail po takim czasie bardziej myli, niż pomaga.' });
  });

  it('dziennik pokazuje powód odłożenia, a po błędzie poczty dotychczasową próbę', async () => {
    const e = srodowisko({ program: programZOknem() });
    const id = zamowienieZFaktura(e.db, e.program);
    e.zaplanujMail(id);
    await e.przebieg(o('10:05'));
    zalozKonto(e.db, { login: 'test-admin', imie: 'Test', haslo: 'h', rola: 'administrator', admin: true });
    const p = nowyPanel({ db: e.db });
    try {
      const ekran = () => get(p.app, `/ustawienia/automatyzacje/${e.regulaId}`, jako(e.db, 'test-admin'));
      const odlozony = await ekran();
      expect(odlozony.statusCode).toBe(200);
      expect(odlozony.body).toMatch(/wyjdzie [^<]+ — Okno poprawek faktury jeszcze trwa/);
      e.db.prepare("UPDATE automatyzacje_wykonania SET stan = 'w_toku' WHERE id = ?").run(wiersz(e.db).id);
      ponow(e.db, wiersz(e.db), { nastepna: o('10:20').toISOString(), powod: 'Błąd poczty' });
      const ponowiony = await ekran();
      expect(ponowiony.body).toMatch(/wyjdzie [^<]+ \(próba 2\)/);
      expect(ponowiony.body).not.toContain('Błąd poczty');
    } finally { await p.app.close(); }
  });

  it('podgląd „Sprawdź na 30 dniach” z fakturą w oknie → liczy się do „wykonałoby”', async () => {
    const e = srodowisko({ program: programZOknem() });
    const id = zamowienieZFaktura(e.db, e.program);
    const zdarzenie = { symulacja: () => [{ zamowienie_id: id, sklep: 'sklep', zdarzenie_at: o('10:00').toISOString() }] };
    const wynik = await symulujRegule({ db: e.db, regula: regulaRozpakowana(e.db, e.regulaId), zdarzenie, akcja: e.akcje[0],
      sprawdzWarunki: sprawdzanieWarunkow, teraz: () => o('10:05') });
    expect(wynik).toMatchObject({ razem: 1, wykonaloby: 1, pominieteRazem: 0 });
    expect(e.program.gotowyDoWydania).toHaveBeenCalled();
    expect(e.program.pobierzPdf).not.toHaveBeenCalled();
  });

  it('wiersz pominięty w trakcie pytania o okno (np. „Pomiń zaległe”) → odłożenie go nie nadpisuje', async () => {
    const e = srodowisko({ program: programZOknem() });
    const id = zamowienieZFaktura(e.db, e.program);
    e.zaplanujMail(id);
    e.program.gotowyDoWydania.mockImplementation(async () => {
      e.db.prepare("UPDATE automatyzacje_wykonania SET stan = 'pominiete', powod = 'Pominięte ręcznie', zakonczone_at = ?")
        .run(o('10:05').toISOString());
      return false;
    });
    await e.przebieg(o('10:05'));
    expect(wiersz(e.db)).toMatchObject({ stan: 'pominiete', powod: 'Pominięte ręcznie', nastepna_proba_at: null });
  });
});

