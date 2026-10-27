// PRZ-118.06 — wystawianie faktur (zamówienia, okresu, WDT) na kontrakcie ProgramFakturowy.
//
// Program TESTOWY („Testownik”, opis.id 'testowy', tests/pomoc/program-testowy.js), nie inFakt: usługa ma działać
// na każdym programie w kontrakcie, zapisywać jego nazwę w kolumnie `program`, mówić jego nazwą w komunikatach
// i zachować fazy (przygotowanie zwalnia rezerwację zawsze, wystawienie — tylko po odmowie 4xx).
// Zachowanie dla inFaktu pilnują stare testy (faktura.test.js, faktura-wdt.test.js, faktura-okresu-*.test.js…)
// i złoty zapis żądań (zapis-zadan-infaktu-prz118.test.js) — bez zmian.
import { describe, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zapewnijOkres, pobierzOkres, rozpocznijFaktureOkresu } from '../../../src/oms/db/okresy.js';
import { createFaktura } from '../../../src/moduly/faktury/services/faktura.js';
import { createFakturaOkresu } from '../../../src/moduly/faktury/services/faktura-okresu.js';
import { stanFaktury } from '../../../src/domena/faktura-stan.js';
import { STAN } from '../../../src/domena/okres-rozliczeniowy.js';
import { programTestowy } from '../../pomoc/program-testowy.js';

const NIP_PRACOWNI = '5250000009';   // zmyślony, z poprawną sumą kontrolną
const NIP_UE = 'DE123456789';        // zmyślony numer VAT-UE
const NIP_SPRZEDAWCY = '1234563218'; // zmyślony
const TERAZ = () => '2026-10-15T10:00:00.000Z';

const zamowienie = (nad = {}) => ({
  zrodlo_id: 4101, numer: 'R/2026/041',
  klient: {
    first_name: 'Ewa', last_name: 'Półcień', company: 'Pracownia Półcień', email: 'biuro@polcien.invalid',
    address_1: 'Lampowa 7', postcode: '00-950', city: 'Warszawa',
  },
  dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: null,
  chce_fakture: 1, nip: NIP_PRACOWNI, kwota_brutto: '123.00', koszt_dostawy_brutto: '0.00',
  status_woo: 'processing',
  oplacone_at: '2026-10-14T13:00:00', anulowane: 0, utworzone_at: '2026-10-14T13:00:00',
  pozycje: [{ nazwa: 'Lampa stołowa Kałamarz', sku: 'LMP-KAL-01', ilosc: 2, cena_brutto: '61.50', vat: null }],
  ...nad,
});

const VIES_WAZNY = { wynik: 'wazny', nazwa: 'LEUCHTEN TEST GMBH', dataZapytania: '2026-10-15T10:00:00.000Z', numerKonsultacji: 'WAPI-T-1' };

function zestaw({ nad = {}, program = programTestowy(), vies = null } = {}) {
  const db = openOmsDb(':memory:');
  const id = zapiszZamowienie(db, 'pro', zamowienie(nad), {});
  const faktura = createFaktura({ db, program, vies, nipSprzedawcy: NIP_SPRZEDAWCY, teraz: TERAZ });
  return { db, id, program, faktura };
}

const wiersz = (db, id) => db.prepare('SELECT * FROM faktury WHERE zamowienie_id = ?').get(id);
const wpisy = (db, id) => db.prepare('SELECT * FROM log WHERE zamowienie_id = ? ORDER BY id').all(id);
const licznikWdt = (db) => db.prepare('SELECT rok, miesiac, kolejny FROM wdt_numery').all();

function bazaZOkresem() {
  const db = openOmsDb();
  const okres = zapewnijOkres(db, { klientKlucz: 'polcien', rok: 2026, miesiac: 9 });
  db.prepare(
    'INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, okres_rozliczeniowy_id, utworzone_at)'
    + " VALUES ('reczne', 202600041, 'R/2026/041', '104.00', ?, '2026-09-10T10:00:00.000Z')",
  ).run(okres.id);
  const zamId = db.prepare('SELECT id FROM zamowienia WHERE numer = ?').get('R/2026/041').id;
  db.prepare(
    'INSERT INTO pozycje (zamowienie_id, nazwa, ilosc, cena_brutto, brutto_linii, zrodlo)'
    + " VALUES (?, 'Lampa wisząca Półksiężyc', 1, '100.00', '100.00', 'reczna'),"
    + " (?, 'Obsługa zamówienia', 1, '4.00', '4.00', 'reczna')",
  ).run(zamId, zamId);
  return { db, okres, zamId };
}

