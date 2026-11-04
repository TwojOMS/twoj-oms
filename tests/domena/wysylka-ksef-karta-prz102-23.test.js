// PRZ-102.23 — przycisk „Wyślij do KSeF” na karcie zamówienia: reguła (czy przycisk, a jeśli nie — jakie zdanie)
// i bezpieczny adres powrotu ekranów podglądu/wyniku. Obie czyste, w domena/wysylka-ksef.js.
import { describe, it, expect } from 'vitest';
import {
  wysylkaZKarty, powrotWysylkiKsef, POWOD_KONSUMENCKA, POWOD_KOREKTA, powodJuzZlecona, coWolnoWyslac, UWAGA_BEZ_NIP_NA_KARCIE,
} from '../../src/domena/wysylka-ksef.js';

const NIP = '1234563218';
const karta = (o = {}) => ({ uuid: 'u1', ksefNumer: null, nip: NIP, zleconaAt: null, dzienWystawienia: '2026-10-20', ...o });

describe('wysylkaZKarty', () => {
  it.each([true, false])('rezerwacja na karcie uwzględnia program wbudowany=%s', (wbudowany) => {
    const program = { opis: { wbudowany } };
    const w = wysylkaZKarty(karta({ program, zleconaAt: '2026-10-20T18:00:00.000Z' }));
    expect(w.powod).toContain('(20.10.2026, 20:00)');
    expect(w.powod.includes('inFak')).toBe(!wbudowany);
    if (wbudowany) expect(w.powod).toBe('Panel już zlecił wysyłkę tego dokumentu do KSeF (20.10.2026, 20:00).');
  });

  it.each([true, false])('dopisek bez NIP-u przy TF nie odsyła do inFaktu, konsumenckie=%s', (konsumenckie) => {
    const w = wysylkaZKarty(karta({ nip: null, konsumenckie, program: { opis: { wbudowany: true } } }));
    expect(w.uwaga).toContain('na ekranie podglądu');
    expect(w.uwaga).not.toContain('inFak');
    expect(w.uwaga).not.toMatch(/ w (TwojeFaktur|inFak|programie)/);
    expect(wysylkaZKarty(karta({ nip: null, konsumenckie })).uwaga).toContain('w inFakcie');
  });
  it('faktura VAT z NIP-em, bez KSeF i bez rezerwacji → przycisk z uuid, miesiącem i polem daty wystawienia', () => {
    expect(wysylkaZKarty(karta())).toEqual({ wolno: true, uuid: 'u1', miesiac: '2026-10', pole: 'invoice_date', stan: 'brak' });
  });

  it('nabywca z numerem VAT UE (WDT) to podatnik — przycisk jest', () => {
    expect(wysylkaZKarty(karta({ nip: 'SK1098765431' })).wolno).toBe(true);
  });

  // Poprawka po recenzji: NIP karty to BIEŻĄCE dane zamówienia (edytowalne po wystawieniu, NIP dopisywany też
  // w inFakcie), nie dokument. Karta nie rozstrzyga „konsumencka” — przycisk zostaje z dopiskiem, a konsumencką
  // odbija podgląd (`coWolnoWyslac`, POWOD_KONSUMENCKA) na dokumencie pobranym z inFaktu.
  it('bez NIP-u na karcie (także same spacje) → przycisk z dopiskiem „panel sprawdzi na podglądzie”, bez zdania o konsumenckiej', () => {
    for (const nip of [null, '', '   ']) {
      const w = wysylkaZKarty(karta({ nip }));
      expect(w).toMatchObject({ wolno: true, uuid: 'u1', miesiac: '2026-10', pole: 'invoice_date', stan: 'brak' });
      expect(w.uwaga).toBe(UWAGA_BEZ_NIP_NA_KARCIE);
      expect(JSON.stringify(w)).not.toContain(POWOD_KONSUMENCKA);
    }
  });

  it('z NIP-em na karcie → przycisk bez dopisku', () => {
    expect(wysylkaZKarty(karta()).uwaga).toBeUndefined();
  });

  it('z rezerwacją („nie wiadomo”) → bez przycisku, zdanie „panel już zlecił” ze stemplem', () => {
    const w = wysylkaZKarty(karta({ zleconaAt: '2026-10-20T18:00:00.000Z' }));
    expect(w).toEqual({ wolno: false, powod: powodJuzZlecona('2026-10-20T18:00:00.000Z'), stan: 'wyslana_czeka' });
  });

  it.each([true, false])('z numerem KSeF i rezerwacją → stan z numerem bez zdania o zleceniu, wbudowany=%s', (wbudowany) => {
    const numer = '1234563218-20261029-ABCDEF123456-AB';
    const w = wysylkaZKarty(karta({ program: { opis: { wbudowany } }, ksefNumer: numer, zleconaAt: '2026-10-20T18:00:00.000Z' }));
    expect(w).toEqual({ wolno: false, powod: null, stan: 'jest' });
  });

  it('pewne fakty panelu wygrywają z brakiem NIP-u: numer KSeF i rezerwacja dają swoje zdanie, nie przycisk', () => {
    expect(wysylkaZKarty(karta({ ksefNumer: 'K', nip: null }))).toEqual({ wolno: false, powod: null, stan: 'jest' });
    expect(wysylkaZKarty(karta({ nip: null, zleconaAt: '2026-10-20T18:00:00.000Z' })))
      .toEqual({ wolno: false, powod: powodJuzZlecona('2026-10-20T18:00:00.000Z'), stan: 'wyslana_czeka' });
  });

  it('bez dokumentu w inFakcie (rezerwacja wystawiania, do wyjaśnienia) → nic: karta mówi o tym swoimi paskami', () => {
    expect(wysylkaZKarty(karta({ uuid: null }))).toBeNull();
  });

  it('bez daty wystawienia → bez przycisku, zdanie odsyła na listę Faktur', () => {
    const w = wysylkaZKarty(karta({ dzienWystawienia: null }));
    expect(w.wolno).toBe(false);
    expect(w.powod).toMatch(/Faktury/);
  });

  it('korekta: to samo zdanie, które bariera daje na podglądzie', () => {
    const { pominiete } = coWolnoWyslac(['k1'], [{ uuid: 'k1', number: 'K/1', rodzaj: 'korekta', client_tax_code: NIP }]);
    expect(pominiete[0].powod).toBe(POWOD_KOREKTA);
  });
});

