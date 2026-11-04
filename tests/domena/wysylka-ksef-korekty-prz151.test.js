// PRZ-151.C02 — reguła wysyłki KSeF a korekty programu, który sam wysyła do KSeF (plan PRZ-151, D2 i rozdz. 8).
// Domena się nie zmienia poza zdaniami: flaga `korekty` dalej domyślnie `false`, a o tym, czy program wysyła korekty,
// rozstrzyga usługa. Tu sprawdzamy:
//   • nowe `POWOD_KOREKTA` znak w znak (bez nazwy programu — strażnik PRZ-118);
//   • przy `korekty: true` korekta z numerem KSeF pierwotnej idzie, bez niego czeka (POWOD_KOREKTA_CZEKA);
//   • korekta konsumencka przy wyłączonym B2C dostaje powód konsumencki jak faktura;
//   • `wysylkaZKarty` z `rodzaj: 'korekta'` mówi o korekcie, domyślnie (`vat`) jak dawniej.
// Dane zmyślone.
import { describe, it, expect } from 'vitest';
import {
  POWOD_KOREKTA, POWOD_KOREKTA_CZEKA, POWOD_KONSUMENCKA, coWolnoWyslac, doZaznaczeniaWszystkich, wysylkaZKarty,
} from '../../src/domena/wysylka-ksef.js';

const NIP = '1234500011';
const KSEF_PIERWOTNEJ = '1234563218-20261003-0A1B2C3D4E5F-01';
const NOWE_ZDANIE = 'Ten program faktur nie wysyła korekt do KSeF z OMS-u — wyślesz je bezpośrednio w programie faktur.';
const ZDANIE_CZEKA = 'Korekta czeka na fakturę pierwotną — wyślesz ją do KSeF, gdy pierwotna dostanie numer KSeF.';

const korekta = (uuid, nadpisz = {}) => ({
  uuid, number: '1/KOR/11/2026', rodzaj: 'korekta', invoice_date: '2026-11-03', ksef_number: null, stanKsef: 'brak',
  client_company_name: 'Pracownia Półcień', client_tax_code: NIP, gross_price: -2700, ...nadpisz,
});

describe('PRZ-151.C02 — POWOD_KOREKTA (rozdz. 8)', () => {
  it('nowe zdanie znak w znak, bez nazwy programu', () => {
    expect(POWOD_KOREKTA).toBe(NOWE_ZDANIE);
    expect(POWOD_KOREKTA).not.toMatch(/infak/i);
    expect(POWOD_KOREKTA_CZEKA).toBe(ZDANIE_CZEKA);
  });

  it('program bez wysyłki korekt (`korekty: false`) — korekta dostaje nowe POWOD_KOREKTA', () => {
    const k = korekta('K1', { ksef_korygowanej: KSEF_PIERWOTNEJ });
    const w = coWolnoWyslac(['K1'], [k], false);
    expect(w.doWyslania).toEqual([]);
    expect(w.pominiete).toEqual([{ numer: '1/KOR/11/2026', powod: NOWE_ZDANIE }]);
  });
});

describe('PRZ-151.C02 — korekty przy `korekty: true` (program, który wysyła do KSeF)', () => {
  it('korekta z numerem KSeF pierwotnej — do wysłania i do „zaznacz wszystkie”', () => {
    const k = korekta('K1', { ksef_korygowanej: KSEF_PIERWOTNEJ });
    const w = coWolnoWyslac(['K1'], [k], false, undefined, undefined, { korekty: true });
    expect(w.doWyslania.map((d) => d.uuid)).toEqual(['K1']);
    expect(w.pominiete).toEqual([]);
    expect(doZaznaczeniaWszystkich(k, false, { korekty: true })).toBe(true);
  });

  it('korekta bez numeru KSeF pierwotnej — czeka (POWOD_KOREKTA_CZEKA znak w znak), bez pola wyboru', () => {
    const k = korekta('K0', { ksef_korygowanej: null });
    const w = coWolnoWyslac(['K0'], [k], false, undefined, undefined, { korekty: true });
    expect(w.doWyslania).toEqual([]);
    expect(w.pominiete).toEqual([{ numer: '1/KOR/11/2026', powod: ZDANIE_CZEKA }]);
    expect(doZaznaczeniaWszystkich(k, false, { korekty: true })).toBe(false);
  });

  it('korekta konsumencka (bez NIP-u) przy wyłączonym B2C — powód konsumencki jak przy fakturze', () => {
    const k = korekta('KB', { ksef_korygowanej: KSEF_PIERWOTNEJ, client_tax_code: '' });
    const w = coWolnoWyslac(['KB'], [k], false, undefined, undefined, { korekty: true });
    expect(w.doWyslania).toEqual([]);
    expect(w.pominiete).toEqual([{ numer: '1/KOR/11/2026', powod: POWOD_KONSUMENCKA }]);
    expect(doZaznaczeniaWszystkich(k, false, { korekty: true })).toBe(false);
    // Przy włączonym B2C ta sama korekta idzie.
    const b2c = coWolnoWyslac(['KB'], [k], true, undefined, undefined, { korekty: true });
    expect(b2c.doWyslania.map((d) => d.uuid)).toEqual(['KB']);
  });
});

describe('PRZ-151.C02 — wysylkaZKarty: zdanie bez daty zależy od rodzaju', () => {
  it('korekta bez daty wystawienia — zdanie o korekcie (rozdz. 8)', () => {
    expect(wysylkaZKarty({ uuid: 'K1', nip: NIP, rodzaj: 'korekta', dzienWystawienia: null })).toEqual({
      wolno: false, powod: 'Panel nie zna daty wystawienia tej korekty — wyślij ją z zakładki Faktury.', stan: 'brak',
    });
  });

  it('domyślnie (faktura VAT) — zdanie jak dawniej', () => {
    expect(wysylkaZKarty({ uuid: 'V1', nip: NIP, dzienWystawienia: null })).toEqual({
      wolno: false, powod: 'Panel nie zna daty wystawienia tej faktury — wyślij ją z zakładki Faktury.', stan: 'brak',
    });
  });

  it('korekta z datą — dane formularza podglądu jak przy fakturze', () => {
    expect(wysylkaZKarty({ uuid: 'K1', nip: NIP, rodzaj: 'korekta', dzienWystawienia: '2026-11-03' })).toEqual({
      wolno: true, uuid: 'K1', miesiac: '2026-11', pole: 'invoice_date', stan: 'brak',
    });
  });
});
