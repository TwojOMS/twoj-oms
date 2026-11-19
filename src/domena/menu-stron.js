// BOCZNE MENU STRON PANELU.
//
// Wejscia na te ekrany to nazwana nawigacja z podpisami i zaznaczeniem, gdzie sie jest —
// a nie same ikony w rogu. Ta sama nawigacja zasila wariant desktopowy i mobilny wspolnej ramy.
//
// ⚠️ LISTA NIE MIESZKA TUTAJ — stoi w domena/ekrany.js, bo ten sam zestaw ekranow rozstrzyga
// TAKZE o uprawnieniach (kto co widzi w strazniku). Lista trzymana osobno od recznie
// rysowanego paska ikon w layout-oms.ejs rozjechala sie: menu mialo „Stali klienci"
// bez „Wiadomosci", pasek odwrotnie. Dopoki to byla nawigacja, byla to
// kosmetyka — przy uprawnieniach ekran pominiety na liscie jest ekranem BEZ PTASZKA. Ten
// plik zostaje przy jednej robocie: mowieniu, GDZIE JESTES (`wSekcji`, `menuStron`).
//
// ⚠️ BEZ LICZNIKOW W TYM PLIKU. Menu NAZYWA strony, nie mierzy ich. Liczby przy
// statusach zamowien dokladaja: lista i karta (`panelStatusow`) oraz — na pozostalych zakladkach —
// pipeline (`licznikiStatusow`).

import { EKRANY, ekranDlaAdresu, maDostepDoEkranu } from './ekrany.js';
import { ETYKIETY } from './status.js';

export const DZIALY = [
  { klucz: 'sprzedaz', etykieta: 'Sprzedaż' },
  { klucz: 'magazyn', etykieta: 'Magazyn' },
  { klucz: 'analizy-cele', etykieta: 'Analizy i cele' },
];

const statusyMenu = (etykiety) => [
  { klucz: 'do_zrobienia', etykieta: 'Do zrobienia', href: '/' },
  { klucz: 'wszystkie', etykieta: 'Wszystkie', href: '/?wszystkie=1' },
  { klucz: 'po_terminie', etykieta: 'Po terminie', href: '/?po_terminie=1' },
  ...Object.entries(etykiety).map(([klucz, etykieta]) => ({
    klucz,
    etykieta,
    href: `/?status=${klucz}`,
  })),
];

// `konto=null` zachowuje historyczne znaczenie pierwszego startu: nawigacja jest pelna,
// zanim w bazie powstanie pierwszy czynny admin. Sam helper capability pozostaje fail-closed.
const maPrawoNawigacji = (konto, klucz) => !konto || maDostepDoEkranu(konto, klucz);

const pozycjeHistoryczne = () =>
  EKRANY.filter((ekran) => ekran.href && ekran.nawigacja)
    .map((ekran) => ({
      klucz: ekran.klucz,
      etykieta: ekran.nawigacja.etykieta ?? ekran.etykieta,
      href: ekran.href,
      dzial: ekran.nawigacja.dzial,
      grupa: ekran.nawigacja.grupa,
      kolejnosc: ekran.nawigacja.kolejnosc,
    }))
    .sort((a, b) => a.kolejnosc - b.kolejnosc);

/** HTTP przekazuje zebrane Aplikacja.menu; brak argumentu zachowuje historyczne API helpera.
 * @param {{ sciezka?: string, konto?: any, menu?: readonly import('../core/kontrakty.ts').PozycjaMenu[], odlozoneEkrany?: readonly string[], etykietyStatusow?: Record<string,string> }} [opcje]
 */
