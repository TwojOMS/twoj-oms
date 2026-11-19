import { milimetryZCentymetrow, centymetryZMilimetrow, gramyZKilogramow, kilogramyZGramow } from './rozmiar.js';
import { normalizujWartosc } from './parametry-kart.js';
import { czyStawkaVat } from './vat.js';
import { kwotaZakupuZNapisu, dzienZNapisu, dzienPolski } from './cena-zakupu.js';
import { dzienWarszawa } from './format-daty.js';
import { cenaPolska, zl } from './kwoty.js';
import { markaZFormularza } from './marka-karty.js';
import { cenaPoZmianie } from './cena-kanalu.js';
import { groszeCenyKatalogowej } from './kwota.js';
import { LIMIT_INFORMACJI_BEZPIECZENSTWA } from './allegro-oferta-z-karty.js';
import { parsujProg } from './prog-stanu.js';

// EDYCJA HURTEM W MAGAZYNIE — reguly czyste. Zadnej bazy, zadnego HTTP: tutaj rozstrzyga
// sie WYLACZNIE, co formularz znaczy i ktore karty ta tresc faktycznie zmieni.
//
// PO CO TEN EKRAN ISTNIEJE: w katalogu bywa kilkaset kart bez wymiaru, wagi albo parametru
// i sporo bez kategorii glownej. Bez niego trzeba by otworzyc te karty po kolei.
//
// ⚠️⚠️ PUSTE POLE ZNACZY „NIE RUSZAJ" — I JEST TO ODWROTNIE NIZ NA KARCIE PRODUKTU. Tam puste
// pole KASUJE wartosc i jest to bezpieczne, bo czlowiek patrzy na jedna karte i widzi, co robi.
// Tutaj formularz ma kilka pol naraz: gdyby puste kasowalo, ustawienie samej wagi
// WYCZYSCILOBY WYMIARY I KATEGORIE 600 KARTOM jednym kliknieciem, bez sladu i bez mozliwosci
// cofniecia. To jest warunek bezpieczenstwa, a nie preferencja.
//
// ⚠️ KASOWANIE HURTEM MUSI BYC OSOBNYM, JAWNYM WYBOREM — nigdy skutkiem pustego pola. Stad
// pola `*_wyczysc` przy wymiarach, wadze i parametrach: droga powrotu po hurtowej pomylce
// musi istniec i musi byc nazwana.

/**
 * Pola, ktore FORMULARZ HURTOWY wysyla — i JEDYNE, ktorych ten ekran dotyka.
 *
 * ⚠️ WEZSZE NIZ `POLA_KARTY` w db/magazyn.js I TAK MA BYC. `sku` jest UNIQUE (hurtem dalo by
 * sie ustawic jedno SKU sześciuset kartom, czyli odbic sie o baze przy drugim), a `opis` jest
 * tekstem pisanym per karta. Zadne z nich nie ma sensu jako
 * ta sama wartosc dla calej zaznaczonej grupy.
 *
 * ⚠️ CZYTAMY WYLACZNIE PO TEJ LISCIE, a nie po kluczach ciala zadania — inaczej pole dopisane
 * recznie do formularza siegaloby dalej, niz ekran pozwala.
 */
export const POLA_HURTU = Object.freeze([
  'szerokosc_cm',
  'szerokosc_cm_wyczysc',
  'wysokosc_cm',
  'wysokosc_cm_wyczysc',
  'glebokosc_cm',
  'glebokosc_cm_wyczysc',
  'waga_kg',
  'waga_kg_wyczysc',
  'kategoria_glowna',
  'marka',
  'marka_nowa',
  'stawka_vat',
  // Wyjątek od zasady „hurt zmienia tylko kolumny karty”: cena zakupu ma własną tabelę z historią
  // „obowiązuje od”, więc nie trafia do `zmiany`, tylko do osobnego pola planu `cenaZakupu`.
  'cena_zakupu_netto',
  'cena_zakupu_od',
  'cena_tryb',
  'cena_wartosc',
  'cena_zaokraglenie',
  // Informacja o bezpieczeństwie (GPSR): tekst albo jawny powrót do tekstu domyślnego konta.
  // Dwa pola, bo puste pole tekstu znaczy „nie ruszaj”, a nie „skasuj”.
  'informacja_bezpieczenstwa',
  'informacja_bezpieczenstwa_domyslna',
  'prog_niskiego_stanu',
  'prog_niskiego_stanu_bez',
]);

// Parametry wlasne kart: pola `parametr_<id>` i `parametr_<id>_wyczysc`. Zbior zalezy od
// definicji w Ustawieniach, wiec nie miesci sie w stalej liscie — ten wzor jest jej odpowiednikiem.
const POLE_PARAMETRU = /^parametr_(\d{1,9})(_wyczysc)?$/;

/**
 * Pole nieprzyslane odrozniamy od przyslanego, ale niebedacego napisem.
 *
 * ⚠️ TA ROZNICA JEST NOSNA. Pole przyslane DWA RAZY wraca z Fastify jako TABLICA — gdyby
 * wpadalo do tego samego worka, co „nie przyslano", formularz z podwojonym polem po cichu
 * NIE ustawialby wymiaru, a reszta zadania wchodzilaby normalnie. Tutaj taka tablica konczy
 * sie ODMOWA calego zapisu, tak samo jak literowka.
 */
