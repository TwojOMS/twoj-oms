import { expect, it } from 'vitest';
import { odnosnikPozycji } from '../../src/domena/link-pozycji.js';

it('zachowuje adres i tytuł dla obu wzorców', () => {
  const pozycja = { ofertaId: '1000001', produktId: 1000001 };
  const opcje = { baseUrl: 'https://sklep.polcien.example' };
  expect(odnosnikPozycji({ sklep: 'allegro_polcien' }, pozycja, opcje)).toEqual({
    adres: 'https://allegro.pl/oferta/1000001', tytul: 'Otwórz ofertę na Allegro',
  });
  expect(odnosnikPozycji({ sklep: 'polcien_test' }, pozycja, opcje)).toEqual({
    adres: 'https://sklep.polcien.example/?post_type=product&p=1000001', tytul: 'Otwórz produkt w sklepie',
  });
});
