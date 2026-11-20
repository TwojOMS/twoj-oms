import { describe, it, expect } from 'vitest';
import * as nawigacja from '../../../src/domena/podmenu-ustawien.js';

const model = (url, o = { admin: true }) => nawigacja.modelNawigacjiUstawien?.(url, o);
describe('działy Ustawień', () => {
  it('pokazuje dokładnie 11 działów i zakładki wyłącznie bieżącego działu', () => {
    const m = model('/ustawienia/firma');
    expect(m?.dzialy.map((d) => d.etykieta)).toEqual([
      'Firma',
      'Integracje',
      'Zamówienia',
      'Wysyłka i druk',
      'Faktury i podatki',
      'Komunikacja',
      'Powiadomienia',
      'Automatyzacje',
      'Zespół i dostęp',
      'Kopie zapasowe',
      'System',
    ]);
    expect(m.zakladki.map((z) => z.etykieta)).toEqual(['Dane i logo', 'Dane rejestrowe', 'Rachunek bankowy']);
    expect(m.aktywnyDzial).toBe('firma');
  });
  it.each([
    ['/ustawienia/integracje/program-fakturowy', 'faktury', 'program'],
    ['/ustawienia/integracje/program-fakturowy/serie', 'faktury', 'numeracja'],
    ['/ustawienia/integracje/program-fakturowy/ksef/konsumenckie', 'faktury', 'ksef'],
    ['/ustawienia/integracje/program-fakturowy/dla-kazdego', 'faktury', 'zasady'],
    ['/ustawienia/firma/zwolnienie-vat', 'faktury', 'vat'],
    ['/ustawienia/integracje/ksef', 'integracje', 'polaczenia'],
    ['/ustawienia/integracje/dpd', 'integracje', 'polaczenia'],
    ['/ustawienia/integracje/infakt/ksef-automat', 'automatyzacje', 'systemowe'],
    ['/ustawienia/paczka', 'wysylka', 'paczki'],
    ['/ustawienia/dostawa', 'wysylka', 'dostawa'],
    ['/ustawienia/integracje/poczta/podpis', 'komunikacja', 'podpis'],
    ['/ustawienia/firma/rachunek', 'firma', 'rachunek'],
  ])('mapuje GET i adres odpowiedzi POST 400 %s', (url, dzial, zakladka) => {
    expect(model(`${url}?zapisano=1`)).toMatchObject({ aktywnyDzial: dzial, aktywnaZakladka: zakladka });
    expect(model(url).dzialy.filter((d) => d.aktywna)).toHaveLength(1);
  });
  it('nie udostępnia administracyjnych zakładek kontu bez praw administratora', () => {
    expect(model('/ustawienia/konta', { admin: false }).dzialy.some((d) => d.klucz === 'zespol')).toBe(false);
    expect(model('/ustawienia/konta', { podgladDemo: true }).dzialy.some((d) => d.klucz === 'zespol')).toBe(true);
  });
  it('dane demo pojawiają się tylko przy istniejącej trasie', () => {
    expect(model('/ustawienia/moduly').zakladki.some((z) => z.klucz === 'demo')).toBe(false);
    expect(model('/ustawienia/moduly', { admin: true, daneDemo: true }).zakladki.some((z) => z.klucz === 'demo')).toBe(
      true,
    );
  });
});

// Menu Ustawień ma podmenu — aktywny dział rozwija swoje podstrony w lewym menu
// (np. Wysyłka i druk → Szablony paczek, Koszty dostawy, Etykiety i druk). Poziome zakładki na razie zostają.
describe('podmenu działów Ustawień', () => {
  it('aktywny dział niesie podstrony z bieżącą zaznaczoną, pozostałe działy — bez podstron', () => {
    const m = model('/ustawienia/wysylka/dostawa');
    const wysylka = m.dzialy.find((d) => d.klucz === 'wysylka');
    expect(wysylka.podstrony.map((p) => [p.etykieta, p.href, p.biezaca])).toEqual([
      ['Szablony paczek', '/ustawienia/zamowienia-i-wysylka', null],
      ['Koszty dostawy', '/ustawienia/wysylka/dostawa', 'page'],
      ['Etykiety i druk', '/ustawienia/druk', null],
    ]);
    expect(m.dzialy.filter((d) => d.klucz !== 'wysylka').every((d) => !d.podstrony)).toBe(true);
  });

  it('alias (formularz pod innym adresem) zaznacza swoją podstronę jako „true”, nie „page”', () => {
    const wysylka = model('/ustawienia/paczka').dzialy.find((d) => d.klucz === 'wysylka');
    expect(wysylka.podstrony.filter((p) => p.biezaca).map((p) => [p.etykieta, p.biezaca])).toEqual([
      ['Szablony paczek', 'true'],
    ]);
  });

  it('podstrony respektują prawa: bez administratora zespół i klucze API nie wychodzą', () => {
    const system = model('/ustawienia/lacznosc', { admin: false }).dzialy.find((d) => d.klucz === 'system');
    expect(system.podstrony ?? []).toEqual([]);
  });

  it('menu Ustawień rysuje podmenu aktywnego działu pod jego pozycją', async () => {
    const { createRequire } = await import('node:module');
    const ejs = createRequire(import.meta.url)('ejs');
    const szablon = new URL('../../../src/core/web/widoki/_menu-ustawien.ejs', import.meta.url);
    const html = await ejs.renderFile(decodeURIComponent(szablon.pathname.replace(/^\/([A-Za-z]:)/, '$1')), {
      pozycje: model('/ustawienia/druk').dzialy,
    });
    const wysylka = html.slice(html.indexOf('>Wysyłka i druk<'));
    const lista = wysylka.match(/<ul class="oms-podmenu-lista"[\s\S]*?<\/ul>/)?.[0] ?? '';
    expect([...lista.matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual([
      '/ustawienia/zamowienia-i-wysylka',
      '/ustawienia/wysylka/dostawa',
      '/ustawienia/druk',
    ]);
    expect(lista).toContain('href="/ustawienia/druk" aria-current="page"');
    expect((html.match(/oms-podmenu-lista/g) ?? []).length).toBe(1);
  });
});