const BRAK_POLA = Symbol('pole nieprzyslane');
function poleHurtu(body, klucz) {
  // `Object.hasOwn`, nie `body[k] ?? ''`: klucze pochodza z zadania HTTP, a na literale
  // obiektu zapytanie o „constructor" albo „toString" oddaje funkcje z prototypu.
  if (!body || !Object.hasOwn(body, klucz)) return BRAK_POLA;
  const wartosc = body[klucz];
  return typeof wartosc === 'string' ? wartosc : null;
}

const NIE_ROZUMIEM_WYMIARU = (surowe) =>
  `„${surowe}" to nie jest wymiar w centymetrach. ` +
  'Wpisz samą liczbę (np. 70 albo 10,5) albo zostaw pole puste — puste pole hurtem ' +
  'znaczy „nie ruszaj tej kolumny", a nie „skasuj ją".';

const NIE_ROZUMIEM_WAGI = (surowe) =>
  `„${surowe}” to nie jest waga w kilogramach. ` +
  'Wpisz liczbę większą od zera (np. 1,25) albo zostaw pole puste — puste pole hurtem ' +
  'znaczy „nie ruszaj”, a nie „skasuj”.';

// Przeliczenia z `domena/rozmiar.js` oddaja tez „puste = skasuj"; tutaj puste odsiano wczesniej,
// wiec kazdy wynik inny niz liczba to tekst, ktorego nie rozumiemy.
const milimetrySame = (s) => milimetryZCentymetrow(s)?.mm ?? null;
const gramySame = (s) => gramyZKilogramow(s)?.g ?? null;

/**
 * Parametry wlasne z formularza hurtu → `{ lista: [{ id, nazwa, typ, jednostka, wartosc }] }`
 * (`wartosc: null` = wyczysc) albo `{ blad }`.
 *
 * ⚠️ WARTOSC SPRAWDZA `normalizujWartosc` — TA SAMA funkcja co karta produktu. Bez niej hurt
 * wpisalby szesciuset kartom „zielony" do parametru, ktorego lista zna tylko „czarny" i „bialy",
 * a filtr po wartosci listy przestalby te karty widziec.
 *
 * Parametr, ktorego definicji juz nie ma (usuniety w Ustawieniach miedzy otwarciem formularza
 * a zapisem), z wypelniona decyzja to odmowa — po cichu pominiety wygladalby jak zapisany.
 */
function parametryZFormularza(body, definicje) {
  const lista = [];
  const znane = new Set();
  for (const p of definicje) {
    znane.add(String(p.id));
    const surowe = poleHurtu(body, `parametr_${p.id}`);
    const wyczysc = poleHurtu(body, `parametr_${p.id}_wyczysc`);
    if (surowe === null || wyczysc === null) {
      return { blad: `${p.nazwa}: wartość przyszła dwa razy — nie wiem, którą wybrać.` };
    }
    if (wyczysc !== BRAK_POLA && wyczysc !== '' && wyczysc !== 'tak') {
      return { blad: `${p.nazwa}: nieprawidłowy wybór „wyczyść wartość”.` };
    }
    const wpisane = surowe !== BRAK_POLA && surowe.trim() !== '';
    if (wyczysc === 'tak') {
      if (wpisane) return { blad: `${p.nazwa}: wybierz wartość albo „wyczyść wartość”.` };
      lista.push({ id: p.id, nazwa: p.nazwa, typ: p.typ, jednostka: p.jednostka ?? null, wartosc: null });
      continue;
    }
    if (!wpisane) continue;
    const wynik = normalizujWartosc(p, surowe);
    if (wynik.blad) return { blad: wynik.blad };
    if (wynik.wartosc === null) continue;
    lista.push({ id: p.id, nazwa: p.nazwa, typ: p.typ, jednostka: p.jednostka ?? null, wartosc: wynik.wartosc });
  }
  for (const klucz of Object.keys(body ?? {})) {
    const dopasowanie = POLE_PARAMETRU.exec(klucz);
    if (!dopasowanie || znane.has(dopasowanie[1])) continue;
    const w = body[klucz];
    if (typeof w === 'string' && !w.trim()) continue;
    return {
      blad: `Parametru nr ${dopasowanie[1]} nie ma — mógł zostać usunięty w Ustawieniach. Otwórz edycję od nowa.`,
    };
  }
  return { lista };
}

const TRYBY_CENY = new Set(['o_procent', 'na_kwote', 'o_kwote']);
const ZAOKRAGLENIA_CENY = new Set(['grosz', '99', 'zloty']);
// Znak przed wartością: plus, minus z klawiatury albo typograficzny (wklejony z dokumentu).
const ZNAK_I_RESZTA = /^([+\-−])?\s*(.*)$/s;
const WZOR_PROCENTU = /^(\d+)(?:[.,](\d{1,2}))?$/;

/**
 * Cena katalogowa hurtem: tryb, wartość i zaokrąglenie → `{ tryb, wartosc, zaokraglenie }`
 * (procent w punktach bazowych, kwoty w groszach), `undefined` gdy nie zmieniamy ceny, albo `blad`.
 *
 * Wartość bez trybu jest odmową, a nie „nie zmieniaj”: przy pieniądzach wpisane „-10” bez
 * wybranego trybu nie może po cichu przepaść ani zostać zgadnięte.
 */