export function nawigacjaDla({
  sciezka = '/',
  konto = null,
  menu,
  odlozoneEkrany = [],
  etykietyStatusow = ETYKIETY,
} = {}) {
  const ekranKlucz = ekranDlaAdresu(sciezka);
  const ekran = EKRANY.find((pozycja) => pozycja.klucz === ekranKlucz) ?? null;
  const kandydaci =
    menu === undefined
      ? [
          ...pozycjeHistoryczne(),
          { klucz: 'ustawienia', href: '/ustawienia', etykieta: 'Ustawienia', dzial: 'ustawienia' },
        ]
      : menu
          .map((p) => ({
            klucz: p.uprawnienie,
            etykieta: p.etykieta,
            href: p.adres,
            dzial: p.dzial,
            grupa: p.grupa,
            kolejnosc: p.kolejnosc,
          }))
          .sort((a, b) => a.kolejnosc - b.kolejnosc);
  const odlozone = new Set(odlozoneEkrany);
  const pozycje = kandydaci.filter((p) => !odlozone.has(p.klucz) && maPrawoNawigacji(konto, p.klucz));
  const biezaca = (p) => (p.klucz === ekranKlucz ? (sciezka.split('?')[0] === p.href ? 'page' : 'true') : null);
  const dzieciFaktur = ['faktury', 'okresy', 'koszty'].flatMap((klucz) =>
    pozycje
      .filter((p) => p.klucz === klucz && (klucz === 'faktury' || p.grupa === 'faktury'))
      .map((p) => ({ ...p, etykieta: klucz === 'faktury' ? 'Wystawione' : p.etykieta, biezaca: biezaca(p) })),
  );
  const maFaktury = pozycje.some((p) => p.klucz === 'faktury');
  // Podmenu Magazynu — Produkty, Kategorie, Producenci (marki mieszkają w sekcji ekranu Producenci). Strona
  // słownika jest „page” tylko pod własnym adresem; Produkty zostają bieżące na liście i kartach, ale nie na
  // stronach słowników.
  const adres = sciezka.split('?')[0];
  // `/magazyn/ustawienia…` i `/magazyn/cenniki…` mają klucz ekranu „ustawienia”, ale w menu należą do Magazynu.
  const wUstawieniachMagazynu = wSekcji(adres, '/magazyn/ustawienia') || wSekcji(adres, '/magazyn/cenniki');
  const podstronyMagazynu = (p) => {
    const slowniki = [
      { href: '/magazyn/kategorie', etykieta: 'Kategorie' },
      // Mapowanie marki na Allegro (…/marki/<marka>/allegro) to podstrona sekcji Marki, więc należy do Producentów.
      { href: '/magazyn/producenci', etykieta: 'Producenci', podstrony: ['/magazyn/marki/'] },
      // Cenniki i ustawienia magazynu otwiera to samo uprawnienie co Ustawienia ogólne.
      ...(maPrawoNawigacji(konto, 'ustawienia')
        ? [
            { href: '/magazyn/cenniki', etykieta: 'Cenniki' },
            { href: '/magazyn/ustawienia', etykieta: 'Ustawienia' },
          ]
        : []),
    ]
      // Podstrona słownika (np. …/kategorie/<nazwa>/allegro) — słownik bieżący jako „true”.
      .map(({ podstrony = [], ...s }) => ({
        ...s,
        biezaca:
          adres === s.href
            ? 'page'
            : [`${s.href}/`, ...podstrony].some((poczatek) => adres.startsWith(poczatek))
              ? 'true'
              : null,
      }));
    return [
      { href: '/magazyn', etykieta: 'Produkty', biezaca: slowniki.some((s) => s.biezaca) ? null : biezaca(p) },
      ...slowniki,
    ];
  };
  // Dokumenty zamówienia nie mają własnego linku, ale nadal należą do Sprzedaży.
  const aktywnyDzial =
    (wUstawieniachMagazynu ? 'magazyn' : null) ??
    kandydaci.find((p) => p.klucz === ekranKlucz && p.dzial !== 'ustawienia')?.dzial ??
    (ekran?.href === null ? ekran.nawigacja?.dzial : null) ??
    null;
  const ustawienia = pozycje.find((p) => p.klucz === 'ustawienia');
  const dzialy = DZIALY.flatMap((dzial) => {
    const widoczne = pozycje.filter((pozycja) => pozycja.dzial === dzial.klucz);
    if (!widoczne.length) return [];
    return [{ ...dzial, href: widoczne[0].href, aktywny: dzial.klucz === aktywnyDzial }];
  });

  const kontekstPozycje = pozycje.filter((pozycja) => pozycja.dzial === aktywnyDzial);
  const grupy = [...new Set(kontekstPozycje.map((pozycja) => pozycja.grupa))]
    .map((grupa) => ({
      klucz: grupa,
      etykieta: grupa === 'obsluga' ? 'Obsługa sprzedaży' : null,
      pozycje: kontekstPozycje
        .filter((pozycja) => pozycja.grupa === grupa && pozycja.klucz !== 'zamowienia')
        .map(({ dzial: _dzial, grupa: _grupa, kolejnosc: _kolejnosc, ...pozycja }) => ({
          ...pozycja,
          aktywna: pozycja.klucz === ekranKlucz,
        })),
    }))
    .filter((grupa) => grupa.pozycje.length);

  // Menu boczne niesie pracę przy zamówieniach i klientach oraz analizy (dział `analizy-cele`) jako JEDNĄ
  // pozycję „Analityka” z podmenu. Pozycje filtruje to samo `pozycje` co wyżej (prawa i `odlozoneEkrany`),
  // więc pusta grupa i pusty przycisk po prostu znikają.
  // Bieżąca podstrona po ADRESIE, nie po kluczu prawa: Podsumowanie (`/analityka`) i Raporty dzielą prawo `raporty`.
  const podAdresem = (p) => adres === p.href || adres.startsWith(`${p.href}/`);
  const analizy = pozycje.filter((p) => p.dzial === 'analizy-cele').map((p) => ({ ...p, aktywna: podAdresem(p) }));
  const analityka = analizy.length
    ? {
        klucz: 'analityka',
        etykieta: 'Analityka',
        href: analizy[0].href,
        aktywna: analizy.some((p) => p.aktywna),
        biezaca: analizy.some((p) => p.aktywna) ? (adres === analizy[0].href ? 'page' : 'true') : null,
        podmenu: analizy.map((p) => ({
          href: p.href,
          etykieta: p.etykieta,
          biezaca: adres === p.href ? 'page' : podAdresem(p) ? 'true' : null,
        })),
      }
    : null;

  return {
    // Kolejność w grupie: kolejność działów niżej, w dziale — `kolejnosc` z manifestu. Grupę „Klienci” wyznacza
    // pole `grupa: 'klienci'`; wszystko inne z działów Sprzedaż i Magazyn zostaje przy zamówieniach.
    boczne: [
      { klucz: 'obsluga', etykieta: 'Obsługa zamówień', klienci: false },
      { klucz: 'klienci', etykieta: 'Klienci', klienci: true },
    ]
      .flatMap((grupa) => {
        const lista = ['sprzedaz', 'magazyn'].flatMap((dzial) =>
          pozycje.filter(
            (p) =>
              p.dzial === dzial && (p.grupa === 'klienci') === grupa.klienci && !(maFaktury && p.grupa === 'faktury'),
          ),
        );
        return lista.length
          ? [
              {
                klucz: grupa.klucz,
                etykieta: grupa.etykieta,
                pozycje: lista.map((p) => ({
                  ...p,
                  biezaca: biezaca(p) || (p.klucz === 'faktury' && dzieciFaktur.some((d) => d.biezaca) ? 'true' : null),
                  aktywna:
                    p.klucz === ekranKlucz ||
                    (p.klucz === 'magazyn' && wUstawieniachMagazynu) ||
                    (p.klucz === 'faktury' && dzieciFaktur.some((d) => d.biezaca)),
                  ...(p.klucz === 'faktury' && dzieciFaktur.length > 1 ? { podmenu: dzieciFaktur } : {}),
                  ...(p.klucz === 'magazyn' ? { podstrony: podstronyMagazynu(p) } : {}),
                })),
              },
            ]
          : [];
      })
      .concat(analityka ? [{ klucz: 'wyniki', etykieta: 'Wyniki', pozycje: [analityka] }] : []),
    // Lista podstron analiz zostaje w modelu (ekran Analityka i testy z niej korzystają); układ nie rysuje jej
    // ani w górnym pasku, ani jako zakładek nad treścią.
    analizy: analizy.length
      ? { etykieta: 'Analityka', aktywna: analizy.some((p) => p.aktywna), pozycje: analizy }
      : null,
    dzialy,
    // Sam adres nie włącza układu Ustawień: odmowy i 404 nie używają ich nawigacji.
    kontekstUstawien: /^\/ustawienia(?:[/?]|$)/.test(sciezka)
      ? {
          statusy: pozycje.some((p) => p.klucz === 'zamowienia') ? statusyMenu(etykietyStatusow) : [],
        }
      : null,
    kontekst: aktywnyDzial
      ? {
          dzial: aktywnyDzial,
          statusy: pozycje.some((p) => p.klucz === 'zamowienia')
            ? statusyMenu(etykietyStatusow).map((status) => ({ ...status, aktywna: false }))
            : [],
          grupy,
        }
      : null,
    ustawienia: ustawienia
      ? {
          href: ustawienia.href,
          etykieta: ustawienia.etykieta,
          aktywna: ekranKlucz === 'ustawienia' && !wUstawieniachMagazynu,
        }
      : null,
  };
}

