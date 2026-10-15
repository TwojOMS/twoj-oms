import { describe, it, expect } from 'vitest';
import { ocenZdrowie } from '../../src/domena/zdrowie.js';

// ⚠️ PROGI SA TU LITERALAMI, NIGDY importem stalych — test liczacy fiksture od
// PROG_POLLERA_S przezylby kazda zmiane progu, bo wejscie przesunęloby sie razem z nim.
// Prog jest UMOWA Z CZUJKA (monitoring odpytuje co godzine), wiec jego wartosc jest
// trescia, nie szczegolem: 15 min / 3 h / 26 h.

// Regula zdrowia panelu dla czujki monitoring. CZYSTA: bez sieci, bez bazy, bez zegara —
// wszystko przychodzi argumentami, wiec test nie czeka ani sekundy.
//
// ⚠️ ZRODLA PRAWDY SA TRZY I ROZNE, i to jest tresc tej funkcji, a nie przypadek:
//   • poller       → tabela stan_pollera (per sklep/kanal, przezywa restart),
//   • czuwacz KSeF → puls w pamieci procesu (nie zostawia zadnego sladu w bazie),
//   • koszty       → tabela stan_kosztow (ostatnie_udane_at bije takze pusta noc).
// Kanaly Allegro przychodza JUZ ocenione przez stanKanalu() — ta funkcja ich nie ocenia
// drugi raz (druga kopia reguly rozjechalaby sie z paskiem ostrzezen na liscie).

const TERAZ = new Date('2026-08-22T12:00:00.000Z');
const iso = (sekundTemu) => new Date(TERAZ.getTime() - sekundTemu * 1000).toISOString();

// Komplet zdrowy — punkt wyjscia kazdego przypadku. Nadpisania robia z niego awarie.
const zdrowe = (nad = {}) => ocenZdrowie({
  teraz: TERAZ,
  startAt: new Date(TERAZ.getTime() - 24 * 3600 * 1000),
  zrodla: ['pro', 'szkicownia'],
  stanyPollera: [
    { sklep: 'pro', ostatni_przebieg_at: iso(60), ostatni_blad: null },
    { sklep: 'szkicownia', ostatni_przebieg_at: iso(90), ostatni_blad: null },
  ],
  ksefWlaczony: true,
  pulsKsef: { okAt: iso(600), bladAt: null, blad: null },
  kosztyWlaczone: true,
  stanKosztow: { ostatnie_udane_at: iso(9 * 3600), ostatni_blad: null, ostatni_blad_at: null },
  kanaly: [{ kanal: 'allegro_szkicownia', zyje: true, pilne: false, uprzedzenie: false, zostaloDni: 84, refreshWygasaAt: '2026-11-14', powod: null }],
  ...nad,
});

describe('ocenZdrowie — komplet zdrowy', () => {
  it('oddaje ok:true i ani jednego alarmu ani uwagi', () => {
    const w = zdrowe();
    expect(w.ok).toBe(true);
    expect(w.alarmy).toEqual([]);
    expect(w.uwagi).toEqual([]);
  });

  it('podaje wiek kazdego zegara w sekundach (zaokraglony w dol)', () => {
    const w = zdrowe();
    expect(w.poller.zrodla.find((z) => z.zrodlo === 'pro').wiekS).toBe(60);
    expect(w.czuwaczKsef.wiekS).toBe(600);
    expect(w.czuwaczKosztow.wiekS).toBe(9 * 3600);
  });
});

