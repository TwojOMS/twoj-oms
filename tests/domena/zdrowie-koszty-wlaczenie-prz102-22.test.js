// PRZ-102.22 (recenzja, WAŻNE 2): wiek czuwacza kosztów liczony od późniejszej z dwóch chwil — ostatniego udanego
// pobrania albo włączenia pobierania (zapis tokenu w Ustawieniach, włączenie modułu Koszty). Bez tego świeżo włączone
// pobieranie wisi w /health jako alarm aż do nocnego okna o 3:00, a /health ok=false budzi właściciela.
import { describe, it, expect } from 'vitest';
import { ocenZdrowie, PROG_KOSZTOW_S } from '../../src/domena/zdrowie.js';

const TERAZ = new Date('2026-10-20T08:00:00Z'); // 10:00 w Warszawie
const temu = (h) => new Date(TERAZ.getTime() - h * 3600000).toISOString();
const ocen = (o) => ocenZdrowie({ teraz: TERAZ, startAt: temu(30), kosztyWlaczone: true, ...o });
const alarmyKosztow = (w) => w.alarmy.filter((a) => a.includes('czuwacz kosztów'));

describe('PRZ-102.22 /health po włączeniu pobierania kosztów', () => {
  it('token zapisany przed chwilą w instalacji, która stała bez tokenu > 26 h: brak alarmu „ani jednego przebiegu”', () => {
    expect(PROG_KOSZTOW_S).toBe(26 * 3600);
    const w = ocen({ stanKosztow: null, kosztyWlaczoneOd: temu(0.1) });
    expect(alarmyKosztow(w)).toEqual([]);
    expect(w.czuwaczKosztow.zdrowy).toBe(true);
    // Bez chwili włączenia — jak dotąd: proces stoi 30 h bez przebiegu = alarm.
    expect(alarmyKosztow(ocen({ stanKosztow: null }))).toHaveLength(1);
  });

  it('moduł Koszty włączony o 7:00 po przegapionym oknie: ostatnie udane 27 h temu nie jest alarmem', () => {
    const stan = { ostatnie_udane_at: temu(27), ostatni_blad: null };
    const w = ocen({ stanKosztow: stan, kosztyWlaczoneOd: temu(1) });
    expect(alarmyKosztow(w)).toEqual([]);
    expect(w.czuwaczKosztow).toMatchObject({ zdrowy: true, wiekS: 27 * 3600, ostatnieUdaneAt: temu(27) });
    expect(alarmyKosztow(ocen({ stanKosztow: stan }))).toHaveLength(1);
  });

  it('prawdziwy brak pobrania przez dobę po włączeniu dalej daje alarm', () => {
    expect(alarmyKosztow(ocen({ stanKosztow: null, kosztyWlaczoneOd: temu(27) }))).toHaveLength(1);
    const w = ocen({ stanKosztow: { ostatnie_udane_at: temu(60), ostatni_blad: null }, kosztyWlaczoneOd: temu(27) });
    expect(alarmyKosztow(w)).toHaveLength(1);
    expect(w.czuwaczKosztow.zdrowy).toBe(false);
    // Włączenie dawno temu nie ucisza świeżej awarii: liczy się PÓŹNIEJSZA z dwóch chwil.
    expect(alarmyKosztow(ocen({ stanKosztow: { ostatnie_udane_at: temu(27), ostatni_blad: null }, kosztyWlaczoneOd: temu(100) }))).toHaveLength(1);
  });
});
