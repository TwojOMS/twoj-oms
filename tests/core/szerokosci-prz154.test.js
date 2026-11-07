import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function pliki(katalog) {
  return readdirSync(katalog, { withFileTypes: true }).flatMap(wpis => {
    const sciezka = join(katalog, wpis.name);
    return wpis.isDirectory() ? pliki(sciezka) : [sciezka];
  });
}

function naruszenia(plik, css) {
  // Zachowanie nowych linii pozwala podać rzeczywiste położenie naruszenia.
  const bezKomentarzy = css.replace(/\/\*[\s\S]*?\*\//g, komentarz => komentarz.replace(/[^\n]/g, ' '));
  const wynik = [];
  for (const dopasowanie of bezKomentarzy.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selektory = dopasowanie[1].trim().split(',').map(s => s.trim());
    const deklaracje = new Map();
    for (const deklaracja of dopasowanie[2].split(';')) {
      const para = deklaracja.match(/^\s*([\w-]+)\s*:\s*([^;]+?)\s*$/);
      if (para) deklaracje.set(para[1].toLowerCase(), para[2].replace(/\s*!important\s*$/i, '').trim().toLowerCase());
    }
    const wartosci = (nazwa) => (deklaracje.get(nazwa) ?? '').split(/\s+/);
    const margin = wartosci('margin');
    const inline = wartosci('margin-inline');
    const auto = wartosc => wartosc === 'auto';
    const wycentrowany = (margin.length === 1 && auto(margin[0])) ||
      (margin.length >= 2 && auto(margin[1]) && (margin.length < 4 || auto(margin[3]))) ||
      (auto(inline[0]) && (inline.length === 1 || auto(inline[1]))) ||
      (auto(deklaracje.get('margin-left')) && auto(deklaracje.get('margin-right')));
    for (const selektor of selektory) {
      const linia = bezKomentarzy.slice(0, dopasowanie.index + dopasowanie[1].search(/\S/)).split('\n').length;
      const opis = `${plik}:${linia} ${selektor}`;
      if (wycentrowany) wynik.push(`${opis} — margines auto`);
      if (deklaracje.has('max-width') && /\.kolumna-glowna(?:\b|(?=[.#:[\s>]))[^,{}]*>/.test(selektor)) {
        wynik.push(`${opis} — max-width dziecka kolumny`);
      }
    }
  }
  return wynik;
}

describe('PRZ-154 E3.4 — szerokości treści', () => {
  it('wykrywa centrowanie i limit bezpośredniego dziecka, pomijając komentarze', () => {
    const css = `/* .komentarz { margin: 0 auto; } */
      .a { margin: 1px auto 2px; }
      .b { margin-right: auto; margin-left: auto; }
      .c { margin-inline: auto; }
      .kolumna-glowna > .cos { max-width: 900px; }
      .szer-karta > :not(style) { max-width: 1222px; }
      .d { margin: 0 auto 0 0; }`;
    expect(naruszenia('przyklad.css', css)).toHaveLength(4);
  });

  it('pilnuje arkuszy OMS i stylów widoków', () => {
    // Layout ładuje oms-design i oms-ustawienia; widoki dołączają dwa pozostałe arkusze.
    const arkusze = pliki('src/public').filter(p => /^src\/public\/[^/]+\.css$/.test(p));
    const widoki = pliki('src').filter(p => /\/widoki\/[^/]+\.ejs$/.test(p));
    const bledy = [];
    for (const plik of [...arkusze, ...widoki]) {
      const tekst = readFileSync(plik, 'utf8');
      if (plik.endsWith('.css')) bledy.push(...naruszenia(plik, tekst));
      else {
        for (const styl of tekst.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
          const poczatek = tekst.slice(0, styl.index + styl[0].indexOf('>') + 1).replace(/[^\n]/g, ' ');
          bledy.push(...naruszenia(plik, poczatek + styl[1]));
        }
      }
    }
    expect(bledy).toEqual([]);
  });
});