describe('ocenZdrowie — poller (stan_pollera per zrodlo)', () => {
  it('przebieg sprzed 16 minut to alarm z nazwa zrodla, sprzed 14 minut jeszcze nie', () => {
    const w = zdrowe({
      stanyPollera: [
        { sklep: 'pro', ostatni_przebieg_at: iso(16 * 60), ostatni_blad: null },
        { sklep: 'szkicownia', ostatni_przebieg_at: iso(14 * 60), ostatni_blad: null },
      ],
    });
    expect(w.ok).toBe(false);
    expect(w.alarmy.some((a) => a.includes('pro') && a.includes('poller'))).toBe(true);
    // Drugie zrodlo jest PONIZEJ progu i NIE wpada do alarmow — awaria jednego kanalu
    // nie moze wygladac jak awaria wszystkich (to samo rozroznienie, co w petli pollera).
    expect(w.alarmy.some((a) => a.includes('szkicownia'))).toBe(false);
  });

  it('zapisany blad zrodla to alarm z trescia bledu', () => {
    const w = zdrowe({
      stanyPollera: [
        { sklep: 'pro', ostatni_przebieg_at: iso(30), ostatni_blad: 'fetch failed' },
        { sklep: 'szkicownia', ostatni_przebieg_at: iso(90), ostatni_blad: null },
      ],
    });
    expect(w.ok).toBe(false);
    // ⚠️ W BAZIE ANGIELSKI, NA WYJSCIU POLSKI (10.09.2026, domain/blad-po-polsku.js):
    // „fetch failed" pisze Node, a alarm czyta czlowiek z ekranu telefonu.
    expect(w.alarmy.some((a) => a.includes('pro') && a.includes('połączenie nie doszło do skutku'))).toBe(true);
  });

  it('zrodlo skonfigurowane a bez wiersza stanu to alarm — chyba ze proces jest mlodszy niz prog', () => {
    const bezWiersza = {
      stanyPollera: [{ sklep: 'pro', ostatni_przebieg_at: iso(60), ostatni_blad: null }],
    };
    const stary = zdrowe(bezWiersza);
    expect(stary.ok).toBe(false);
    expect(stary.alarmy.some((a) => a.includes('szkicownia'))).toBe(true);

    const mlody = zdrowe({ ...bezWiersza, startAt: new Date(TERAZ.getTime() - 60 * 1000) });
    expect(mlody.ok).toBe(true);
  });

  it('wiersz zrodla NIEskonfigurowanego nie robi alarmu (kanal wygaszony zostawia stan w bazie)', () => {
    const w = zdrowe({
      stanyPollera: [
        { sklep: 'pro', ostatni_przebieg_at: iso(60), ostatni_blad: null },
        { sklep: 'szkicownia', ostatni_przebieg_at: iso(90), ostatni_blad: null },
        { sklep: 'stary_kanal', ostatni_przebieg_at: iso(999999), ostatni_blad: 'martwy' },
      ],
    });
    expect(w.ok).toBe(true);
  });
});

describe('ocenZdrowie — czuwacz KSeF (puls w pamieci)', () => {
  it('sukces sprzed 4 godzin to alarm, sprzed 2 godzin jeszcze nie', () => {
    const stary = zdrowe({ pulsKsef: { okAt: iso(4 * 3600), bladAt: null, blad: null } });
    expect(stary.ok).toBe(false);
    expect(stary.alarmy.some((a) => a.includes('KSeF'))).toBe(true);

    const swiezy = zdrowe({ pulsKsef: { okAt: iso(2 * 3600), bladAt: null, blad: null } });
    expect(swiezy.ok).toBe(true);
  });

  it('blad swiezszy niz ostatni sukces to alarm z trescia', () => {
    const w = zdrowe({ pulsKsef: { okAt: iso(1200), bladAt: iso(600), blad: 'inFakt: 500' } });
    expect(w.ok).toBe(false);
    expect(w.alarmy.some((a) => a.includes('inFakt: 500'))).toBe(true);
  });

  it('sukces swiezszy niz blad NIE jest alarmem (awaria minela)', () => {
    const w = zdrowe({ pulsKsef: { okAt: iso(600), bladAt: iso(1200), blad: 'chwilowe' } });
    expect(w.ok).toBe(true);
  });

  it('brak przebiegu od startu: mlody proces czeka, stary alarmuje', () => {
    const pusty = { pulsKsef: { okAt: null, bladAt: null, blad: null } };
    const mlody = zdrowe({ ...pusty, startAt: new Date(TERAZ.getTime() - 10 * 60 * 1000) });
    expect(mlody.ok).toBe(true);

    const stary = zdrowe(pusty);
    expect(stary.ok).toBe(false);
    expect(stary.alarmy.some((a) => a.includes('KSeF'))).toBe(true);
  });

  it('czuwacz wylaczony (brak inFaktu/kanalu) nie alarmuje i mowi o tym wprost', () => {
    const w = zdrowe({ ksefWlaczony: false, pulsKsef: null });
    expect(w.ok).toBe(true);
    expect(w.czuwaczKsef.wlaczony).toBe(false);
  });
});

