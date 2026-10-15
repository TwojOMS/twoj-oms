import { describe, it, expect } from 'vitest';
import { sprawdzZrodlo, METODY_BEZPIECZNE } from '../../../src/core/bezpieczenstwo/csrf.js';

// Atak, przed ktorym to stoi: obca strona otwarta w sasiedniej karcie wysyla formularz
// POST na adres panelu. Przegladarka DOLACZA zapamietane poswiadczenia Basic Auth, wiec
// zadanie jest uwierzytelnione — i nadaje paczke albo wystawia fakture w KSeF.
// Jedynym, czego obca strona nie moze podrobic, jest naglowek Origin/Referer.

const zadanie = (n = {}) => ({ method: 'POST', host: 'panel.local:3001', ...n });

describe('sprawdzZrodlo', () => {
  it('przepuszcza metody bezpieczne bez patrzenia na zrodlo', () => {
    for (const m of METODY_BEZPIECZNE) {
      expect(sprawdzZrodlo({ method: m, host: 'panel.local:3001' })).toBe(null);
    }
  });

  it('przepuszcza POST z wlasnego origin', () => {
    expect(sprawdzZrodlo(zadanie({ origin: 'http://panel.local:3001' }))).toBe(null);
  });

  it('odrzuca POST z obcego origin', () => {
    expect(sprawdzZrodlo(zadanie({ origin: 'https://zla-strona.example' }))).toMatch(/zrodl|Origin/i);
  });

  // Sam numer portu wystarcza, zeby to bylo inne pochodzenie - i wystarcza, zeby
  // to byla inna aplikacja na tym samym NAS-ie (n8n, Caddy, panel indywidualny).
  it('odrzuca POST z tego samego hosta, ale innego portu', () => {
    expect(sprawdzZrodlo(zadanie({ origin: 'http://panel.local:5678' }))).not.toBe(null);
  });

  it('gdy nie ma Origin, rozstrzyga Referer', () => {
    expect(sprawdzZrodlo(zadanie({ referer: 'http://panel.local:3001/zamowienia/7' }))).toBe(null);
    expect(sprawdzZrodlo(zadanie({ referer: 'https://zla-strona.example/x' }))).not.toBe(null);
  });

  // Firefox przez dlugi czas NIE wysylal Origin przy formularzu na wlasny serwer.
  // Bez tego zapasu ochrona blokowalaby normalna prace, a wtedy wylatuje w calosci.
  it('Origin ma pierwszenstwo przed Refererem, gdy sa oba', () => {
    expect(sprawdzZrodlo(zadanie({
      origin: 'https://zla-strona.example',
      referer: 'http://panel.local:3001/lista',
    }))).not.toBe(null);
  });

  // Sandboksowana ramka i niektore przekierowania wysylaja doslownie "null".
  // To NIE jest brak naglowka - nie wolno przechodzic wtedy do Referera.
  it('odrzuca Origin rowny "null" i nie siega po Referer', () => {
    expect(sprawdzZrodlo(zadanie({ origin: 'null', referer: 'http://panel.local:3001/lista' }))).not.toBe(null);
  });

  // Zawodzimy zamknieciem: brak obu naglowkow to zadanie, ktorego pochodzenia
  // nie da sie stwierdzic. Panel jest narzedziem przegladarkowym, wiec nie ma
  // legalnego klienta, ktory by ich nie wysylal.
  it('odrzuca POST bez Origin i bez Referera', () => {
    expect(sprawdzZrodlo(zadanie())).not.toBe(null);
  });

  it('odrzuca zadanie bez naglowka Host - nie ma z czym porownac', () => {
    expect(sprawdzZrodlo({ method: 'POST', origin: 'http://panel.local:3001' })).not.toBe(null);
  });

  it('odrzuca smieciowy Origin zamiast wywalac sie na parsowaniu', () => {
    expect(sprawdzZrodlo(zadanie({ origin: 'to nie jest URL' }))).not.toBe(null);
    expect(sprawdzZrodlo(zadanie({ referer: '////' }))).not.toBe(null);
  });

  // Port domyslny bywa w jednym miejscu zapisany, a w drugim pominiety
  // (naglowek Host go niesie, URL w Origin juz nie). To ten sam adres.
  it('port domyslny liczy sie tak samo, zapisany i pominiety', () => {
    expect(sprawdzZrodlo({ method: 'POST', host: 'panel.local:80', origin: 'http://panel.local' })).toBe(null);
    expect(sprawdzZrodlo({ method: 'POST', host: 'panel.local', origin: 'http://panel.local:80' })).toBe(null);
    expect(sprawdzZrodlo({ method: 'POST', host: 'panel.local:443', origin: 'https://panel.local' })).toBe(null);
  });

  it('porownanie hosta jest niewrazliwe na wielkosc liter', () => {
    expect(sprawdzZrodlo({ method: 'POST', host: 'Panel.Local:3001', origin: 'http://panel.local:3001' })).toBe(null);
  });

  it('kazda metoda zmieniajaca stan jest sprawdzana, nie tylko POST', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(sprawdzZrodlo({ method: m, host: 'panel.local:3001', origin: 'https://zla-strona.example' })).not.toBe(null);
    }
  });
});
