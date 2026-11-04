import { expect, it } from 'vitest';
import ejs from 'ejs';
import { fileURLToPath } from 'node:url';
import { MODUL_WOO } from '../../../src/domena/modul-woo.ts';
import { MODUL_ALLEGRO } from '../../../src/domena/modul-allegro.ts';
import { zakresDatyStartu } from '../../../src/moduly/kanaly/zakres-importu-allegro.ts';

const widok = nazwa => fileURLToPath(new URL(`../../../src/core/web/konfigurator/${nazwa}.ejs`, import.meta.url));

it('sekret nie trafia do HTML, także przez przykład i domyślną wartość', async () => {
  const krok = MODUL_WOO.konfigurator.kroki.find(k => k.id === 'klucze');
  expect(krok).toBeDefined();
  const html = await ejs.renderFile(widok('krok-konfiguratora'), {
    krok: { ...krok, formularz: { ...krok.formularz, pola: krok.formularz.pola.map(p => ({ ...p, przyklad: 'cs_test_polcien', domyslna: 'cs_test_polcien' })) } },
    akcja: '/ustawienia/integracje/woocommerce/polcien/klucze',
    wartosci: { ck: 'ck_test_polcien', cs: 'cs_test_polcien' }, formularzId: 'csrf-test', wersja: 3,
  });
  expect(html).not.toContain('ck_test_polcien');
  expect(html).not.toContain('cs_test_polcien');
  expect(html.match(/autocomplete="off"/g)).toHaveLength(2);
  expect(html.match(/zapisane/g)).toHaveLength(2);
  expect(html).toContain('name="formularzId" value="csrf-test"');
  expect(html).toContain('name="wersja" value="3"');
  expect(html.match(/<li>/g)).toHaveLength(4);
  expect(html.match(/<input[^>]*type="password"[^>]*>/g).every(p => !/value=|placeholder=|data-/.test(p))).toBe(true);
});

it('bieżący krok listy jest pogrubiony, zrobione opisane słownie', async () => {
  const { stanKrokow } = await import('../../../src/core/web/konfigurator/konfigurator.ts');
  const html = await ejs.renderFile(widok('kroki-konfiguratora'), {
    kroki: stanKrokow(MODUL_ALLEGRO.konfigurator, { biezacy: 'nazwa', zrobione: ['aplikacja'] }),
  });
  expect(html).toMatch(/<strong>1\. Nazwa i zakres zamówień<\/strong>/);
  expect(html).toContain('zrobione');
  expect(html).toContain('aria-current="step"');
});

it('pole daty obu kanałów ma granice dnia warszawskiego przekazane do widoku', async () => {
  for (const modul of [MODUL_WOO, MODUL_ALLEGRO]) {
    for (const krok of modul.konfigurator.kroki.filter(k => k.formularz?.pola.some(p => p.rodzaj === 'data'))) {
      const html = await ejs.renderFile(widok('krok-konfiguratora'), {
        krok, akcja: '/test', wartosci: {}, formularzId: 'test', wersja: 0,
        zakresDatyStartu: zakresDatyStartu(new Date('2026-11-03T23:30:00Z')),
      });
      const input = html.match(/<input[^>]*type="date"[^>]*>/)?.[0];
      expect(input).toContain('min="2025-11-04"');
      expect(input).toContain('max="2026-11-04"');
      expect(html.match(/\bbtn--glowny\b/g)).toHaveLength(1);
      expect(html).toMatch(/<button class="btn btn--glowny" type="submit">/);
    }
  }
});

it('instrukcja zostaje listą numerowaną w karcie, akapity korzystają z odstępów karty', async () => {
  const krok = MODUL_WOO.konfigurator.kroki.find(k => k.id === 'klucze');
  const html = await ejs.renderFile(widok('krok-konfiguratora'), {
    krok, akcja: '/test', wartosci: {}, formularzId: 'test', wersja: 0,
  });
  expect(html).toContain('<section class="ust-sekcja">');
  expect(html.match(/<li><p>/g)).toHaveLength(krok.instrukcja.length);
  expect(html).toContain('</p></li></ol>');
  expect(html.match(/\bbtn--glowny\b/g)).toHaveLength(1);
});

it('trasy przekazują zakres z własnego zegara aż do HTML Allegro i Woo', async () => {
  const { default: Fastify } = await import('fastify');
  const { registerTrasyWoo } = await import('../../../src/moduly/kanaly/trasy-woo.ts');
  const { registerTrasyAllegro } = await import('../../../src/moduly/kanaly/trasy-allegro.ts');
  const teraz = () => new Date('2026-11-03T23:30:00Z');
  const mapowanie = { instancje: { '1': { metoda: 'dpd' } }, bramkiPobrania: [] };
  const k = { klucz: 'polcien', nazwa: 'Sklep Półcień', zrodlo: 'panel', wersja: 0,
    generacjaImportu: 0, autoryzacja: 'brak', pobieranie: 'wylaczone' };
  const db = { prepare: () => ({ get: () => ({ adres: 'https://example.test',
    sprawdzono_at: '2026-11-03', ustawienia_json: JSON.stringify({ mapowanie }) }) }) };
  for (const typ of ['woo', 'allegro']) {
    const app = Fastify();
    app.decorateRequest('konto', null);
    app.addHook('preHandler', async req => { req.konto = { login: 'admin', admin: true }; });
    app.decorateReply('view', async function(nazwa, dane) {
      expect(dane.zakresDatyStartu).toEqual({ min: '2025-11-04', max: '2026-11-04' });
      const plik = fileURLToPath(new URL(`../../../src/moduly/kanaly/widoki/${nazwa}`, import.meta.url));
      return this.type('text/html').send(await ejs.renderFile(plik, dane));
    });
    try {
      if (typ === 'woo') {
        registerTrasyWoo(app, { db, repozytorium: { listaTypu: () => [k] },
          sklepyWoo: { metodyWysylki: async () => ({ ok: true, dane: { metody: [], mapowanie } }),
            blokadaUsuniecia: () => null }, envSklepy: [], teraz, tryb: 'proba' });
      } else {
        registerTrasyAllegro(app, { repozytoriumKanalow: { lista: () => [] },
          aplikacjaAllegro: { stanAplikacji: () => ({ device: null, dcrGotowe: false }) } }, teraz);
      }
      const r = await app.inject({ url: typ === 'woo'
        ? '/ustawienia/integracje/woocommerce/polcien' : '/ustawienia/integracje/allegro/nowe' });
      expect(r.statusCode, r.body).toBe(200);
      const input = r.body.match(/<input[^>]*type="date"[^>]*>/)?.[0];
      expect(input).toContain('min="2025-11-04"');
      expect(input).toContain('max="2026-11-04"');
      const krok = typ === 'woo' ? r.body.slice(r.body.indexOf('<h2>4.'), r.body.indexOf('<h2>Zarządzanie')) : r.body;
      expect(krok.match(/\bbtn--glowny\b/g)).toHaveLength(1);
    } finally {
      await app.close();
    }
  }
});
