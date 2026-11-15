import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const klasyPrzycisku = new Set([
  'btn', 'oms-menu-toggle', 'oms-theme-button', 'oms-podmenu-przycisk',
  'logowanie-wyslij', 'ust-przelacznik', 'ust-uchwyt', 'm-filter', 'poza-okiem',
]);
const kontenery = new Set(['szukajka', 'wydruki-menu', 'menu-uzytkownika-panel']);
const pusteTagi = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));

function widoki(katalog) {
  return readdirSync(katalog, { withFileTypes: true }).flatMap(wpis => {
    const plik = join(katalog, wpis.name);
    return wpis.isDirectory() ? widoki(plik) : plik.endsWith('.ejs') ? [plik] : [];
  }).sort();
}

function naruszenia(zrodlo, plik) {
  // Statyczny stos tagów sprawdza rzeczywiste zagnieżdżenie kontenera w tym samym
  // pliku, nie samą obecność jego klasy. Nie wykonujemy warunków ani include EJS.
  // Maskowanie EJS i komentarzy zachowuje pozycje (plik:linia) oraz usuwa ich „>”.
  // Dla wyjść EJS zachowujemy wspólne tokeny wszystkich literałów (np. klas
  // obu ramion ternary) i każdą literówkę btn-. Nie wykonujemy kodu szablonu.
  const html = zrodlo.replace(/<%[\s\S]*?%>|<!--[\s\S]*?-->/g, tekst => {
    const litery = tekst.startsWith('<%=') || tekst.startsWith('<%-')
      ? [...tekst.matchAll(/'([^']*)'|"([^"]*)"/g)].map(([, a, b]) => (a ?? b).split(/\s+/)) : [];
    const tokeny = litery.length ? [...new Set(litery.flat().filter(klasa =>
      /^btn-(?!-)/.test(klasa) || litery.every(lista => lista.includes(klasa))))].join(' ') : '';
    let indeks = 0;
    return tekst.replace(/[^\n]/g, () => tokeny[indeks++] ?? ' ');
  });
  const stos = [];
  const bledy = [];
  for (const tag of html.matchAll(/<(\/?)(([a-z][\w-]*))\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi)) {
    const [, zamkniecie, nazwaSurowa, , atrybuty] = tag;
    const nazwa = nazwaSurowa.toLowerCase();
    if (zamkniecie) {
      const indeks = stos.findLastIndex(element => element.nazwa === nazwa);
      if (indeks >= 0) stos.length = indeks;
      continue;
    }
    const pola = new Map([...atrybuty.matchAll(/([^\s=/'"]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)]
      .map(([, klucz, podwojne, pojedyncze, bezCudzyslowu]) => [klucz.toLowerCase(), podwojne ?? pojedyncze ?? bezCudzyslowu ?? '']));
    const klasy = (pola.get('class') ?? '').split(/\s+/).filter(Boolean);
    if (nazwa === 'button') {
      const literowki = klasy.filter(klasa => /^btn-(?!-)/.test(klasa));
      const ostylowany = klasy.some(klasa => klasyPrzycisku.has(klasa)) || pola.has('hidden')
        || stos.some(element => element.klasy.some(klasa => kontenery.has(klasa)));
      if (!ostylowany || literowki.length) {
        const koniec = html.indexOf('</button', tag.index + tag[0].length);
        const tekst = html.slice(tag.index + tag[0].length, koniec < 0 ? tag.index + tag[0].length : koniec)
          .replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
        const linia = zrodlo.slice(0, tag.index).split('\n').length;
        bledy.push(`${plik}:${linia}: ${tekst || '(bez tekstu)'} — ${literowki.length ? `niedozwolona klasa ${literowki.join(', ')}` : 'brak stylu OMS'}`);
      }
    }
    if (!pusteTagi.has(nazwa) && !/\/\s*$/.test(atrybuty)) stos.push({ nazwa, klasy });
  }
  return bledy;
}

describe('PRZ-160 P3a.03 — styl przycisków', () => {
  it('każdy przycisk w src/**/*.ejs ma styl OMS i poprawne modyfikatory', () => {
    const bledy = widoki('src').flatMap(plik => naruszenia(readFileSync(plik, 'utf8'), plik));
    expect(bledy, bledy.join('\n')).toEqual([]);
  });
  it('rozpoznaje kontener tylko w jego wnętrzu oraz sam atrybut hidden', () => {
    expect(naruszenia('<button class="<%= problem ? \'btn btn--glowny\' : \'btn\' %>">Test</button>', 'proba.ejs')).toEqual([]);
    expect(naruszenia('<form class="szukajka"><div><button>Szukaj</button></div></form><button hidden>Ukryty</button>', 'proba.ejs')).toEqual([]);
    expect(naruszenia('<div class="wydruki-menu"></div>\n<button data-hidden="true">Obcy</button>', 'proba.ejs'))
      .toEqual(['proba.ejs:2: Obcy — brak stylu OMS']);
    expect(naruszenia('<button hidden class="btn btn-maly">Ukryty</button>', 'proba.ejs'))
      .toEqual(['proba.ejs:1: Ukryty — niedozwolona klasa btn-maly']);
  });
});
