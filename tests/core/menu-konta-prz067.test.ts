// PRZ-067: ustawienia (zębatka), motyw i konto wracają do górnego paska; boczne menu ich nie niesie.
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { MODULY } from '../../src/moduly/lista.ts';
import { nawigacjaDla } from '../../src/domena/menu-stron.js';
import { menuKontaDla } from '../../src/domena/menu-konta.js';
import { adresZasobu } from '../../src/core/web/wersja-zasobow.js';

const ejs = createRequire(import.meta.url)('ejs') as { renderFile:(path:string,data:Record<string,unknown>)=>Promise<string> };
const szablon = fileURLToPath(new URL('../../src/core/web/widoki/layout-oms.ejs', import.meta.url));
const menu = MODULY.flatMap(m => m.menu).toSorted((a,b) => a.kolejnosc-b.kolejnosc);

const WSZYSTKIE = ['zamowienia','przesylki','faktury','ustawienia'];
const konto = (o:Record<string,unknown>) => ({imie:'Jan Kowalski',login:'jan',rola:'niestandardowa',admin:false,uprawnienia:new Set(WSZYSTKIE),...o});
async function render(k:Record<string,unknown>) {
  const html = await ejs.renderFile(szablon,{title:'Test',motyw:'jasny',htmx:false,bezPaska:false,body:'<p>x</p>',marka:{logoAlt:'F'},
    nawigacja:nawigacjaDla({sciezka:'/przesylki',konto:k,menu,odlozoneEkrany:['kampania','cele','finanse']}),
    menuKonta:menuKontaDla(k,{powrot:'/przesylki'}),modyfikatorStatusu:()=>null,
    // PRZ-100: serwer daje `zasob` każdemu widokowi (defaultContext) — render układu wprost dostaje to samo.
    zasob:adresZasobu(fileURLToPath(new URL('../../src/public', import.meta.url)))});
  return {
    header: html.match(/<header class="oms-topbar">[\s\S]*?<\/header>/)?.[0] ?? '',
    aside: html.match(/<aside class="oms-sidebar">[\s\S]*?<\/aside>/)?.[0] ?? '',
  };
}

describe('PRZ-067 górny pasek: ustawienia, motyw, konto', () => {
  it('zębatka w pasku prowadzi do /ustawienia i ma etykietę „Ustawienia”', async () => {
    const { header } = await render(konto({}));
    const a = header.match(/<a [^>]*href="\/ustawienia"[^>]*>/)?.[0] ?? '';
    expect(a).toContain('aria-label="Ustawienia"');
    expect(a).toContain('title="Ustawienia"');
    expect(header).toMatch(/<a [^>]*href="\/ustawienia"[^>]*>\s*<svg/);
  });
  it('kolejność od lewej: zębatka, motyw, konto', async () => {
    const { header } = await render(konto({}));
    const i = [header.indexOf('href="/ustawienia"'), header.indexOf('action="/motyw"'), header.indexOf('class="menu-uzytkownika"')];
    expect(i.every(n => n > 0)).toBe(true);
    expect([...i].sort((a,b)=>a-b)).toEqual(i);
  });
  it('bez uprawnienia do ustawień nie ma zębatki', async () => {
    const { header, aside } = await render(konto({uprawnienia:new Set(['przesylki'])}));
    expect(header).not.toContain('href="/ustawienia"');
    expect(aside).not.toContain('href="/ustawienia"');
  });
  it('okienko konta niesie imię, rolę i Wyloguj, bez „Zmień motyw”', async () => {
    const { header } = await render(konto({}));
    const okienko = header.match(/<details class="menu-uzytkownika"[\s\S]*?<\/details>/)?.[0] ?? '';
    expect(okienko).toContain('Jan Kowalski');
    expect(okienko).toContain('menu-uzytkownika-rola');
    expect(okienko).toContain('Wyloguj');
    expect(okienko).toContain('action="/wyloguj"');
    expect(okienko).not.toContain('Zmień motyw');
    expect(okienko).not.toContain('action="/motyw"');
    expect(header.match(/action="\/motyw"/g)).toHaveLength(1);
  });
  it('„Użytkownicy i uprawnienia” tylko dla administratora', async () => {
    const admin = await render(konto({admin:true,rola:'administrator'}));
    expect(admin.header).toContain('Użytkownicy i uprawnienia');
    const zwykly = await render(konto({}));
    expect(zwykly.header).not.toContain('Użytkownicy i uprawnienia');
  });
  it('boczne menu nie ma ustawień ani bloku konta', async () => {
    const { aside } = await render(konto({admin:true,rola:'administrator'}));
    expect(aside).not.toContain('href="/ustawienia"');
    expect(aside).not.toContain('oms-account');
    expect(aside).not.toContain('menu-uzytkownika');
    expect(aside).not.toContain('Wyloguj');
  });
});