function cenaKatalogowaZFormularza(body) {
  const tryb = poleHurtu(body, 'cena_tryb');
  const wartosc = poleHurtu(body, 'cena_wartosc');
  const zaokraglenie = poleHurtu(body, 'cena_zaokraglenie');
  if (tryb === null || wartosc === null || zaokraglenie === null) {
    return { blad: 'Cena katalogowa przyszła dwa razy — nie wiem, którą wartość wybrać.' };
  }
  const t = tryb === BRAK_POLA ? '' : tryb.trim();
  const w = wartosc === BRAK_POLA ? '' : wartosc.trim();
  if (!t && !w) return {};
  if (!t) {
    return {
      blad:
        `Wpisano „${w}” przy cenie katalogowej, ale nie wybrano, co z nią zrobić. ` +
        'Wybierz „zmień o %”, „zmień na kwotę” albo „zmień o kwotę”.',
    };
  }
  if (!TRYBY_CENY.has(t)) {
    return { blad: `„${t}” to nie jest sposób zmiany ceny. Wybierz go z listy przy cenie katalogowej.` };
  }
  if (!w) {
    return {
      blad: 'Wybrano zmianę ceny katalogowej, ale nie wpisano wartości. Wpisz ją albo wybierz „— nie zmieniaj —”.',
    };
  }
  const z = zaokraglenie === BRAK_POLA ? 'grosz' : zaokraglenie.trim() || 'grosz';
  if (!ZAOKRAGLENIA_CENY.has(z)) {
    return { blad: `„${z}” to nie jest sposób zaokrąglenia ceny. Wybierz go z listy.` };
  }

  if (t === 'na_kwote') {
    const gr = groszeCenyKatalogowej(w);
    if (gr === undefined || gr === null) {
      return { blad: `„${w}” to nie jest cena w złotych. Wpisz samą kwotę, np. 49,90.` };
    }
    if (cenaPoZmianie({ gr: null, tryb: t, wartosc: gr }).blad) {
      return { blad: 'Cena katalogowa musi być większa od zera.' };
    }
    // Kwota podana wprost nie ma czego zaokrąglać.
    return { cena: { tryb: t, wartosc: gr, zaokraglenie: 'grosz' } };
  }

  const [, znak = '+', reszta] = ZNAK_I_RESZTA.exec(w);
  const ujemna = znak !== '+';
  if (t === 'o_kwote') {
    const gr = groszeCenyKatalogowej(reszta);
    if (gr === undefined || gr === null) {
      return { blad: `„${w}” to nie jest kwota w złotych. Wpisz samą kwotę ze znakiem, np. -10 albo +5,50.` };
    }
    return { cena: { tryb: t, wartosc: ujemna ? -gr : gr, zaokraglenie: z } };
  }

  const procent = WZOR_PROCENTU.exec(reszta);
  if (!procent) {
    return {
      blad: `„${w}” to nie jest procent. Wpisz liczbę ze znakiem, np. -10 albo 7,5 (najwyżej dwa miejsca po przecinku).`,
    };
  }
  const bp = Number(procent[1]) * 100 + Number(`${procent[2] ?? ''}00`.slice(0, 2));
  const wartoscBp = ujemna ? -bp : bp;
  // Zakres sprawdza ta sama funkcja, która potem liczy cenę — granice żyją w jednym miejscu.
  if (cenaPoZmianie({ gr: 10000, tryb: t, wartosc: wartoscBp }).blad === 'PROCENT_POZA_ZAKRESEM') {
    return { blad: `Zmiana ceny o ${w}% jest poza zakresem — procent musi być między −99% a +1000%.` };
  }
  return { cena: { tryb: t, wartosc: wartoscBp, zaokraglenie: z } };
}

/**
 * Tresc formularza hurtowego → POLECENIE, czyli komplet kolumn do ustawienia.
 *
 * @returns {{polecenie: object|null, blad: string|null}} `polecenie` z kluczami WYLACZNIE
 *   tych kolumn, ktore czlowiek FAKTYCZNIE wypelnil; pusty obiekt znaczy „nic nie wybrano".
 *
 * ⚠️⚠️ ODMOWA JEST CALOSCIOWA. Jedno pole, ktorego nie rozumiemy, wstrzymuje CALY zapis —
 * a nie „to, co dalo sie odczytac". Polowiczny zapis hurtem zostawialby w bazie stan,
 * o ktorym ekran mowi „nie zapisalem", i przy sześciuset kartach nikt by juz nie odtworzyl,
 * ktora polowa weszla.
 */
