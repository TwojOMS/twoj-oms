import { describe, it, expect } from 'vitest';
import {
  PROG_PODLACZENIA_MIN, DLAWIENIE_S, NAJWIECEJ_STANOWISK, stanStanowisk, czyZapisac, dopisz, nazwaStanowiska,
} from '../../src/domena/druk-faktur.js';

// PRZ-126.C05a: komputer z drukarką faktur zgłasza się przy każdym odpytaniu kolejki (co 10 s). Panel uznaje go
// za podłączony, gdy zgłosił się w ostatnich 5 minutach; zapis do bazy najwyżej raz na 60 s na stanowisko.
const TERAZ = new Date('2026-10-29T12:00:00.000Z');
const temu = (ms) => new Date(TERAZ.getTime() - ms).toISOString();
const S = 1000;
const MIN = 60 * S;

describe('stanStanowisk — próg podłączenia', () => {
  it('próg to 5 minut, dławienie 60 s', () => {
    expect(PROG_PODLACZENIA_MIN).toBe(5);
    expect(DLAWIENIE_S).toBe(60);
  });

  it('zgłoszenie 4 min 59 s temu → podłączone', () => {
    const stan = stanStanowisk({ 'BIURO-1': temu(4 * MIN + 59 * S) }, TERAZ);
    expect(stan.podlaczone).toBe(true);
    expect(stan.stanowiska).toEqual([{ nazwa: 'BIURO-1', at: temu(4 * MIN + 59 * S), minutTemu: 4, aktywne: true }]);
  });

  it('zgłoszenie równo 5 min temu → jeszcze podłączone (granica włącznie)', () => {
    expect(stanStanowisk({ 'BIURO-1': temu(5 * MIN) }, TERAZ).podlaczone).toBe(true);
  });

  it('zgłoszenie 5 min 1 s temu → niepodłączone', () => {
    const stan = stanStanowisk({ 'BIURO-1': temu(5 * MIN + S) }, TERAZ);
    expect(stan.podlaczone).toBe(false);
    expect(stan.stanowiska[0]).toMatchObject({ nazwa: 'BIURO-1', minutTemu: 5, aktywne: false });
  });

  it('pusta mapa, brak mapy albo zepsute wpisy → niepodłączone, bez stanowisk', () => {
    expect(stanStanowisk({}, TERAZ)).toEqual({ podlaczone: false, stanowiska: [] });
    expect(stanStanowisk(null, TERAZ)).toEqual({ podlaczone: false, stanowiska: [] });
    expect(stanStanowisk({ X: 'nie-data', Y: 42 }, TERAZ)).toEqual({ podlaczone: false, stanowiska: [] });
  });

  it('stanowiska od najświeższego; jedno aktywne wystarcza', () => {
    const stan = stanStanowisk({ STARY: temu(3 * 60 * MIN), NOWY: temu(30 * S), SREDNI: temu(10 * MIN) }, TERAZ);
    expect(stan.podlaczone).toBe(true);
    expect(stan.stanowiska.map((s) => s.nazwa)).toEqual(['NOWY', 'SREDNI', 'STARY']);
    expect(stan.stanowiska.map((s) => s.aktywne)).toEqual([true, false, false]);
    expect(stan.stanowiska[2].minutTemu).toBe(180);
  });

  it('zgłoszenie „z przyszłości” (cofnięty zegar) liczy się jako świeże, minutTemu = 0', () => {
    const stan = stanStanowisk({ A: new Date(TERAZ.getTime() + 2 * MIN).toISOString() }, TERAZ);
    expect(stan.stanowiska[0]).toMatchObject({ minutTemu: 0, aktywne: true });
  });
});

describe('czyZapisac — dławienie zapisu', () => {
  it('pierwsze zgłoszenie stanowiska zapisuje', () => {
    expect(czyZapisac({}, 'BIURO-1', TERAZ)).toBe(true);
    expect(czyZapisac({ INNE: temu(S) }, 'BIURO-1', TERAZ)).toBe(true);
  });

  it('10 s po zapisie — nie; 60 s i więcej — tak', () => {
    expect(czyZapisac({ 'BIURO-1': temu(10 * S) }, 'BIURO-1', TERAZ)).toBe(false);
    expect(czyZapisac({ 'BIURO-1': temu(59 * S) }, 'BIURO-1', TERAZ)).toBe(false);
    expect(czyZapisac({ 'BIURO-1': temu(60 * S) }, 'BIURO-1', TERAZ)).toBe(true);
    expect(czyZapisac({ 'BIURO-1': temu(61 * S) }, 'BIURO-1', TERAZ)).toBe(true);
  });

  it('dławi po nazwie po przycięciu (spacje, pusta nazwa)', () => {
    expect(czyZapisac({ 'BIURO-1': temu(10 * S) }, '  BIURO-1 ', TERAZ)).toBe(false);
    expect(czyZapisac({ 'bez nazwy': temu(10 * S) }, '', TERAZ)).toBe(false);
  });

  it('nazwa z prototypu obiektu nie myli dławienia', () => {
    expect(czyZapisac({}, 'constructor', TERAZ)).toBe(true);
  });
});

describe('dopisz — mapa zgłoszeń', () => {
  it('dopisuje ISO bieżącej chwili i nie zmienia wejścia', () => {
    const mapa = { A: temu(MIN) };
    const nowa = dopisz(mapa, 'B', TERAZ);
    expect(nowa).toEqual({ A: temu(MIN), B: TERAZ.toISOString() });
    expect(mapa).toEqual({ A: temu(MIN) });
  });

  it('nazwa przycięta do 64 znaków, pusta → „bez nazwy”', () => {
    expect(nazwaStanowiska('x'.repeat(100))).toBe('x'.repeat(64));
    expect(nazwaStanowiska('   ')).toBe('bez nazwy');
    expect(nazwaStanowiska(undefined)).toBe('bez nazwy');
    expect(Object.keys(dopisz({}, `  ${'y'.repeat(70)}  `, TERAZ))).toEqual(['y'.repeat(64)]);
  });

  it(`najwyżej ${20} wpisów — najstarsze wypadają`, () => {
    expect(NAJWIECEJ_STANOWISK).toBe(20);
    let mapa = {};
    for (let i = 0; i < 25; i += 1) mapa = dopisz(mapa, `PC-${i}`, new Date(TERAZ.getTime() + i * MIN));
    const klucze = Object.keys(mapa);
    expect(klucze).toHaveLength(20);
    expect(klucze).not.toContain('PC-0');
    expect(klucze).not.toContain('PC-4');
    expect(klucze).toContain('PC-5');
    expect(klucze).toContain('PC-24');
  });
});
