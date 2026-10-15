import { describe, it, expect } from 'vitest';
import { listaProduktowZbiorcza } from '../../src/domena/lista-produktow.js';

// Zbiorcza „Lista produktów" (PRZ-084): jedna kartka do kompletowania kilku zaznaczonych
// zamowien. Scalanie po SKU, bez SKU po DOKLADNEJ nazwie; przy kazdym wierszu numery
// zamowien z krotnoscia, zeby po skompletowaniu dalo sie rozdzielic towar.

const zam = (numer, pozycje) => ({ numer, pozycje });
const p = (nazwa, sku, ilosc, cena = '24.90') => ({ nazwa, sku, ilosc, cena_brutto: cena });

describe('listaProduktowZbiorcza', () => {
  it('scala ten sam SKU z roznych zamowien i sumuje sztuki', () => {
    const l = listaProduktowZbiorcza([
      zam('A1', [p('Gingerbread - Craft', 'GB-1', 2)]),
      zam('B2', [p('Gingerbread – Craft (Allegro)', 'GB-1', 1)]),
    ]);
    expect(l.wiersze).toHaveLength(1);
    expect(l.wiersze[0]).toMatchObject({ ilosc: 3, sku: 'GB-1', nazwa: 'Gingerbread - Craft' });
    expect(l.wiersze[0].zamowienia).toEqual([{ numer: 'A1', ilosc: 2 }, { numer: 'B2', ilosc: 1 }]);
  });

  it('bez SKU scala po dokladnej nazwie, a rozne nazwy zostawia osobno', () => {
    const l = listaProduktowZbiorcza([
      zam('A1', [p('Łuki 80cm', null, 1), p('Choinka 3', null, 1)]),
      zam('B2', [p('Łuki 80cm', '', 2), p('Łuki 80 cm', null, 1)]),
    ]);
    const luki = l.wiersze.find((w) => w.nazwa === 'Łuki 80cm');
    expect(luki.ilosc).toBe(3);
    expect(l.wiersze.map((w) => w.nazwa)).toContain('Łuki 80 cm');
    expect(l.razemPozycji).toBe(3);
    expect(l.razemSztuk).toBe(5);
  });

  it('nazwa bez SKU nie wpada do wiersza produktu, ktorego SKU brzmi tak samo', () => {
    const l = listaProduktowZbiorcza([zam('A1', [p('X-1', null, 1), p('Inny produkt', 'X-1', 1)])]);
    expect(l.wiersze).toHaveLength(2);
  });

  it('dwie linie tego samego produktu w jednym zamowieniu to jeden wpis numeru', () => {
    const l = listaProduktowZbiorcza([zam('A1', [p('Sparkle', 'SP', 1), p('Sparkle', 'SP', 2)])]);
    expect(l.wiersze[0].zamowienia).toEqual([{ numer: 'A1', ilosc: 3 }]);
  });

  it('pomija wysylke przebrana za pozycje i SKU zaslepki traktuje jak brak SKU', () => {
    const l = listaProduktowZbiorcza([zam('A1', [
      p('Kurier DPD (darmowa wysyłka)', null, 1, '0.00'),
      p('Wysyłka kurierem DPD', 'psm-zam-placeholder', 1, '19.00'),
      p('Szablon Żółw', 'psm-zam-placeholder', 1),
    ])]);
    expect(l.wiersze.map((w) => w.nazwa)).toEqual(['Szablon Żółw']);
    expect(l.wiersze[0].sku).toBeNull();
  });

  it('sortuje po nazwie w polskim porzadku i zachowuje kolejnosc numerow', () => {
    const l = listaProduktowZbiorcza([
      zam('Z9', [p('Żaba', null, 1), p('Ćma', null, 1)]),
      zam('A1', [p('Ala', null, 1)]),
    ]);
    expect(l.wiersze.map((w) => w.nazwa)).toEqual(['Ala', 'Ćma', 'Żaba']);
    expect(l.numery).toEqual(['Z9', 'A1']);
  });

  it('wiersz nie niesie zadnej kwoty', () => {
    const l = listaProduktowZbiorcza([zam('A1', [p('Sparkle', 'SP', 1, '123.45')])]);
    expect(JSON.stringify(l)).not.toContain('123.45');
  });
});
