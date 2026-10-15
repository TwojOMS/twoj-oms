import { describe, it, expect } from 'vitest';
import {
  zakresSkrotu, poprzedniOkres, rokWczesniej, miesiaceOkresu, nazwaOkresu,
  dniOkresu, tygodnieOkresu,
} from '../../src/domena/okresy-raportu.js';

describe('skroty okresow', () => {
  // ⚠️ OCZEKIWANIE ZMIENIONE 17.08.2026 wraz z zachowaniem: „ten miesiac" konczy sie DZIS,
  // nie ostatniego dnia miesiaca (uzasadnienie w naglowku `doDzis` w domenie i w zestawie
  // testow „skroty «ten…» koncza sie DZIS" nizej).
  it('ten miesiac konczy sie dzisiaj, poprzedni obejmuje caly miesiac', () => {
    expect(zakresSkrotu('ten-miesiac', '2026-08-13')).toMatchObject({ od: '2026-08-01', do: '2026-08-13' });
    expect(zakresSkrotu('poprzedni-miesiac', '2026-08-13')).toMatchObject({ od: '2026-07-01', do: '2026-07-31' });
  });

  it('poprzedni miesiac na PRZELOMIE ROKU cofa takze rok', () => {
    expect(zakresSkrotu('poprzedni-miesiac', '2026-01-05')).toMatchObject({ od: '2025-12-01', do: '2025-12-31' });
  });

  // Luty przestepny sprawdzamy na skrocie „poprzedni miesiac" — po zmianie z 17.08.2026
  // „ten miesiac" konczy sie dzisiaj, wiec dlugosci miesiaca juz nie pokazuje.
  it('luty roku przestepnego ma 29 dni', () => {
    expect(zakresSkrotu('poprzedni-miesiac', '2028-03-10').do).toBe('2028-02-29');
    // …i konczy sie 29 lutego takze wtedy, gdy „dzis" jest juz po jego koncu.
    expect(zakresSkrotu('ten-miesiac', '2028-02-29').do).toBe('2028-02-29');
  });

  it('kwartaly i lata', () => {
    // „Ten kwartal" tez konczy sie dzisiaj — 30 wrzesnia jeszcze nie bylo.
    expect(zakresSkrotu('ten-kwartal', '2026-08-13')).toMatchObject({ od: '2026-07-01', do: '2026-08-13' });
    expect(zakresSkrotu('poprzedni-kwartal', '2026-08-13')).toMatchObject({ od: '2026-04-01', do: '2026-06-30' });
    expect(zakresSkrotu('poprzedni-rok', '2026-08-13')).toMatchObject({ od: '2025-01-01', do: '2025-12-31' });
  });
});

// ——— SKROT „DZISIAJ" (31.08.2026, prosba właściciela) ————————————————————————————————————
describe('skrot „dzisiaj"', () => {
  it('to jeden dzien — obie granice rowne dniu biezacemu', () => {
    expect(zakresSkrotu('dzisiaj', '2026-08-13'))
      .toEqual({ od: '2026-08-13', do: '2026-08-13', etykieta: 'Dzisiaj' });
  });

  // ⚠️ `doKonca` NIE MA TU CO PRZYCIAC ANI CO ROZCIAGNAC — dzien jest okresem pelnym sam
  // z siebie. Gdyby opcja cokolwiek tu zmieniala, ten sam przycisk pokazywalby na /raporty
  // i na /finanse dwa rozne zakresy, a rozniloby je wylacznie wywolanie w trasie.
  it('opcja doKonca niczego nie zmienia — dzien jest okresem pelnym', () => {
    expect(zakresSkrotu('dzisiaj', '2026-08-13', { doKonca: true }))
      .toEqual(zakresSkrotu('dzisiaj', '2026-08-13'));
  });

  it('dziala na przelomie miesiaca i roku, bo bierze dzien wprost', () => {
    expect(zakresSkrotu('dzisiaj', '2026-01-01')).toMatchObject({ od: '2026-01-01', do: '2026-01-01' });
    expect(zakresSkrotu('dzisiaj', '2028-02-29')).toMatchObject({ od: '2028-02-29', do: '2028-02-29' });
  });

  it('poprzedni okres dla jednego dnia to dzien wczesniej', () => {
    expect(poprzedniOkres({ od: '2026-08-13', do: '2026-08-13' }))
      .toEqual({ od: '2026-08-12', do: '2026-08-12' });
    // …takze przez granice miesiaca i roku.
    expect(poprzedniOkres({ od: '2026-08-02', do: '2026-08-02' }))
      .toEqual({ od: '2026-08-01', do: '2026-08-01' });
    expect(poprzedniOkres({ od: '2026-01-01', do: '2026-01-01' }))
      .toEqual({ od: '2025-12-01', do: '2025-12-01' });
  });

  // ⚠️ PIERWSZY DZIEN MIESIACA porownuje sie z PIERWSZYM DNIEM POPRZEDNIEGO, a nie z 31.
  // To nie przeoczenie, tylko ta sama regula „ten sam wycinek okresu", ktora rzadzi calym
  // ekranem: 1 sierpnia to „sierpien do dzis", wiec podstawa jest „lipiec do tego samego
  // dnia". Test stoi tu po to, zeby ta niespodzianka byla ZAPISANA, a nie odkrywana.
  it('pierwszy dzien miesiaca porownuje sie z pierwszym dniem poprzedniego', () => {
    expect(poprzedniOkres({ od: '2026-08-01', do: '2026-08-01' }))
      .toEqual({ od: '2026-07-01', do: '2026-07-01' });
  });

  // ⚠️ Bez tego naglowek ekranu mowilby „sprzedaz w okresie 2026-08-31 – 2026-08-31 ·
  // 2026-08-31 – 2026-08-31", a podpis delty kanalu — „vs 2026-08-30 – 2026-08-30"
  // w kolumnie szerokiej na 6,5 rem.
  it('nazwa jednego dnia to sam dzien, a nie „dzien – dzien"', () => {
    expect(nazwaOkresu({ od: '2026-08-31', do: '2026-08-31' })).toBe('2026-08-31');
    expect(nazwaOkresu({ od: '2026-08-30', do: '2026-08-31' })).toBe('2026-08-30 – 2026-08-31');
  });
});