describe('ocenZdrowie — czuwacz kosztow (stan_kosztow)', () => {
  it('udane pobranie sprzed 27 godzin to alarm, sprzed 25 jeszcze nie (pusta noc tez bije znacznik)', () => {
    const stary = zdrowe({ stanKosztow: { ostatnie_udane_at: iso(27 * 3600), ostatni_blad: null, ostatni_blad_at: null } });
    expect(stary.ok).toBe(false);
    expect(stary.alarmy.some((a) => a.includes('koszt'))).toBe(true);

    const swiezy = zdrowe({ stanKosztow: { ostatnie_udane_at: iso(25 * 3600), ostatni_blad: null, ostatni_blad_at: null } });
    expect(swiezy.ok).toBe(true);
  });

  it('obecny ostatni_blad to alarm (blad gasnie w bazie przy sukcesie, wiec obecnosc = stan biezacy)', () => {
    const w = zdrowe({ stanKosztow: { ostatnie_udane_at: iso(3600), ostatni_blad: 'KSeF: 401', ostatni_blad_at: iso(1800) } });
    expect(w.ok).toBe(false);
    expect(w.alarmy.some((a) => a.includes('KSeF: 401'))).toBe(true);
  });

  it('brak wiersza stanu: mlody proces czeka na pierwsza noc, stary alarmuje', () => {
    const mlody = zdrowe({ stanKosztow: null, startAt: new Date(TERAZ.getTime() - 3600 * 1000) });
    expect(mlody.ok).toBe(true);

    const stary = zdrowe({ stanKosztow: null, startAt: new Date(TERAZ.getTime() - 27 * 3600 * 1000) });
    expect(stary.ok).toBe(false);
  });

  it('czuwacz wylaczony nie alarmuje', () => {
    const w = zdrowe({ kosztyWlaczone: false, stanKosztow: null });
    expect(w.ok).toBe(true);
    expect(w.czuwaczKosztow.wlaczony).toBe(false);
  });
});

describe('ocenZdrowie — czuwacz przesylek (puls, zegar #4 od 23.08)', () => {
  it('wlaczony i swiezy jest zdrowy; sukces sprzed 4 godzin to alarm', () => {
    const ok = zdrowe({ przesylkiWlaczone: true, pulsPrzesylek: { okAt: iso(1800), bladAt: null, blad: null } });
    expect(ok.ok).toBe(true);
    expect(ok.czuwaczPrzesylek.zdrowy).toBe(true);

    const stary = zdrowe({ przesylkiWlaczone: true, pulsPrzesylek: { okAt: iso(4 * 3600), bladAt: null, blad: null } });
    expect(stary.ok).toBe(false);
    expect(stary.alarmy.some((a) => a.includes('przesyłek'))).toBe(true);
  });

  it('blad swiezszy niz sukces to alarm; wylaczony nie alarmuje', () => {
    const zly = zdrowe({ przesylkiWlaczone: true, pulsPrzesylek: { okAt: iso(1200), bladAt: iso(600), blad: 'DPD: timeout' } });
    expect(zly.ok).toBe(false);
    expect(zly.alarmy.some((a) => a.includes('DPD: timeout'))).toBe(true);

    const wylaczony = zdrowe({ przesylkiWlaczone: false, pulsPrzesylek: null });
    expect(wylaczony.ok).toBe(true);
    expect(wylaczony.czuwaczPrzesylek.wlaczony).toBe(false);
  });

  it('brak przebiegu od startu: mlody proces czeka, stary alarmuje', () => {
    const mlody = zdrowe({
      przesylkiWlaczone: true, pulsPrzesylek: null,
      startAt: new Date(TERAZ.getTime() - 10 * 60 * 1000),
    });
    expect(mlody.ok).toBe(true);
    const stary = zdrowe({ przesylkiWlaczone: true, pulsPrzesylek: null });
    expect(stary.ok).toBe(false);
  });
});

