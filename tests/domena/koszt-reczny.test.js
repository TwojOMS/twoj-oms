import { describe, it, expect } from 'vitest';
import {
  naWierszReczny, nowyKluczReczny, czyKluczReczny, numerRecznego, PREFIKS_RECZNEGO,
} from '../../src/domena/koszt-reczny.js';

// ⚠️ TO JEST DRUGIE (i ostatnie) miejsce styku „to, co wpisał człowiek" z kształtem wiersza
// `koszty` — pierwszym jest `naWiersz` (domain/koszt-metadane.js, kształt KSeF). Oba wychodzą
// TYM SAMYM kształtem i oba oddają kwoty jako NAPISY z dwoma miejscami po przecinku, bo
// kolumny są TEXT-em, a arytmetyka pieniędzy idzie przez `grosze()` (niezmiennik 4.5).
//
// ⚠️⚠️ FORMULARZ MA TRZY POLA: firma, data, kwota (13.08.2026, prośba właściciela). Wszystko
// pozostałe niesie DEFINICJA FIRMY ze słownika (db/firmy-reczne.js) — drugi argument.
const FIRMA = {
  nazwa: 'Facebook (Meta)',
  sprzedawca: 'Meta Platforms Ireland Limited',
  kategoria: 'Reklama',
  typ: 'zmienny',
};

const dane = (n = {}) => ({ dataWystawienia: '2026-08-05', kwota: '100', ...n });

describe('koszt reczny — kształt wiersza z trzech pól', () => {
  it('składa wiersz w tym samym kształcie, co dokument z KSeF', () => {
    expect(naWierszReczny(dane(), FIRMA)).toEqual({
      // ⚠️ NUMER DOKUMENTU SKŁADANY Z FIRMY I DATY — operator go nie wpisuje, a kolumna
      // go wymaga. Ma być czytelny na liście i NIE UDAWAĆ numeru faktury sprzedawcy.
      numerDokumentu: 'Facebook (Meta) 2026-08-05',
      sprzedawcaNip: null,
      sprzedawcaNazwa: 'Meta Platforms Ireland Limited',
      dataWystawienia: '2026-08-05',
      netto: '100.00',
      vat: '0.00',
      brutto: '100.00',
      waluta: 'PLN',
      kategoriaDokumentu: 'Reklama',
      typDokumentu: 'zmienny',
    });
  });

  // ⚠️⚠️ JEDNA KWOTA, W ZŁOTÓWKACH, JAKO NETTO **ORAZ** BRUTTO, Z ZEROWYM VAT-em. To są zakupy
  // zagraniczne rozliczane jako IMPORT USŁUG: VAT idzie odwrotnym obciążeniem, sprzedawca go
  // nie nalicza, a do kosztu w KPiR wchodzi kwota netto. Operator ma pod ręką dokładnie jedną
  // liczbę — tę z rozliczenia karty albo z wyciągu.
  it('⚠️ jedna kwota wchodzi jako netto I brutto, VAT zerowy', () => {
    const w = naWierszReczny(dane({ kwota: '246,50' }), FIRMA);
    expect(w.netto).toBe('246.50');
    expect(w.brutto).toBe('246.50');
    expect(w.vat).toBe('0.00');
  });

  // ⚠️ WALUTA TO PLN I NIE MA JEJ NA FORMULARZU — to jest poprawka usterki, a nie kosmetyka.
  // Dokument w obcej walucie stoi POZA sumą miesiąca (kursu nie zmyślamy), czyli koszty,
  // dla których ta funkcja powstała, lądowały poza sumą, którą miały zasilić.
  it('⚠️ waluta jest zawsze PLN — inaczej wiersz wypadłby z sumy miesiąca', () => {
    expect(naWierszReczny(dane({ waluta: 'USD' }), FIRMA).waluta).toBe('PLN');
  });

  // ⚠️ KWOTY WYCHODZĄ JAKO NAPISY W POSTACI KANONICZNEJ ('100.00'), a nie tak, jak je ktoś
  // wklepał. Napis zapisany raz jako '100', a raz jako '100.00' przechodzi przez `grosze()`
  // tak samo, ale w bazie leżą wtedy DWIE postaci tej samej kwoty — a porównanie dwóch
  // napisów przestaje wtedy cokolwiek znaczyć (ta sama zasada, co przy `toFixed(2)`
  // w domain/koszt-metadane.js).
  it.each([
    ['100', '100.00'],
    ['100.5', '100.50'],
    ['100,50', '100.50'],
    [' 100.50 ', '100.50'],
    [100.5, '100.50'],
  ])('kwota %p zapisuje się jako %p', (wejscie, wynik) => {
    expect(naWierszReczny(dane({ kwota: wejscie }), FIRMA).netto).toBe(wynik);
  });

  it('⚠️ brak kwoty odmawia — zero weszłoby do sumy miesiąca jako prawda', () => {
    expect(() => naWierszReczny(dane({ kwota: '' }), FIRMA)).toThrow(/kwot/i);
    expect(() => naWierszReczny(dane({ kwota: null }), FIRMA)).toThrow(/kwot/i);
    expect(() => naWierszReczny(dane({ kwota: 'osiemdziesiąt' }), FIRMA)).toThrow(/kwot/i);
  });

  // Miesiąc kosztów liczy się PO DACIE WYSTAWIENIA (db/koszty.js), a zapytanie idzie
  // zakresem po napisie. Data w innym formacie wypadłaby z KAŻDEGO miesiąca — czyli
  // dokument wpisany ręką byłby w bazie i nie byłoby go w żadnej sumie.
  it.each(['', '5.08.2026', '2026-8-5', 'wczoraj', null])(
    '⚠️ data wystawienia %p jest odrzucana, a nie zapisywana byle jak',
    (data) => {
      expect(() => naWierszReczny(dane({ dataWystawienia: data }), FIRMA)).toThrow(/dat/i);
    },
  );

  // ⚠️⚠️ FIRMA JEST WYBIERANA Z LISTY, NIE WPISYWANA — a odmowa musi istnieć mimo `<select>`
  // na ekranie, bo żądanie da się złożyć z ręki. Firma spoza słownika nie niesie ani nazwy
  // sprzedawcy, ani kategorii: wiersz wszedłby do sumy miesiąca jako koszt niczyj.
  it('⚠️ firma spoza listy odmawia — bez niej nie ma sprzedawcy ani kategorii', () => {
    expect(() => naWierszReczny(dane({ firma: 'Wymyślona' }), undefined)).toThrow(/firm/i);
    expect(() => naWierszReczny(dane(), null)).toThrow(/firm/i);
    expect(() => naWierszReczny(dane(), { nazwa: 'X', kategoria: 'Reklama', typ: 'zmienny' }))
      .toThrow(/firm/i);
  });

  // Kategoria idzie ze SŁOWNIKA, a nie z formularza — i to jest cała różnica wobec pierwszej
  // wersji: kategoria wybierana przy każdym koszcie od nowa rozpadała się po kwartale na
  // „Reklamę" i „Marketing", czyli dwie grupy w rozbiciu, po cichu, z jednego kosztu.
  it('kategoria i typ biorą się z definicji firmy, a nie z formularza', () => {
    const w = naWierszReczny(dane({ kategoria: 'Cokolwiek', typ: 'drobne' }), FIRMA);
    expect(w).toMatchObject({ kategoriaDokumentu: 'Reklama', typDokumentu: 'zmienny' });
  });

  // ⚠️ NIP JEST ZAWSZE PUSTY I TO JEST SEDNO TEJ FUNKCJI: Google, Meta ani Anthropic nie mają
  // polskiego NIP-u, a to właśnie ich faktur nie ma w KSeF. Sprzedawca, który NIP ma, trafia
  // do panelu sam, przez czuwacza — nie ma powodu wpisywać go ręką.
  it('⚠️ NIP jest zawsze pusty — pola na niego nie ma i mieć nie ma', () => {
    expect(naWierszReczny(dane({ sprzedawcaNip: '525-267-47-98' }), FIRMA).sprzedawcaNip)
      .toBeNull();
  });
});