describe('okresy porownawcze', () => {
  it('dla PELNEGO MIESIACA poprzedni okres to poprzedni MIESIAC, nie 31 dni wstecz', () => {
    // ⚠️ Lipiec ma 31 dni, a czerwiec 30 — „to samo okno miesiac wczesniej" NIE ISTNIEJE.
    // Okno tej samej dlugosci daloby 31.05–30.06, czyli „czerwiec plus jeden dzien maja",
    // opisany na ekranie jako „poprzedni okres". Delta wyszlaby wiarygodnie i bylaby falszem.
    expect(poprzedniOkres({ od: '2026-07-01', do: '2026-07-31' }))
      .toEqual({ od: '2026-06-01', do: '2026-06-30' });
  });

  it('dla PELNEGO KWARTALU poprzedni okres to poprzedni KWARTAL', () => {
    expect(poprzedniOkres({ od: '2026-04-01', do: '2026-06-30' }))
      .toEqual({ od: '2026-01-01', do: '2026-03-31' });
  });

  it('dla PELNEGO ROKU poprzedni okres to poprzedni ROK', () => {
    expect(poprzedniOkres({ od: '2026-01-01', do: '2026-12-31' }))
      .toEqual({ od: '2025-01-01', do: '2025-12-31' });
  });

  it('trzy pelne miesiace NIE stojace na granicy kwartalu ida regula dlugosci', () => {
    // 01.02–30.04 to trzy pelne miesiace, ale nie kwartal — „poprzedni kwartal" nie mialby
    // tu znaczenia, wiec zostaje okno tej samej dlugosci (89 dni) konczace sie 31 stycznia.
    expect(poprzedniOkres({ od: '2026-02-01', do: '2026-04-30' }))
      .toEqual({ od: '2025-11-04', do: '2026-01-31' });
  });

  it('zakres DOWOLNY ma poprzednik TEJ SAMEJ DLUGOSCI, konczacy sie dzien przed', () => {
    expect(poprzedniOkres({ od: '2026-07-15', do: '2026-07-24' }))
      .toEqual({ od: '2026-07-05', do: '2026-07-14' });
  });

  it('rok wczesniej to ten sam zakres z odjetym rokiem', () => {
    expect(rokWczesniej({ od: '2026-07-01', do: '2026-07-31' }))
      .toEqual({ od: '2025-07-01', do: '2025-07-31' });
  });

  it('29 lutego rok wczesniej cofa sie na 28 lutego, a nie na 1 marca', () => {
    expect(rokWczesniej({ od: '2028-02-29', do: '2028-02-29' }))
      .toEqual({ od: '2027-02-28', do: '2027-02-28' });
  });
});

