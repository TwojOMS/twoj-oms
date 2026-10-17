import { milimetryZCentymetrow, centymetryZMilimetrow, nazwaBezRozmiaru } from './rozmiar.js';
import { PACZKOMAT_WARTOSCI } from './paczkomat.js';

// EDYCJA HURTEM W MAGAZYNIE — reguly czyste. Zadnej bazy, zadnego HTTP: tutaj rozstrzyga
// sie WYLACZNIE, co formularz znaczy i ktore karty ta tresc faktycznie zmieni.
//
// PO CO TEN EKRAN ISTNIEJE (zmierzone na produkcji 2026-08-12): 645 kart bez wymiaru,
// 965 bez oznaczenia paczkomatu, 152 bez kategorii glownej. Bez niego trzeba by otworzyc
// 645 kart po kolei.
//
// ⚠️⚠️ PUSTE POLE ZNACZY „NIE RUSZAJ" — I JEST TO ODWROTNIE NIZ NA KARCIE PRODUKTU. Tam puste
// pole KASUJE wartosc i jest to bezpieczne, bo czlowiek patrzy na jedna karte i widzi, co robi.
// Tutaj formularz ma kilka pol naraz: gdyby puste kasowalo, ustawienie samego paczkomatu
// WYCZYSCILOBY WYMIARY I KATEGORIE 600 KARTOM jednym kliknieciem, bez sladu i bez mozliwosci
// cofniecia. To jest warunek bezpieczenstwa, a nie preferencja.
//
// ⚠️ KASOWANIE HURTEM MUSI BYC OSOBNYM, JAWNYM WYBOREM — nigdy skutkiem pustego pola.
// Jedyne takie miejsce nizej to paczkomat 'nieoznaczone': to on jest droga powrotu po
// hurtowej pomylce na sześciuset kartach, wiec musi istniec i musi byc nazwany.

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
  'szerokosc_cm', 'wysokosc_cm', 'kategoria_glowna', 'paczkomat', 'nazwa_bez_rozmiaru',
]);

// Wartosc pola wyboru paczkomatu, ktora JAWNIE kasuje decyzje i wraca do stanu „jeszcze
// nieoznaczone". ⚠️ To jest CO INNEGO niz pole puste: puste znaczy „nie ruszaj".
const PACZKOMAT_KASUJACY = 'nieoznaczone';

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

