import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const czytaj = sciezka => readFileSync(new URL(`../../../${sciezka}`, import.meta.url), 'utf8');

describe('PRZ-160 P2.05c: reszta napisów „Klienci B2B”, pole B2B, linki', () => {
  it('menu i moduł mają etykietę „Klienci B2B”', () => {
    const modul = czytaj('src/moduly/wiadomosci/modul.ts');
    expect(modul).toContain("etykieta: 'Klienci B2B'");
    expect(modul).not.toContain('Stali klienci');
    expect(czytaj('src/domena/ekrany.js')).not.toContain("etykieta: 'Stali klienci'");
  });

  it('komunikat faktury okresu odsyła na ekran „Klienci B2B”', () => {
    const src = czytaj('src/moduly/faktury/services/faktura-okresu.js');
    expect(src).toContain('na ekranie Klienci B2B');
    expect(src).not.toContain('Stali klienci');
  });

  it('etykiety rabatu i wyboru klienta mówią „klienta B2B”', () => {
    for (const plik of ['zamowienie.ejs', 'nowe-zamowienie.ejs']) {
      const widok = czytaj(`src/moduly/zamowienia/widoki/${plik}`);
      expect(widok).toContain('Rabat klienta B2B (%)');
      expect(widok).not.toContain('Rabat stałego klienta</span>');
      expect(widok).not.toContain('Rabat stałego klienta (%)');
    }
    const nowe = czytaj('src/moduly/zamowienia/widoki/nowe-zamowienie.ejs');
    expect(nowe).toContain('>Klient B2B\n');
    expect(nowe).not.toContain('>Stały klient');
  });

  it('pole B2B ma jeden napis na obu ekranach', () => {
    for (const plik of ['zamowienie.ejs', 'nowe-zamowienie.ejs']) {
      const widok = czytaj(`src/moduly/zamowienia/widoki/${plik}`);
      expect(widok).toContain('Liczony w raportach jako kanał B2B (hurt)');
      expect(widok).not.toContain('sprzedaż hurtowa (osobny kanał');
    }
  });

  it('linki do klienta: karta z historią i adres bez przekierowania', () => {
    expect(czytaj('src/moduly/zamowienia/widoki/zamowienie.ejs')).toContain('href="/klienci/<%= klientZBazy.id %>/karta"');
    expect(czytaj('src/moduly/wiadomosci/trasy/klienci.js')).toContain('href: `/klienci/${edytowany.id}/karta`');
    expect(czytaj('src/moduly/wiadomosci/widoki/klient.ejs')).toContain('href="/klienci/<%= klient.id %>">Edytuj');
    expect(czytaj('src/moduly/wiadomosci/widoki/klient.ejs')).not.toContain('/edytuj#formularz');
    expect(czytaj('src/moduly/wiadomosci/widoki/_naglowek-opis-klient.ejs')).not.toContain('/edytuj#formularz');
  });

  it('„Koszt dostawy”: dopisek tylko w etykiecie, bez aria-describedby', () => {
    const widok = czytaj('src/moduly/wiadomosci/widoki/klienci.ejs');
    expect(widok).not.toContain('aria-describedby="opis-kosztu"');
    expect(widok).toContain('id="opis-kosztu"');
  });
});
