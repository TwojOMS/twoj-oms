import { describe, it, expect } from 'vitest';
import { wykonajWejscie, wykonajZegary, wykonajJednaFabrykeTokenow, OCZEKIWANE_ZEGARY } from '../../pomoc/odbior-bootstrap-030.ts';

describe('rzeczywisty src/oms.js → main.ts → MODULY', () => {
  it('uruchamia HTTP całego zachowanego produktu przy zablokowanej sieci wychodzącej', async () => {
    expect(await wykonajWejscie()).toEqual([
      ['/ustawienia/zamowienia-i-wysylka', 200, 'Paczki i koszty dostawy'],
      ['/faktury', 200, 'Faktury'], ['/magazyn', 200, 'Magazyn'], ['/raporty', 200, 'Raporty'], ['/wiadomosci', 200, 'Wiadomości'],
    ]);
  }, 30000);
  it('uruchamia dokładny zbiór rzeczywistych interwałów i usuwa je przy zamknięciu', async () => {
    const wynik = await wykonajZegary();
    expect(wynik.nazwy).toEqual([...OCZEKIWANE_ZEGARY].sort());
    expect(wynik.liczba).toBe(10);
  });
  it.each(['czuwaczOstrzezen', 'czuwaczKosztow', 'czuwaczArchiwumSprzedazy'])('rzeczywisty zegar %s woła tę samą instancję usługi', async nazwa => {
    await wykonajZegary(nazwa);
  });
  it('tworzy tokeny kanału dokładnie raz dla klienta i widoków', async () => {
    expect(await wykonajJednaFabrykeTokenow()).toBe(1);
  });
});
