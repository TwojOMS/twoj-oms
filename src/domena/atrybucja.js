// SKAD PRZYSZLO ZAMOWIENIE — WooCommerce Order Attribution (Etap 3 kampanii, 2026-08-25).
//
// Sklep zapisuje przy kazdym zamowieniu, skad przyszedl kupujacy: rodzaj zrodla, adres
// odsylajacy, strone wejscia, urzadzenie i wielkosc sesji. Panel mial te dane w
// `surowe_json` od zawsze i ich NIE POKAZYWAL — ta domena je z niego wyjmuje, tak samo
// jak `kupony.js` wyjmuje kupony (jedna regula, czytana przez pollera i przez przeliczenie
// wstecz, nigdy dwie kopie).
//
// ⚠️⚠️ `null` (brak atrybucji) TO CO INNEGO NIZ „wejscie bezposrednie". 21 produkcyjnych
// zamowien powstalo PRZED wlaczeniem tej funkcji w sklepie (na PRO dopiero 31.07.2026)
// i o ich zrodle nie dowiemy sie juz nigdy. Zlanie tych dwoch stanow w jeden zamienialoby
// luke w danych w falszywy fakt „klient wszedl wprost".
//
// ⚠️ USER AGENTA CELOWO NIE PRZENOSIMY. Urzadzenie mamy osobnym polem, a pelny user agent
// to dana osobowa o znikomej wartosci operacyjnej — karta zamowienia bywa ogladana przy
// kliencie i przy kurierze.

const PREFIKS = '_wc_order_attribution_';

