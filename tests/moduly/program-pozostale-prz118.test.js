// PRZ-118.08 — pozostałe moduły (zwroty, koszty, wiadomości, wysyłka, zdrowie, ustawienia) na kontrakcie
// ProgramFakturowy. Program testowy „Testownik” (tests/pomoc/program-testowy.js) — NIE inFakt: własny opis, licznik
// wywołań. Każda usługa ma wołać JEGO metody (`{ program }` albo program pod starą nazwą `infakt` — szew modułu
// faktur), a teksty z nazwą programu mówić jego nazwą.
//
// (1) korekta zwrotu, paczka dla biura, mail z PDF faktury, czuwacz pobrań, czuwacz ostrzeżeń, diagnostyka łączności;
// (2) czuwacz pobrań przy odmowie z `bezProgramu` (bez `bezInfaktu`) przerywa przebieg bez trwałego „nieznana”.
// Pełna aplikacja: szew `fabryki.programFakturowy` modułu faktur (wyłącznie OMS_TRYB=proba).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../src/oms/db/zamowienia.js';
import { dodajZwrot, zwrot } from '../../src/oms/db/zwroty.js';
import { rozpocznijFakture, zakonczFakture } from '../../src/moduly/faktury/db/faktury.js';
import { rozpocznijPrzesylke, zakonczPrzesylke, zapiszStatusDpd } from '../../src/moduly/wysylka/db/przesylki.js';
import { oznaczenieZaplaty } from '../../src/moduly/wysylka/db/oznaczenia-zaplaty.js';
import { createKorekta } from '../../src/moduly/zwroty/services/korekta.js';
import { createPaczkaDlaBiura } from '../../src/moduly/koszty/services/paczka-dla-biura.js';
import { createWiadomosci } from '../../src/moduly/wiadomosci/services/wiadomosci.js';
import { createCzuwaczPrzesylek } from '../../src/moduly/wysylka/services/czuwacz-przesylek.js';
import { oznaczDoreczonePobrania } from '../../src/moduly/wysylka/services/oznaczanie-pobran.js';
import {
  createCzuwaczOstrzezen, NAJDLUZSZY_PRZEBIEG_OSTRZEZEN_MS, najdluzszyPrzebiegOstrzezenMs,
} from '../../src/moduly/zdrowie/services/czuwacz-ostrzezen.js';
import { celeLacznosci } from '../../src/domena/lacznosc.js';
import { programInfakt } from '../../src/integracje/programy/infakt.ts';
import { zbudujOms } from '../../src/oms/bootstrap.ts';
import { modulyDla } from '../../src/moduly/lista.ts';
import { createModulFaktury } from '../../src/moduly/faktury/modul.ts';
import { createAtrapaVies } from '../../deploy/proba/atrapy/infakt.mjs';
import * as diagnostyka from '../../src/oms/services/lacznosc.js';
import { programTestowy } from '../pomoc/program-testowy.js';

const NIP = '5250000009'; // zmyślony, z poprawną sumą kontrolną
const wpisyLogu = (db, id) => db.prepare('SELECT wynik FROM log WHERE zamowienie_id = ? ORDER BY id').all(id).map((w) => w.wynik);

const zamowienie = (nr, nad = {}) => ({
  zrodlo_id: nr, numer: String(nr),
  klient: { first_name: 'Anna', last_name: 'Półcień', company: 'Pracownia Półcień', email: 'biuro@polcien.invalid',
    address_1: 'Lampowa 1', postcode: '00-950', city: 'Warszawa' },
  dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: NIP,
  kwota_brutto: '258.00', status_woo: 'processing', oplacone_at: null, anulowane: 0, utworzone_at: '2026-10-01T10:00:00',
  pozycje: [{ zrodlo_id: 11, nazwa: 'Lampa wisząca Półcień', sku: 'LAMPA-W1', ilosc: 2, cena_brutto: '129.00',
    brutto_linii: '258.00', vat: null }],
  ...nad,
});

