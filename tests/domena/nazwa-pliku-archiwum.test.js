import { describe, it, expect } from 'vitest';
import {
  MIESIACE_KATALOGOW, doNazwyPliku, doDnia, sciezkaArchiwumSprzedazy,
} from '../../src/domena/nazwa-pliku-archiwum.js';

describe('nazwa pliku w archiwum sprzedazy', () => {
  it('trzyma konwencje istniejacych plikow: <rok>/<Miesiac>/RRRR-MM-DD_<numer z / na ->.pdf', () => {
    expect(sciezkaArchiwumSprzedazy({ invoiceDate: '2026-08-03', numer: '12/08/2026' }))
      .toBe('2026/Sierpien/2026-08-03_12-08-2026.pdf');
  });

  it('korekta idzie do tego samego folderu, KOR zostaje w nazwie', () => {
    expect(sciezkaArchiwumSprzedazy({ invoiceDate: '2026-02-02', numer: '1/KOR/02/2026' }))
      .toBe('2026/Luty/2026-02-02_1-KOR-02-2026.pdf');
  });

  it('miesiace bez polskich znakow, 12 sztuk', () => {
    expect(MIESIACE_KATALOGOW).toHaveLength(12);
    expect(MIESIACE_KATALOGOW[3]).toBe('Kwiecien');
    expect(MIESIACE_KATALOGOW[9]).toBe('Pazdziernik');
    expect(MIESIACE_KATALOGOW.join('')).not.toMatch(/[ąćęłńóśźż]/i);
  });

  it('data ze znacznikiem czasu skraca sie do dnia (dwukropek jest nielegalny na SMB)', () => {
    expect(doDnia('2026-06-30T22:30:00Z')).toBe('2026-06-30');
    expect(sciezkaArchiwumSprzedazy({ invoiceDate: '2026-06-30T22:30:00Z', numer: '1/06/2026' })).not.toContain(':');
  });

  it('znaki nielegalne w nazwie pliku zamieniaja sie na myslnik, kropki i przecinki znikaja', () => {
    expect(doNazwyPliku('Allegro sp. z o.o.')).toBe('Allegro sp z oo');
    expect(doNazwyPliku('a\\b:c*d?e"f<g>h|i')).toBe('a-b-c-d-e-f-g-h-i');
  });

  it('numer bez tresci nie daje pustej nazwy', () => {
    expect(sciezkaArchiwumSprzedazy({ invoiceDate: '2026-08-03', numer: '' }))
      .toBe('2026/Sierpien/2026-08-03_bez-numeru.pdf');
  });
});
