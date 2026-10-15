import { describe, it, expect } from 'vitest';
import { zdjecieLinii, adresMiniatury } from '../../src/domena/miniatury.js';

// Miniatury produktów w kolumnie „Produkty" na stronie głównej.
// Woo oddaje w `line_items[].image.src` adres zdjęcia w PEŁNYM rozmiarze; my pokazujemy
// kwadrat 38 px, więc pobieranie oryginału byłoby kilkunastoma megabajtami na odświeżenie.

describe('zdjecieLinii — co zapisujemy z odpowiedzi sklepu', () => {
  it('bierze adres zdjęcia z linii zamówienia', () => {
    expect(zdjecieLinii({ image: { id: 1092, src: 'https://pro.szkicownia.pl/x.jpg' } }))
      .toBe('https://pro.szkicownia.pl/x.jpg');
  });

  it('linia bez zdjęcia daje null, nie pusty napis', () => {
    expect(zdjecieLinii({})).toBe(null);
    expect(zdjecieLinii({ image: null })).toBe(null);
    expect(zdjecieLinii({ image: { id: 0, src: '' } })).toBe(null);
    expect(zdjecieLinii(null)).toBe(null);
  });

  // ⚠️ Adres ze sklepu ląduje wprost w atrybucie `src` naszego HTML-a. Sklep jest nasz,
  // ale wartość spoza http(s) nie ma tam czego szukać — a kosztuje to jedną linię.
  it('przepuszcza wyłącznie http(s)', () => {
    expect(zdjecieLinii({ image: { src: 'javascript:alert(1)' } })).toBe(null);
    expect(zdjecieLinii({ image: { src: 'data:image/png;base64,AAA' } })).toBe(null);
    expect(zdjecieLinii({ image: { src: 'http://sklep.test/x.png' } })).toBe('http://sklep.test/x.png');
  });
});

describe('adresMiniatury — wariant 150×150 wygenerowany przez WordPressa', () => {
  it('wstawia rozmiar przed rozszerzeniem, zachowując je', () => {
    expect(adresMiniatury('https://pro.szkicownia.pl/wp-content/uploads/2026/07/szablon.jpg'))
      .toBe('https://pro.szkicownia.pl/wp-content/uploads/2026/07/szablon-150x150.jpg');
    expect(adresMiniatury('https://pro.szkicownia.pl/wp-content/uploads/2026/07/SZABLON-EV.png'))
      .toBe('https://pro.szkicownia.pl/wp-content/uploads/2026/07/SZABLON-EV-150x150.png');
  });

  // Kropka w nazwie katalogu albo w nazwie pliku bez rozszerzenia nie ma prawa rozerwać
  // adresu w połowie — wtedy uczciwiej pokazać oryginał niż adres, którego nie ma.
  it('adres bez rozszerzenia zostawia bez zmian', () => {
    expect(adresMiniatury('https://sklep.test/zdjecie')).toBe('https://sklep.test/zdjecie');
    expect(adresMiniatury('https://sklep.test/a.b/zdjecie')).toBe('https://sklep.test/a.b/zdjecie');
  });

  it('pustą wartość oddaje jako null', () => {
    expect(adresMiniatury(null)).toBe(null);
    expect(adresMiniatury('')).toBe(null);
  });

  // Adres z parametrami (CDN, cache-buster) — rozmiar musi trafić do ŚCIEŻKI, nie na koniec
  // całego adresu, bo inaczej powstałby plik „x.jpg?v=2-150x150", który nie istnieje.
  it('nie tyka części zapytania', () => {
    expect(adresMiniatury('https://sklep.test/x.jpg?v=2'))
      .toBe('https://sklep.test/x-150x150.jpg?v=2');
  });
});