const wartoscMeta = (surowe, nazwa) => {
  const m = surowe?.meta_data?.find((x) => x.key === `${PREFIKS}${nazwa}`);
  const v = m?.value;
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

const liczbaMeta = (surowe, nazwa) => {
  const v = wartoscMeta(surowe, nazwa);
  const n = Number(v);
  return v !== null && Number.isFinite(n) ? n : null;
};

export function atrybucjaZeSurowych(surowe) {
  const typ = wartoscMeta(surowe, 'source_type');
  const zrodlo = wartoscMeta(surowe, 'utm_source');
  // Wlacznikiem jest OBECNOSC ktoregokolwiek z dwoch pol rozstrzygajacych o zrodle.
  // Samo `session_pages` bez nich nie opisuje zrodla, wiec nie czyni atrybucji.
  if (!typ && !zrodlo) return null;
  return {
    typ,
    zrodlo,
    medium: wartoscMeta(surowe, 'utm_medium'),
    kampania: wartoscMeta(surowe, 'utm_campaign'),
    odsylacz: wartoscMeta(surowe, 'referrer'),
    wejscie: wartoscMeta(surowe, 'session_entry'),
    start: wartoscMeta(surowe, 'session_start_time'),
    stron: liczbaMeta(surowe, 'session_pages'),
    sesja: liczbaMeta(surowe, 'session_count'),
    urzadzenie: wartoscMeta(surowe, 'device_type'),
  };
}

// Odczyt kolumny `atrybucja_json`. Uszkodzony JSON jednego wiersza nie ma prawa wywalic
// listy ani karty — ta sama zasada, co przy kazdej kolumnie *_json w tym module.
export function atrybucjaZWiersza(json) {
  if (!json) return null;
  try {
    const dane = JSON.parse(json);
    return dane && typeof dane === 'object' && !Array.isArray(dane) ? dane : null;
  } catch {
    return null;
  }
}

// Nazwy wlasne wyszukiwarek pisane tak, jak pisze je czlowiek — reszta zrodel zostaje
// dokladnie taka, jak zapisal sklep (nie zgadujemy, czym jest „xyz.pl").
const NAZWY = { google: 'Google', bing: 'Bing', duckduckgo: 'DuckDuckGo', yahoo: 'Yahoo', ecosia: 'Ecosia' };
const nazwij = (zrodlo) => NAZWY[String(zrodlo ?? '').toLowerCase()] ?? zrodlo;

// Czy strona wejscia siega GLEBIEJ niz strona glowna. Po tym poznaje sie link otwarty
// z aplikacji: adres prowadzi wprost do produktu, a odsylacza nie ma.
function wGlabSklepu(wejscie) {
  if (!wejscie) return false;
  try {
    const sciezka = new URL(wejscie).pathname.replace(/\/+$/, '');
    return sciezka !== '' && sciezka !== '/';
  } catch {
    return false;
  }
}

/**
 * Opis zrodla DLA CZLOWIEKA: krotka etykieta, szczegol i ewentualna wskazowka.
 *
 * ⚠️ `klucz` (grupowanie na zakladce kampanii) jest ODDZIELNY od `etykiety`: etykieta to
 * tekst, ktory wolno poprawic bez rozsypania zestawien, a klucz ma zostac staly.
 */
export function opisAtrybucji(a) {
  if (!a) {
    return {
      klucz: 'brak',
      etykieta: 'Nie wiadomo (sprzed atrybucji)',
      szczegol: null,
      wskazowka: null,
    };
  }
  const zrodlo = nazwij(a.zrodlo);
  const klucz = `${a.typ ?? '?'}|${String(a.zrodlo ?? '').toLowerCase()}`;

  let etykieta;
  switch (a.typ) {
    case 'typein': etykieta = 'Bezpośrednie'; break;
    case 'organic': etykieta = `${zrodlo} — wyszukiwarka`; break;
    case 'referral': etykieta = `${zrodlo} — odsyłacz`; break;
    case 'utm': etykieta = `${zrodlo} — link z tagiem`; break;
    case 'admin': etykieta = 'Panel sklepu (wpisane ręcznie)'; break;
    case 'mobile_app': etykieta = 'Aplikacja mobilna'; break;
    default: etykieta = zrodlo ? `${zrodlo}` : 'Nieznane źródło';
  }

  const czesci = [];
  // Kampania z UTM-u odpowiada na pytanie „KTORA akcja to przyniosla" — stoi pierwsza.
  if (a.kampania) czesci.push(`kampania: ${a.kampania}`);
  if (a.medium && a.medium !== a.typ) czesci.push(`medium: ${a.medium}`);
  if (a.odsylacz) czesci.push(`z: ${a.odsylacz}`);

  // ⚠️⚠️ WSKAZOWKA, KTORA RATUJE INTERPRETACJE CALEJ KAMPANII. Wejscie „bezposrednie"
  // PROSTO na podstrone to typowy podpis linku otwartego w aplikacji: przegladarki
  // w Instagramie i Facebooku gubia odsylacz, wiec sklep widzi ruch bez zrodla.
  // Bez tego zdania operator czyta „Bezpośrednie" jako „klientka wpisała adres z palca"
  // i odklada kampanie do szuflady „nic nie dała".
  //
  // ⚠️ Zdanie jest OSTROZNE („bywa", nie „to stamtąd") — panel nie ma jak tego rozstrzygnac
  // i nie wolno mu udawac, ze ma.
  //
  // ⚠️ DWIE DLUGOSCI, I TO NIE JEST OZDOBNIK. Karta ma na te wartosc kolumne ~300 px
  // (uklad 50/50), a pelne zdanie zajmowalo w niej SZESC linii: zmierzone na renderze,
  // wiersz „Skąd przyszło" mial 205 px przy 26 px kazdego innego i rozpychal cala sekcje
  // z 180 na 386 px. Krotka wersja stoi na ekranie, pelna siedzi w podpowiedzi — wiedza
  // zostaje dostepna, a karta spokojna.
  const wGlab = a.typ === 'typein' && wGlabSklepu(a.wejscie);
  const wskazowka = wGlab ? 'Bez odsyłacza — tak wygląda link otwarty z aplikacji.' : null;
  const wskazowkaPelna = wGlab
    ? 'Wejście prosto na podstronę, bez odsyłacza. Przeglądarki w Instagramie i Facebooku '
      + 'gubią odsyłacz, więc ruch z aplikacji wygląda tak samo jak wpisany adres, link '
      + 'z wiadomości albo zakładka. Panel nie ma jak tego rozstrzygnąć.'
    : null;

  return {
    klucz,
    etykieta,
    szczegol: czesci.length ? czesci.join(' · ') : null,
    wskazowka,
    wskazowkaPelna,
  };
}
