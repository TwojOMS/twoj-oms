import { describe, it, expect } from 'vitest';
import { tekstZAllegro } from '../../src/domena/tekst-allegro.js';

// Centrum wiadomosci Allegro oddaje `text` z ENCJAMI HTML. Pomiar na kopii produkcji
// (14.10.2026): 30 z 85 wiadomosci ma `&oacute;`, jedna `&Oacute;`, do tego `&quot;`
// i `&zwnj;`. Litery spoza Latin-1 (ą, ę, ł, ś…) przychodza jako zwykle znaki — dlatego
// zepsute wygladalo TYLKO „ó/Ó". Szablon EJS ucieka `&` drugi raz i czlowiek widzial
// dosłownie „&Oacute;".
describe('tekstZAllegro', () => {
  it('rozwija ó i Ó z zachowaniem wielkości litery', () => {
    expect(tekstZAllegro('DZI&Oacute;BEK i kr&oacute;tki')).toBe('DZIÓBEK i krótki');
  });

  it('rozwija cudzysłów, niełącznik i encje liczbowe', () => {
    expect(tekstZAllegro('&quot;A&quot;&zwnj;&#211;&#xF3;')).toBe('"A"‌Óó');
  });

  it('rozwija JEDNYM przebiegiem — „&amp;lt;" zostaje tekstem „&lt;", nie znacznikiem', () => {
    expect(tekstZAllegro('&amp;lt;b&amp;gt;')).toBe('&lt;b&gt;');
  });

  it('nieznaną encję i gołe „&" zostawia bez zmian', () => {
    expect(tekstZAllegro('A & B &nieznana; &#0;')).toBe('A & B &nieznana; &#0;');
  });

  it('null zostaje null', () => {
    expect(tekstZAllegro(null)).toBeNull();
    expect(tekstZAllegro(undefined)).toBeNull();
  });
});
