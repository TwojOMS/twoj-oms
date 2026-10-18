// PRZ-093.08 (P2 z recenzji) — „Odbiorca” w bloku PRZELEW maila płatniczego to nazwa firmy z TEGO SAMEGO źródła
// adresu co proforma: plik (DPD_NADAWCA_*) wygrywa, potem Ustawienia → Firma, czytane przy KAŻDYM mailu.
// Przed poprawką nazwa była liczona raz przy starcie i tylko z pliku: firma z adresem wpisanym w panelu wysyłała
// prośbę o przelew z pustym „Odbiorca: ”. Dane zmyślone; podgląd maila niczego nie wysyła.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { createWiadomosci } from '../../../src/moduly/wiadomosci/services/wiadomosci.js';
import { adresFirmyZEnv } from '../../../src/core/adres-firmy.ts';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { zapiszAdresFirmy } from '../../../src/oms/db/adres-firmy.js';

const RACHUNEK = '34109010140000000000000000';
const zamowienie = () => ({
  zrodlo_id: 6001, numer: 'PRZELEW-093',
  klient: { first_name: 'Jan', last_name: 'Testowy', email: 'klient@fikcja.invalid', company: 'Nabywca Testowy' },
  dostawa: { first_name: 'Jan', last_name: 'Testowy', address_1: 'Odbiorcza 4', postcode: '00-950', city: 'Nibylandia' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null,
  kwota_brutto: '990.00', koszt_dostawy_brutto: '0.00', koszt_dostawy_netto: '0.00',
  status_woo: 'processing', oplacone_at: null, anulowane: 0, utworzone_at: '2026-10-01T09:15:00',
  termin_platnosci: '14',
  pozycje: [{ zrodlo_id: 7001, nazwa: 'Lampa', sku: 'LAMPA-1', ilosc: 10, cena_brutto: '99.00', cena_netto: '80.49',
    brutto_linii: '990.00', netto_linii: '804.88', vat: null }],
});
const ADRES_BAZY = { nazwa: 'Pracownia Zmyślona', ulica: 'Wymyślona 12', kod: '00-950', miasto: 'Nibylandia', kraj: 'PL',
  phone: '', email: '' };
const PLIK = { DPD_NADAWCA_NAZWA: 'Firma z Pliku', DPD_NADAWCA_ULICA: 'Plikowa 1', DPD_NADAWCA_KOD: '00-001', DPD_NADAWCA_MIASTO: 'Plikowo' };
const odbiorca = (tekst) => /Odbiorca: ?(.*)/u.exec(tekst)?.[1] ?? null;

function usluga(config) {
  const db = openOmsDb(':memory:');
  const mailer = { sendMail: async () => { throw new Error('podgląd nie wysyła'); } };
  const w = createWiadomosci({ db, mailer, config: { proforma: { rachunek: RACHUNEK }, ...config },
    teraz: () => '2026-10-02T10:00:00.000Z' });
  return { w, id: zapiszZamowienie(db, 'reczne', zamowienie(), {}) };
}

describe('PRZ-093.08 odbiorca przelewu w mailu płatniczym', () => {
  it('adres tylko w Ustawieniach: odbiorca = nazwa z bazy, czytana przy każdym mailu (bez restartu)', async () => {
    let adres = ADRES_BAZY;
    const { w, id } = usluga({ nadawca: adresFirmyZEnv({}), adresFirmy: () => adres });
    const p = await w.podglad(id, 'przypomnienie');
    expect(odbiorca(p.tekst)).toBe('Pracownia Zmyślona');
    expect(p.html).toContain('Pracownia Zmyślona');
    adres = { ...ADRES_BAZY, nazwa: 'Pracownia Po Zmianie' };
    expect(odbiorca((await w.podglad(id, 'przypomnienie')).tekst)).toBe('Pracownia Po Zmianie');
  });

  it('produkcja (adres w pliku): odbiorca = DPD_NADAWCA_NAZWA, jak przed zmianą', async () => {
    const zPliku = adresFirmyZEnv(PLIK);
    const { w, id } = usluga({ nadawca: zPliku, adresFirmy: () => zPliku });
    expect(odbiorca((await w.podglad(id, 'przypomnienie')).tekst)).toBe('Firma z Pliku');
  });

  it('bez źródła adresu: pusty odbiorca jak dziś; skład bez funkcji (stare testy) czyta config.nadawca', async () => {
    const pusty = usluga({ nadawca: adresFirmyZEnv({}), adresFirmy: () => null });
    expect(odbiorca((await pusty.w.podglad(pusty.id, 'przypomnienie')).tekst)).toBe('');
    const stary = usluga({ nadawca: { nazwa: 'Stary Skład' } });
    expect(odbiorca((await stary.w.podglad(stary.id, 'przypomnienie')).tekst)).toBe('Stary Skład');
  });
});

// Prawdziwy skład: funkcja adresu z modułu faktur dociera do usługi wiadomości przez kopiowanie configu.
describe('PRZ-093.08 odbiorca przelewu przez prawdziwy skład modułów', () => {
  let katalog;
  beforeEach(() => {
    katalog = mkdtempSync(join(tmpdir(), 'prz093-przelew-'));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('Sieć zabroniona'); });
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(katalog, { recursive: true, force: true }); });
  const env = (dodatkowe = {}) => ({ OMS_TRYB: 'produkcja', OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: RACHUNEK,
    OMS_USER: 'operator', OMS_PASS: 'fixture', OMS_PROFORMY_KATALOG: katalog, OMS_ETYKIETY_KATALOG: katalog,
    SMTP_HOST: 'smtp.fikcja.invalid', SMTP_USER: 'sklep@fikcja.invalid', SMTP_PASS: 'atrapa', ...dodatkowe });

  for (const [wariant, dodatkowe, oczekiwany] of [
    ['adres tylko w Ustawieniach', {}, 'Pracownia Zmyślona'],
    ['adres w pliku wygrywa nad bazą', PLIK, 'Firma z Pliku'],
  ]) {
    it(wariant, async () => {
      const a = await zbudujOms({ env: env(dodatkowe) });
      try {
        zapiszAdresFirmy(a.db, { nazwa: 'Pracownia Zmyślona', ulica: 'Wymyślona 12', kod: '00-950', miasto: 'Nibylandia', kraj: 'PL', telefon: '', email: '' });
        const id = zapiszZamowienie(a.db, 'reczne', zamowienie(), {});
        const p = await a.usluga('wiadomosci', 'wiadomosci').podglad(id, 'przypomnienie');
        expect(odbiorca(p.tekst)).toBe(oczekiwany);
      } finally { await a.app.close(); a.db.close(); }
    });
  }
});