describe('ocenZdrowie — kanaly Allegro (ocenione wczesniej przez stanKanalu)', () => {
  it('kanal pilny to alarm z jego powodem', () => {
    const w = zdrowe({
      kanaly: [{ kanal: 'allegro_szkicownia', zyje: false, pilne: true, uprzedzenie: false, zostaloDni: null, refreshWygasaAt: null, powod: 'Kanał allegro_szkicownia nie pobiera zamówień' }],
    });
    expect(w.ok).toBe(false);
    expect(w.alarmy.some((a) => a.includes('nie pobiera zamówień'))).toBe(true);
  });

  it('uprzedzenie (token na dniach) to UWAGA, nie alarm — panel dziala', () => {
    const w = zdrowe({
      kanaly: [{ kanal: 'allegro_szkicownia', zyje: true, pilne: false, uprzedzenie: true, zostaloDni: 5, refreshWygasaAt: '2026-08-27', powod: 'Kanał allegro_szkicownia: połączenie z Allegro wygasa 2026-08-27' }],
    });
    expect(w.ok).toBe(true);
    expect(w.uwagi.some((u) => u.includes('wygasa'))).toBe(true);
  });
});

describe('ocenZdrowie — ksztalt wyniku dla czujki', () => {
  it('ok jest false dokladnie wtedy, gdy jest jakikolwiek alarm', () => {
    const w = zdrowe({ stanyPollera: [] });
    expect(w.alarmy.length).toBeGreaterThan(0);
    expect(w.ok).toBe(false);
  });

  it('kanaly przechodza do wyniku bez dokladania pol (biala lista stanKanalu zostaje jedyna)', () => {
    const w = zdrowe();
    expect(Object.keys(w.kanaly[0]).sort()).toEqual(
      ['kanal', 'pilne', 'powod', 'refreshWygasaAt', 'uprzedzenie', 'zostaloDni', 'zyje'],
    );
  });
});

