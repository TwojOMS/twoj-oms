import { describe, it, expect } from 'vitest';
import { postepCelu } from '../../src/domena/postep-celu.js';

const TERAZ = '2026-09-13T10:00:00Z';

describe('postepCelu — stan ZNANY', () => {
  it('licznik ze swiezym zrodlem', () => {
    const w = postepCelu({
      celIle: 5,
      pomiar: { ile: 3, zrodloAt: '2026-09-13T09:00:00Z' },
      progSwiezosciH: 36,
      teraz: TERAZ,
    });
    expect(w.stan).toBe('znany');
    expect(w.ile).toBe(3);
    expect(w.procent).toBe(60);
  });

  it('miernik bez starzenia sie (reczny) jest znany nawet ze starym zrodlem', () => {
    // `zrodloAt` recznego to dzien ostatniego wpisu. Stary wpis NIE znaczy zepsutego
    // zrodla — znaczy, ze dawno nikt nie klikal. To informacja, nie awaria.
    const w = postepCelu({
      celIle: 5, pomiar: { ile: 1, zrodloAt: '2026-08-01' }, progSwiezosciH: null, teraz: TERAZ,
    });
    expect(w.stan).toBe('znany');
  });

  it('procent jest PRZYCIETY do 100 — pasek nie wychodzi poza kafel', () => {
    const w = postepCelu({
      celIle: 5, pomiar: { ile: 9, zrodloAt: null }, progSwiezosciH: null, teraz: TERAZ,
    });
    expect(w.ile).toBe(9); // liczba zostaje prawdziwa — nadwykonanie to dobra wiadomosc
    expect(w.procent).toBe(100); // przyciety jest WYLACZNIE pasek
  });

  it('zero zdarzen przy zrodle, ktore odpowiedzialo, to UCZCIWE zero', () => {
    const w = postepCelu({
      celIle: 5, pomiar: { ile: 0, zrodloAt: null }, progSwiezosciH: null, teraz: TERAZ,
    });
    expect(w.stan).toBe('znany');
    expect(w.ile).toBe(0);
    expect(w.procent).toBe(0);
  });
});

describe('postepCelu — stan NIESWIEZY', () => {
  it('zrodlo starsze niz prog', () => {
    const w = postepCelu({
      celIle: 5,
      pomiar: { ile: 3, zrodloAt: '2026-09-10T09:00:00Z' },
      progSwiezosciH: 36,
      teraz: TERAZ,
    });
    expect(w.stan).toBe('nieswiezy');
    expect(w.ile).toBe(3); // liczbe dalej pokazujemy — z zastrzezeniem
    expect(w.zrodloAt).toBe('2026-09-10T09:00:00Z');
  });

  it('dokladnie na progu jeszcze swieze', () => {
    // Prog to granica, po ktorej przestajemy ufac, a nie moment, w ktorym przestajemy.
    const w = postepCelu({
      celIle: 5,
      pomiar: { ile: 3, zrodloAt: '2026-09-11T22:00:00Z' },
      progSwiezosciH: 36,
      teraz: TERAZ,
    });
    expect(w.stan).toBe('znany');
  });
});

describe('postepCelu — stan NIEZNANY (to jest cala ochrona przed falszywa zielenia)', () => {
  it('pomiar null daje NIEZNANY, a ile jest null — NIE zero', () => {
    // ⚠️ TO JEST NAJWAZNIEJSZA ASERCJA W TYM PLIKU. `ile: 0` na kaflu znaczy „nikt nic
    // nie zrobil". Miernik, ktory padl, MUSI wygladac inaczej niz czlowiek, ktory nie
    // zrobil nic — inaczej na podstawie zepsutego czuwacza zapada rozmowa z czlowiekiem.
    const w = postepCelu({ celIle: 5, pomiar: null, progSwiezosciH: 36, teraz: TERAZ });
    expect(w.stan).toBe('nieznany');
    expect(w.ile).toBe(null);
    expect(w.procent).toBe(null);
  });

  it('pomiar bez liczbowego `ile` daje NIEZNANY', () => {
    const w = postepCelu({
      celIle: 5, pomiar: { zrodloAt: '2026-09-13T09:00:00Z' }, progSwiezosciH: 36, teraz: TERAZ,
    });
    expect(w.stan).toBe('nieznany');
    expect(w.ile).toBe(null);
  });

  it('miernik deklarujacy prog, ale nieoddajacy zrodloAt, jest ZEPSUTY — nieznany', () => {
    // Prog bez znacznika zrodla znaczy, ze miernik nie umie powiedziec, jak stara jest
    // jego liczba. Nie da sie wtedy stwierdzic, czy jest swieza — wiec nie udajemy, ze jest.
    const w = postepCelu({
      celIle: 5, pomiar: { ile: 3, zrodloAt: null }, progSwiezosciH: 36, teraz: TERAZ,
    });
    expect(w.stan).toBe('nieznany');
  });
});

describe('postepCelu — zadanie tak/nie', () => {
  it('celIle null: zero zdarzen = niezrobione', () => {
    const w = postepCelu({
      celIle: null, pomiar: { ile: 0, zrodloAt: null }, progSwiezosciH: null, teraz: TERAZ,
    });
    expect(w.zrobione).toBe(false);
    expect(w.procent).toBe(null); // zadanie nie ma paska
  });

  it('celIle null: jedno zdarzenie = zrobione', () => {
    const w = postepCelu({
      celIle: null, pomiar: { ile: 1, zrodloAt: '2026-09-12' }, progSwiezosciH: null, teraz: TERAZ,
    });
    expect(w.zrobione).toBe(true);
  });

  it('zadanie z nieznanym pomiarem NIE jest „niezrobione", tylko nieznane', () => {
    // Roznica jest istotna: „niezrobione" to zarzut wobec czlowieka, „nie wiem" to zarzut
    // wobec miernika.
    const w = postepCelu({ celIle: null, pomiar: null, progSwiezosciH: null, teraz: TERAZ });
    expect(w.stan).toBe('nieznany');
    expect(w.zrobione).toBe(null);
  });
});
