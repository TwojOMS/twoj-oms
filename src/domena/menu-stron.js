// BOCZNE MENU STRON PANELU (17.08.2026).
//
// Do tego dnia wejscia na te ekrany istnialy WYLACZNIE jako ikony w prawym gornym rogu —
// bez podpisow i bez zaznaczenia, gdzie sie jest. Dzis ta sama nazwana nawigacja zasila
// wariant desktopowy i mobilny wspolnej ramy.
//
// ⚠️ LISTA JUZ NIE MIESZKA TUTAJ — od 2026-09-12 stoi w domain/ekrany.js, bo ten sam zestaw
// ekranow rozstrzyga TAKZE o uprawnieniach (kto co widzi w strazniku). Do tego dnia stala
// TUTAJ osobno od recznie rysowanego paska ikon w layout-oms.ejs i JUZ SIE ROZJECHALY: menu
// mialo „Stali klienci" bez „Wiadomosci", pasek odwrotnie. Dopoki to byla nawigacja, byla to
// kosmetyka — przy uprawnieniach ekran pominiety na liscie jest ekranem BEZ PTASZKA. Ten
// plik zostaje przy jednej robocie: mowieniu, GDZIE JESTES (`wSekcji`, `menuStron`).
//
// ⚠️ BEZ LICZNIKOW W TYM PLIKU (decyzja właściciela). Menu NAZYWA strony, nie mierzy ich. Liczby przy
// statusach zamowien dokladaja: lista i karta (`panelStatusow`) oraz — na pozostalych zakladkach —
// pipeline (`licznikiStatusow`, PRZ-085).

import { EKRANY, ekranDlaAdresu, maDostepDoEkranu } from './ekrany.js';
import { ETYKIETY } from './status.js';

export const DZIALY = [
  { klucz: 'sprzedaz', etykieta: 'Sprzedaż' },
  { klucz: 'magazyn', etykieta: 'Magazyn' },
  { klucz: 'analizy-cele', etykieta: 'Analizy i cele' },
];

const STATUSY = [
  { klucz: 'do_zrobienia', etykieta: 'Do zrobienia', href: '/' },
  { klucz: 'wszystkie', etykieta: 'Wszystkie', href: '/?wszystkie=1' },
  { klucz: 'po_terminie', etykieta: 'Po terminie', href: '/?po_terminie=1' },
  ...Object.entries(ETYKIETY).map(([klucz, etykieta]) => ({
    klucz, etykieta, href: `/?status=${klucz}`,
  })),
];

// `konto=null` zachowuje historyczne znaczenie pierwszego startu: nawigacja jest pelna,
// zanim w bazie powstanie pierwszy czynny admin. Sam helper capability pozostaje fail-closed.
const maPrawoNawigacji = (konto, klucz) => !konto || maDostepDoEkranu(konto, klucz);

const pozycjeHistoryczne = () => EKRANY
  .filter((ekran) => ekran.href && ekran.nawigacja)
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
 * @param {{ sciezka?: string, konto?: any, menu?: readonly import('../core/kontrakty.ts').PozycjaMenu[], odlozoneEkrany?: readonly string[] }} [opcje]
 */
export function nawigacjaDla({ sciezka = '/', konto = null, menu, odlozoneEkrany = [] } = {}) {
  const ekranKlucz = ekranDlaAdresu(sciezka);
  const ekran = EKRANY.find((pozycja) => pozycja.klucz === ekranKlucz) ?? null;
  const kandydaci = menu === undefined ? [
    ...pozycjeHistoryczne(),
    { klucz: 'ustawienia', href: '/ustawienia', etykieta: 'Ustawienia', dzial: 'ustawienia' },
  ] : menu.map(p => ({
    klucz: p.uprawnienie, etykieta: p.etykieta, href: p.adres,
    dzial: p.dzial, grupa: p.grupa, kolejnosc: p.kolejnosc,
  })).sort((a,b) => a.kolejnosc-b.kolejnosc);
  const odlozone = new Set(odlozoneEkrany);
  const pozycje = kandydaci.filter(p => !odlozone.has(p.klucz) && maPrawoNawigacji(konto,p.klucz));
  // Dokumenty zamówienia nie mają własnego linku, ale nadal należą do Sprzedaży.
  const aktywnyDzial = kandydaci.find(p => p.klucz === ekranKlucz && p.dzial !== 'ustawienia')?.dzial
    ?? (ekran?.href === null ? ekran.nawigacja?.dzial : null) ?? null;
  const ustawienia = pozycje.find(p => p.klucz === 'ustawienia');
  const dzialy = DZIALY.flatMap((dzial) => {
    const widoczne = pozycje.filter((pozycja) => pozycja.dzial === dzial.klucz);
    if (!widoczne.length) return [];
    return [{ ...dzial, href: widoczne[0].href, aktywny: dzial.klucz === aktywnyDzial }];
  });

  const kontekstPozycje = pozycje.filter((pozycja) => pozycja.dzial === aktywnyDzial);
  const grupy = [...new Set(kontekstPozycje.map((pozycja) => pozycja.grupa))].map((grupa) => ({
    klucz: grupa,
    etykieta: grupa === 'obsluga' ? 'Obsługa sprzedaży' : null,
    pozycje: kontekstPozycje
      .filter((pozycja) => pozycja.grupa === grupa && pozycja.klucz !== 'zamowienia')
      .map(({ dzial: _dzial, grupa: _grupa, kolejnosc: _kolejnosc, ...pozycja }) => ({
        ...pozycja, aktywna: pozycja.klucz === ekranKlucz,
      })),
  })).filter((grupa) => grupa.pozycje.length);

  return {
    // Jedno menu wszystkich dostępnych ekranów, na każdej zakładce.
    // Źródłem i filtrem praw pozostają manifesty oraz maPrawoNawigacji powyżej.
    boczne: [
      { klucz: 'obsluga', etykieta: 'Obsługa sklepu', dzialy: ['sprzedaz', 'magazyn'] },
      { klucz: 'rozwoj', etykieta: 'Rozwój i finanse', dzialy: ['analizy-cele'] },
    ].flatMap(grupa => {
      const lista = grupa.dzialy.flatMap(dzial => pozycje.filter(p => p.dzial === dzial));
      return lista.length ? [{ klucz: grupa.klucz, etykieta: grupa.etykieta,
        pozycje: lista.map(p => ({ ...p, aktywna: p.klucz === ekranKlucz })) }] : [];
    }),
    dzialy,
    kontekst: aktywnyDzial ? {
      dzial: aktywnyDzial,
      statusy: aktywnyDzial === 'sprzedaz' && pozycje.some(p => p.klucz === 'zamowienia')
        ? STATUSY.map((status) => ({ ...status, aktywna: false }))
        : [],
      grupy,
    } : null,
    ustawienia: ustawienia ? {
      href: ustawienia.href, etykieta: ustawienia.etykieta, aktywna: ekranKlucz === 'ustawienia',
    } : null,
  };
}

// ⚠️ Kolejnosc i tresc pochodza WYLACZNIE z EKRANY — nie dopisuj tu nic recznie. Pozycja
// dopisana tylko tutaj byloby dokladnie tym bledem, ktory ten plik mial przestac powtarzac.
export const STRONY = EKRANY
  .filter((e) => e.href !== null)
  .map((e) => ({
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
    aktywna: sekcja ? (czysta === href || wSekcji(czysta, sekcja)) : wSekcji(czysta, href),
  }));
}