describe('powrotWysylkiKsef', () => {
  const lista = { miesiac: '2026-10', pole: 'invoice_date' };

  it('zachowuje tylko dozwolone filtry listy, a na karcie je ignoruje', () => {
    const filtry = { ...lista, typ: 'korekta', platnosc: 'niezaplacona' };
    expect(powrotWysylkiKsef(undefined, filtry).adres).toBe('/faktury?miesiac=2026-10&pole=invoice_date&typ=korekta&platnosc=niezaplacona');
    expect(powrotWysylkiKsef(undefined, { ...filtry, typ: 'zle"><x' }).adres).toBe('/faktury?miesiac=2026-10&pole=invoice_date&platnosc=niezaplacona');
    expect(powrotWysylkiKsef('/zamowienia/42', filtry).adres).toBe('/zamowienia/42#faktura');
  });

  it('karta zamówienia → powrót na sekcję faktury tej karty', () => {
    expect(powrotWysylkiKsef('/zamowienia/42', lista)).toEqual({
      adres: '/zamowienia/42#faktura', etykieta: 'Wróć do zamówienia', powrot: '/zamowienia/42',
    });
  });

  it('brak albo obcy adres → lista Faktur z miesiącem i polem (jak dotąd)', () => {
    const domyslny = { adres: '/faktury?miesiac=2026-10&pole=invoice_date', etykieta: 'Wróć do listy faktur', powrot: null };
    for (const zly of [undefined, null, '', '//obcy.example/zamowienia/1', 'https://obcy.example/zamowienia/1',
      '/zamowienia/1/../../ustawienia', '/zamowienia/1?x=1', '/zamowienia/abc', '/zamowienia/0', ['/zamowienia/1', '/zamowienia/2'],
      '/zamowienia/1\n', ' /zamowienia/1', '/Zamowienia/1', '/zamowienia/12345678901']) {
      expect(powrotWysylkiKsef(zly, lista), JSON.stringify(zly)).toEqual(domyslny);
    }
  });
});