export function polecenieZFormularza(
  body,
  { dzis = dzienWarszawa(new Date().toISOString()), parametry: definicjeParametrow = [] } = {},
) {
  const polecenie = {};

  // ⚠️ CENTYMETRY WCHODZA, MILIMETRY LADUJA W BAZIE — przelicza `domena/rozmiar.js`, TA SAMA
  // funkcja, ktorej uzywa karta produktu. Druga kopia arytmetyki znaczylaby, ze „10,5 cm"
  // wpisane hurtem to co innego niz „10,5 cm" wpisane na karcie.
  for (const [pole, kolumna, etykieta, przelicz, nieRozumiem] of [
    ['szerokosc_cm', 'szerokosc_mm', 'Szerokość', milimetrySame, NIE_ROZUMIEM_WYMIARU],
    ['wysokosc_cm', 'wysokosc_mm', 'Wysokość', milimetrySame, NIE_ROZUMIEM_WYMIARU],
    ['glebokosc_cm', 'glebokosc_mm', 'Głębokość', milimetrySame, NIE_ROZUMIEM_WYMIARU],
    ['waga_kg', 'waga_g', 'Waga', gramySame, NIE_ROZUMIEM_WAGI],
  ]) {
    const surowe = poleHurtu(body, pole);
    const wyczysc = poleHurtu(body, `${pole}_wyczysc`);
    if (surowe === null) return { polecenie: null, blad: nieRozumiem('(pole wysłane dwa razy)') };
    if (wyczysc !== BRAK_POLA && wyczysc !== '' && wyczysc !== 'tak') {
      return { polecenie: null, blad: `${etykieta}: nieprawidłowy wybór „wyczyść wartość”.` };
    }
    // ⚠️ PUSTE ZNACZY „NIE RUSZAJ" — i tu, i nigdzie indziej. `milimetryZCentymetrow('')`
    // oddaje `{ mm: null }`, czyli „skasuj wymiar"; hurtem tej odpowiedzi NIE WOLNO uzyc,
    // wiec puste pole odsiewamy ZANIM do niej dojdzie. Kasowanie to wylacznie `_wyczysc`.
    const wpisane = surowe !== BRAK_POLA && surowe.trim() !== '';
    if (wyczysc === 'tak') {
      if (wpisane) {
        return { polecenie: null, blad: `${etykieta}: wpisz wartość albo wybierz „wyczyść wartość”.` };
      }
      polecenie[kolumna] = null;
      continue;
    }
    if (!wpisane) continue;
    const wartosc = przelicz(surowe);
    if (wartosc === null) return { polecenie: null, blad: nieRozumiem(surowe) };
    polecenie[kolumna] = wartosc;
  }

  const parametry = parametryZFormularza(body, definicjeParametrow);
  if (parametry.blad) return { polecenie: null, blad: parametry.blad };
  if (parametry.lista.length) polecenie.parametry = parametry.lista;

  const kategoria = poleHurtu(body, 'kategoria_glowna');
  if (kategoria === null) {
    return { polecenie: null, blad: 'Kategoria główna przyszła dwa razy — nie wiem, którą wybrać.' };
  }
  // Kategorii hurtem NIE DA SIE wyczyscic i to jest decyzja: puste pole znaczy „nie ruszaj",
  // a czyszczenie musialoby byc osobnym, nazwanym wyborem (jak `_wyczysc` przy wymiarach wyzej).
  if (kategoria !== BRAK_POLA && kategoria.trim()) polecenie.kategoria_glowna = kategoria.trim();

  const { marka, blad: bladMarki } = markaZFormularza(body, { hurt: true });
  if (bladMarki) return { polecenie: null, blad: bladMarki };
  if (marka !== undefined) polecenie.marka = marka;

  // Stawka VAT — WYLACZNIE z listy panelu (`czyStawkaVat`, domena/vat.js), ta sama regula co
  // formularz karty, bez „zw". Hurt stawki NIE KASUJE: karta umie, ale tutaj puste znaczy
  // „nie zmieniaj", a jawnego wyboru „skasuj stawke" ten ekran nie ma.
  const stawka = poleHurtu(body, 'stawka_vat');
  if (stawka !== BRAK_POLA) {
    if (typeof stawka !== 'string') {
      return { polecenie: null, blad: 'Stawka VAT przyszła dwa razy — nie wiem, którą wybrać.' };
    }
    const s = stawka.trim();
    if (s && !czyStawkaVat(s)) {
      return {
        polecenie: null,
        blad: `„${s}” to nie jest stawka VAT z listy. Wybierz stawkę z listy albo „nie zmieniaj”.`,
      };
    }
    if (s) polecenie.stawka_vat = s;
  }

  // Cena zakupu netto — wpis do historii „obowiązuje od”, nie kolumna karty. Pusta kwota znaczy
  // „nie zmieniaj” także przy wpisanej dacie (pole daty bywa wypełnione z góry, jak na karcie),
  // więc data bez kwoty jest ignorowana. Kwotę i dzień czytają te same funkcje co formularz karty.
  const cena = poleHurtu(body, 'cena_zakupu_netto');
  const od = poleHurtu(body, 'cena_zakupu_od');
  if (cena === null || od === null) {
    return { polecenie: null, blad: 'Cena zakupu przyszła dwa razy — nie wiem, którą wybrać.' };
  }
  if (cena !== BRAK_POLA && cena.trim()) {
    const kwota = kwotaZakupuZNapisu(cena);
    if (kwota.blad) return { polecenie: null, blad: kwota.blad };
    let dzien = dzis;
    if (od !== BRAK_POLA && od.trim()) {
      const wynik = dzienZNapisu(od);
      if (wynik.blad) return { polecenie: null, blad: wynik.blad };
      dzien = wynik.dzien;
    }
    polecenie.cenaZakupu = { gr: kwota.gr, od: dzien };
  }

  const { cena: cenaKatalogowa, blad: bladCeny } = cenaKatalogowaZFormularza(body);
  if (bladCeny) return { polecenie: null, blad: bladCeny };
  if (cenaKatalogowa) polecenie.cenaKatalogowa = cenaKatalogowa;

  const { informacja, blad: bladInformacji } = informacjaBezpieczenstwaZFormularza(body);
  if (bladInformacji) return { polecenie: null, blad: bladInformacji };
  if (informacja !== BRAK_POLA) polecenie.informacja_bezpieczenstwa = informacja;

  const surowyProg = poleHurtu(body, 'prog_niskiego_stanu');
  const bezProgu = poleHurtu(body, 'prog_niskiego_stanu_bez');
  const prog = surowyProg === BRAK_POLA ? null : parsujProg(surowyProg);
  if (prog !== null && typeof prog === 'object') {
    return {
      polecenie: null,
      blad: 'Próg niskiego stanu: wpisz liczbę całkowitą od 0 w górę albo wybierz „bez progu”.',
    };
  }
  if (bezProgu !== BRAK_POLA && bezProgu !== '' && bezProgu !== 'tak') {
    return { polecenie: null, blad: 'Próg niskiego stanu: nieprawidłowy wybór „bez progu”.' };
  }
  if (bezProgu === 'tak' && prog !== null) {
    return { polecenie: null, blad: 'Próg niskiego stanu: wpisz liczbę albo wybierz „bez progu”.' };
  }
  if (bezProgu === 'tak') polecenie.prog_niskiego_stanu = null;
  else if (prog !== null) polecenie.prog_niskiego_stanu = prog;

  return { polecenie, blad: null };
}