const bezStatusu = (komunikat) => new Error(komunikat);
const zeStatusem = (komunikat, status) => Object.assign(new Error(komunikat), { dlaOperatora: true, status });

describe('PRZ-118.06 (1) faktura zamówienia na programie testowym', () => {
  it('wystawia, zapisuje program=testowy i dokument_id, infakt_uuid zostaje NULL', async () => {
    const { db, id, program, faktura } = zestaw();
    const w = await faktura.wystaw(id);
    expect(w.numer).toBe('TST 1/10/2026');
    const f = wiersz(db, id);
    expect(f.program).toBe('testowy');
    expect(f.dokument_id).toBe('dok-t1');
    expect(f.infakt_uuid).toBeNull();
    expect(f.numer).toBe('TST 1/10/2026');
    expect(stanFaktury(f)).toBe('wystawiona');
    // Nabywca przez kontrakt, z założeniem gdy brak — dane z daneFaktury (karta), nie ze sklepu wprost.
    expect(program.przygotujNabywce).toHaveBeenCalledTimes(1);
    const [nabywca, opcje] = program.przygotujNabywce.mock.calls[0];
    expect(opcje).toEqual({ zalozGdyBrak: true });
    expect(nabywca.nip).toBe(NIP_PRACOWNI);
    expect(nabywca.firma).toBe('Pracownia Półcień');
    // Pola nabywcy z programu idą do ładunku.
    expect(program.wystaw.mock.calls[0][0].client_id).toBe('nabywca-t1');
    expect(wpisy(db, id).find((l) => l.akcja === 'faktura').wynik).toBe('TST 1/10/2026');
  });

  it('podanie naraz `program` i `infakt` to błąd programisty — od razu przy tworzeniu usługi', () => {
    const db = openOmsDb(':memory:');
    expect(() => createFaktura({ db, program: programTestowy(), infakt: {} })).toThrow(/naraz/);
    expect(() => createFakturaOkresu({ db, program: programTestowy(), infakt: {} })).toThrow(/naraz/);
  });

  it('nabywca bez identyfikatora (null z przygotujNabywce) → odmowa z nazwą programu i zwolniona rezerwacja', async () => {
    const program = programTestowy({ metody: { przygotujNabywce: async () => null } });
    const { db, id, faktura } = zestaw({ program });
    await expect(faktura.wystaw(id)).rejects.toThrow('Testownik nie oddał identyfikatora nabywcy.');
    expect(wiersz(db, id)).toBeUndefined();
    expect(program.wystaw).not.toHaveBeenCalled();
  });
});

describe('PRZ-118.06 (2) faza przygotowania — KAŻDY błąd przygotujNabywce zwalnia rezerwację', () => {
  it.each([
    ['503 bez statusu (komunikat z kodem, brak pola status)', () => bezStatusu('Testownik odpowiedział 503')],
    ['503 ze statusem', () => zeStatusem('Testownik odpowiedział 503', 503)],
    ['zerwane połączenie', () => bezStatusu('Testownik nieosiągalny: fetch failed')],
    ['TypeError z naszego kodu', () => new TypeError('x is not a function')],
  ])('%s → wiersza nie ma, wystaw nie wołany, ponowienie przechodzi', async (_opis, blad) => {
    const przygotujNabywce = vi.fn()
      .mockRejectedValueOnce(blad())
      .mockResolvedValue({ client_id: 'nabywca-t1' });
    const program = programTestowy({ metody: { przygotujNabywce } });
    const { db, id, faktura } = zestaw({ program });
    await expect(faktura.wystaw(id)).rejects.toThrow();
    expect(wiersz(db, id)).toBeUndefined();
    expect(program.wystaw).not.toHaveBeenCalled();
    expect(wpisy(db, id).some((l) => l.akcja === 'faktura' && l.wynik.startsWith('BŁĄD:'))).toBe(true);
    // Ponowienie po usunięciu przyczyny przechodzi — rezerwacja naprawdę zwolniona.
    await expect(faktura.wystaw(id)).resolves.toMatchObject({ numer: 'TST 1/10/2026' });
    expect(program.ile('wystaw')).toBe(1);
  });

  it('kolejność wołań przy WDT: VIES → nabywca → seria (iluMaNumer) → wystaw', async () => {
    const kolejnosc = [];
    const vies = { sprawdz: vi.fn(async () => { kolejnosc.push('vies'); return VIES_WAZNY; }) };
    const program = programTestowy({ metody: { wystaw: async () => ({ uuid: 'dok-t2', numer: 'WDT/1/10/2026', ksefStatus: null }) } });
    const { faktura, id } = zestaw({ nad: { nip: NIP_UE }, program, vies });
    await faktura.wystaw(id);
    expect(['vies', ...program.wywolania.map(([m]) => m)]).toEqual(['vies', 'przygotujNabywce', 'iluMaNumer', 'wystaw']);
    expect(kolejnosc).toEqual(['vies']);
    expect(program.wystaw.mock.calls[0][0].number).toBe('WDT/1/10/2026');
  });
});

