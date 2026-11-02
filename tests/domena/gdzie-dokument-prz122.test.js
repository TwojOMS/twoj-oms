import { describe, expect, it } from 'vitest';
import { gdzieDokument } from '../../src/domena/nazwa-programu.js';
import { parsujNumerKorekty } from '../../src/domena/zwrot.js';
import { zdanieWstrzymanej } from '../../src/domena/ostrzezenia.js';
import { sprawyKarty } from '../../src/domena/sprawy-karty.js';
import { readFileSync } from 'node:fs';
import ejs from 'ejs';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { createPaczkaDlaBiura } from '../../src/moduly/koszty/services/paczka-dla-biura.js';

const nazwa = { mianownik: 'Program Test', miejscownik: 'Programie Test', dopelniacz: 'Programu Test' };
const zewnetrzny = { opis: { nazwa } };
const wbudowany = { opis: { nazwa, wbudowany: true } };

describe('miejsce dokumentu PRZ-122', () => {
  it.each([[zewnetrzny, 'w Programie Test'], [wbudowany, 'w zakładce FAKTURY OMS-u']])('wybiera miejsce', (program, miejsce) => {
    expect(gdzieDokument(program)).toBe(miejsce);
  });
  it.each([[zewnetrzny, 'w Programie Test'], [wbudowany, 'w zakładce FAKTURY OMS-u']])('wskazuje miejsce poprawienia numeru korekty', (program, miejsce) => {
    const blad = parsujNumerKorekty({ korekta_numer: 'KOR 1' }, 'KOR 2', { nazwa, gdzie: gdzieDokument(program) }).blad;
    expect(blad).toContain(`Jeśli pierwszy numer jest błędny, popraw go ${miejsce} i zgłoś to.`);
  });
  it.each([[zewnetrzny, 'w Programie Test'], [wbudowany, 'w zakładce FAKTURY OMS-u']])('wskazuje miejsce poprawienia wstrzymanej faktury', (program, miejsce) => {
    expect(zdanieWstrzymanej({ numer: 'FV 1' }, nazwa, gdzieDokument(program))).toContain(`Następny krok: popraw ${miejsce} i wyślij ręcznie albo zwolnij.`);
  });
  it.each([[zewnetrzny, 'w Programie Test'], [wbudowany, 'w zakładce FAKTURY OMS-u']])('wskazuje miejsce faktury do wyjaśnienia i odrzuconego pliku', (program, miejsce) => {
    const z = { przesylki: [], faktura: { ksef_status: 'do_wyjasnienia', allegro_weryfikacja: 'REJECTED' } };
    const sprawy = sprawyKarty(z, Date.now(), { nazwa, gdzie: gdzieDokument(program) });
    expect(sprawy.find((s) => s.klucz === 'faktura').tekst).toContain(`Sprawdź ${miejsce}, czy dokument powstał.`);
    expect(sprawy.find((s) => s.klucz === 'faktura-allegro').tekst).toContain(`Sprawdź dokument ${miejsce} i wyślij go jeszcze raz`);
  });
  it.each([[zewnetrzny, 'w Programie Test'], [wbudowany, 'w zakładce FAKTURY OMS-u']])('wskazuje dokument oczekujący na KSeF', (program, miejsce) => {
    const z = { przesylki: [], chce_fakture: 1, sklep: 'sklep', faktura: { numer: 'FV 1', infakt_uuid: 'u1', ksef_odczyt: 'ok', ksef_zlecona_at: '2026-08-05T10:05:00Z' } };
    const sprawa = sprawyKarty(z, Date.parse('2026-08-07T12:00:00Z'), { nazwa, gdzie: gdzieDokument(program) }).find((s) => s.klucz === 'ksef');
    expect(sprawa.tekst).toContain(`Sprawdź ten dokument ${miejsce}:`);
  });
  it.each([[zewnetrzny, 'w Programie Test'], [wbudowany, 'w zakładce FAKTURY OMS-u']])('wskazuje miejsce duplikatu w paczce', async (program, miejsce) => {
    const dokument = { uuid: 'u1', id: 1, number: 'FV 1', kind: 'vat', invoice_date: '2026-08-05', sale_date: '2026-08-05', net_price: 10000, tax_price: 2300, gross_price: 12300, currency: 'PLN' };
    const atrapa = { ...program, listaFaktur: async () => [dokument, { ...dokument, number: 'FV 2' }], listaKorekt: async () => [] };
    const db = openOmsDb(':memory:');
    try {
      const paczka = createPaczkaDlaBiura({ db, program: atrapa, teraz: () => new Date('2026-09-02T10:00:00Z') });
      await expect(paczka.zbuduj('2026-08', 'sprzedaz')).rejects.toThrow(`sprawdź ${miejsce}.`);
    } finally { db.close(); }
  });
  const widoki = [
    ['zamowienia/widoki/zamowienie.ejs', 'wystawiony dokument popraw KOREKTĄ'],
    ['zamowienia/widoki/zamowienie.ejs', 'Sprawdź RĘCZNIE'],
    ['zamowienia/widoki/zamowienie.ejs', 'Najpierw sprawdź'],
    ['zwroty/widoki/zwrot.ejs', 'Sprawdź sam'],
    ['zwroty/widoki/zwrot.ejs', 'zlecenie zostało odrzucone. Sprawdź'],
  ];
  it.each(widoki)('renderuje wskazanie w %s: %s', (plik, fragment) => {
    const linia = readFileSync(`src/moduly/${plik}`, 'utf8').split('\n').find((l) => l.includes(fragment));
    for (const program of [zewnetrzny, wbudowany]) {
      expect(ejs.render(linia, { nazwaProgramu: nazwa, gdzieProgramu: gdzieDokument(program) })).toContain(gdzieDokument(program));
    }
    expect(ejs.render(linia, { nazwaProgramu: nazwa })).toContain('w Programie Test');
  });
});