describe('nazwy i miesiace', () => {
  it('rozpoznaje pelny miesiac, kwartal, polrocze i rok', () => {
    expect(nazwaOkresu({ od: '2026-06-01', do: '2026-06-30' })).toBe('2026-06');
    expect(nazwaOkresu({ od: '2026-04-01', do: '2026-06-30' })).toBe('2026-Q2');
    expect(nazwaOkresu({ od: '2026-01-01', do: '2026-06-30' })).toBe('2026-H1');
    expect(nazwaOkresu({ od: '2026-01-01', do: '2026-12-31' })).toBe('2026');
    expect(nazwaOkresu({ od: '2026-01-05', do: '2026-02-03' })).toBe('2026-01-05 – 2026-02-03');
  });

  it('miesiace okresu obejmuja kazdy dotkniety miesiac', () => {
    expect(miesiaceOkresu({ od: '2025-11-15', do: '2026-01-02' }))
      .toEqual(['2025-11', '2025-12', '2026-01']);
  });
});

// ——— ZAKRES „DO DZIŚ", NIE „DO KOŃCA MIESIĄCA" (17.08.2026) —————————————————————————
// ⚠️ POWOD JEST MIERZALNY, NIE ESTETYCZNY. Do 17.08.2026 skrot „Ten miesiac" siegal do
// KONCA miesiaca, a `poprzedniOkres` rozpoznawal taki zakres jako pelny miesiac i zestawial
// go z pelnym miesiacem poprzednim. Zmierzone na produkcji 17 sierpnia: panel pokazywal
// „sprzedaz ↓ 59,8%" i „zamowienia ↓ 30,7%", bo porownywal 17 dni sierpnia z 31 dniami lipca.
// Ten sam wycinek obu miesiecy (1–17) daje sprzedaz −33% i zamowienia **+46%** — czyli
// odwrotny znak przy zamowieniach. Ekran nie myli sie tu o kilka procent; myli sie o kierunek.
describe('skroty „ten…" koncza sie DZIS, nie na koncu okresu', () => {
  it('ten miesiac w polowie miesiaca konczy sie dzisiaj', () => {
    expect(zakresSkrotu('ten-miesiac', '2026-08-17')).toMatchObject({ od: '2026-08-01', do: '2026-08-17' });
  });

  it('ten miesiac ostatniego dnia miesiaca obejmuje caly miesiac', () => {
    expect(zakresSkrotu('ten-miesiac', '2026-08-31')).toMatchObject({ od: '2026-08-01', do: '2026-08-31' });
  });

  it('ten kwartal konczy sie dzisiaj, a nie 30 wrzesnia', () => {
    expect(zakresSkrotu('ten-kwartal', '2026-08-17')).toMatchObject({ od: '2026-07-01', do: '2026-08-17' });
  });

  it('ten rok konczy sie dzisiaj, a nie 31 grudnia', () => {
    expect(zakresSkrotu('ten-rok', '2026-08-17')).toMatchObject({ od: '2026-01-01', do: '2026-08-17' });
  });

  // ⚠️ SKROTY „POPRZEDNI…" ZOSTAJA PELNE — one opisuja okres, ktory sie SKONCZYL,
  // wiec przyciecie do „dzis" nie mialoby sensu.
  it('poprzedni miesiac zostaje PELNYM miesiacem', () => {
    expect(zakresSkrotu('poprzedni-miesiac', '2026-08-17')).toMatchObject({ od: '2026-07-01', do: '2026-07-31' });
  });
});

describe('poprzedniOkres dla zakresu „od pierwszego do dziś"', () => {
  // ⚠️ TA SAMA CZESC MIESIACA, nie „okno tej samej dlugosci cofniete o dzien". Zmierzone
  // 17.08.2026: okno tej samej dlugosci to 15–31.07, a wtedy zamowienia rosna o 9,4%;
  // ten sam wycinek (1–17.07) pokazuje wzrost o 46%. Czlowiek pytajacy „jak idzie sierpien"
  // pyta o pierwsze siedemnascie dni lipca, a nie o jego druga polowe.
  it('1–17 sierpnia porownuje sie z 1–17 lipca', () => {
    expect(poprzedniOkres({ od: '2026-08-01', do: '2026-08-17' })).toEqual({ od: '2026-07-01', do: '2026-07-17' });
  });

  it('pelny miesiac dalej porownuje sie z pelnym poprzednim', () => {
    expect(poprzedniOkres({ od: '2026-08-01', do: '2026-08-31' })).toEqual({ od: '2026-07-01', do: '2026-07-31' });
  });

  // ⚠️ POPRZEDNI MIESIAC BYWA KROTSZY OD WYCINKA. 1–30 marca to 30 dni, a luty ma 28 —
  // przeniesione wprost dalyby „1.02–2.03", czyli wycinek zachodzacy na marzec.
  it('wycinek dluzszy niz poprzedni miesiac zostaje PRZYCIETY do jego konca', () => {
    expect(poprzedniOkres({ od: '2026-03-01', do: '2026-03-30' })).toEqual({ od: '2026-02-01', do: '2026-02-28' });
  });

  it('kwartal do dzis porownuje sie z tym samym wycinkiem poprzedniego kwartalu', () => {
    // 1.07–17.08 to 48 dni; 48 dni od 1 kwietnia konczy sie 18 maja.
    expect(poprzedniOkres({ od: '2026-07-01', do: '2026-08-17' })).toEqual({ od: '2026-04-01', do: '2026-05-18' });
  });

  // ⚠️ Zakres NIE zaczynajacy sie pierwszego dnia miesiaca zostaje przy starej regule:
  // nie ma „tego samego wycinka", bo nie ma poczatku okresu, od ktorego liczyc.
  it('zakres z srodka miesiaca dalej dostaje okno tej samej dlugosci', () => {
    expect(poprzedniOkres({ od: '2026-08-05', do: '2026-08-20' })).toEqual({ od: '2026-07-20', do: '2026-08-04' });
  });
});

