import { describe, it, expect } from 'vitest';
import { ocenZdrowie } from '../../src/domena/zdrowie.js';

// DLAWIENIE POJEDYNCZEJ WPADKI POLLERA (08.09.2026).
//
// ⚠️ POWSTALO PO FALSZYWYM ALARMIE. 08.09.2026 o 19:05:32 jeden przebieg pollera `pro`
// padl na `Sklep nieosiągalny: fetch failed`; czujka monitoring odpytala /health
// o 19:05:51 — DZIEWIETNASCIE SEKUND pozniej — i wyslala na telefon „Panel OMS zglasza
// awarie". Nastepny przebieg (dwie minuty pozniej) zgasil blad. Alarm byl NIEAKTUALNY,
// zanim telefon zdazyl zawibrowac.
//
// Skala z logu kontenera (04–09.09, 4,4 doby): 24 nieudane przebiegi na ~12 700, czyli
// 0,2%. KAZDY z nich otwieral dwuminutowe okno `ok:false`, a czujka pyta RAZ NA GODZINE —
// wiec alarm o czknieciu sieci byl loteria 2/60. Trafila raz. To nie jest ochrona:
// prawdziwy postoj sklepu ta sama reguła wykrywa tak samo dobrze, a czlowiek uczy sie
// ignorowac budzik, ktory 24 razy na 25 klamie.
//
// ⚠️ PROG JEST LITERALEM, NIE importem stalej — test liczacy fiksture od PROG_BLEDU_POLLERA_S
// przezylby kazda zmiane progu (ta sama zasada, co przy progach w zdrowie-domena.test.js).
// Prog to UMOWA Z CZUJKA i decyzja wlasciciela z 09.09.2026: 10 minut, czyli piec nieudanych
// przebiegow z rzedu. Najdluzsza seria w tamtych 4,4 doby miala DLUGOSC JEDEN.

const TERAZ = new Date('2026-09-09T12:00:00.000Z');
const iso = (sekundTemu) => new Date(TERAZ.getTime() - sekundTemu * 1000).toISOString();

// Komplet zdrowy z JEDNYM zrodlem — nadpisania robia z niego awarie albo czknieccie.
const zdrowie = (wierszPro) => ocenZdrowie({
  teraz: TERAZ,
  startAt: new Date(TERAZ.getTime() - 24 * 3600 * 1000),
  zrodla: ['pro'],
  stanyPollera: [wierszPro],
});

const zrodloPro = (w) => w.poller.zrodla.find((z) => z.zrodlo === 'pro');