// ⚠️ NUMER SKŁADANY JEST CZYTELNY I NIE JEST KLUCZEM. Dwie faktury od tej samej firmy z tego
// samego dnia dostaną ten sam napis i to jest poprawne — tożsamość wiersza niesie
// `RECZNY-<uuid>`, a rozpoznawania dubletów świadomie tu nie ma.
describe('koszt reczny — numer dokumentu', () => {
  it('mówi, czyj to koszt i z kiedy — i nie udaje numeru faktury sprzedawcy', () => {
    expect(numerRecznego('Anthropic', '2026-08-12')).toBe('Anthropic 2026-08-12');
    expect(numerRecznego('Anthropic', '2026-08-12')).not.toMatch(/FV|INV/i);
  });
});

// ⚠️⚠️ KLUCZ SYNTETYCZNY. Wiersz ręczny leży w TEJ SAMEJ tabeli, co dokumenty z KSeF (jedna
// prawda o kosztach), a kluczem głównym jest tam numer KSeF — którego ręczna faktura nie ma
// i mieć nie będzie.
describe('koszt reczny — klucz', () => {
  it('klucz jest rozpoznawalny na pierwszy rzut oka i nie da się go pomylić z numerem KSeF', () => {
    const klucz = nowyKluczReczny();
    expect(klucz.startsWith(PREFIKS_RECZNEGO)).toBe(true);
    expect(czyKluczReczny(klucz)).toBe(true);
    // Prawdziwy numer KSeF zaczyna się od NIP-u wystawcy — nigdy od liter naszego prefiksu.
    expect(czyKluczReczny('5252674798-20260605-0F0F0F0F0F0F-A1')).toBe(false);
    expect(czyKluczReczny(null)).toBe(false);
  });

  it('⚠️ każdy klucz jest inny — dwa dokumenty tego samego dnia nie mogą się skleić', () => {
    const klucze = new Set(Array.from({ length: 50 }, () => nowyKluczReczny()));
    expect(klucze.size).toBe(50);
  });
});