/**
 * Informacja o bezpieczeństwie z formularza hurtu: JSON `{typ:'TEXT', tekst}`, `null` (powrót do
 * tekstu domyślnego konta) albo `BRAK_POLA` (nie ruszaj).
 *
 * ⚠️ PUSTE POLE TEKSTU NIE ZNACZY „WRÓĆ DO DOMYŚLNEGO”. Kasowanie ma osobne, jawne pole wyboru:
 * inaczej ustawienie samej stawki VAT zdjęłoby ręczne teksty GPSR z całej zaznaczonej grupy.
 * Tekst normalizujemy tak samo jak karta (nowe linie bez `\r`, przycięcie), żeby ten sam tekst
 * wpisany hurtem i na karcie nie wyglądał na zmianę.
 */
function informacjaBezpieczenstwaZFormularza(body) {
  const tekstSurowy = poleHurtu(body, 'informacja_bezpieczenstwa');
  const domyslna = poleHurtu(body, 'informacja_bezpieczenstwa_domyslna');
  if (tekstSurowy === null || domyslna === null) {
    return { blad: 'Informacja o bezpieczeństwie przyszła dwa razy — nie wiem, którą wybrać.' };
  }
  const tekst = tekstSurowy === BRAK_POLA ? '' : tekstSurowy.replace(/\r\n?/g, '\n').trim();
  const powrot = domyslna !== BRAK_POLA && Boolean(domyslna.trim());
  if (tekst && powrot) {
    return {
      blad:
        'Informacja o bezpieczeństwie: wpisano tekst i zaznaczono powrót do tekstu domyślnego konta naraz. ' +
        'Zostaw jedno z nich.',
    };
  }
  if (tekst.length > LIMIT_INFORMACJI_BEZPIECZENSTWA) {
    return {
      blad: `Informacja o bezpieczeństwie ma ${tekst.length} znaków — Allegro przyjmie najwyżej ${LIMIT_INFORMACJI_BEZPIECZENSTWA}.`,
    };
  }
  if (powrot) return { informacja: null };
  if (tekst) return { informacja: JSON.stringify({ typ: 'TEXT', tekst }) };
  return { informacja: BRAK_POLA };
}

/**
 * Pola formularza do PRZENIESIENIA ukrytymi polami na ekran podgladu.
 *
 * ⚠️⚠️ PRZENOSIMY DECYZJE, A NIE JEJ SKUTEK. Ukryte pola niosa dokladnie to, co czlowiek
 * wpisal („70", „nie"), i nigdy gotowego zestawu „z czego na co" — ten trasa zatwierdzajaca
 * liczy PONOWNIE, ze stanu biezacego bazy. Inaczej odczyt katalogow albo druga karta miedzy
 * podgladem a kliknieciem zmienilyby zbior po cichu.
 *
 * ⚠️ WYLACZNIE PO BIALEJ LISCIE (`POLA_HURTU`), a nie po kluczach ciala zadania: pole
 * dopisane recznie do formularza nie ma prawa przejechac przez ekran podgladu do zapisu.
 * Puste pomijamy — puste znaczy „nie ruszaj", wiec nie ma czego przenosic. Parametry wlasne
 * przechodza po wzorze `POLE_PARAMETRU` (ich zbior zalezy od Ustawien); czy parametr o tym
 * numerze istnieje, sprawdza ponownie zatwierdzenie.
 */
export function polaDoPrzeniesienia(body) {
  const pary = [];
  const dodaj = (klucz) => {
    const wartosc = poleHurtu(body, klucz);
    if (wartosc === BRAK_POLA || typeof wartosc !== 'string' || !wartosc.trim()) return;
    pary.push({ name: klucz, value: wartosc });
  };
  for (const klucz of POLA_HURTU) dodaj(klucz);
  for (const klucz of Object.keys(body ?? {})) if (POLE_PARAMETRU.test(klucz)) dodaj(klucz);
  return pary;
}

