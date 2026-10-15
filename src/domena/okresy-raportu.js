// Zakresy dat dla ekranu raportow. Modul jest CZYSTY — nie dotyka bazy i nie zna zegara:
// „dzisiaj" przychodzi argumentem, zeby test nie musial przestawiac czasu systemowego.
//
// ⚠️ ARYTMETYKA NA UTC, ZAWSZE. `new Date('2026-08-13')` to polnoc UTC; liczenie miesiecy
// przez `setMonth` na dacie lokalnej daje w Polsce przesuniecie o dzien dwa razy w roku,
// czyli raport „za lipiec" zaczynajacy sie 30 czerwca. Wszystkie dzialania ida przez
// `Date.UTC` i `getUTC*`.

import { kluczOkresu } from './okres-rozliczeniowy.js';
import { komunikatDlaOperatora } from './bledy.js';

const dwie = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getUTCFullYear()}-${dwie(d.getUTCMonth() + 1)}-${dwie(d.getUTCDate())}`;
const zDnia = (s) => new Date(`${s}T00:00:00.000Z`);

/** Ostatni dzien miesiaca — dzien 0 nastepnego miesiaca. Luty przestepny wychodzi sam. */
const koniecMiesiaca = (rok, miesiac) => iso(new Date(Date.UTC(rok, miesiac + 1, 0)));
const poczatekMiesiaca = (rok, miesiac) => iso(new Date(Date.UTC(rok, miesiac, 1)));

/**
 * ⚠️⚠️ SKROTY „TEN…" KONCZA SIE DZIS, NIE NA KONCU OKRESU (poprawka 17.08.2026).
 *
 * Do tego dnia „Ten miesiac" oddawal 1–31 sierpnia, choc byl 17 sierpnia — a `poprzedniOkres`
 * rozpoznawal taki zakres jako PELNY miesiac i zestawial go z PELNYM lipcem. Panel pokazywal
 * przez to „sprzedaz ↓ 59,8%" i „zamowienia ↓ 30,7%", porownujac 17 dni z 31 dniami.
 * Ten sam wycinek obu miesiecy dawal −33% sprzedazy i **+46% zamowien** — czyli ekran mylil
 * sie nie o kilka procent, tylko o KIERUNEK. Zmierzone na produkcji, nie oszacowane.
 *
 * Dni z przyszlosci nie niosly zadnej informacji (sprzedazy jeszcze nie ma), a psuly kazde
 * porownanie, ktore panel liczyl z dlugosci zakresu.
 *
 * ⚠️ `doKonca: true` PRZYWRACA PELNE OKRESY — i ma dokladnie jednego wolajacego: rachunek
 * zarzadczy (decyzja właściciela 17.08.2026: poprawka dotyczy zakladki sprzedazy). Tam koszty,
 * ZUS i PIT-5 sa MIESIECZNE, wiec skroty maja podawac okresy, dla ktorych rachunek w ogole
 * ma sens; zakres urwany w polowie miesiaca stawia tam pasek i nic nie liczy.
 * Domyslnie przycinamy, zeby nowy ekran, ktory zapomni podac opcji, dostal zachowanie
 * BEZPIECZNIEJSZE dla porownan.
 */
const doDzis = (koniec, dzisiaj) => (koniec < dzisiaj ? koniec : dzisiaj);

export function zakresSkrotu(skrot, dzisiaj, { doKonca = false } = {}) {
  const przytnij = (koniec) => (doKonca ? koniec : doDzis(koniec, dzisiaj));
  const d = zDnia(dzisiaj);
  const rok = d.getUTCFullYear();
  const m = d.getUTCMonth();

  // ⚠️ „DZISIAJ" NIE PODLEGA ANI PRZYCIECIU, ANI OPCJI `doKonca` (31.08.2026, prosba właściciela).
  // Jeden dzien jest okresem PELNYM sam z siebie: nie ma w nim przyszlosci do przyciecia
  // ani konca miesiaca do rozciagniecia. Gdyby przechodzil przez `przytnij`, wynik bylby
  // ten sam — ale opcja `doKonca` (rachunek zarzadczy) kazalaby czytac, czy przypadkiem
  // nie rozciaga dnia do konca czegokolwiek. Warunek stoi PRZED reszta wlasnie po to.
  if (skrot === 'dzisiaj') {
    return { od: dzisiaj, do: dzisiaj, etykieta: 'Dzisiaj' };
  }
  if (skrot === 'ten-miesiac') {
    return {
      od: poczatekMiesiaca(rok, m), do: przytnij(koniecMiesiaca(rok, m)),
      etykieta: 'Ten miesiąc',
    };
  }
  if (skrot === 'poprzedni-miesiac') {
    // ⚠️ `Date.UTC(rok, -1, 1)` sam cofa rok — recznego warunku na styczen NIE piszemy.
    return {
      od: poczatekMiesiaca(rok, m - 1), do: koniecMiesiaca(rok, m - 1),
      etykieta: 'Poprzedni miesiąc',
    };
  }
  if (skrot === 'ten-kwartal') {
    const k = Math.floor(m / 3) * 3;
    return {
      od: poczatekMiesiaca(rok, k), do: przytnij(koniecMiesiaca(rok, k + 2)),
      etykieta: 'Ten kwartał',
    };
  }
  if (skrot === 'poprzedni-kwartal') {
    const k = Math.floor(m / 3) * 3 - 3;
    return {
      od: poczatekMiesiaca(rok, k), do: koniecMiesiaca(rok, k + 2),
      etykieta: 'Poprzedni kwartał',
    };
  }
  // ⚠️ KWARTAL WSKAZANY NUMEREM (21.08.2026, na zyczenie właściciela do zakladki FINANSE).
  // `ten-kwartal`/`poprzedni-kwartal` odpowiadaja na pytanie „ktory to kwartal?" — a przy
  // rachunku zarzadczym wlasciciel wskazuje kwartal WPROST. Rok bierze sie z „dzisiaj",
  // tak samo jak przy `ten-rok`: obok stoi przycisk „Ten rok" i oba maja mowic o tym samym.
  const kwartal = /^q([1-4])$/.exec(skrot);
  if (kwartal) {
    const k = (Number(kwartal[1]) - 1) * 3;
    const od = poczatekMiesiaca(rok, k);
    const koniec = koniecMiesiaca(rok, k + 2);
    return {
      od,
      // ⚠️⚠️ KWARTAL, KTORY SIE JESZCZE NIE ZACZAL, NIE PODLEGA PRZYCIECIU. `doDzis` liczy
      // `min(koniec, dzisiaj)`, wiec Q4 ogladany w sierpniu dostalby `2026-10-01 → 2026-08-21`,
      // czyli zakres ODWROCONY: kazde zapytanie o sprzedaz oddaje wtedy pustke, bez ani jednego
      // bledu, a zero z odwroconego zakresu wyglada tak samo wiarygodnie jak zero prawdziwe.
      // (Pozostale skroty tego warunku nie potrzebuja — zaden z nich nie siega w przyszlosc.)
      do: dzisiaj < od ? koniec : przytnij(koniec),
      etykieta: `Q${kwartal[1]}`,
    };
  }
  if (skrot === 'ten-rok') {
    return { od: `${rok}-01-01`, do: przytnij(`${rok}-12-31`), etykieta: 'Ten rok' };
  }
  if (skrot === 'poprzedni-rok') {
    return { od: `${rok - 1}-01-01`, do: `${rok - 1}-12-31`, etykieta: 'Poprzedni rok' };
  }
  if (skrot === 'ostatnie-30') {
    const od = new Date(d); od.setUTCDate(od.getUTCDate() - 29);
    return { od: iso(od), do: dzisiaj, etykieta: 'Ostatnie 30 dni' };
  }
  const e = new Error(`Nieznany skrót okresu: ${skrot}.`);
  e.dlaOperatora = true;
  throw e;
}

/** Etykieta skrótu bez liczenia zakresu — do rysowania przycisków. */
export const nazwaSkrotu = (skrot, dzisiaj) => zakresSkrotu(skrot, dzisiaj).etykieta;

/**
 * Okres porownawczy: ten POPRZEDNI.
 *
 * ⚠️⚠️ DWIE REGULY, I TA KOLEJNOSC JEST CALA TRESCIA TEJ FUNKCJI.
 *
 * Dla zakresu pokrywajacego sie z PELNYM MIESIACEM (albo kwartalem, polroczem, rokiem)
 * poprzedni okres to poprzedni TAKI SAM okres kalendarzowy — czerwiec dla lipca, Q1 dla Q2.
 * Dopiero dla zakresu dowolnego (np. „ostatnie 30 dni", wlasny zakres z kalendarza) liczy sie
 * okno TEJ SAMEJ DLUGOSCI, konczace sie dzien przed `od`.
 *
 * Bez pierwszej reguly lipiec (31 dni) porownywalby sie z oknem 31.05–30.06 — czyli
 * z „czerwcem plus jeden dzien maja", opisanym na ekranie jako „poprzedni okres". Delta
 * wyszlaby wiarygodnie i bylaby nieprawda: miesiace roznia sie dlugoscia, wiec „to samo
 * okno co miesiac wczesniej" NIE ISTNIEJE. Czlowiek pytajacy „jak lipiec wypadl wobec
 * poprzedniego okresu" pyta o czerwiec, a nie o dowolne 31 dni przed lipcem.
 */
export function poprzedniOkres({ od, do: doDnia }) {
  const kalendarzowy = poprzedniKalendarzowy({ od, do: doDnia });
  if (kalendarzowy) return kalendarzowy;
  const dni = Math.round((zDnia(doDnia) - zDnia(od)) / 86_400_000) + 1;
  const koniec = zDnia(od); koniec.setUTCDate(koniec.getUTCDate() - 1);
  const poczatek = new Date(koniec); poczatek.setUTCDate(poczatek.getUTCDate() - dni + 1);
  return { od: iso(poczatek), do: iso(koniec) };
}

/**
 * Poprzedni okres kalendarzowy albo `null`, gdy zakres nie pokrywa sie z zadnym.
 * Rozpoznanie idzie po tej samej zasadzie co `nazwaOkresu`: liczy sie DOKLADNE pokrycie
 * pierwszego i ostatniego dnia, a nie sama liczba miesiecy.
 */
function poprzedniKalendarzowy({ od, do: doDnia }) {
  const rok = Number(od.slice(0, 4));
  const m = Number(od.slice(5, 7)) - 1;
  // Ile miesiecy obejmuje zakres, jesli w ogole zaczyna sie i konczy na granicy miesiaca.
  for (const dlugosc of [1, 3, 6, 12]) {
    const start = poczatekMiesiaca(rok, m);
    const koniec = koniecMiesiaca(rok, m + dlugosc - 1);
    if (start !== od || koniec !== doDnia) continue;
    // ⚠️ Kwartal, polrocze i rok musza jeszcze stac na WLASCIWEJ granicy: 1.02–30.04 to trzy
    // pelne miesiace, ale nie jest kwartalem, wiec „poprzedni kwartal" nie mialby znaczenia.
    if (dlugosc > 1 && m % dlugosc !== 0) continue;
    return {
      od: poczatekMiesiaca(rok, m - dlugosc),
      do: koniecMiesiaca(rok, m - 1),
    };
  }
  return czesciowyOdPoczatku({ od, do: doDnia, rok, m });
}

/**
 * Zakres zaczynajacy sie PIERWSZEGO dnia okresu, ale konczacy sie przed jego koncem —
 * czyli „miesiac (kwartal, rok) do dzis". Porownanie to TEN SAM WYCINEK okresu poprzedniego.
 *
 * ⚠️⚠️ TO NIE JEST TO SAMO, CO „okno tej samej dlugosci cofniete o dzien" (regula nizej,
 * dla zakresow z srodka miesiaca). Zmierzone na produkcji 17.08.2026: okno tej samej dlugosci
 * dla 1–17 sierpnia to 15–31 LIPCA, i przy nim zamowienia rosly o 9,4%. Ten sam wycinek
 * (1–17 lipca) pokazuje wzrost o **46%**. Czlowiek pytajacy „jak idzie sierpien" pyta
 * o pierwsze siedemnascie dni lipca, a nie o jego druga polowe — te dwie liczby opisuja
 * rozne rzeczy, a ekran nazywa obie „poprzedni okres".
 *
 * ⚠️ POPRZEDNI OKRES BYWA KROTSZY OD WYCINKA i wtedy wycinek zostaje PRZYCIETY. 1–30 marca
 * to 30 dni, a luty ma 28: przeniesione wprost dalyby „1.02–2.03", czyli zakres zachodzacy
 * na miesiac, ktory wlasnie porownujemy.
 */
function czesciowyOdPoczatku({ od, do: doDnia, rok, m }) {
  if (od !== poczatekMiesiaca(rok, m)) return null;
  // Najkrotszy okres kalendarzowy, w ktorym zakres SIE MIESCI i ktorego poczatek pokrywa.
  for (const dlugosc of [1, 3, 6, 12]) {
    if (dlugosc > 1 && m % dlugosc !== 0) continue;
    const koniecOkresu = koniecMiesiaca(rok, m + dlugosc - 1);
    if (doDnia > koniecOkresu) continue;
    if (doDnia === koniecOkresu) return null; // pelny okres — obsluzyla petla wyzej
    const dni = Math.round((zDnia(doDnia) - zDnia(od)) / 86_400_000);
    const poprzedniStart = poczatekMiesiaca(rok, m - dlugosc);
    const poprzedniKoniec = koniecMiesiaca(rok, m - 1);
    const wycinek = zDnia(poprzedniStart);
    wycinek.setUTCDate(wycinek.getUTCDate() + dni);
    return {
      od: poprzedniStart,
      do: iso(wycinek) > poprzedniKoniec ? poprzedniKoniec : iso(wycinek),
    };
  }
  return null;
}

/**
 * Ten sam zakres rok wczesniej.
 * ⚠️ 29 lutego ma zejsc na 28 lutego, a nie przewinac sie na 1 marca — `Date.UTC(2027,1,29)`
 * to wlasnie 1 marca, wiec dzien trzeba przyciac do dlugosci miesiaca.
 */
export function rokWczesniej({ od, do: doDnia }) {
  const cofnij = (s) => {
    const d = zDnia(s);
    const rok = d.getUTCFullYear() - 1;
    const m = d.getUTCMonth();
    const ostatni = new Date(Date.UTC(rok, m + 1, 0)).getUTCDate();
    return iso(new Date(Date.UTC(rok, m, Math.min(d.getUTCDate(), ostatni))));
  };
  return { od: cofnij(od), do: cofnij(doDnia) };
}

/**
 * Wszystkie dni zakresu, obie granice wlacznie. Lista przychodzi Z ZAKRESU, nie z danych —
 * dzien bez sprzedazy ma miec swoj wiersz z zerem (ta sama zasada, co `miesiaceOkresu`).
 */
export function dniOkresu({ od, do: doDnia }) {
  const wynik = [];
  const d = zDnia(od);
  const koniec = zDnia(doDnia);
  while (d <= koniec) { wynik.push(iso(d)); d.setUTCDate(d.getUTCDate() + 1); }
  return wynik;
}

/**
 * Tygodnie kalendarzowe (pn–nd) pokrywajace zakres, PRZYCIETE do jego granic.
 * ⚠️ Dzien spoza zakresu nie wchodzi do zadnego tygodnia — pierwszy i ostatni bywaja krotsze.
 * Cofniecie do poniedzialku sprzed zakresu wciagaloby sprzedaz, o ktora nikt nie pytal,
 * i pierwszy slupek klamalby zawyzona kwota.
 */
export function tygodnieOkresu({ od, do: doDnia }) {
  const wynik = [];
  const d = zDnia(od);
  // getUTCDay: niedziela = 0 — przesuniecie robi z poniedzialku poczatek tygodnia.
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  const koniec = zDnia(doDnia);
  while (d <= koniec) {
    const k = new Date(d); k.setUTCDate(k.getUTCDate() + 6);
    wynik.push({ od: iso(d) < od ? od : iso(d), do: iso(k) > doDnia ? doDnia : iso(k) });
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return wynik;
}

/**
 * Zakres PELNEGO miesiaca 'RRRR-MM' → `{ od, do }`.
 *
 * Wybor miesiaca na /finanse jest zwyklym `<input type="month">`, wiec przegladarka oddaje
 * SAM MIESIAC — a rachunek liczy sie z dni. Przelozenie stoi TUTAJ, przy reszcie arytmetyki
 * zakresow: druga kopia „ostatniego dnia miesiaca" w trasie rozjechalaby sie z ta przy
 * pierwszej zmianie (a luty przestepny jest jedynym miejscem, gdzie taki rozjazd widac).
 * ⚠️ Luty przestepny wychodzi sam — dzien 0 nastepnego miesiaca; recznego warunku NIE MA.
 */
export function zakresMiesiaca(miesiac) {
  const rok = Number(miesiac.slice(0, 4));
  const m = Number(miesiac.slice(5, 7)) - 1;
  return { od: poczatekMiesiaca(rok, m), do: koniecMiesiaca(rok, m) };
}

export function miesiaceOkresu({ od, do: doDnia }) {
  const wynik = [];
  const d = zDnia(od.slice(0, 7) + '-01');
  const koniec = doDnia.slice(0, 7);
  for (;;) {
    const m = `${d.getUTCFullYear()}-${dwie(d.getUTCMonth() + 1)}`;
    wynik.push(m);
    if (m >= koniec) break;
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return wynik;
}

/** Nazwa okresu, gdy pokrywa sie z miesiacem / kwartalem / polroczem / rokiem. */
export function nazwaOkresu({ od, do: doDnia }) {
  // ⚠️ JEDEN DZIEN NAZYWA SIE RAZ (31.08.2026, razem ze skrotem „Dzisiaj"). Bez tego
  // naglowek ekranu brzmi „sprzedaz w okresie 2026-08-31 – 2026-08-31 · 2026-08-31 –
  // 2026-08-31", a podpis delty kanalu — „vs 2026-08-30 – 2026-08-30" w kolumnie
  // szerokiej na 6,5 rem.
  if (od === doDnia) return od;
  const rok = od.slice(0, 4);
  if (od.slice(0, 7) === doDnia.slice(0, 7)
    && od.endsWith('-01') && doDnia === koniecMiesiaca(Number(rok), Number(od.slice(5, 7)) - 1)) {
    return od.slice(0, 7);
  }
  if (rok === doDnia.slice(0, 4)) {
    const pary = [
      [`${rok}-01-01`, `${rok}-03-31`, `${rok}-Q1`], [`${rok}-04-01`, `${rok}-06-30`, `${rok}-Q2`],
      [`${rok}-07-01`, `${rok}-09-30`, `${rok}-Q3`], [`${rok}-10-01`, `${rok}-12-31`, `${rok}-Q4`],
      [`${rok}-01-01`, `${rok}-06-30`, `${rok}-H1`], [`${rok}-07-01`, `${rok}-12-31`, `${rok}-H2`],
      [`${rok}-01-01`, `${rok}-12-31`, rok],
    ];
    // ⚠️ Rok sprawdzamy OSTATNI, inaczej 1.01–31.12 wyszloby jako „Q1" (pierwsze trafienie).
    const trafienie = pary.find(([a, b]) => a === od && b === doDnia);
    if (trafienie) return trafienie[2];
  }
  return `${od} – ${doDnia}`;
}

const WZORZEC_DNIA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Dzień z parametru albo `null`.
 * ⚠️ Walidację robi `kluczOkresu`, NIE `new Date`: V8 nie odrzuca dat kalendarzowo
 * niepoprawnych, tylko je cicho przewija — `new Date('2026-02-30')` to 2 marca.
 */
function dzienZParametru(surowa) {
  if (typeof surowa !== 'string' || !WZORZEC_DNIA.test(surowa.trim())) return null;
  try { kluczOkresu(surowa.trim()); } catch { return null; }
  return surowa.trim();
}

/**
 * ⚠️ JEDEN PARSER ZAKRESU NA WSZYSTKIE EKRANY, KTÓRE PYTAJĄ O OKRES (13.09.2026).
 * Do tego dnia siedział w `routes/raporty.js` i obsługiwał ekran raportów oraz eksport CSV.
 * Zakładka STATYSTYKI jest trzecim wołającym — druga kopia tych reguł znaczyłaby, że ekrany
 * mogą się różnić tym, CO uznają za poprawny zakres, a wtedy żaden z nich nie jest dowodem.
 *
 * ⚠️ ZŁA DATA I ODWRÓCONY ZAKRES TO BŁĄD, NIE PUSTY RAPORT. Przepuszczone dalej oddają 200
 * i zerowy wynik — a zera nikt nie kwestionuje, bo wygląda jak zero.
 */
export function zakresZZapytania(query, dzien) {
  if (query?.od || query?.do) {
    const od = dzienZParametru(query.od);
    const doDnia = dzienZParametru(query.do);
    if (!od || !doDnia) {
      return {
        blad: 'Niepoprawna data: parametry od i do muszą być istniejącymi dniami'
          + ' w formacie RRRR-MM-DD.',
      };
    }
    if (od > doDnia) {
      return { blad: 'Niepoprawny zakres: parametr od nie może być późniejszy niż do.' };
    }
    return { zakres: { od, do: doDnia, etykieta: null } };
  }
  try {
    return { zakres: zakresSkrotu(query?.skrot || 'ten-miesiac', dzien) };
  } catch (e) {
    return { blad: komunikatDlaOperatora(e) };
  }
}