describe('PRZ-118.06 (3) faza wystawienia — błąd bez statusu = DO WYJAŚNIENIA, rezerwacja trzyma', () => {
  it('błąd bez statusu w wystaw → „DO WYJAŚNIENIA”, wiersz zostaje, drugie wystawienie odmawia', async () => {
    const program = programTestowy({ metody: { wystaw: vi.fn().mockRejectedValue(bezStatusu('Testownik nieosiągalny: fetch failed')) } });
    const { db, id, faktura } = zestaw({ program });
    await expect(faktura.wystaw(id)).rejects.toThrow(/fetch failed/);
    const f = wiersz(db, id);
    expect(f).toBeDefined();
    expect(stanFaktury(f)).toBe('do_wyjasnienia');
    expect(wpisy(db, id).some((l) => l.wynik.startsWith('DO WYJAŚNIENIA:'))).toBe(true);
    await expect(faktura.wystaw(id)).rejects.toThrow();
    expect(program.ile('wystaw')).toBe(1);
  });

  it('błąd 503 ze statusem w wystaw → też DO WYJAŚNIENIA (zwalnia tylko 4xx)', async () => {
    const program = programTestowy({ metody: { wystaw: vi.fn().mockRejectedValue(zeStatusem('Testownik odpowiedział 503', 503)) } });
    const { db, id, faktura } = zestaw({ program });
    await expect(faktura.wystaw(id)).rejects.toThrow();
    expect(stanFaktury(wiersz(db, id))).toBe('do_wyjasnienia');
  });

  it('odmowa 422 w wystaw → rezerwacja zwolniona', async () => {
    const program = programTestowy({ metody: { wystaw: vi.fn().mockRejectedValue(zeStatusem('Testownik odrzucił fakturę (422)', 422)) } });
    const { db, id, faktura } = zestaw({ program });
    await expect(faktura.wystaw(id)).rejects.toThrow();
    expect(wiersz(db, id)).toBeUndefined();
  });
});

describe('PRZ-118.06 (4) zdolność oznaczZaplacona', () => {
  const ZAPLACONE = { dataWystawienia: '2026-10-15', termin: 'zaplacone' };

  it('program BEZ oznaczZaplacona, faktura „zapłacone” → wystawiona, wpis w logu, nic nie rzuca', async () => {
    const program = programTestowy({ pomin: ['oznaczZaplacona'] });
    const { db, id, faktura } = zestaw({ program });
    await expect(faktura.wystaw(id, ZAPLACONE)).resolves.toMatchObject({ numer: 'TST 1/10/2026' });
    expect(stanFaktury(wiersz(db, id))).toBe('wystawiona');
    const log = wpisy(db, id).filter((l) => l.akcja === 'faktura');
    expect(log[0].wynik).toBe('TST 1/10/2026');
    expect(log[1].wynik).toMatch(/^UWAGA:/);
    expect(log[1].wynik).toContain('Testownik nie umie oznaczyć zapłaty — ');
    expect(log[1].wynik).toContain('ręcznie w Testowniku');
    expect(log[1].wynik).not.toMatch(/inFak/);
  });

  it('program Z oznaczZaplacona → zlecenie, log mówi nazwą programu', async () => {
    const { db, id, program, faktura } = zestaw();
    await faktura.wystaw(id, ZAPLACONE);
    expect(program.oznaczZaplacona).toHaveBeenCalledWith('dok-t1', { paidDate: '2026-10-15' });
    const log = wpisy(db, id).filter((l) => l.akcja === 'faktura');
    expect(log[1].wynik).toBe('Zlecono w Testowniku oznaczenie faktury TST 1/10/2026 jako opłaconej '
      + '(data zapłaty 2026-10-15). Testownik przetwarza to zadanie w tle.');
  });
});

