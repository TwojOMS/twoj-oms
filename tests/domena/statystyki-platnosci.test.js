import { describe, it, expect } from 'vitest';
import { rozkladMetod } from '../../src/domena/statystyki-platnosci.js';

const z = (metoda, sklep = 'szkicownia') => ({ metoda_platnosci: metoda, sklep });

describe('rozkladMetod', () => {
  // ⚠️ Na produkcji baza trzyma „BLIK" (15×) i „Blik" (28×) jako dwa różne napisy.
  // Bez słownika ekran pokazałby dwa wiersze i żaden nie odpowiadałby na pytanie o BLIK.
  it('skleja BLIK i Blik w jeden kubełek', () => {
    const { pozycje } = rozkladMetod([z('BLIK'), z('Blik'), z('blik')]);
    expect(pozycje).toEqual([{ etykieta: 'BLIK', ile: 3, udzial: 100 }]);
  });

  it('trzy warianty przelewu to jeden kubełek, a Przelewy24 osobny', () => {
    const { pozycje } = rozkladMetod([
      z('Przelew'), z('Przelew tradycyjny'), z('Przelew bankowy'), z('Przelewy24'),
    ]);
    const mapa = Object.fromEntries(pozycje.map((p) => [p.etykieta, p.ile]));
    expect(mapa).toEqual({ Przelew: 3, Przelewy24: 1 });
  });

  it('nieznana bramka przechodzi pod własną nazwą, nie do kubełka „inne"', () => {
    const { pozycje } = rozkladMetod([z('Revolut Pay')]);
    expect(pozycje).toEqual([{ etykieta: 'Revolut Pay', ile: 1, udzial: 100 }]);
  });

  it('pusta metoda dostaje jawny kubełek', () => {
    const { pozycje } = rozkladMetod([z(null)]);
    expect(pozycje).toEqual([{ etykieta: 'Nieokreślona', ile: 1, udzial: 100 }]);
  });

  // ⚠️⚠️ SEDNO TEJ SEKCJI. Allegro oddaje wyłącznie `payment.type` (ONLINE /
  // CASH_ON_DELIVERY) — nie mówi, czym kupujący zapłacił. Na produkcji to 92 z 226 zamówień.
  it('zamówienia Allegro stoją POZA procentami, z własnym licznikiem', () => {
    const w = rozkladMetod([
      z('BLIK'), z('Przelew'),
      z('Allegro (płatność online)', 'allegro_szkicownia'),
      z('Za pobraniem', 'allegro_amarka'),
    ]);
    expect(w.wszystkie).toBe(4);
    expect(w.mianownik).toBe(2);
    expect(w.allegroBezInformacji).toBe(2);
    expect(w.pozycje.map((p) => p.etykieta).sort()).toEqual(['BLIK', 'Przelew']);
    expect(w.pozycje.every((p) => p.udzial === 50)).toBe(true);
  });

  // ⚠️ Kanał rozstrzyga KOLUMNA `sklep`, nie treść metody — metoda jest edytowalna z karty.
  it('kanał poznaje się po sklepie, nie po napisie metody', () => {
    const w = rozkladMetod([z('Allegro (płatność online)', 'szkicownia')]);
    expect(w.allegroBezInformacji).toBe(0);
    expect(w.mianownik).toBe(1);
  });

  // Decyzja zapisana w spec §3.5: wyrzucenie zamówień ręcznych podniosłoby udział BLIK-u
  // z 36% na 52%, czyli zmieniłoby ODPOWIEDŹ, nie tylko mianownik.
  it('zamówienia ręczne zostają w rozkładzie', () => {
    const w = rozkladMetod([z('BLIK'), z('Przelew', 'reczne')]);
    expect(w.mianownik).toBe(2);
    expect(w.pozycje.find((p) => p.etykieta === 'Przelew').ile).toBe(1);
  });

  it('same zamówienia Allegro dają null w udziałach, nie dzielenie przez zero', () => {
    const w = rozkladMetod([z('Allegro (płatność online)', 'allegro_szkicownia')]);
    expect(w.mianownik).toBe(0);
    expect(w.pozycje).toEqual([]);
    expect(w.allegroBezInformacji).toBe(1);
  });

  // Sortowanie stabilne: bez drugiego kryterium kolejność dwóch metod o tej samej liczbie
  // skacze między odświeżeniami i ekran wygląda, jakby dane się zmieniały (ta sama zasada,
  // co przy `rozkladUslug`).
  it('przy równej liczbie sortuje alfabetycznie po polsku', () => {
    const { pozycje } = rozkladMetod([z('Gotówka'), z('BLIK')]);
    expect(pozycje.map((p) => p.etykieta)).toEqual(['BLIK', 'Gotówka']);
  });

  it('pusta lista nie wybucha', () => {
    expect(rozkladMetod([]))
      .toEqual({ pozycje: [], mianownik: 0, allegroBezInformacji: 0, wszystkie: 0 });
  });
});