const FAKTURA = {
  number: 'TST 1/10/2026', invoice_date: '2026-10-01', uuid: 'dok-t1',
  services: [{ name: 'Lampa wisząca Półcień', quantity: 2, gross_price: 25800, tax_symbol: '23' }],
};

describe('PRZ-118.08 (1) usługi pozostałych modułów wołają program testowy', () => {
  it('korekta zwrotu: „przed” i korekta z programu, odmowa i log jego nazwą', async () => {
    const db = openOmsDb(':memory:');
    const id = zapiszZamowienie(db, 'pro', zamowienie(4101), {});
    db.prepare('INSERT INTO faktury (zamowienie_id, program, dokument_id, numer, utworzona_at) VALUES (?,?,?,?,?)')
      .run(id, 'testowy', 'dok-t1', 'TST 1/10/2026', '2026-10-01T10:00:00Z');
    const zwrotId = dodajZwrot(db, id, { data: '2026-10-14', kwota: '129.00',
      pozycje: [{ klucz_pozycji: 's11', nazwa: 'Lampa wisząca Półcień', ilosc: 1, kwota: '129.00' }] }).id;
    const program = programTestowy({ metody: {
      pobierzFakture: async () => FAKTURA,
      wystawKorekte: async () => ({ referencja: 'REF-T1', uuid: null, numer: null }),
      listaKorekt: async () => [{ uuid: 'kor-t1', number: 'TST K 1/10/2026', corrected_invoice_number: 'TST 1/10/2026' }],
    } });
    const korekta = createKorekta({ db, program });
    await korekta.wystaw(id, zwrotId);
    expect(program.ile('pobierzFakture')).toBe(1);
    expect(program.wywolania.find(([m]) => m === 'pobierzFakture')[1]).toBe('dok-t1');
    expect(program.ile('wystawKorekte')).toBe(1);
    await expect(korekta.wystaw(id, zwrotId)).rejects.toThrow('sprawdź ją w Testowniku.');
    await korekta.doczytaj(id, zwrotId);
    expect(program.ile('listaKorekt')).toBe(1);
    expect(zwrot(db, id, zwrotId).korekta_numer).toBe('TST K 1/10/2026');
    expect(wpisyLogu(db, id).some((t) => t.includes('znaleziona w Testowniku'))).toBe(true);
    expect(JSON.stringify(wpisyLogu(db, id))).not.toContain('inFak');
  });

  it('korekta zamówienia bez dokumentu: odmowa nazwą programu', async () => {
    const db = openOmsDb(':memory:');
    const id = zapiszZamowienie(db, 'pro', zamowienie(4102), {});
    const program = programTestowy();
    await expect(createKorekta({ db, program }).wystaw(id, 1)).rejects.toThrow('nie ma faktury w Testowniku');
    expect(program.wywolania).toEqual([]);
  });

  it('paczka dla biura: listy sprzedaży i korekt z programu', async () => {
    const db = openOmsDb(':memory:');
    const program = programTestowy();
    const w = await createPaczkaDlaBiura({ db, program }).zbudujZestawieniePrzychodow('2026-09');
    expect(w.nazwa).toBe('zestawienie-przychodow-2026-09.pdf');
    expect([program.ile('listaFaktur'), program.ile('listaKorekt')]).toEqual([1, 1]);
  });

  it('mail z PDF faktury: plik z programu', async () => {
    const db = openOmsDb(':memory:');
    const id = zapiszZamowienie(db, 'pro', zamowienie(4103), {});
    const f = rozpocznijFakture(db, id);
    zakonczFakture(db, f.id, { uuid: 'dok-t1', numer: 'TST 1/10/2026', ksefStatus: null }, { program: 'testowy' });
    const mailer = { sendMail: vi.fn().mockResolvedValue({}) };
    const program = programTestowy();
    const config = { nadawca: { nazwa: 'Pracownia Półcień', ulica: 'Lampowa 1', kod: '00-950', miasto: 'Warszawa', kraj: 'PL' },
      proforma: { nip: '1234563218', rachunek: '34109010140000000000000000' } };
    await createWiadomosci({ db, mailer, program, config, teraz: () => '2026-10-15T10:00:00.000Z' }).wyslij(id, 'faktura');
    expect(program.ile('pobierzPdf')).toBe(1);
    expect(program.wywolania.find(([m]) => m === 'pobierzPdf')[1]).toBe('dok-t1');
    expect(mailer.sendMail.mock.calls[0][0].attachments[0].content.toString()).toBe('%PDF-testownik');
  });

  it('czuwacz ostrzeżeń: lista dokumentów z programu, budżet z jego limitów, odmowa jego nazwą', async () => {
    const db = openOmsDb(':memory:');
    const program = programTestowy();
    const czuwacz = createCzuwaczOstrzezen({ db, program });
    await czuwacz.przebieg();
    expect(program.ile('listaFaktur')).toBe(1);
    // Testownik: zadanie 30 s, sufit 20 stron, 2 strony naraz → luki 11 tur + terminy 11 tur = 22 × 30 s.
    expect(czuwacz.najdluzszyPrzebiegMs).toBe(22 * 30_000);
    expect(najdluzszyPrzebiegOstrzezenMs(programInfakt({}).opis.limity)).toBe(NAJDLUZSZY_PRZEBIEG_OSTRZEZEN_MS);
    const zly = programTestowy({ metody: { listaFaktur: async () => ({ blad: 'nie lista' }) } });
    await expect(createCzuwaczOstrzezen({ db, program: zly }).przebieg())
      .rejects.toThrow('Testownik oddał listę dokumentów w kształcie, którego panel nie rozumie');
  });

  it('diagnostyka łączności (domena): cel z opisu programu — klucz, nazwa i adres', () => {
    const { opis } = programTestowy();
    expect(celeLacznosci({ program: { opis, url: opis.adres } })).toEqual([
      { klucz: 'testowy', nazwa: 'Testownik', url: 'https://testownik.invalid/api', host: 'testownik.invalid' },
    ]);
  });
});