// Moment startu procesu (2026-09-10). Panel ZNAL te liczbe od poczatku — `procesWiekS`
// decyduje, czy mlody proces ma czekac zamiast klamac alarmem — ale jej nie oddawal.
// Bez niej z zewnatrz nie da sie odroznic RESTARTU PANELU od zadlawienia sieci: jedno
// i drugie wyglada jak cisza na /health. Bot diagnozujacy awarie pisal wprost „nie
// odroznie restartu kontenera od zadlawienia sieci" — a odpowiedz siedziala w procesie.
// ⚠️⚠️ UMOWA Z CZUJKĄ, KTÓREJ DO 10.09.2026 NIC NIE PILNOWAŁO. `monitoring.sh` na
// Proxmoksie NIE parsuje JSON-a — wycina treść sedem, zakładając SĄSIEDZTWO kluczy:
//     sed -n 's/.*"uwagi":\[\(.*\)\],"poller".*/\1/p'
// Pole dołożone MIĘDZY `uwagi` a `poller` nie wywala niczego i nic nie zgłasza: czujka
// po prostu przestaje umieć podać powód i wysyła ogólnik „/health zglasza uwagi" zamiast
// „token Allegro wygasa za 5 dni". Cicha strata treści budzika — dokładnie ta klasa awarii,
// która jest niewidoczna dla testów każdej ze stron osobno.
// Bezpieczne miejsca na nowe pola: PRZED `ok` albo PO `poller`. Nie w środku.
describe('ocenZdrowie — kolejność kluczy jest umową z czujką monitoring', () => {
  const SED_ALARMY = /"alarmy":\[(.*)\],"uwagi"/;
  const SED_UWAGI = /"uwagi":\[(.*)\],"poller"/;

  it('czujka wycina POWODY alarmu swoim wzorcem', () => {
    const json = JSON.stringify(zdrowe({ stanyPollera: [] }));
    expect(json.match(SED_ALARMY)?.[1]).toContain('poller');
  });

  it('czujka wycina TREŚĆ uwag swoim wzorcem', () => {
    const json = JSON.stringify(zdrowe({
      kanaly: [{ kanal: 'allegro_szkicownia', zyje: true, pilne: false, uprzedzenie: true, zostaloDni: 5, refreshWygasaAt: '2026-09-15', powod: 'token allegro_szkicownia wygasa za 5 dni' }],
    }));
    expect(json.match(SED_UWAGI)?.[1]).toContain('wygasa za 5 dni');
  });
});

describe('ocenZdrowie — moment startu procesu', () => {
  it('oddaje start procesu w ISO i jego wiek w sekundach', () => {
    const w = zdrowe();
    expect(w.proces.startAt).toBe(new Date(TERAZ.getTime() - 24 * 3600 * 1000).toISOString());
    expect(w.proces.wiekS).toBe(24 * 3600);
  });

  it('nieznany start to null, NIE zero — zero znaczyloby „wlasnie wstal"', () => {
    const w = zdrowe({ startAt: null });
    expect(w.proces).toEqual({ startAt: null, wiekS: null });
  });

  it('swiezy restart widac po wieku, nie po zgadywaniu', () => {
    const w = zdrowe({ startAt: new Date(TERAZ.getTime() - 45 * 1000) });
    expect(w.proces.wiekS).toBe(45);
  });
});

// Zegar #6: czuwacz ostrzezen (2026-08-29) — lustra tabelki ostrzezen strony glownej
// (luki KSeF + terminy platnosci). Zyje WYLACZNIE pulsem, jak KSeF i przesylki;
// prog 3 h (chodzi co godzine, jedna czkawka sieci nie budzi telefonu).
describe('ocenZdrowie — czuwacz ostrzezen (puls)', () => {
  it('swiezy sukces jest zdrowy, postoj ponad 3 h alarmuje', () => {
    const ok = zdrowe({ ostrzezeniaWlaczone: true, pulsOstrzezen: { okAt: iso(1800), bladAt: null, blad: null } });
    expect(ok.ok).toBe(true);
    expect(ok.czuwaczOstrzezen.zdrowy).toBe(true);

    const stary = zdrowe({ ostrzezeniaWlaczone: true, pulsOstrzezen: { okAt: iso(4 * 3600), bladAt: null, blad: null } });
    expect(stary.ok).toBe(false);
    expect(stary.alarmy.some((a) => a.includes('ostrzeżeń'))).toBe(true);
  });

  it('blad swiezszy niz sukces to alarm; wylaczony nie alarmuje', () => {
    const zly = zdrowe({ ostrzezeniaWlaczone: true, pulsOstrzezen: { okAt: iso(1200), bladAt: iso(600), blad: 'luki KSeF: inFakt 500' } });
    expect(zly.ok).toBe(false);
    expect(zly.alarmy.some((a) => a.includes('inFakt 500'))).toBe(true);

    const wylaczony = zdrowe({ ostrzezeniaWlaczone: false, pulsOstrzezen: null });
    expect(wylaczony.ok).toBe(true);
    expect(wylaczony.czuwaczOstrzezen.wlaczony).toBe(false);
  });
});