describe('ocenZdrowie — blad pollera typu „awaria" (siec, sklep, timeout)', () => {
  it('swiezy blad NIE jest alarmem — dokladnie ten falszywy alarm z 08.09.2026', () => {
    const w = zdrowie({
      sklep: 'pro',
      ostatni_przebieg_at: iso(19),
      ostatni_blad: 'Sklep nieosiągalny: fetch failed',
      ostatni_blad_od_at: iso(19),
      ostatni_blad_rodzaj: 'awaria',
    });
    expect(w.ok).toBe(true);
    expect(w.alarmy).toEqual([]);
  });

  it('EKRAN TEZ MILCZY PRZY PIERWSZEJ WPADCE — decyzja wlasciciela 10.09.2026', () => {
    // ⚠️ DO 09.09.2026 STALO TU `zdrowy: false`, z uzasadnieniem „czknieccie ma byc widoczne
    // NA EKRANIE i milczec na TELEFONIE". Doba pozniej wlasciciel zobaczyl, ile to warte:
    // strona glowna pokazala „Poller allegro_amarka nie działa: The operation was
    // aborted due to timeout", Ustawienia → Łączność odpowiedzialy „wszystko ok" (bo dwie
    // minuty wczesniej nastepny przebieg zgasil blad), a jedynym skutkiem bylo szukanie
    // awarii, ktorej juz nie bylo.
    const w = zdrowie({
      sklep: 'pro',
      ostatni_przebieg_at: iso(19),
      ostatni_blad: 'Sklep nieosiągalny: fetch failed',
      ostatni_blad_od_at: iso(19),
      ostatni_blad_rodzaj: 'awaria',
      ostatni_blad_prob: 1,
    });
    const z = zrodloPro(w);
    expect(z.zdrowy).toBe(true);
    // ⚠️ TO NIE JEST ZIELEN NA SILE: tresc bledu ZOSTAJE w wyniku (slad do diagnozy, gdy
    // czkniecia zaczna sie mnozyc) — dlawimy wylacznie to, co krzyczy do czlowieka.
    // I jest po polsku, bo `blad` z tego pola trafia wprost na ekran.
    expect(z.blad).toBe('Sklep nieosiągalny: połączenie nie doszło do skutku');
    expect(z.bladWiekS).toBe(19);
    expect(z.bladProb).toBe(1);
  });

  it('DRUGA wpadka z rzedu jeszcze milczy, TRZECIA zapala wiersz w panelu', () => {
    // ⚠️ PROG JEST LITERALEM (3), nie importem `PROB_BLEDU_NA_EKRAN` — test liczacy
    // fiksture od stalej przezylby kazda jej zmiane. „Trzy nieudane przebiegi z rzedu"
    // to decyzja wlasciciela z 10.09.2026, a nie szczegol implementacji.
    const wierszZ = (proby) => ({
      sklep: 'pro',
      ostatni_przebieg_at: iso(30),
      ostatni_blad: 'Sklep nieosiągalny: fetch failed',
      ostatni_blad_od_at: iso(4 * 60),
      ostatni_blad_rodzaj: 'awaria',
      ostatni_blad_prob: proby,
    });
    expect(zrodloPro(zdrowie(wierszZ(2))).zdrowy).toBe(true);
    expect(zrodloPro(zdrowie(wierszZ(3))).zdrowy).toBe(false);
  });

  it('⚠️ EKRAN ZAPALA SIE PRZED TELEFONEM — dwa progi, dwa koszty pomylki', () => {
    // Trzy proby, ale blad trwa dopiero 4 minuty: wiersz w panelu JEST, budzik jeszcze nie.
    // Gdyby oba czytaly jedna regule, albo telefon dzwonilby po 4 minutach (cofniecie
    // decyzji z 09.09), albo panel milczalby przez 10 (cofniecie decyzji z 10.09).
    const w = zdrowie({
      sklep: 'pro',
      ostatni_przebieg_at: iso(30),
      ostatni_blad: 'Sklep nieosiągalny: fetch failed',
      ostatni_blad_od_at: iso(4 * 60),
      ostatni_blad_rodzaj: 'awaria',
      ostatni_blad_prob: 3,
    });
    expect(zrodloPro(w).zdrowy).toBe(false);
    expect(w.ok).toBe(true);
    expect(w.alarmy).toEqual([]);
  });

  it('po przekroczeniu OBU progow EKRAN I TELEFON mowia to samo', () => {
    // Dlawienie ma OPOZNIAC, a nie kasowac — po progu obie drogi sa otwarte.
    const w = zdrowie({
      sklep: 'pro',
      ostatni_przebieg_at: iso(30),
      ostatni_blad: 'Sklep nieosiągalny: fetch failed',
      ostatni_blad_od_at: iso(11 * 60),
      ostatni_blad_rodzaj: 'awaria',
      ostatni_blad_prob: 6,
    });
    expect(zrodloPro(w).zdrowy).toBe(false);
    expect(w.ok).toBe(false);
  });

  it('wiersz sprzed migracji licznika POKAZUJE blad — na braku wiedzy nie chowamy', () => {
    // Kolumna `ostatni_blad_prob` powstala 10.09.2026. Wiersz zapisany wczesniej ma tam
    // NULL; domyslne „dlawimy" zamienialoby brak wiedzy w cisze na ekranie.
    const w = zdrowie({
      sklep: 'pro',
      ostatni_przebieg_at: iso(30),
      ostatni_blad: 'Sklep nieosiągalny: fetch failed',
      ostatni_blad_od_at: iso(30),
      ostatni_blad_rodzaj: 'awaria',
    });
    const z = zrodloPro(w);
    expect(z.bladProb).toBeNull();
    expect(z.zdrowy).toBe(false);
  });

  it('blad trwajacy 11 minut to alarm z trescia i z czasem trwania', () => {
    const w = zdrowie({
      sklep: 'pro',
      ostatni_przebieg_at: iso(30),
      ostatni_blad: 'Sklep nieosiągalny: fetch failed',
      ostatni_blad_od_at: iso(11 * 60),
      ostatni_blad_rodzaj: 'awaria',
    });
    expect(w.ok).toBe(false);
    expect(w.alarmy).toHaveLength(1);
    expect(w.alarmy[0]).toContain('pro');
    expect(w.alarmy[0]).toContain('Sklep nieosiągalny: połączenie nie doszło do skutku');
    // Czas trwania jest w tresci, bo to on odroznia postoj od czknieccia — a czlowiek
    // czyta ten napis na ekranie telefonu, bez dostepu do bazy.
    expect(w.alarmy[0]).toContain('11 min');
  });

  it('granica progu: 10 minut juz alarmuje, 9 minut jeszcze nie', () => {
    const wierszZ = (sekund) => ({
      sklep: 'pro',
      ostatni_przebieg_at: iso(30),
      ostatni_blad: 'fetch failed',
      ostatni_blad_od_at: iso(sekund),
      ostatni_blad_rodzaj: 'awaria',
    });
    expect(zdrowie(wierszZ(10 * 60)).ok).toBe(false);
    expect(zdrowie(wierszZ(9 * 60)).ok).toBe(true);
  });

  it('swiezy blad NIE zaslania alarmu o STOJACYM pollerze — to dwie rozne awarie', () => {
    // Blad mlodszy niz prog, ale ostatni przebieg sprzed 16 minut: poller nie chodzi wcale.
    // Gdyby dlawienie bledu wyciszalo takze regule wieku, zawieszony poller z jednym
    // swiezym bledem stalby sie NIEWIDZIALNY — czyli dokladnie ta cicha awaria, przed
    // ktora /health powstalo.
    const w = zdrowie({
      sklep: 'pro',
      ostatni_przebieg_at: iso(16 * 60),
      ostatni_blad: 'fetch failed',
      ostatni_blad_od_at: iso(60),
      ostatni_blad_rodzaj: 'awaria',
    });
    expect(w.ok).toBe(false);
    expect(w.alarmy.some((a) => a.includes('ostatni przebieg'))).toBe(true);
  });
});