describe('PRZ-118.06 (5) zdolność numeracjaWlasna (iluMaNumer) przy WDT', () => {
  it('faktura zamówienia WDT na programie bez numeracjaWlasna → odmowa PRZED rezerwacją, licznik serii nietknięty', async () => {
    const vies = { sprawdz: vi.fn().mockResolvedValue(VIES_WAZNY) };
    const program = programTestowy({ pomin: ['iluMaNumer'] });
    const { db, id, faktura } = zestaw({ nad: { nip: NIP_UE }, program, vies });
    await expect(faktura.wystaw(id)).rejects.toThrow(/Testownik/);
    expect(wiersz(db, id)).toBeUndefined();
    expect(licznikWdt(db)).toEqual([]);
    expect(program.wywolania).toEqual([]);
    expect(vies.sprawdz).not.toHaveBeenCalled();
  });

  it('faktura okresu WDT na programie bez numeracjaWlasna → odmowa przed rezerwacją i zamknięciem okresu', async () => {
    const { db, okres } = bazaZOkresem();
    const program = programTestowy({ pomin: ['iluMaNumer'] });
    const vies = { sprawdz: vi.fn().mockResolvedValue(VIES_WAZNY) };
    const usluga = createFakturaOkresu({ db, program, vies, nipSprzedawcy: NIP_SPRZEDAWCY, teraz: TERAZ });
    await expect(usluga.wystaw(okres.id, { nip: NIP_UE })).rejects.toThrow(/Testownik/);
    const po = pobierzOkres(db, okres.id);
    expect(po.stan).toBe(STAN.OTWARTY);
    expect(po.ksef_status).toBeNull();
    expect(licznikWdt(db)).toEqual([]);
    expect(program.wywolania).toEqual([]);
  });

  it('krajowa faktura na programie bez numeracjaWlasna wystawia się normalnie', async () => {
    const { db, id, faktura } = zestaw({ program: programTestowy({ pomin: ['iluMaNumer'] }) });
    await faktura.wystaw(id);
    expect(stanFaktury(wiersz(db, id))).toBe('wystawiona');
  });

  it('seria WDT zajęta w programie → komunikat z nazwą programu, licznik cofnięty, rezerwacja zwolniona', async () => {
    const vies = { sprawdz: vi.fn().mockResolvedValue(VIES_WAZNY) };
    const program = programTestowy({ metody: { iluMaNumer: async () => 1 } });
    const { db, id, faktura } = zestaw({ nad: { nip: NIP_UE }, program, vies });
    await expect(faktura.wystaw(id)).rejects.toThrow(/^W Testowniku istnieje już dokument o numerze WDT\/1\/10\/2026 .*listę faktur w Testowniku/);
    expect(wiersz(db, id)).toBeUndefined();
    expect(licznikWdt(db)).toEqual([{ rok: 2026, miesiac: 10, kolejny: 0 }]);
  });
});