// Kolejnosc kolumn na ekranie podgladu. Stala i JEDNA — dwie listy rozjechalyby sie o jedna
// pozycje, czyli „z czego na co" opisywaloby inna kolumne, niz nazywa.
const KOLUMNY = Object.freeze([
  'szerokosc_mm',
  'wysokosc_mm',
  'glebokosc_mm',
  'waga_g',
  'kategoria_glowna',
  'marka',
  'stawka_vat',
  'informacja_bezpieczenstwa',
  'prog_niskiego_stanu',
]);

// Etykieta i postac czytelna KAZDEJ kolumny — liczone TUTAJ, bo widok w tym module niczego
// nie liczy (ta sama zasada, co w magazyn-lista.ejs i magazyn-karta.ejs).
const wCentymetrach = (mm) => {
  const cm = centymetryZMilimetrow(mm);
  return cm === null ? null : `${cm} cm`;
};
const wKilogramach = (g) => {
  const kg = kilogramyZGramow(g);
  return kg === null ? null : `${kg.replace('.', ',')} kg`;
};
// Liczba parametru jest w bazie z kropka (zapis kanoniczny, po nim filtruje lista), a czlowiek
// czyta ja z przecinkiem i jednostka — tak jak na karcie.
function parametrCzytelnie(p, w) {
  if (w === null || w === undefined) return null;
  if (p.typ !== 'liczba') return w;
  const liczba = String(w).replace('.', ',');
  return p.jednostka ? `${liczba} ${p.jednostka}` : liczba;
}
const OPIS_KOLUMNY = Object.freeze({
  szerokosc_mm: { etykieta: 'Szerokość', czytelnie: wCentymetrach },
  wysokosc_mm: { etykieta: 'Wysokość', czytelnie: wCentymetrach },
  glebokosc_mm: { etykieta: 'Głębokość', czytelnie: wCentymetrach },
  waga_g: { etykieta: 'Waga', czytelnie: wKilogramach },
  kategoria_glowna: { etykieta: 'Kategoria główna', czytelnie: (w) => w || null },
  marka: { etykieta: 'Marka', czytelnie: (w) => w || null },
  // Kolumna jest tekstowa, wiec stawka „0" to napis (prawdziwy), a nie brak — wychodzi „0%".
  stawka_vat: { etykieta: 'Stawka VAT', czytelnie: (w) => (w ? `${w}%` : null) },
  // JSON w kolumnie porównujemy po treści, nie po napisie: ten sam tekst zapisany przez kartę
  // z innym odstępem albo kolejnością kluczy nie jest zmianą.
  informacja_bezpieczenstwa: {
    etykieta: 'Informacja o bezpieczeństwie',
    czytelnie: informacjaCzytelnie,
    doPorownania: informacjaDoPorownania,
  },
  prog_niskiego_stanu: {
    etykieta: 'Próg niskiego stanu',
    czytelnie: (w) => (w === null ? 'bez progu' : `${w} szt.`),
  },
});

function informacjaZJsona(w) {
  if (w === null || w === undefined || w === '') return null;
  try {
    const obiekt = JSON.parse(w);
    return obiekt && typeof obiekt === 'object' ? obiekt : { typ: null };
  } catch {
    return { typ: null };
  }
}
const SKROT_INFORMACJI = 100;
function informacjaCzytelnie(w) {
  const informacja = informacjaZJsona(w);
  if (!informacja) return 'tekst domyślny konta';
  if (informacja.typ === 'TEXT' && typeof informacja.tekst === 'string') {
    const tekst = informacja.tekst.trim();
    return tekst.length > SKROT_INFORMACJI ? `${tekst.slice(0, SKROT_INFORMACJI)}…` : tekst;
  }
  if (informacja.typ === 'ATTACHMENTS') {
    const liczba = Array.isArray(informacja.zalaczniki) ? informacja.zalaczniki.length : 0;
    return `załączniki z Allegro (${liczba})`;
  }
  return 'nieczytelny zapis';
}
function informacjaDoPorownania(w) {
  const informacja = informacjaZJsona(w);
  if (!informacja) return null;
  if (informacja.typ === 'TEXT' && typeof informacja.tekst === 'string') {
    return `TEXT:${informacja.tekst.replace(/\r\n?/g, '\n').trim()}`;
  }
  return w;
}
const maZalacznikiAllegro = (w) => informacjaZJsona(w)?.typ === 'ATTACHMENTS';

/**
 * Wartosc docelowa JEDNEJ kolumny dla JEDNEJ karty — albo `BRAK_POLA`, gdy polecenie
 * tej kolumny w ogole nie dotyczy.
 */
function wartoscDocelowa(polecenie, kolumna) {
  return Object.hasOwn(polecenie, kolumna) ? polecenie[kolumna] : BRAK_POLA;
}

