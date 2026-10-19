import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zalozKonto, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { odczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';

const env = { OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
  OMS_USER: 'operator', OMS_PASS: 'atrapa', OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir() };
const basic = 'Basic ' + Buffer.from('operator:atrapa').toString('base64');

async function przypadek(praca) {
  const katalog = mkdtempSync(join(tmpdir(), 'oms-prz024-'));
  const plik = join(katalog, 'oms.sqlite');
  let db = openOmsDb(plik), aplikacja;
  try {
    // Import w teście: RED pokazuje nazwy wszystkich brakujących zachowań.
    const { modulZwroty } = await import('../../../src/moduly/zwroty/modul.ts');
    aplikacja = await zbudujOms({ db, env });
    const id = zapiszZamowienie(db, 'kanal-testowy', {
      zrodlo_id: 901, numer: '901', klient: null, dostawa: null, metoda_wysylki: 'dpd',
      kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '220.00',
      koszt_dostawy_brutto: '20.00', koszt_dostawy_netto: '16.26', status_woo: 'processing',
      oplacone_at: null, anulowane: 0, utworzone_at: '2026-08-01T12:00:00',
      pozycje: [{ zrodlo_id: 731, nazwa: 'Produkt testowy', sku: 'TEST', ilosc: 4,
        cena_brutto: '50.00', cena_netto: '40.65', brutto_linii: '200.00', netto_linii: '162.60', vat: null }],
    }, {});
    const cialo = { data: '2026-08-02', kwota: '50,00', kwota_dostawy: '10,00',
      powod: 'Uszkodzenie', klucz: pobierzZamowienie(db, id).pozycje[0].klucz,
      nazwa: 'Produkt testowy', ilosc: '1', pozycja_kwota: '50,00' };
    const wyslij = (body = cialo, headers = {}, url = `/zamowienia/${id}/zwrot`) => aplikacja.app.inject({
      method: 'POST', url, headers: { authorization: basic, origin: 'http://localhost',
        'content-type': 'application/x-www-form-urlencoded', ...headers }, payload: new URLSearchParams(body).toString(),
    });
    const stan = () => ({ zwroty: db.prepare('SELECT * FROM zwroty ORDER BY id').all(),
      pozycje: db.prepare('SELECT * FROM zwroty_pozycje ORDER BY id').all(),
      log: db.prepare("SELECT akcja, wynik, kto FROM log WHERE akcja = 'zwrot.rejestracja' ORDER BY id").all() });
    const otworzPonownie = async () => { await aplikacja.app.close(); aplikacja = null; db.close(); db = openOmsDb(plik); };
    await praca({ db, id, cialo, wyslij, stan, otworzPonownie, modulZwroty });
  } finally {
    await aplikacja?.app.close(); db.close(); rmSync(katalog, { recursive: true, force: true });
  }
}

describe('PRZ-024 — rzeczywisty zapis zwrotu przez chronione HTTP', () => {
  it('utrwala nagłówek, pozycje, kwotę dostawy i log sukcesu po ponownym otwarciu bazy', async () => {
    await przypadek(async ({ id, wyslij, stan, otworzPonownie }) => {
      const r = await wyslij();
      expect(r.statusCode).toBe(302); expect(r.headers.location).toBe(`/zamowienia/${id}`);
      await otworzPonownie();
      const s = stan();
      expect(s.zwroty).toHaveLength(1); expect(s.pozycje).toHaveLength(1);
      expect(s.zwroty[0]).toMatchObject({ zamowienie_id: id, data: '2026-08-02', kwota: '50.00', kwota_dostawy: '10.00', powod: 'Uszkodzenie' });
      expect(s.pozycje[0]).toMatchObject({ zwrot_id: s.zwroty[0].id, nazwa: 'Produkt testowy', ilosc: 1, kwota: '50.00' });
      expect(s.log).toEqual([{ akcja: 'zwrot.rejestracja', wynik: 'Ręcznie (operator): zarejestrowany zwrot z 2026-08-02 na 50.00 zł + dostawa 10.00 zł, pozycji: 1; powód: Uszkodzenie.', kto: 'automat' }]);
    });
  });
  it('odmowa niespójnej kwoty pozostawia wyłącznie trwały log błędu', async () => {
    await przypadek(async ({ cialo, wyslij, stan, otworzPonownie }) => {
      const r = await wyslij({ ...cialo, kwota: '49.00' });
      expect(r.statusCode).toBe(400); expect(r.body).toContain('nie zgadza się z sumą');
      await otworzPonownie(); const s = stan();
      expect(s.zwroty).toEqual([]); expect(s.pozycje).toEqual([]);
      expect(s.log).toHaveLength(1); expect(s.log[0].wynik).toBe(`BŁĄD: ${r.body}`);
    });
  });
  it('błąd zapisu pozycji cofa nagłówek i ukrywa szczegóły SQL przed operatorem', async () => {
    await przypadek(async ({ db, wyslij, stan, otworzPonownie }) => {
      db.exec("CREATE TRIGGER odmowa_test BEFORE INSERT ON zwroty_pozycje BEGIN SELECT RAISE(ABORT, 'testowy-blad-pozycji'); END");
      const r = await wyslij();
      expect(r.statusCode).toBe(400); expect(r.body).toBe('błąd techniczny panelu — szczegóły w logu zamówienia.');
      await otworzPonownie(); const s = stan();
      expect(s.zwroty).toEqual([]); expect(s.pozycje).toEqual([]);
      expect(s.log).toHaveLength(1); expect(s.log[0].wynik).toContain('BŁĄD: testowy-blad-pozycji');
    });
  });
  it('nie dubluje tego samego zwrotu po powtórzeniu formularza', async () => {
    await przypadek(async ({ wyslij, stan }) => {
      expect((await wyslij()).statusCode).toBe(302);
      const r = await wyslij(); expect(r.statusCode).toBe(400); expect(r.body).toContain('Taki sam zwrot jest już zapisany');
      expect(stan().zwroty).toHaveLength(1); expect(stan().pozycje).toHaveLength(1);
      expect(stan().log).toHaveLength(2); expect(stan().log[1].wynik).toContain('BŁĄD:');
    });
  });
  it('bez sesji, z obcego Origin i bez pochodzenia odmawia przed zapisem', async () => {
    await przypadek(async ({ wyslij, stan }) => {
      expect((await wyslij(undefined, { authorization: '' })).statusCode).toBe(401);
      expect((await wyslij(undefined, { origin: 'https://obca.example' })).statusCode).toBe(403);
      expect((await wyslij(undefined, { origin: '' })).statusCode).toBe(403);
      expect(stan()).toEqual({ zwroty: [], pozycje: [], log: [] });
    });
  });
  it('sama rola produkcja bez ptaszka nie wystarcza; nadany ptaszek pozwala zapisać', async () => {
    await przypadek(async ({ db, wyslij, stan }) => {
      const konto = zalozKonto(db, { login: 'pracownik', imie: 'Pracownik testowy', haslo: 'haslo-testowe', rola: 'produkcja', ekrany: ['zamowienia'] });
      const cookie = `${NAZWA_CIASTECZKA_OMS}=${podpisz('pracownik', odczytajSekret(db), Date.now(), 0)}`;
      const headers = { authorization: '', cookie };
      expect((await wyslij(undefined, headers)).statusCode).toBe(403);
      expect(stan()).toEqual({ zwroty: [], pozycje: [], log: [] });
      ustawUprawnienia(db, konto, ['zamowienia', 'zwroty-zamowienia']);
      expect((await wyslij(undefined, headers)).statusCode).toBe(302);
      expect(stan().zwroty).toHaveLength(1); expect(stan().log[0].kto).toBe('Pracownik testowy');
    });
  });
  it('zachowuje powrót do listy i odrzuca zewnętrzny adres przekierowania', async () => {
    await przypadek(async ({ id, cialo, wyslij }) => {
      const r = await wyslij({ ...cialo, powrot: '/?status=zwrot' });
      expect(r.statusCode).toBe(302); expect(r.headers.location).toBe(`/zamowienia/${id}?powrot=%2F%3Fstatus%3Dzwrot`);
    });
    await przypadek(async ({ id, cialo, wyslij }) => {
      const r = await wyslij({ ...cialo, powrot: 'https://obca.example/' });
      expect(r.statusCode).toBe(302); expect(r.headers.location).toBe(`/zamowienia/${id}`);
    });
  });
  it('nieistniejące zamówienie daje 404, manifest nie dodaje tabel ani zegarów', async () => {
    await przypadek(async ({ wyslij, stan, modulZwroty }) => {
      const r = await wyslij(undefined, {}, '/zamowienia/99999/zwrot');
      expect(r.statusCode).toBe(404); expect(r.body).toBe('Nie ma takiego zamówienia');
      expect(stan()).toEqual({ zwroty: [], pozycje: [], log: [] });
      expect(modulZwroty.migracje).toEqual([]); expect(modulZwroty.menu).toEqual([]);
      expect(modulZwroty.uprawnienia.map(u => u.klucz)).toContain('zwroty-zamowienia');
    });
  });
});