const NIE_ROZUMIEM_WYMIARU = (surowe) => `„${surowe}" to nie jest wymiar w centymetrach. `
  + 'Wpisz samą liczbę (np. 70 albo 10,5) albo zostaw pole puste — puste pole hurtem '
  + 'znaczy „nie ruszaj tej kolumny", a nie „skasuj ją".';

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
export function polecenieZFormularza(body) {
  const polecenie = {};

  // ⚠️ CENTYMETRY WCHODZA, MILIMETRY LADUJA W BAZIE — przelicza `domain/rozmiar.js`, TA SAMA
  // funkcja, ktorej uzywa karta produktu. Druga kopia arytmetyki znaczylaby, ze „10,5 cm"
  // wpisane hurtem to co innego niz „10,5 cm" wpisane na karcie.
  for (const [pole, kolumna] of [['szerokosc_cm', 'szerokosc_mm'], ['wysokosc_cm', 'wysokosc_mm']]) {
    const surowe = poleHurtu(body, pole);
    if (surowe === BRAK_POLA) continue;
    if (surowe === null) return { polecenie: null, blad: NIE_ROZUMIEM_WYMIARU('(pole wysłane dwa razy)') };
    // ⚠️ PUSTE ZNACZY „NIE RUSZAJ" — i tu, i nigdzie indziej. `milimetryZCentymetrow('')`
    // oddaje `{ mm: null }`, czyli „skasuj wymiar"; hurtem tej odpowiedzi NIE WOLNO uzyc,
    // wiec puste pole odsiewamy ZANIM do niej dojdzie.
    if (!surowe.trim()) continue;
    const wynik = milimetryZCentymetrow(surowe);
    if (!wynik || wynik.mm === null) return { polecenie: null, blad: NIE_ROZUMIEM_WYMIARU(surowe) };
    polecenie[kolumna] = wynik.mm;
  }

  const kategoria = poleHurtu(body, 'kategoria_glowna');
  if (kategoria === null) {
    return { polecenie: null, blad: 'Kategoria główna przyszła dwa razy — nie wiem, którą wybrać.' };
  }
  // Kategorii hurtem NIE DA SIE wyczyscic i to jest decyzja: puste pole znaczy „nie ruszaj",
  // a czyszczenie musialoby byc osobnym, nazwanym wyborem (jak przy paczkomacie nizej).
  if (kategoria !== BRAK_POLA && kategoria.trim()) polecenie.kategoria_glowna = kategoria.trim();

  // ⚠️ PACZKOMAT WYLACZNIE RECZNIE, TRZY STANY, ZERO WYLICZANIA Z WYMIAROW (decyzja
  // wlasciciela). Droga typowa to zaznaczyc duza grupe i ustawic „nie", a wyjatki poprawic
  // pojedynczo. Czwarta wartosc w kolumnie zepsulaby filtr „bez oznaczenia paczkomatu" —
  // karta z napisem „moze" nie bylaby ani oznaczona, ani nieoznaczona.
  const paczkomat = poleHurtu(body, 'paczkomat');
  if (paczkomat !== BRAK_POLA) {
    if (typeof paczkomat !== 'string') {
      return { polecenie: null, blad: 'Paczkomat przyszedł dwa razy — nie wiem, którą wartość wybrać.' };
    }
    const p = paczkomat.trim();
    if (p === PACZKOMAT_KASUJACY) polecenie.paczkomat = null;
    else if (PACZKOMAT_WARTOSCI.has(p)) polecenie.paczkomat = p;
    else if (p) {
      return {
        polecenie: null,
        blad: `„${p}" nie jest oznaczeniem paczkomatu. Wybierz „tak", „nie" albo `
          + `„${PACZKOMAT_KASUJACY}".`,
      };
    }
  }

  // Skrocenie nazwy o rozmiar. ⚠️ WYLACZNIE W REJESTRZE MAGAZYNU — nazwa NIE JEDZIE do
  // sklepu (decyzja wlasciciela): jest zaindeksowanym tytulem strony, a czesc katalogu
  // wlasnie przeniesiono do drugiego sklepu z przekierowaniami 301.
  const skroc = poleHurtu(body, 'nazwa_bez_rozmiaru');
  if (skroc !== BRAK_POLA && typeof skroc === 'string' && skroc.trim()) {
    polecenie.nazwaBezRozmiaru = true;
  }

  return { polecenie, blad: null };
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
 * Puste pomijamy — puste znaczy „nie ruszaj", wiec nie ma czego przenosic.
 */
export function polaDoPrzeniesienia(body) {
  const pary = [];
  for (const klucz of POLA_HURTU) {
    const wartosc = poleHurtu(body, klucz);
    if (wartosc === BRAK_POLA || typeof wartosc !== 'string' || !wartosc.trim()) continue;
    pary.push({ name: klucz, value: wartosc });
  }
  return pary;
}

// Kolejnosc kolumn na ekranie podgladu. Stala i JEDNA — dwie listy rozjechalyby sie o jedna
// pozycje, czyli „z czego na co" opisywaloby inna kolumne, niz nazywa.
const KOLUMNY = Object.freeze(['nazwa', 'szerokosc_mm', 'wysokosc_mm', 'kategoria_glowna', 'paczkomat']);

// Etykieta i postac czytelna KAZDEJ kolumny — liczone TUTAJ, bo widok w tym module niczego
// nie liczy (ta sama zasada, co w magazyn-lista.ejs i magazyn-karta.ejs).
const wCentymetrach = (mm) => {
  const cm = centymetryZMilimetrow(mm);
  return cm === null ? null : `${cm} cm`;
};
const OPIS_KOLUMNY = Object.freeze({
  nazwa: { etykieta: 'Nazwa', czytelnie: (w) => w || null },
  szerokosc_mm: { etykieta: 'Szerokość', czytelnie: wCentymetrach },
  wysokosc_mm: { etykieta: 'Wysokość', czytelnie: wCentymetrach },
  kategoria_glowna: { etykieta: 'Kategoria główna', czytelnie: (w) => w || null },
  // ⚠️ Brak oznaczenia to STAN, a nie brak danych — i musi byc nazwany po imieniu, bo
  // wlasnie miedzy nim a „nie" przebiega cala roznica tej kolumny.
  paczkomat: { etykieta: 'Paczkomat', czytelnie: (w) => w || 'nieoznaczone' },
});

/**
 * Wartosc docelowa JEDNEJ kolumny dla JEDNEJ karty — albo `BRAK_POLA`, gdy polecenie
 * tej kolumny w ogole nie dotyczy.
 *
 * `nazwa` jest jedyna kolumna liczona Z KARTY, a nie ze stalej: skrocenie o rozmiar daje
 * kazdej karcie INNA nowa nazwe (i wielu z nich — te sama, co dotad).
 */
function wartoscDocelowa(karta, polecenie, kolumna) {
  if (kolumna === 'nazwa') {
    return polecenie.nazwaBezRozmiaru ? nazwaBezRozmiaru(karta.nazwa) : BRAK_POLA;
  }
  return Object.hasOwn(polecenie, kolumna) ? polecenie[kolumna] : BRAK_POLA;
}

/**
 * Zestaw zmian: ktore z podanych kart polecenie FAKTYCZNIE zmieni, w czym i z czego na co.
 *
 * @returns {Array<{id: number, nazwa: string, zmiany: object, opisy: Array}>}
 *
 * ⚠️⚠️ KARTA, KTORA JUZ MA TE WARTOSC, NIE WCHODZI. Podglad obiecujacy „zmienię 645"
 * i zmieniajacy 200 klamie o wlasnym skutku — a ten ekran istnieje wylacznie po to, zeby
 * czlowiek zobaczyl skutek PRZED kliknieciem. Skutek uboczny i pozadany: powtorne wyslanie
 * tego samego formularza nie przestawia juz `zmieniony_at` sześciuset kartom.
 *
 * ⚠️ TA SAMA FUNKCJA LICZY PODGLAD I ZATWIERDZENIE. Gdyby zatwierdzenie liczylo po swojemu
 * albo przepisywalo gotowy zestaw z ukrytego pola, odczyt katalogow miedzy jednym a drugim
 * zmienilby zbior po cichu — to jest ta sama zasada, ktora obowiazuje zapis do sklepow.
 */
export function zmianyHurtem(karty, polecenie) {
  const plan = [];
  for (const karta of karty ?? []) {
    const zmiany = {};
    const opisy = [];

    for (const kolumna of KOLUMNY) {
      const docelowa = wartoscDocelowa(karta, polecenie ?? {}, kolumna);
      if (docelowa === BRAK_POLA) continue;
      // `?? null` po obu stronach: kolumna nullowalna oddaje `null`, a `undefined` (kolumna
      // nieodczytana z bazy) nie ma prawa udawac zmiany.
      const biezaca = karta[kolumna] ?? null;
      const nowa = docelowa ?? null;
      if (biezaca === nowa) continue;

      zmiany[kolumna] = nowa;
      const { etykieta, czytelnie } = OPIS_KOLUMNY[kolumna];
      opisy.push({ pole: etykieta, z: czytelnie(biezaca), na: czytelnie(nowa) });
    }

    if (opisy.length) plan.push({ id: karta.id, nazwa: karta.nazwa, zmiany, opisy });
  }
  return plan;
}
