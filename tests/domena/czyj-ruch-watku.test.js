// tests/oms/czyj-ruch-watku.test.js
import { describe, it, expect } from 'vitest';
import { czyjRuch } from '../../src/domena/czyj-ruch-watku.js';

const wiersz = (odKupujacego) => ({ ostatnia_od_kupujacego: odKupujacego ? 1 : 0 });
const dowod = (rodzaj, wyslany) => ({ rodzaj, wyslany_at: wyslany ? '2026-08-28T20:00:00Z' : null });

describe('czyj ruch w watku Allegro', () => {
  it('ostatnia od kupujacego, zero odpowiedzi = czeka na ciebie', () => {
    expect(czyjRuch(wiersz(true), [])).toBe('czeka');
  });

  it('ostatnia nasza, napisana przez czlowieka = zalatwione', () => {
    expect(czyjRuch(wiersz(false), [dowod('reczna', true)])).toBe('zalatwione');
  });

  it('ostatnia nasza, ale to byla formulka = poszla formulka, nie zalatwione', () => {
    expect(czyjRuch(wiersz(false), [dowod('formulka', true)])).toBe('formulka');
  });

  it('po formulce czlowiek odpisal = zalatwione', () => {
    expect(czyjRuch(wiersz(false), [dowod('formulka', true), dowod('reczna', true)])).toBe('zalatwione');
  });

  it('kupujacy napisal PO naszej odpowiedzi = znowu czeka na ciebie', () => {
    expect(czyjRuch(wiersz(true), [dowod('reczna', true)])).toBe('czeka');
  });

  it('dowod ZAPISANY, ale niewyslany, nie liczy sie jako nasza odpowiedz', () => {
    // ⚠️ Wpis powstaje PRZED strzalem do Allegro. Gdyby liczyl sie od razu, watek po
    // nieudanej wysylce wygladalby na obsluzony — czyli cisza u kupujacego bez lampki.
    expect(czyjRuch(wiersz(false), [dowod('formulka', false)])).toBe('zalatwione');
  });

  it('odpowiedz wyslana spoza panelu (z Allegro) tez daje zalatwione', () => {
    // Wlasciciel odpisal w aplikacji Allegro — nie mamy dowodu, ale ostatnia nie jest kupujacego.
    expect(czyjRuch(wiersz(false), [])).toBe('zalatwione');
  });
});