describe('PRZ-118.06 (6)(7) faktura okresu — nabywca i komunikaty z nazwą programu', () => {
  it('(1) okresu: wystawia, zapisuje program=testowy i dokument_id, infakt_uuid NULL', async () => {
    const { db, okres } = bazaZOkresem();
    const program = programTestowy();
    const wynik = await createFakturaOkresu({ db, program }).wystaw(okres.id, { nip: NIP_PRACOWNI });
    expect(wynik.stan).toBe(STAN.ZAFAKTUROWANY);
    expect(wynik.program).toBe('testowy');
    expect(wynik.dokument_id).toBe('dok-t1');
    expect(wynik.infakt_uuid).toBeNull();
    expect(program.przygotujNabywce).toHaveBeenCalledWith({ nip: NIP_PRACOWNI }, { zalozGdyBrak: false });
    expect(program.wystaw.mock.calls[0][0].client_id).toBe('nabywca-t1');
  });

  it('(6) okres zawieszony (restart w trakcie wywołania) → komunikat mówi „Testownika” i „w Testowniku”', async () => {
    const { db, okres } = bazaZOkresem();
    rozpocznijFaktureOkresu(db, okres.id);
    db.prepare("UPDATE okresy_rozliczeniowe SET utworzona_at = '2026-09-01T00:00:00.000Z' WHERE id = ?").run(okres.id);
    const program = programTestowy();
    const blad = await createFakturaOkresu({ db, program }).wystaw(okres.id, { nip: NIP_PRACOWNI }).catch((e) => e);
    expect(blad.message).toContain('panel najpewniej został zrestartowany w trakcie wywołania Testownika.');
    expect(blad.message).toContain('Sprawdź RĘCZNIE w Testowniku, czy faktura za ten okres istnieje.');
    expect(blad.message).not.toMatch(/inFak/);
    expect(program.wywolania).toEqual([]);
  });

  it('(7) nabywca nieznaleziony → „W Testowniku nie ma klienta o NIP …”, bez rezerwacji', async () => {
    const { db, okres } = bazaZOkresem();
    const program = programTestowy({ metody: { przygotujNabywce: async () => null } });
    await expect(createFakturaOkresu({ db, program }).wystaw(okres.id, { nip: NIP_PRACOWNI }))
      .rejects.toThrow(`W Testowniku nie ma klienta o NIP ${NIP_PRACOWNI} — załóż go tam raz, ręcznie, i ponów wystawienie.`);
    expect(program.przygotujNabywce).toHaveBeenCalledWith({ nip: NIP_PRACOWNI }, { zalozGdyBrak: false });
    const po = pobierzOkres(db, okres.id);
    expect(po.stan).toBe(STAN.OTWARTY);
    expect(po.ksef_status).toBeNull();
    expect(program.wystaw).not.toHaveBeenCalled();
  });

  it('odpowiedź bez numeru i identyfikatora → komunikat z nazwą programu', async () => {
    const { db, okres } = bazaZOkresem();
    const program = programTestowy({ metody: { wystaw: async () => ({ uuid: null, numer: null }) } });
    await expect(createFakturaOkresu({ db, program }).wystaw(okres.id, { nip: NIP_PRACOWNI }))
      .rejects.toThrow(/^Testownik odpowiedział bez numeru .*Sprawdź RĘCZNIE w Testowniku/);
  });

  it('dla inFaktu (stary `{ infakt }`) komunikat okresu zawieszonego bez zmian', async () => {
    const { db, okres } = bazaZOkresem();
    rozpocznijFaktureOkresu(db, okres.id);
    db.prepare("UPDATE okresy_rozliczeniowe SET utworzona_at = '2026-09-01T00:00:00.000Z' WHERE id = ?").run(okres.id);
    const infakt = { znajdzKlientaPoNip: vi.fn(), zalozKlienta: vi.fn(), wystaw: vi.fn() };
    const blad = await createFakturaOkresu({ db, infakt }).wystaw(okres.id, { nip: NIP_PRACOWNI }).catch((e) => e);
    expect(blad.message).toBe('Rezerwacja faktury tego okresu wisi od 2026-09-01T00:00:00.000Z i żadne wystawianie już nie trwa '
      + '— panel najpewniej został zrestartowany w trakcie wywołania inFaktu. Sprawdź RĘCZNIE w inFakcie, czy faktura za ten okres istnieje. '
      + 'Jeśli JEST i jeszcze nie poszła do KSeF (wysyłkę robi właściciel ręcznie, wieczorem) — '
      + 'skasuj ją tam. Panel sam z tego stanu NIE WYJDZIE i wystawienia nie ponowi: okres '
      + 'zostaje zablokowany, dopóki ktoś go świadomie nie odblokuje. Ta blokada jest po to, '
      + 'żeby drugie podejście nie dołożyło drugiej faktury za ten sam miesiąc.');
  });
});
