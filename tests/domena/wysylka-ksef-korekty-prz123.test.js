// PRZ-123 C08 — korekty jako kandydaci wysyłki do KSeF, TYLKO przy programie wbudowanym (TwojeFaktury).
// Reguła: `coWolnoWyslac(…, { korekty })` i `doZaznaczeniaWszystkich(d, konsumenckie, { korekty })`.
//   • flaga domyślnie false → korekta odrzucona zdaniem POWOD_KOREKTA znak w znak (inFakt, program `test`);
//   • korekty: true → korekta jest kandydatem wyłącznie, gdy faktura pierwotna jest już w KSeF
//     (`ksef_korygowanej` w wierszu listy); bez niego czeka na pierwotną — zdanie POWOD_KOREKTA_CZEKA (C09: nie „w inFakcie”);
//   • wysyłalna korekta przechodzi te same bariery co VAT („jest już w KSeF”, konsumencka, „panel już zlecił”).
// Dane zmyślone (NIP-y testowe, numery KSeF wg wzoru TNumerKSeF).
import { describe, it, expect } from 'vitest';
import {
  coWolnoWyslac, doZaznaczeniaWszystkich, POWOD_KOREKTA, POWOD_KOREKTA_CZEKA, POWOD_KONSUMENCKA,
} from '../../src/domena/wysylka-ksef.js';
const NIP = '1234500011';
const KSEF_PIERWOTNEJ = '1234563218-20261103-0A1B2C3D4E5F-01';
const vat = (n, nadpisz = {}) => ({
  uuid: `v${n}`, number: `FV/${n}/11/2026`, rodzaj: 'vat', ksef_number: null, client_tax_code: NIP, stanKsef: 'brak',
  client_company_name: 'Pracownia Półcień', gross_price: 15899, ...nadpisz,
});
const kor = (n, nadpisz = {}) => ({
  uuid: `k${n}`, number: `FK/${n}/11/2026`, rodzaj: 'korekta', ksef_number: null, client_tax_code: NIP, stanKsef: 'brak',
  client_company_name: 'Pracownia Półcień', gross_price: -2700,
  ksef_korygowanej: KSEF_PIERWOTNEJ, ...nadpisz,
});
const TF = { korekty: true };

describe('C08 — flaga domyślnie wyłączona: korekty jak dziś (inFakt, program `test`)', () => {
  it('coWolnoWyslac bez flagi: korekta z numerem KSeF pierwotnej → POWOD_KOREKTA znak w znak', () => {
    const w = coWolnoWyslac(['v1', 'k1'], [vat(1), kor(1)]);
    expect(w.doWyslania.map((d) => d.uuid)).toEqual(['v1']);
    // PRZ-151.C02 (plan PRZ-151, rozdz. 8): nowe brzmienie POWOD_KOREKTA — bez nazwy programu; zostaje tylko dla
    // programu, który nie wysyła do KSeF (flaga false). Do PRZ-151: „Korekty wysyła się w inFakcie — panel ich nie wysyła.”
    const ZDANIE = 'Ten program faktur nie wysyła korekt do KSeF z OMS-u — wyślesz je bezpośrednio w programie faktur.';
    expect(w.pominiete).toEqual([{ numer: 'FK/1/11/2026', powod: ZDANIE }]);
    expect(POWOD_KOREKTA).toBe(ZDANIE);
  });

  it('coWolnoWyslac z jawnym { korekty: false } — to samo co bez flagi', () => {
    const bez = coWolnoWyslac(['v1', 'k1'], [vat(1), kor(1)], false, undefined, undefined);
    const jawnie = coWolnoWyslac(['v1', 'k1'], [vat(1), kor(1)], false, undefined, undefined, { korekty: false });
    expect(jawnie).toEqual(bez);
    expect(jawnie.pominiete[0].powod).toBe(POWOD_KOREKTA);
  });

  it('doZaznaczeniaWszystkich bez flagi: korekta z numerem KSeF pierwotnej nie jest kandydatem', () => {
    expect(doZaznaczeniaWszystkich(kor(1))).toBe(false);
    expect(doZaznaczeniaWszystkich(kor(1), false)).toBe(false);
    expect(doZaznaczeniaWszystkich(vat(1))).toBe(true);
  });
});