// ⚠️ Kolejnosc i tresc pochodza WYLACZNIE z EKRANY — nie dopisuj tu nic recznie. Pozycja
// dopisana tylko tutaj byloby dokladnie tym bledem, ktory ten plik mial przestac powtarzac.
export const STRONY = EKRANY.filter((e) => e.href !== null).map((e) => ({
  href: e.href,
  etykieta: e.etykieta,
  klucz: e.klucz,
  // „Zamowienia" ma adres `/`, wiec dopasowanie po prefiksie zaznaczaloby je NA KAZDYM
  // ekranie. Ta jedna pozycja rozpoznaje sie inaczej: sama „/" albo cokolwiek pod
  // „/zamowienia" (karta zamowienia zyje wlasnie tam).
  sekcja: e.href === '/' ? '/zamowienia' : undefined,
}));

/** Czy `sciezka` nalezy do sekcji `prefiks` — sam ekran albo cokolwiek pod nim. */
const wSekcji = (sciezka, prefiks) => sciezka === prefiks || sciezka.startsWith(`${prefiks}/`);

/**
 * Pozycje menu dla biezacej sciezki. Dokladnie jedna jest `aktywna` na kazdym znanym
 * ekranie — zero znaczy „menu nie mowi, gdzie jestes", a dwie znacza, ze mowi nieprawde.
 *
 * ⚠️ PODSTRONA ZAZNACZA SWOJA SEKCJE: `/finanse/dane` swieci „Finanse", `/okresy/7`
 * swieci „Okresy". Inaczej menu gasnie dokladnie wtedy, gdy operator wszedl glebiej —
 * czyli gdy najbardziej potrzebuje wiedziec, gdzie jest.
 *
 * Nieznany adres (stary link, literowka) nie zaznacza NICZEGO. Wskazanie przypadkowej
 * strony byloby gorsze niz milczenie.
 */
export function menuStron(sciezka = '/') {
  const czysta = String(sciezka).split('?')[0] || '/';
  return STRONY.map(({ href, etykieta, sekcja }) => ({
    href,
    etykieta,
    aktywna: sekcja ? czysta === href || wSekcji(czysta, sekcja) : wSekcji(czysta, href),
  }));
}