describe('ocenZdrowie — blad pollera typu „pominiecie" NIE podlega dlawieniu', () => {
  it('pominiete zamowienie alarmuje NATYCHMIAST, choc jest swieze', () => {
    // ⚠️ TO NIE JEST CZKNIECCIE SIECI I NIE WOLNO GO DLAWIC. Zamowienie odrzucone przez
    // mapowanie zostalo POMINIETE, a kursor pollera przez nie przeskoczyl — samo z siebie
    // NIE WROCI (services/poller.js, `opisPominietych`). Ponowienie za dwie minuty niczego
    // nie naprawi, bo dane u zrodla sie nie zmienily. Blad znika z bazy przy najblizszym
    // czystym przebiegu, czyli po ~2 minutach: dlawienie 10-minutowe skasowaloby ten alarm
    // CALKOWICIE, a nie tylko opoznilo.
    const w = zdrowie({
      sklep: 'pro',
      ostatni_przebieg_at: iso(5),
      ostatni_blad: 'Pominięto 1 zamówienie (kursor przesunięty, same z siebie nie wrócą): zła kwota',
      ostatni_blad_od_at: iso(5),
      ostatni_blad_rodzaj: 'pominiecie',
    });
    expect(w.ok).toBe(false);
    expect(w.alarmy.some((a) => a.includes('Pominięto'))).toBe(true);
  });
});

describe('ocenZdrowie — wiersz sprzed migracji (bez rodzaju bledu)', () => {
  it('blad nieznanego rodzaju alarmuje NATYCHMIAST — na braku danych nie milczymy', () => {
    // Wiersz zapisany przed wdrozeniem tej zmiany nie ma ani rodzaju, ani poczatku bledu.
    // Domyslne „dlawimy" zamienialoby brak wiedzy w cisze; domyslne „alarmujemy" najwyzej
    // powtarza dotychczasowe zachowanie przez pierwsze dwie minuty po starcie kontenera.
    const w = zdrowie({
      sklep: 'pro',
      ostatni_przebieg_at: iso(30),
      ostatni_blad: 'fetch failed',
    });
    expect(w.ok).toBe(false);
    expect(w.alarmy.some((a) => a.includes('połączenie nie doszło do skutku'))).toBe(true);
  });

  it('rodzaj „awaria" bez poczatku bledu tez alarmuje — nie da sie zmierzyc trwania', () => {
    const w = zdrowie({
      sklep: 'pro',
      ostatni_przebieg_at: iso(30),
      ostatni_blad: 'fetch failed',
      ostatni_blad_rodzaj: 'awaria',
      ostatni_blad_od_at: null,
    });
    expect(w.ok).toBe(false);
  });
});
