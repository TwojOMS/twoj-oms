import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import ejs from 'ejs';

const widok = (nazwa) => readFileSync(`src/moduly/wysylka/widoki/${nazwa}.ejs`, 'utf8').replace(/<%#.*?%>/gs, '');
const kontrolki = (html) => html.match(/<(?:input|select|textarea)\b(?:[^">]|"[^"]*")*>/g) ?? [];
const nazwy = (html) => [...html.matchAll(/\bname="([^"]+)"/g)].map((m) => m[1]);

// Pełna lista (także ukryte pola i powtórzenia w gałęziach) z HTML szablonów przy 85ed5070.
const przedZmiana = {
  nadaj: ['powrot', 'kolejnosc', 'delivery_method_id_allegro', 'kurier', 'punkt_odbioru', 'nazwa', 'company', 'ulica', 'kod', 'miasto', 'phone', 'email', 'kraj', 'ulica', 'kod', 'miasto', 'pobranie_na_tej_paczce', 'kwota_pobrania', 'potwierdz_niedoplate', 'kwota_pobrania', 'potwierdz_niedoplate', 'waga', 'gabaryt', 'waga', 'gabaryt', 'waga', 'dlugosc', 'szerokosc', 'wysokosc', 'zatwierdzenie', 'zatwierdzenie'],
  'nadaj-kurier': [],
  'masowe-nadaj': ['id', 'usluga_<%= w.id %>', 'szablon_<%= w.id %>', 'gabaryt_<%= w.id %>', 'gabaryt_<%= w.id %>', 'waga_<%= w.id %>', 'powrot', 'zatwierdzenie', 'zatwierdzenie'],
};

describe('PRZ-152.G14a — pola formularzy nadania', () => {
  for (const [nazwa, lista] of Object.entries(przedZmiana)) {
    it(`${nazwa}: zachowuje wszystkie name= sprzed zmiany`, () => {
      expect(nazwy(widok(nazwa))).toEqual(lista);
    });
    it(`${nazwa}: każda edytowalna kontrolka we wszystkich gałęziach ma klasę OMS`, () => {
      for (const tag of kontrolki(widok(nazwa))) {
        if (/type="(?:hidden|checkbox|radio)"/.test(tag)) continue;
        expect(tag, tag).toMatch(/class="[^"]*\boms-pole\b[^"]*"/);
      }
    });
  }
  it('cztery wymiary należą do jednego równego rzędu', () => {
    const rzad = widok('nadaj').match(/<div class="rzad nadanie-wymiary">([\s\S]*?)<\/div>/)?.[1];
    expect(rzad).toBeDefined();
    expect(nazwy(rzad ?? '')).toEqual(['waga', 'dlugosc', 'szerokosc', 'wysokosc']);
  });
  it('nadanie hurtem zachowuje dotychczasowe napisy i jednostkę wagi', async () => {
    const html = await ejs.renderFile('src/moduly/wysylka/widoki/masowe-nadaj.ejs', {
      powrot: '/', paczka: null, sumaPobran: null, nadawanieDziala: true,
      uwagi: [], pominiete: [], etykietaStatusu: () => 'Wysłane',
      szablony: { szablony: [{ id: 'mala', nazwa: 'Mała', waga: 1, dlugosc: 20, szerokosc: 10, wysokosc: 5 }] },
      wiersze: ['szablon', 'gabaryt', 'automat'].map((pole, i) => ({
        id: i + 1, numer: `TEST-${i + 1}`, produkty: [], droga: 'Testowa',
        pobranie: null, deliveryMethodId: null,
        rozmiar: { pole, szablon: 'mala', waga: 1, gabaryt: pole === 'gabaryt' ? 'A' : 'S', gabaryty: ['S', 'M', 'L'] },
      })),
    });
    const pola = kontrolki(html).filter((tag) => !/type="hidden"/.test(tag));
    expect(pola).toHaveLength(4);
    for (const tag of pola) expect(tag).toContain('class="oms-pole"');
    const widoczne = html.replace(/<[^>]*>/g, '');
    expect(widoczne).not.toMatch(/(?:Szablon paczki|Gabaryt paczkomatu|Gabaryt automatu|Waga \(kg\)) zamówienia/);
    expect(html).toMatch(/<input\b[^>]*name="waga_3"[^>]*> kg/);
    expect(nazwy(html)).toEqual(['id', 'szablon_1', 'id', 'gabaryt_2', 'id', 'gabaryt_3', 'waga_3', 'powrot', 'zatwierdzenie', 'zatwierdzenie']);
  });
  it('siatka wymiarów ma cztery kolumny, a na telefonie dwie', () => {
    const css = readFileSync('src/public/oms-design.css', 'utf8');
    expect(css).toMatch(/\.nadanie-formularz \.nadanie-wymiary\s*\{[^}]*display:\s*grid\s*;/);
    expect(css).toMatch(/\.nadanie-formularz \.nadanie-wymiary\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
    expect(css).toMatch(/@media\s*\(max-width:\s*40rem\)\s*\{\s*\.nadanie-formularz \.nadanie-wymiary\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  });
  it('zachowuje bazowy styl OMS oraz wyróżnienie kodu paczkomatu i kwoty', () => {
    const css = readFileSync('src/public/oms-design.css', 'utf8');
    expect(css).toMatch(/\.nadanie-formularz \.oms-pole\s*\{[^}]*box-sizing:\s*border-box;/);
    for (const klasa of ['paczkomat-cialo', 'pole-kwoty']) {
      const regula = css.match(new RegExp(`\\.nadanie-formularz \\.${klasa} \\.oms-pole\\s*(?:,[^{]*)?\\{([^}]*)\\}`))?.[1];
      expect(regula).toBeDefined();
      expect(regula).toMatch(/font-size:\s*1\.15rem\s*;/);
      expect(regula).toMatch(/font-weight:\s*700\s*;/);
    }
    expect(css).toMatch(/\.nadanie-formularz \.pole-kwoty \.oms-pole\s*\{[^}]*width:\s*8rem\s*;/);
  });
  it('waga poza siatką wymiarów ma naturalną szerokość', () => {
    const css = readFileSync('src/public/oms-design.css', 'utf8');
    expect(css).toMatch(/\.nadanie-formularz \.rzad:not\(\.nadanie-wymiary\) > label:has\(> input\[name="waga"\]\)\s*\{[^}]*flex:\s*0 1 auto\s*;/);
    expect(css).toMatch(/\.nadanie-formularz \.rzad:not\(\.nadanie-wymiary\) input\[name="waga"\]\.oms-pole\s*\{[^}]*width:\s*auto\s*;/);
  });
  it('kontrolki w tabeli hurtu mają naturalną szerokość, a formularz hurtu klasę nadania', () => {
    const css = readFileSync('src/public/oms-design.css', 'utf8');
    expect(css).toMatch(/\.nadanie-formularz \.nadanie-hurtem \.oms-pole\s*\{[^}]*width:\s*auto\s*;/);
    expect(readFileSync('src/moduly/wysylka/widoki/masowe-nadaj.ejs', 'utf8')).toMatch(/<form[^>]*action="\/zamowienia\/masowe\/nadaj"[^>]*class="nadanie-formularz"/);
  });
  it('szablon w tabeli ma miejsce na pełną nazwę', () => {
    const css = readFileSync('src/public/oms-design.css', 'utf8');
    const regula = css.match(/\.nadanie-formularz \.nadanie-hurtem select\[name\^="szablon_"\]\.oms-pole\s*\{([^}]*)\}/)?.[1];
    expect(regula).toMatch(/width:\s*auto\s*;/);
    expect(regula).toMatch(/max-width:\s*none\s*;/);
  });
});