// ——— czuwacz pobrań ——————————————————————————————————————————————————————————————————————
function doreczonePobranie(db, nr, uuid) {
  const id = zapiszZamowienie(db, 'pro', zamowienie(nr, { kwota_pobrania: '258.00', pobranie: 1 }), {});
  db.prepare('INSERT INTO faktury (zamowienie_id, program, dokument_id, numer, utworzona_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'testowy', uuid, `TST ${nr}/10/2026`, '2026-10-01T08:00:00.000Z');
  const p = rozpocznijPrzesylke(db, id, 'dpd', 1);
  zakonczPrzesylke(db, p.id, { numerListu: `N${nr}`, etykietaSciezka: '/tmp/e.pdf', surowa: '<x/>' });
  zapiszStatusDpd(db, p.id, { opis: 'Przesyłka doręczona', at: '2026-10-05T14:00:00.000' });
  return id;
}

describe('PRZ-118.08 (1) czuwacz pobrań na programie testowym', () => {
  it('czuwacz przesyłek oznacza doręczone pobranie w programie; log jego nazwą', async () => {
    const db = openOmsDb(':memory:');
    const id = doreczonePobranie(db, 5101, 'dok-p1');
    const program = programTestowy({ metody: {
      pobierzFakture: async (uuid) => ({ uuid, number: 'TST', invoice_date: '2026-10-01', status: 'sent', left_to_pay: 25800 }),
    } });
    const wynik = await createCzuwaczPrzesylek({ db, kurierzy: {}, program, teraz: () => new Date('2026-10-06T10:00:00Z') }).przebieg();
    expect(wynik.pobrania).toMatchObject({ zlecone: 1, bledy: 0 });
    expect([program.ile('pobierzFakture'), program.ile('oznaczZaplacona')]).toEqual([1, 1]);
    expect(oznaczenieZaplaty(db, 'dok-p1')).toMatchObject({ powod: 'pobranie_doreczone' });
    const log = wpisyLogu(db, id).join('\n');
    expect(log).toContain('zlecono w Testowniku oznaczenie faktury');
    expect(log).toContain('Testownik przetwarza to zadanie w tle.');
    expect(log).not.toContain('inFak');
  });

  it('jednoznaczna odmowa programu: „NIE ZNA” jego nazwą, dokument zamknięty', async () => {
    const db = openOmsDb(':memory:');
    const id = doreczonePobranie(db, 5102, 'dok-p2');
    const program = programTestowy({ metody: {
      pobierzFakture: async () => { throw Object.assign(new Error('nie ma takiego dokumentu'), { status: 404, dlaOperatora: true }); },
    } });
    await oznaczDoreczonePobrania({ db, program });
    expect(oznaczenieZaplaty(db, 'dok-p2')).toMatchObject({ powod: 'nieznana_w_infakcie' });
    const log = wpisyLogu(db, id).join('\n');
    expect(log).toContain('ale Testownik NIE ZNA faktury');
    expect(log).toContain('skasowany w Testowniku');
    expect(log).not.toContain('inFak');
  });
});

describe('PRZ-118.08 (2) odmowa bez kontaktu z programem (`bezProgramu`) nie zamyka pobrania', () => {
  it('przebieg przerwany po pierwszej odmowie, bez rezerwacji i bez „NIE BĘDZIE PONAWIAŁ”', async () => {
    const db = openOmsDb(':memory:');
    const ids = [doreczonePobranie(db, 5201, 'dok-b1'), doreczonePobranie(db, 5202, 'dok-b2')];
    const program = programTestowy({ metody: {
      pobierzFakture: async () => {
        throw Object.assign(new Error('Testownik nie jest skonfigurowany'), { status: 400, dlaOperatora: true, bezProgramu: true });
      },
    } });
    const wynik = await oznaczDoreczonePobrania({ db, program });
    expect(wynik).toMatchObject({ zlecone: 0, bledy: 1 });
    expect(program.ile('pobierzFakture')).toBe(1);
    expect(oznaczenieZaplaty(db, 'dok-b1')).toBeFalsy();
    expect(oznaczenieZaplaty(db, 'dok-b2')).toBeFalsy();
    for (const id of ids) expect(wpisyLogu(db, id).some((t) => t.includes('NIE BĘDZIE PONAWIAŁ'))).toBe(false);
  });
});

// ——— pełna aplikacja: szew `fabryki.programFakturowy` ————————————————————————————————————
describe('PRZ-118.08 (1) pełna aplikacja z programem testowym w szwie modułu faktur', () => {
  let katalog;
  afterEach(() => { if (katalog) rmSync(katalog, { recursive: true, force: true }); vi.restoreAllMocks(); });

  async function aplikacja() {
    katalog = mkdtempSync(join(tmpdir(), 'prz118-08-'));
    const env = { OMS_TRYB: 'proba', OMS_USER: 'operator', OMS_PASS: 'fixture', OMS_SPRZEDAWCA_NIP: '1234563218',
      OMS_RACHUNEK: '34109010140000000000000000', OMS_PROFORMY_KATALOG: katalog, OMS_ETYKIETY_KATALOG: katalog };
    const program = programTestowy({ metody: { pobierzFakture: async () => FAKTURA,
      wystawKorekte: async () => ({ referencja: 'REF-T2', uuid: null, numer: null }) } });
    const fabryki = { programFakturowy: () => program, createVies: () => createAtrapaVies({ env }) };
    const moduly = modulyDla(env).map((m) => (m.nazwa === 'faktury' ? createModulFaktury({ fabryki }) : m));
    const a = await zbudujOms({ env, moduly, teraz: () => new Date(), log: () => {} });
    return { a, program };
  }

  it('diagnostyka łączności pokazuje cel „Testownik” z opis.adres (nie inFakt)', async () => {
    const { a } = await aplikacja();
    try {
      const pomiar = vi.spyOn(diagnostyka, 'sprawdzLacznosc').mockResolvedValue([]);
      await a.usluga('ustawienia', 'lacznosc').sprawdz();
      const cele = pomiar.mock.calls[0][0].cele;
      expect(cele.filter((c) => ['testowy', 'infakt'].includes(c.klucz))).toEqual([
        { klucz: 'testowy', nazwa: 'Testownik', url: 'https://testownik.invalid/api', host: 'testownik.invalid' },
      ]);
    } finally { await a.app.close(); a.db.close(); }
  });

  // Recenzja 08: strażnik startu modułu zdrowie liczy budżet czuwacza ostrzeżeń z limitów programu, nie ze stałej inFaktu.
  // Limity: luki 20 tur × 45 s + terminy 60 tur × 45 s = 3 600 000 ms ≥ odstęp 3 600 000 ms (KSeF i archiwum mieszczą się).
  it('program, którego budżet ostrzeżeń nie mieści się między tyknięciami: panel nie wstaje', async () => {
    katalog = mkdtempSync(join(tmpdir(), 'prz118-08-'));
    const env = { OMS_TRYB: 'proba', OMS_USER: 'operator', OMS_PASS: 'fixture', OMS_SPRZEDAWCA_NIP: '1234563218',
      OMS_RACHUNEK: '34109010140000000000000000', OMS_PROFORMY_KATALOG: katalog, OMS_ETYKIETY_KATALOG: katalog };
    const baza = programTestowy();
    const program = { ...baza, opis: Object.freeze({ ...baza.opis, limity: Object.freeze({
      zadanieMs: 45_000, najdluzszaListaMs: 60_000, stronaListy: 10, sufitStron: 60, rownolegleStron: 1 }) }) };
    expect(najdluzszyPrzebiegOstrzezenMs(program.opis.limity)).toBe(3_600_000);
    const fabryki = { programFakturowy: () => program, createVies: () => createAtrapaVies({ env }) };
    const moduly = modulyDla(env).map((m) => (m.nazwa === 'faktury' ? createModulFaktury({ fabryki }) : m));
    let a = null;
    let blad = null;
    try { a = await zbudujOms({ env, moduly, teraz: () => new Date(), log: () => {} }); } catch (e) { blad = e; }
    if (a) { await a.app.close(); a.db.close(); }
    expect(blad?.message ?? 'PANEL WSTAŁ').toMatch(/^Budżet czuwacza ostrzeżeń z limitów programu „Testownik” \(3600000 ms\)/);
    // inFakt: 960 000 ms — strażnik ze stałej i z limitów mówi to samo, start jak dziś.
    expect(najdluzszyPrzebiegOstrzezenMs(programInfakt({}).opis.limity)).toBe(960_000);
  });

  it('korekta zwrotu, paczka dla biura i czuwacz ostrzeżeń modułów wołają program z szwu', async () => {
    const { a, program } = await aplikacja();
    try {
      const id = zapiszZamowienie(a.db, 'pro', zamowienie(4201), {});
      a.db.prepare('INSERT INTO faktury (zamowienie_id, program, dokument_id, numer, utworzona_at) VALUES (?,?,?,?,?)')
        .run(id, 'testowy', 'dok-t1', 'TST 1/10/2026', '2026-10-01T10:00:00Z');
      const zwrotId = dodajZwrot(a.db, id, { data: '2026-10-14', kwota: '129.00',
        pozycje: [{ klucz_pozycji: 's11', nazwa: 'Lampa wisząca Półcień', ilosc: 1, kwota: '129.00' }] }).id;
      await a.usluga('zwroty', 'korekta').wystaw(id, zwrotId);
      expect(program.ile('wystawKorekte')).toBe(1);

      await a.usluga('koszty', 'paczkaDlaBiura').zbudujZestawieniePrzychodow('2026-09');
      const czuwacz = a.usluga('zdrowie', 'czuwaczOstrzezen');
      await czuwacz.przebieg();
      expect(program.ile('listaFaktur')).toBe(2);
      expect(czuwacz.najdluzszyPrzebiegMs).toBe(22 * 30_000);
    } finally { await a.app.close(); a.db.close(); }
  });
});
