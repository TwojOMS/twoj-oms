import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { trescOfertyAllegro } from '../../src/domena/tresc-oferty-allegro.js';
import { ofertaAllegroPelna, ofertyAllegro } from '../../scripts/demo-dane-katalog.mjs';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/allegro/oferta-lampa.json', import.meta.url), 'utf8'));
const oferta = images => ({ ...structuredClone(fixture), aiCoCreatedContent: { images } });

it.each([
  [[], 0],
  [['https://zdjecia.przyklad.invalid/ai.jpg'], 1],
  [undefined, 0], [null, 0], ['adres', 0], [{ length: 1 }, 0],
])('AI sprzedawcy tylko z niepustej tablicy images (%j → %i)', (images, wynik) => {
  const o = oferta(images);
  expect(o.productSet[0].product.isAiCoCreated).toBe(true);
  expect(trescOfertyAllegro(o, null).daneKanalu.ai_wspoltworzone).toBe(wynik);
  o.productSet[0].product.isAiCoCreated = false;
  expect(trescOfertyAllegro(o, null).daneKanalu.ai_wspoltworzone).toBe(wynik);
});

it('brak aiCoCreatedContent oznacza 0', () => {
  const o = oferta([]);
  delete o.aiCoCreatedContent;
  expect(trescOfertyAllegro(o, null).daneKanalu.ai_wspoltworzone).toBe(0);
});

it('demo i atrapa mają flagę Katalogu AI, ale karta nie ma deklaracji AI', () => {
  const o = ofertaAllegroPelna('allegro', ofertyAllegro('allegro')[0].id);
  expect(o.productSet[0].product.isAiCoCreated).toBe(true);
  expect(o.aiCoCreatedContent).toEqual({ images: [] });
  expect(trescOfertyAllegro(o, null).daneKanalu.ai_wspoltworzone).toBe(0);
});

// E2.12a: decyzja ręczna jest przy zdjęciu; testy importu i ochrony w zdjecia-ai-prz160e2.
it('adresy AI dla zdjęć obsługują napisy i obiekty, bez flagi Katalogu', () => {
  const o = oferta(['https://polcien.example.invalid/1.jpg', { url: 'https://polcien.example.invalid/2.jpg' }]);
  expect(trescOfertyAllegro(o, null).zdjeciaAi).toEqual(['https://polcien.example.invalid/1.jpg', 'https://polcien.example.invalid/2.jpg']);
  delete o.aiCoCreatedContent;
  expect(trescOfertyAllegro(o, null).zdjeciaAi).toEqual([]);
});