// ⚠️ RACHUNEK ZARZADCZY ZOSTAJE PRZY PELNYCH OKRESACH (decyzja właściciela 17.08.2026: poprawka
// dotyczy zakladki SPRZEDAZ). Tam koszty, ZUS i PIT-5 sa miesieczne, a skroty maja podawac
// okresy, dla ktorych rachunek w ogole ma sens. Dlatego `zakresSkrotu` przyjmuje `doKonca`.
describe('zakresSkrotu z opcja doKonca (rachunek zarzadczy)', () => {
  it('doKonca oddaje PELNY miesiac, tak jak przed poprawka', () => {
    expect(zakresSkrotu('ten-miesiac', '2026-08-17', { doKonca: true }))
      .toMatchObject({ od: '2026-08-01', do: '2026-08-31' });
  });

  it('doKonca oddaje pelny kwartal i pelny rok', () => {
    expect(zakresSkrotu('ten-kwartal', '2026-08-17', { doKonca: true }).do).toBe('2026-09-30');
    expect(zakresSkrotu('ten-rok', '2026-08-17', { doKonca: true }).do).toBe('2026-12-31');
  });

  // ⚠️ DOMYSLNIE PRZYCINAMY. Nowy ekran, ktory zapomni podac opcji, dostanie zachowanie
  // BEZPIECZNIEJSZE dla porownan — a nie to, ktore pokazywalo „↓ 59,8%" w polowie miesiaca.
  it('bez opcji zakres konczy sie dzisiaj', () => {
    expect(zakresSkrotu('ten-miesiac', '2026-08-17').do).toBe('2026-08-17');
  });
});

// ——— DNI I TYGODNIE OKRESU (przebudowa raportow, 17.08.2026) ————————————————————————
// Lista okresow przychodzi Z ZAKRESU, nie z danych — dzien bez sprzedazy ma miec swoj
// wiersz z zerem (ta sama zasada, co przy `miesiaceOkresu` i sezonowosci).
describe('dniOkresu', () => {
  it('oddaje wszystkie dni zakresu, obie granice wlacznie', () => {
    const dni = dniOkresu({ od: '2026-07-01', do: '2026-07-31' });
    expect(dni).toHaveLength(31);
    expect(dni[0]).toBe('2026-07-01');
    expect(dni.at(-1)).toBe('2026-07-31');
  });

  // ⚠️ Luty przestepny — arytmetyka na UTC ma go policzyc sama, bez warunku z reki.
  it('luty przestepny ma 29 dni', () => {
    const dni = dniOkresu({ od: '2024-02-01', do: '2024-03-01' });
    expect(dni).toHaveLength(30);
    expect(dni).toContain('2024-02-29');
  });

  it('jeden dzien to lista z jednym wpisem', () => {
    expect(dniOkresu({ od: '2026-08-17', do: '2026-08-17' })).toEqual(['2026-08-17']);
  });
});

