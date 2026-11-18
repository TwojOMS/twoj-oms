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
// Oprócz trzech dosłownych zwrotów — reguła ogólniejsza: pora dnia i dni tygodnia, „księgowa”,
// „co tydzień”, „w weekend”. Zmierzone na tych 5 plikach (bez komentarzy): zero trafień na prawdziwych zdaniach.
// Samego „ręcznie” NIE dodajemy: stoi w uczciwych zdaniach („Sprawdź RĘCZNIE w inFakcie…”, „załóż go tam raz, ręcznie”).
const ZWYCZAJ = new RegExp(
  [
    'wieczorem',
    'właściciel ręcznie',
    'właściciel włączył',
    // „księgowa” i „rano” całymi słowami: rdzeń trafiał „zaksięgowano”, „dokument księgowy”, „wybrano”, „pobrano”.
    '(?<!\\p{L})księgow(?:a|ą|ej)(?!\\p{L})',
    '(?<!\\p{L})rano(?!\\p{L})',
    'poniedział',
    'sobot',
    'niedziel',
    // Pozostałe dni całymi formami z granicą liter: samo „wtor” trafia „wtorzona”/„wtórny”, a `\b` w trybie `u`
    // nie działa po „ę” („w środę”).
    '(?<!\\p{L})(?:wtor(?:ek|ki?|ku)|czwart(?:ek|ki?|ku)|piąt(?:ek|ki?|ku)|środ[aęy])(?!\\p{L})',
    'nocą',
    'w weekend',
    'co tydzień',
  ].join('|'),
  'iu',
);

const bezKomentarzy = (tekst) =>
  tekst
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

// „Test na test”: reguła łapie zwyczaje innymi słowami, a nie rusza uczciwych zdań o ręcznym sprawdzeniu.
describe('reguła zwyczajów jednej firmy', () => {
  it.each([
    'skasuj ją tam (wysyła ją księgowa w piątki)',
    'Wysyłką zajmujemy się w poniedziałek rano.',
    'Do KSeF idzie co tydzień, w weekend.',
    'Księgowość zamyka miesiąc (wysyłamy w piątek).',
    'Faktury idą we wtorek i w czwartek.',
    'Wysyłka do KSeF w środę.',
  ])('łapie: %s', (zdanie) => {
    expect(ZWYCZAJ.test(zdanie)).toBe(true);
  });

  it.each([
    'Sprawdź RĘCZNIE w inFakcie, czy faktura za ten okres istnieje.',
    'W inFakcie nie ma klienta o NIP 5250000009 — załóż go tam raz, ręcznie, i ponów wystawienie.',
    'Jeśli jeszcze nie poszła do KSeF, skasuj ją w inFakcie; jeśli już poszła, wystaw KOREKTĘ.',
    'Faktura została utworzona wtórnie; wtorzona kopia nie idzie do KSeF.',
    'Nic nie wybrano.',
    'Zaksięgowano 10 zł',
    'Pobrano dokument księgowy.',
  ])('nie rusza: %s', (zdanie) => {
    expect(ZWYCZAJ.test(zdanie)).toBe(false);
  });
});
