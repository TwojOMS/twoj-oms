import { describe, it, expect } from 'vitest';
import { znormalizujKomentarz, MAX_ZNAKOW } from '../../../src/domena/komentarz-wewnetrzny.js';
import { daneSpecyfikacji } from '../../pomoc/specyfikacja-parytetu.js';
import { pozycjeDokumentu } from '../../../src/domena/pozycje-faktury.js';

describe('znormalizujKomentarz', () => {
  it('przepuszcza notatkę bez zmian, obcinając otoczkę', () => {
    expect(znormalizujKomentarz('  klient dzwonił, czeka na projekt  ')).toBe('klient dzwonił, czeka na projekt');
  });

  // ⚠️ PUSTE KASUJE — bez tego raz założonej notatki nie dałoby się zdjąć.
  it('pusty napis i same białe znaki kasują notatkę', () => {
    expect(znormalizujKomentarz('')).toBeNull();
    expect(znormalizujKomentarz('   \n  ')).toBeNull();
    expect(znormalizujKomentarz(null)).toBeNull();
  });

  it('CRLF z przeglądarki schodzi do LF', () => {
    expect(znormalizujKomentarz('pierwsza\r\ndruga\rtrzecia')).toBe('pierwsza\ndruga\ntrzecia');
  });

  it('wielolinijkowa notatka zostaje wielolinijkowa', () => {
    expect(znormalizujKomentarz('a\n\nb')).toBe('a\n\nb');
  });

  it('ponad limit → odmowa z liczbą znaków w komunikacie', () => {
    expect(() => znormalizujKomentarz('x'.repeat(MAX_ZNAKOW + 1))).toThrow(/4001 znaków/);
  });

  it('dokładnie na limicie przechodzi', () => {
    expect(znormalizujKomentarz('x'.repeat(MAX_ZNAKOW))).toHaveLength(MAX_ZNAKOW);
  });

  // ⚠️ Licznik liczy tekst PO normalizacji: 2000 linii po jednym znaku to 3999 znaków z LF-ami,
  // a nie 5999 z CRLF-ami. Inaczej limit zależałby od tego, jaki system ma operator.
  it('limit liczy się po normalizacji końców linii, nie przed', () => {
    expect(() => znormalizujKomentarz('x\r\n'.repeat(2000))).not.toThrow();
  });
});

// ============================================================================
// ⚠️ NIE OPUSZCZA PANELU. Te dwa testy są całym powodem, dla którego pole w ogóle wolno było
// dołożyć: komentarz ma nie trafić ani na fakturę, ani na kartkę wkładaną do paczki.
// „Nie ma jak tam wpaść" jest prawdą tylko do najbliższej zmiany w tamtych modułach — więc
// niech to pilnuje test, a nie pamięć.
// ============================================================================
const zamowienie = () => ({
  numer: 'PRO/1', utworzone_at: '2026-08-21T09:00:00Z', kwota_brutto: '110.00',
  koszt_dostawy_brutto: '10.00', metoda_wysylki: 'dpd', metoda_platnosci: 'Przelew', faktura: null,
  komentarz_wewnetrzny: 'NIE POKAZYWAĆ KLIENTOWI: klient marudzi, doliczyć zapas czasu',
  pozycje: [{ nazwa: 'STOP 70x100', sku: 'STOP-70', ilosc: 2, cena_brutto: '50.00', brutto_linii: '100.00' }],
});

const SPRZEDAWCA = { nazwa: 'Lumina', adres: 'Pęki', nip: '5492447186', bdo: '000123456' };

describe('komentarz wewnętrzny nie wychodzi do klienta', () => {
  it('nie ma go w specyfikacji do paczki', () => {
    const d = daneSpecyfikacji(zamowienie(), { sprzedawca: SPRZEDAWCA });
    expect(JSON.stringify(d)).not.toContain('NIE POKAZYWAĆ KLIENTOWI');
  });

  it('nie ma go w pozycjach faktury', () => {
    const uslugi = pozycjeDokumentu(zamowienie());
    expect(JSON.stringify(uslugi)).not.toContain('NIE POKAZYWAĆ KLIENTOWI');
  });
});