describe('tygodnieOkresu', () => {
  // 1 lipca 2026 to SRODA — pierwszy tydzien ma byc krotszy (sr–nd), nie cofniety
  // do poniedzialku sprzed zakresu: dzien spoza zakresu nie ma prawa do niego wejsc.
  it('pierwszy tydzien jest PRZYCIETY do poczatku zakresu', () => {
    const tygodnie = tygodnieOkresu({ od: '2026-07-01', do: '2026-07-31' });
    expect(tygodnie[0]).toEqual({ od: '2026-07-01', do: '2026-07-05' });
    expect(tygodnie[1]).toEqual({ od: '2026-07-06', do: '2026-07-12' });
  });

  it('ostatni tydzien jest PRZYCIETY do konca zakresu', () => {
    const tygodnie = tygodnieOkresu({ od: '2026-07-01', do: '2026-07-31' });
    // 27.07.2026 to poniedzialek; tydzien konczylby sie 2 sierpnia, ale zakres konczy lipiec.
    expect(tygodnie.at(-1)).toEqual({ od: '2026-07-27', do: '2026-07-31' });
    expect(tygodnie).toHaveLength(5);
  });

  it('pojedynczy dzien to jeden tydzien od-do tego samego dnia', () => {
    expect(tygodnieOkresu({ od: '2026-08-17', do: '2026-08-17' }))
      .toEqual([{ od: '2026-08-17', do: '2026-08-17' }]);
  });
});

// ——— KWARTALY PO NUMERZE (21.08.2026) ————————————————————————————————————————————
// Zakladka FINANSE dostala na zyczenie właściciela pasek „Poprzedni miesiac · Q1 · Q2 · Q3 · Q4 ·
// Ten rok". Skroty `ten-kwartal`/`poprzedni-kwartal` odpowiadaja na pytanie „ktory to
// kwartal?", a wlasciciel chce wskazac kwartal WPROST — inaczej zeby zobaczyc Q1 w sierpniu
// trzeba wpisywac daty recznie.
describe('skroty kwartalow po numerze (q1–q4)', () => {
  it('q1–q4 to kwartaly BIEZACEGO roku, liczone od miesiaca „dzisiaj"', () => {
    expect(zakresSkrotu('q1', '2026-08-21', { doKonca: true }))
      .toMatchObject({ od: '2026-01-01', do: '2026-03-31', etykieta: 'Q1' });
    expect(zakresSkrotu('q2', '2026-08-21', { doKonca: true }))
      .toMatchObject({ od: '2026-04-01', do: '2026-06-30', etykieta: 'Q2' });
    expect(zakresSkrotu('q3', '2026-08-21', { doKonca: true }))
      .toMatchObject({ od: '2026-07-01', do: '2026-09-30', etykieta: 'Q3' });
    expect(zakresSkrotu('q4', '2026-08-21', { doKonca: true }))
      .toMatchObject({ od: '2026-10-01', do: '2026-12-31', etykieta: 'Q4' });
  });

  it('rok bierze sie z „dzisiaj", a nie ze stalej', () => {
    expect(zakresSkrotu('q1', '2027-05-05', { doKonca: true }))
      .toMatchObject({ od: '2027-01-01', do: '2027-03-31' });
  });

  // Ta sama regula, co przy `ten-kwartal`: bez `doKonca` skrot konczy sie DZIS, bo dni,
  // ktorych nie bylo, zanizaja kazde porownanie liczone z dlugosci zakresu.
  it('bez doKonca kwartal TRWAJACY konczy sie dzisiaj', () => {
    expect(zakresSkrotu('q3', '2026-08-21')).toMatchObject({ od: '2026-07-01', do: '2026-08-21' });
  });

  it('bez doKonca kwartal ZAMKNIETY zostaje caly', () => {
    expect(zakresSkrotu('q2', '2026-08-21')).toMatchObject({ od: '2026-04-01', do: '2026-06-30' });
  });

  // ⚠️⚠️ KWARTAL, KTORY SIE JESZCZE NIE ZACZAL, NIE PODLEGA PRZYCIECIU DO „DZIS".
  // Przyciecie liczy `min(koniec, dzisiaj)`, wiec Q4 ogladany w sierpniu dostalby
  // `od: 2026-10-01, do: 2026-08-21` — zakres ODWROCONY, ktory kazde zapytanie o sprzedaz
  // oddaje jako puste, bez ani jednego bledu. Zero z odwroconego zakresu wyglada dokladnie
  // tak samo wiarygodnie jak zero prawdziwe.
  it('kwartal PRZYSZLY nie zostaje przyciety do odwroconego zakresu', () => {
    const q4 = zakresSkrotu('q4', '2026-08-21');
    expect(q4.od <= q4.do).toBe(true);
    expect(q4).toMatchObject({ od: '2026-10-01', do: '2026-12-31' });
  });

  it('nieznany numer kwartalu dalej jest nieznanym skrotem', () => {
    expect(() => zakresSkrotu('q5', '2026-08-21')).toThrow(/skrót/i);
    expect(() => zakresSkrotu('q0', '2026-08-21')).toThrow(/skrót/i);
  });
});
