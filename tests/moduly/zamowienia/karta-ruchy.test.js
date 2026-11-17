import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import ejs from 'ejs';

const widok = readFileSync('src/moduly/zamowienia/widoki/zamowienie.ejs', 'utf8');
const start = widok.indexOf('    <table class="tab-pozycje', widok.indexOf('<h2>Płatności</h2>'));
const szablon = widok.slice(start, widok.indexOf('</table>', start) + 8);
function tabela(ruchy) {
  return ejs.render(szablon, { ruchyPlatnosci: ruchy, stan: { stan: 'oplacone' }, z: { id: 1 }, powrot: '/',
    wart: v => v || '—', zlotowki: v => v, zl: v => v / 100, mozeAdres: () => true, adresPodwidoku: () => '/zwrot' });
}
const sklep = { kiedy: '4.11 13:10', znak: '+', kwotaGr: 5000, opis: 'Wpłata · Allegro (płatność online) · ze sklepu', zrodlo: 'sklep' };

it('Data i Kwota mają klasę tabeli wymuszającą jeden wiersz', () => {
  expect(tabela([sklep])).toContain('class="tab-pozycje tab-ruchy"');
  expect(widok).toMatch(/\.tab-ruchy\s+:is\(th, td\):nth-child\(-n\+2\)\s*\{\s*white-space:\s*nowrap;/u);
});
it('bez akcji nie rezerwuje czwartej kolumny; akcje ręcznej wpłaty i zwrotu zostają', () => {
  expect(tabela([sklep])).not.toContain('kol-akcje');
  expect(tabela([])).toContain('colspan="3"');
  expect(tabela([{ ...sklep, zrodlo: 'reczna', id: 2 }])).toContain('>Usuń</button>');
  expect(tabela([{ ...sklep, rodzaj: 'zwrot' }])).toContain('szczegóły zwrotu');
});
