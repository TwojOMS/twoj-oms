import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

// Teksty o wysyłce do KSeF widzi obcy sprzedawca: nie mogą opisywać zwyczajów jednej firmy
// („właściciel ręcznie, wieczorem”). Migawka ekranów faktur wycina sekcję faktury, więc pilnuje
// tego ten test — na tekście plików, z pominięciem komentarzy (te porządkuje osobny etap).
const PLIKI = [
  'src/moduly/faktury/widoki/okres.ejs',
  'src/moduly/faktury/widoki/faktury.ejs',
  'src/moduly/zamowienia/widoki/zamowienie.ejs',
  'src/moduly/faktury/services/faktura-okresu.js',
  'src/moduly/faktury/db/faktury.js',
];
const ZWYCZAJ = /wieczorem|właściciel ręcznie|właściciel włączył/;

const bezKomentarzy = (tekst) => tekst
  .replace(/<%#[\s\S]*?%>/g, '')
  .split('\n')
  .filter((w) => !/^\s*(\/\/|\*|\/\*)/.test(w))
  .join('\n');

describe('teksty KSeF bez zwyczajów jednej firmy', () => {
  it.each(PLIKI)('%s', (plik) => {
    const tekst = bezKomentarzy(fs.readFileSync(new URL(`../../${plik}`, import.meta.url), 'utf8'));
    expect(tekst.length).toBeGreaterThan(1000);
    const trafienia = tekst.split('\n').filter((w) => ZWYCZAJ.test(w));
    expect(trafienia).toEqual([]);
  });
});
