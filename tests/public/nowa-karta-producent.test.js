import { describe, it, expect } from 'vitest';
import { podepnij, stanProducenta } from '../../src/public/nowa-karta-producent.js';

// Pole „Producent” w formularzu „Nowy produkt” odświeża się po wyborze marki bez przeładowania.
// Repo nie ma biblioteki DOM — skrypt dostaje atrapy elementów z tym, czego używa.

const DANE = { marki: { 'Lampa Półcień': 'Pracownia Półcień' }, domyslny: 'Zakład Przykładowy' };

describe('stanProducenta', () => {
  it('marka z producentem → producent z marki', () => {
    expect(stanProducenta('Lampa Półcień', DANE)).toEqual({
      tekst: 'Producent: Pracownia Półcień (z marki Lampa Półcień)',
      link: false,
    });
  });
  it('marka bez przypisania (także nowa) → producent domyślny', () => {
    for (const marka of ['Świeca Cienista', 'Mgła Poranna'])
      expect(stanProducenta(marka, DANE)).toEqual({
        tekst: 'Producent: Zakład Przykładowy (producent domyślny)',
        link: false,
      });
  });
  it('marka bez przypisania i bez domyślnego → komunikat z linkiem', () => {
    expect(stanProducenta('Świeca Cienista', { ...DANE, domyslny: null })).toEqual({
      tekst: 'Marka bez producenta — ',
      link: true,
    });
  });
  it('brak marki → podpowiedź', () => {
    expect(stanProducenta('', DANE)).toEqual({ tekst: 'Wybierz markę — producent wynika z marki.', link: false });
  });
  it('nazwa marki z „Object.prototype” nie udaje przypisania', () => {
    expect(stanProducenta('constructor', { marki: {}, domyslny: null }).link).toBe(true);
  });
});

function strona({ dane = DANE, surowe, marka = '', nowa = '', serwer = [] } = {}) {
  const obsluga = {};
  const pole = (value) => ({
    value,
    addEventListener: (typ, fn) => {
      (obsluga[typ] ??= []).push(fn);
    },
  });
  const wybor = pole(marka);
  const wpis = pole(nowa);
  const wyjscie = {
    dataset: { producenci: surowe ?? JSON.stringify(dane) },
    dzieci: serwer,
    zmiany: 0,
    replaceChildren(...dzieci) {
      this.zmiany++;
      this.dzieci = dzieci;
    },
    get textContent() {
      return this.dzieci.map((d) => (typeof d === 'string' ? d : d.textContent)).join('');
    },
    get tekst() {
      return this.dzieci.map((d) => (typeof d === 'string' ? d : `[${d.textContent}→${d.href}]`)).join('');
    },
  };
  const dokument = {
    getElementById: (id) => (id === 'nowa-producent' ? wyjscie : null),
    querySelector: (s) => ({ 'select[name="marka"]': wybor, 'input[name="marka_nowa"]': wpis })[s] ?? null,
    createElement: (tag) => ({ tag, textContent: '', href: '', target: '', rel: '' }),
  };
  podepnij(dokument);
  const zmien = (el, wartosc, typ) => {
    el.value = wartosc;
    for (const fn of obsluga[typ] ?? []) fn({ target: el });
  };
  return { wybor, wpis, wyjscie, zmien };
}

describe('nowa-karta-producent — odświeżanie na żywo', () => {
  it('wybór marki z listy pokazuje producenta z marki, potem domyślnego', () => {
    const s = strona();
    expect(s.wyjscie.tekst).toBe('Wybierz markę — producent wynika z marki.');
    s.zmien(s.wybor, 'Lampa Półcień', 'change');
    expect(s.wyjscie.tekst).toBe('Producent: Pracownia Półcień (z marki Lampa Półcień)');
    s.zmien(s.wybor, 'Świeca Cienista', 'change');
    expect(s.wyjscie.tekst).toBe('Producent: Zakład Przykładowy (producent domyślny)');
  });

  it('wpisana nowa marka wygrywa z wyborem; wyczyszczona oddaje głos wyborowi', () => {
    const s = strona({ marka: 'Lampa Półcień' });
    s.zmien(s.wpis, '  Mgła Poranna ', 'input');
    expect(s.wyjscie.tekst).toBe('Producent: Zakład Przykładowy (producent domyślny)');
    s.zmien(s.wpis, '   ', 'input');
    expect(s.wyjscie.tekst).toBe('Producent: Pracownia Półcień (z marki Lampa Półcień)');
  });

  it('bez domyślnego pokazuje link do producentów w nowej karcie', () => {
    const s = strona({ dane: { ...DANE, domyslny: null }, nowa: 'Mgła Poranna' });
    expect(s.wyjscie.tekst).toBe('Marka bez producenta — [przypisz w Magazyn → Producenci→/magazyn/producenci]');
    const link = s.wyjscie.dzieci[1];
    expect([link.target, link.rel]).toEqual(['_blank', 'noopener']);
  });

  it('kolejne litery nowej marki nie odświeżają pola, gdy tekst się nie zmienia (bez powtórnych ogłoszeń)', () => {
    const s = strona();
    s.zmien(s.wpis, 'M', 'input');
    const po = s.wyjscie.zmiany;
    s.zmien(s.wpis, 'Mg', 'input');
    s.zmien(s.wpis, 'Mgł', 'input');
    expect(s.wyjscie.zmiany).toBe(po);
  });

  it('stan wyrenderowany przez serwer nie jest podmieniany przy wczytaniu (bez ogłoszenia na starcie)', () => {
    const s = strona({ marka: 'Lampa Półcień', serwer: ['Producent: Pracownia Półcień (z marki Lampa Półcień)'] });
    expect(s.wyjscie.zmiany).toBe(0);
    s.zmien(s.wybor, '', 'change');
    expect(s.wyjscie.tekst).toBe('Wybierz markę — producent wynika z marki.');
  });

  it('uszkodzone dane nie psują formularza — marka bez mapy to brak producenta', () => {
    const s = strona({ surowe: '{', marka: 'Lampa Półcień' });
    expect(s.wyjscie.tekst).toBe('Marka bez producenta — [przypisz w Magazyn → Producenci→/magazyn/producenci]');
  });
});