describe('C08 — TwojeFaktury ({ korekty: true })', () => {
  it('korekta faktury, która jest już w KSeF → do wysłania (razem z fakturą VAT)', () => {
    const w = coWolnoWyslac(['v1', 'k1'], [vat(1), kor(1)], false, undefined, undefined, TF);
    expect(w.doWyslania).toEqual([{ uuid: 'v1', numer: 'FV/1/11/2026' }, { uuid: 'k1', numer: 'FK/1/11/2026' }]);
    expect(w.pominiete).toEqual([]);
    expect(doZaznaczeniaWszystkich(kor(1), false, TF)).toBe(true);
  });

  it('korekta faktury BEZ numeru KSeF (pierwotna jeszcze nie w KSeF) nie jest kandydatem — czeka, zdanie POWOD_KOREKTA_CZEKA', () => {
    for (const brak of [null, undefined, '']) {
      const d = kor(2, { ksef_korygowanej: brak });
      expect(doZaznaczeniaWszystkich(d, false, TF)).toBe(false);
      const w = coWolnoWyslac(['k2'], [d], false, undefined, undefined, TF);
      expect(w.doWyslania).toEqual([]);
      expect(w.pominiete).toEqual([{ numer: 'FK/2/11/2026', powod: POWOD_KOREKTA_CZEKA }]);
    }
    expect(POWOD_KOREKTA_CZEKA).toBe('Korekta czeka na fakturę pierwotną — wyślesz ją do KSeF, gdy pierwotna dostanie numer KSeF.');
    expect(POWOD_KOREKTA_CZEKA).not.toMatch(/inFakt/u);
  });

  // Kolejność odsiewu: „pierwotna nie w KSeF” stoi tam, gdzie biała lista rodzaju — PRZED stanem (numer KSeF,
  // rezerwacja). Korekta czekająca na pierwotną nie może dostać „panel już zlecił” ani polecieć dalej.
  it('kolejność: korekta bez pierwotnej w KSeF — POWOD_KOREKTA_CZEKA wygrywa z rezerwacją i z konsumencką', () => {
    const d = kor(3, { ksef_korygowanej: null, ksefZleconaAt: '2026-11-05T10:00:00.000Z', client_tax_code: '' });
    const w = coWolnoWyslac(['k3'], [d], false, undefined, undefined, TF);
    expect(w.doWyslania).toEqual([]);
    expect(w.pominiete).toEqual([{ numer: 'FK/3/11/2026', powod: POWOD_KOREKTA_CZEKA }]);
  });

  it('kolejność: wysyłalna korekta przechodzi dalsze bariery jak faktura VAT', () => {
    const wKsef = kor(4, { ksef_number: '1234563218-20261106-0A1B2C3D4E61-03' });
    const konsumencka = kor(5, { client_tax_code: '' });
    const zlecona = kor(6, { ksefZleconaAt: '2026-11-05T10:00:00.000Z' });
    const w = coWolnoWyslac(['k4', 'k5', 'k6'], [wKsef, konsumencka, zlecona], false, undefined, undefined, TF);
    expect(w.doWyslania).toEqual([]);
    expect(w.pominiete.map((p) => p.numer)).toEqual(['FK/4/11/2026', 'FK/5/11/2026', 'FK/6/11/2026']);
    expect(w.pominiete[0].powod).toBe('Ten dokument jest już w KSeF (1234563218-20261106-0A1B2C3D4E61-03).');
    expect(w.pominiete[1].powod).toBe(POWOD_KONSUMENCKA);
    expect(w.pominiete[2].powod).not.toBe(POWOD_KOREKTA_CZEKA);
    expect(doZaznaczeniaWszystkich(konsumencka, false, TF)).toBe(false);
    expect(doZaznaczeniaWszystkich(konsumencka, true, TF)).toBe(true);
    expect(doZaznaczeniaWszystkich({ ...kor(7), stanKsef: 'jest' }, false, TF)).toBe(false);
  });

  it('nieznany rodzaj dalej odrzucony, także z flagą', () => {
    const w = coWolnoWyslac(['x'], [{ ...vat(9), uuid: 'x', rodzaj: 'proforma' }], false, undefined, undefined, TF);
    expect(w.pominiete[0].powod).toBe('Nieznany rodzaj dokumentu — panel wysyła wyłącznie faktury VAT.');
    expect(doZaznaczeniaWszystkich({ ...vat(9), rodzaj: 'proforma' }, false, TF)).toBe(false);
  });
});