/**
 * Zestaw zmian: ktore z podanych kart polecenie FAKTYCZNIE zmieni, w czym i z czego na co.
 *
 * @returns {Array<{id: number, nazwa: string, zmiany: object, opisy: Array}>}
 *
 * ⚠️⚠️ KARTA, KTORA JUZ MA TE WARTOSC, NIE WCHODZI. Podglad obiecujacy „zmienię 600"
 * i zmieniajacy 200 klamie o wlasnym skutku — a ten ekran istnieje wylacznie po to, zeby
 * czlowiek zobaczyl skutek PRZED kliknieciem. Skutek uboczny i pozadany: powtorne wyslanie
 * tego samego formularza nie przestawia juz `zmieniony_at` sześciuset kartom.
 *
 * ⚠️ TA SAMA FUNKCJA LICZY PODGLAD I ZATWIERDZENIE. Gdyby zatwierdzenie liczylo po swojemu
 * albo przepisywalo gotowy zestaw z ukrytego pola, odczyt katalogow miedzy jednym a drugim
 * zmienilby zbior po cichu — to jest ta sama zasada, ktora obowiazuje zapis do sklepow.
 */
export function zmianyHurtem(karty, polecenie, { cenyNaDzien, wartosciParametrow } = {}) {
  const { plan, blad } = planHurtu(karty, polecenie, { cenyNaDzien, wartosciParametrow });
  if (blad) throw new Error(`zmianyHurtem: ${blad}`);
  return plan;
}

// Zmiana ceny o więcej niż połowę w którąkolwiek stronę dostaje na podglądzie oznaczenie — ten sam
// próg co przy wysyłce cen do sklepów. Stała w kodzie, nie ustawienie konta: to ochrona przed
// pomyłką o rząd wielkości (np. „100” zamiast „10”), a nie reguła handlowa.
export const PROG_DUZEJ_ZMIANY_CENY_BP = 5000;

const cenaNaEkranie = (gr) => cenaPolska(zl(gr));

// Procent zmiany z jednym miejscem po przecinku, liczony z groszy na BigInt (połówką w górę).
function procentZmiany(stara, nowa) {
  const roznica = BigInt(nowa - stara);
  const bezwzgledna = roznica < 0n ? -roznica : roznica;
  const dziesiate = Number((bezwzgledna * 2000n + BigInt(stara)) / (2n * BigInt(stara)));
  return `${roznica < 0n ? '−' : '+'}${Math.floor(dziesiate / 10)},${dziesiate % 10}%`;
}

function opisCeny(stara, nowa) {
  const opis = { pole: 'Cena katalogowa', z: stara === null ? null : cenaNaEkranie(stara), na: cenaNaEkranie(nowa) };
  if (stara) {
    const roznica = BigInt(Math.abs(nowa - stara));
    opis.zmianaProcent = procentZmiany(stara, nowa);
    opis.duzaZmiana = roznica * 10000n > BigInt(PROG_DUZEJ_ZMIANY_CENY_BP) * BigInt(stara);
  }
  return opis;
}

const nazwaDoOdmowy = (karta) => `„${karta.nazwa}”${karta.sku ? ` (${karta.sku})` : ''}`;
const ODMOWA_CENY = {
  CENA_NIEDODATNIA: (karta, wynik) =>
    `Cena katalogowa karty ${nazwaDoOdmowy(karta)} spadłaby do zera albo poniżej: ${wynik.rachunek}. ` +
    'Nie zmieniłem ceny żadnej karcie — zmniejsz zmianę albo odznacz tę kartę na liście.',
  CENA_POZA_ZAKRESEM: (karta) =>
    `Cena katalogowa karty ${nazwaDoOdmowy(karta)} wyszłaby poza zakres, który panel umie zapisać. ` +
    'Nie zmieniłem ceny żadnej karcie.',
  PROCENT_POZA_ZAKRESEM: () => 'Procent zmiany ceny musi być między −99% a +1000%. Nie zmieniłem ceny żadnej karcie.',
};

/**
 * Plan hurtu: zestaw zmian (jak opisuje `zmianyHurtem`) plus to, co dotyczy ceny katalogowej.
 *
 * @returns {{ plan: Array, pominieteBezCeny: number, straciZalaczniki: number, blad: string|null }}
 *
 * ⚠️ CENA, KTÓREJ NIE DA SIĘ POLICZYĆ NA JEDNEJ KARCIE, ODMAWIA CAŁOŚCI (pusty plan). Zapis
 * „reszty” zostawiłby katalog w połowie przeceniony, a człowiek nie wiedziałby, które karty weszły.
 * Karty bez ceny przy zmianie „o %” i „o kwotę” są pominięte i policzone — nie ma od czego liczyć.
 */
