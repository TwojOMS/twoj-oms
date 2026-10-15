import { describe, it, expect } from 'vitest';
import { odroczenieMs, SUFIT_ODROCZENIA_MS } from '../../src/domena/kolejka-druku-stan.js';

// Czuwacz (deploy/drukarka/czuwacz-etykiet.ps1) odpytuje panel co 5 sekund. Bez odroczenia
// pozycja, ktorej nie da sie wydrukowac, wracalaby do kolejki NATYCHMIAST i byla probowana
// w kolko co 5 s, dopisujac wpis do logu za kazdym razem — w tej infrastrukturze pelny dysk
// juz raz polozyl usluge (AdGuard).
describe('odroczenieMs', () => {
  it('rośnie WYKŁADNICZO z kolejną próbą', () => {
    const a = odroczenieMs(1);
    const b = odroczenieMs(2);
    const c = odroczenieMs(3);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    // Podwojenie, nie liniowy przyrost.
    expect(b).toBe(a * 2);
    expect(c).toBe(a * 4);
  });

  it('pierwsza próba daje odroczenie WIĘKSZE OD ZERA — pozycja nie wraca natychmiast', () => {
    expect(odroczenieMs(1)).toBeGreaterThan(0);
  });

  // TWARDY sufit 15 minut: awaria przemijająca (zgaszony komputer, otwarta głowica) ma się
  // sama naprawić, gdy sprzęt wróci — panelowi nie wolno poddać się na stałe.
  it('ma twardy sufit 15 minut, niezależnie od liczby prób', () => {
    expect(SUFIT_ODROCZENIA_MS).toBe(15 * 60 * 1000);
    expect(odroczenieMs(50)).toBe(SUFIT_ODROCZENIA_MS);
    expect(odroczenieMs(1000)).toBe(SUFIT_ODROCZENIA_MS);
  });

  it('w końcu dociera do sufitu przy rozsądnej liczbie prób (nie po tysiącach)', () => {
    let proby = 1;
    while (odroczenieMs(proby) < SUFIT_ODROCZENIA_MS && proby < 100) proby += 1;
    expect(odroczenieMs(proby)).toBe(SUFIT_ODROCZENIA_MS);
    expect(proby).toBeLessThan(20);
  });

  it('żadna wartość nigdy nie przekracza sufitu', () => {
    for (let p = 1; p <= 30; p += 1) {
      expect(odroczenieMs(p)).toBeLessThanOrEqual(SUFIT_ODROCZENIA_MS);
    }
  });
});