export function planHurtu(karty, polecenie, { cenyNaDzien, wartosciParametrow } = {}) {
  // Parametry: obecne wartości kart z bazy (id karty → id parametru → wartość). Bez mapy każda
  // karta wyglądałaby na pustą i podgląd obiecywałby zmianę kartom, które już ją mają.
  const parametry = polecenie?.parametry ?? null;
  if (parametry && !(wartosciParametrow instanceof Map)) {
    throw new Error('zmianyHurtem: polecenie ma parametry, a brak mapy wartosciParametrow');
  }
  // Cena zakupu: „stara” to ta obowiązująca w dniu `od` (mapa id karty → grosze, liczona przez
  // wołającego na ten dzień). Bez mapy każda karta wyglądałaby na „bez ceny” i podgląd obiecywałby
  // zmianę kartom, które już ją mają — dlatego brak mapy przy cenie w poleceniu to błąd wołającego.
  const cenaZakupu = polecenie?.cenaZakupu ?? null;
  if (cenaZakupu && !(cenyNaDzien instanceof Map)) {
    throw new Error('zmianyHurtem: polecenie ma cenę zakupu, a brak mapy cenyNaDzien');
  }
  const naCeny = cenaZakupu ? `${cenaPolska(zl(cenaZakupu.gr))} od ${dzienPolski(cenaZakupu.od)}` : null;
  const cenaKatalogowa = polecenie?.cenaKatalogowa ?? null;

  const plan = [];
  let pominieteBezCeny = 0;
  let straciZalaczniki = 0;
  for (const karta of karty ?? []) {
    const zmiany = {};
    const opisy = [];

    for (const kolumna of KOLUMNY) {
      const docelowa = wartoscDocelowa(polecenie ?? {}, kolumna);
      if (docelowa === BRAK_POLA) continue;
      // `?? null` po obu stronach: kolumna nullowalna oddaje `null`, a `undefined` (kolumna
      // nieodczytana z bazy) nie ma prawa udawac zmiany.
      const biezaca = karta[kolumna] ?? null;
      const nowa = docelowa ?? null;
      const { etykieta, czytelnie, doPorownania = (w) => w } = OPIS_KOLUMNY[kolumna];
      if (doPorownania(biezaca) === doPorownania(nowa)) continue;

      zmiany[kolumna] = nowa;
      opisy.push({ pole: etykieta, z: czytelnie(biezaca), na: czytelnie(nowa) });
    }

    if (cenaKatalogowa) {
      const stara = karta.cena_gr ?? null;
      // Ta sama funkcja liczy podgląd i zatwierdzenie — trasa woła ten plan w obu przypadkach.
      const wynik = cenaPoZmianie({ gr: stara, ...cenaKatalogowa });
      if (wynik.pominieta) pominieteBezCeny += 1;
      else if (wynik.blad)
        return { plan: [], pominieteBezCeny: 0, straciZalaczniki: 0, blad: ODMOWA_CENY[wynik.blad](karta, wynik) };
      else if (wynik.gr !== stara) {
        zmiany.cena_gr = wynik.gr;
        opisy.push(opisCeny(stara, wynik.gr));
      }
    }

    const wpis = { id: karta.id, nazwa: karta.nazwa, zmiany };
    if (cenaZakupu) {
      const stara = cenyNaDzien.get(karta.id) ?? null;
      if (stara !== cenaZakupu.gr) {
        wpis.cenaZakupu = { gr: cenaZakupu.gr, od: cenaZakupu.od };
        opisy.push({ pole: 'Cena zakupu netto', z: stara === null ? null : cenaPolska(zl(stara)), na: naCeny });
      }
    }

    if (parametry) {
      const obecne = wartosciParametrow.get(karta.id);
      for (const p of parametry) {
        const stara = obecne?.get(p.id) ?? null;
        if (stara === p.wartosc) continue;
        wpis.parametry ??= {};
        wpis.parametry[p.id] = p.wartosc;
        opisy.push({ pole: p.nazwa, z: parametrCzytelnie(p, stara), na: parametrCzytelnie(p, p.wartosc) });
      }
    }

    if (opisy.length) plan.push({ ...wpis, opisy });
    // Allegro trzyma załączniki GPSR przy koncie; tekst albo powrót do domyślnego je odpina,
    // a odtworzyć je da się tylko ręcznie na karcie — podgląd musi to policzyć.
    if (Object.hasOwn(zmiany, 'informacja_bezpieczenstwa') && maZalacznikiAllegro(karta.informacja_bezpieczenstwa)) {
      straciZalaczniki += 1;
    }
  }
  return { plan, pominieteBezCeny, straciZalaczniki, blad: null };
}

/**
 * Podpis cen, od których liczył podgląd: „id:grosze” po przecinku, pusty grosz dla karty bez ceny.
 *
 * ⚠️ ZMIANA „O %” I „O KWOTĘ” NIE JEST IDEMPOTENTNA: ten sam formularz „+10%” wysłany drugi raz
 * (wstecz w przeglądarce, podwójny klik) dałby +21%. Zatwierdzenie liczy ze stanu bazy, ale tylko
 * wtedy, gdy ceny są dokładnie te z podglądu. Zwykła lista zamiast skrótu, bo zatwierdzenie
 * sprawdza tylko karty zostawione zaznaczone — podzbiór tych z podglądu.
 */
export function podpisCen(karty) {
  return [...(karty ?? [])]
    .sort((a, b) => a.id - b.id)
    .map((k) => `${k.id}:${k.cena_gr ?? ''}`)
    .join(',');
}

/** Czy każda z kart ma dziś tę samą cenę co w podpisie z podglądu (brak karty w podpisie = nie). */
export function cenyZgodneZPodpisem(karty, podpis) {
  if (typeof podpis !== 'string' || !podpis) return false;
  const zPodgladu = new Map();
  for (const para of podpis.split(',')) {
    const [id, gr, ...nadmiar] = para.split(':');
    if (gr === undefined || nadmiar.length || zPodgladu.has(id)) return false;
    zPodgladu.set(id, gr);
  }
  return (karty ?? []).every((k) => zPodgladu.get(String(k.id)) === String(k.cena_gr ?? ''));
}
