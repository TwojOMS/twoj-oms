// Ręczne poprawki danych klienta — mechanika WSPÓLNA dla adresu wysyłki i danych do faktury.
//
// ⚠️ PO CO TO W OGÓLE ISTNIEJE. Klient potrafi podać zły adres i napisać w wiadomości, że
// chce go zmienić. Panel musi umieć tę poprawkę zapisać — ale poller synchronizuje sklep
// CO DWIE MINUTY i przy każdym przebiegu przepisuje `klient_json`, `dostawa_json`, `nip`
// i `chce_fakture` (patrz UPDATE w db/zamowienia.js). Poprawka zapisana w TAMTYCH polach
// działałaby w testach jednostkowych i znikała na produkcji, zanim ktokolwiek zdążyłby
// nadać paczkę. Dlatego poprawki mieszkają w OSOBNYCH kolumnach, których synchronizacja
// nigdy nie dotyka — dokładnie tak samo jak `oplacone_recznie` (ta ochrona powstała po
// tym, jak ten błąd raz wystąpił).
//
// ⚠️ NADPISANIE JEST POLOWE, NIE OBIEKTOWE. W kolumnie leży `{"kod":"00-002"}`, a nie cała
// kopia adresu. Gdyby leżała cała kopia, poprawka jednego kodu pocztowego ZAMRAŻAŁABY
// resztę danych na zawsze: zmiana nazwiska w sklepie nigdy by już nie doszła, a panel
// pokazywałby dane tym starsze, im dawniej ktoś kliknął „zapisz". Klucze zapisujemy więc
// wyłącznie dla pól, które FAKTYCZNIE odbiegają od sklepu (patrz roznice()) — reszta
// czyta się dalej ze sklepu i płynie z każdą synchronizacją.

/**
 * Nadpisania z kolumny TEXT. Uszkodzony JSON (ręczny UPDATE w pliku SQLite, przerwany
 * zapis) NIE MOŻE wywalić karty zamówienia — wtedy po prostu czytamy sam sklep, bo to
 * jest jedyny bezpieczny domyślny stan: dane ze sklepu są zawsze prawdziwe, tylko czasem
 * nieaktualne. Tablica i wartości skalarne to też „nie mam nadpisań", a nie wyjątek.
 */
export function odczytajNadpisania(surowy) {
  if (!surowy) return {};
  try {
    const o = JSON.parse(surowy);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

/**
 * Wartość POD KLUCZEM mapy nadpisań — musi być obiektem, inaczej czytamy ją jako brak
 * nadpisań. `odczytajNadpisania` powyżej pilnuje tylko SAMEJ MAPY; ręczny UPDATE w pliku
 * SQLite albo starszy kształt danych może wstawić pod klucz liczbę albo tablicę, a
 * `Object.hasOwn` na tablicy przepuściłby indeks jako nazwę pola.
 *
 * Mieszka tutaj, przy `odczytajNadpisania`, bo czytają ją DWA moduły nadpisań polowych —
 * pozycje (`pozycje-reczne.js`) i wysyłka (`wysylka-kwota.js`). Do 07.08.2026 była prywatna
 * w tym pierwszym; drugi musiałby ją skopiować.
 */
export const obiektAlboPusty = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// Pusty string i same spacje znaczą „pole puste", czyli null — spójnie z adresOdbiorcy()
// i parsujAdresOdbiorcy(), gdzie ta sama zasada obowiązuje od pierwszej wersji.
export function tekst(surowa) {
  const t = String(surowa ?? '').trim();
  return t || null;
}

// Sklep B rozbija adres na DWA pola formularza: nazwa ulicy w address_1,
// numer budynku w address_2 (potwierdzone na żywych zamówieniach — patrz PRZEWODNIK 4.7 i
// nagłówki adres-odbiorcy.js / dane-faktury.js). Sklejenie mieszka TUTAJ, w module
// WSPÓLNYM dla adresu wysyłki i danych do faktury, żeby obie strony (adresOdbiorcy,
// daneFaktury) używały jednej reguły zamiast dwóch kopii, które prędzej czy później by się
// rozjechały.
//
// Filter(Boolean) PO przycięciu białych znaków, nie zwykłe `a + ' ' + b`: przy pustym
// address_2 (dziś normalny przypadek — numer bywa wpisany razem z nazwą ulicy w address_1)
// naiwne sklejenie zostawiłoby spację na końcu, czyli ulicę RÓŻNĄ od tego, co jest dziś.
export function sklejUlice(adres1, adres2) {
  const czesci = [adres1, adres2].map((c) => String(c ?? '').trim()).filter(Boolean);
  return czesci.length ? czesci.join(' ') : null;
}

/**
 * Wartość ręczna, jeśli jest; w przeciwnym razie ze sklepu. Sprawdzamy OBECNOŚĆ KLUCZA,
 * a nie prawdziwość wartości: `{"phone": null}` znaczy „operator ŚWIADOMIE wyczyścił
 * telefon", a nie „brak nadpisania" — bez tego rozróżnienia wyczyszczenia pola nie dałoby
 * się w ogóle zapisać, bo sklep natychmiast wstawiałby starą wartość z powrotem.
 */
export function zastosuj(zeSklepu, nadpisania, pola) {
  const wynik = { ...zeSklepu };
  for (const pole of pola) {
    if (Object.hasOwn(nadpisania, pole)) wynik[pole] = tekst(nadpisania[pole]);
  }
  return wynik;
}

/**
 * Pola, które ODBIEGAJĄ od sklepu — to one dostają na karcie oznaczenie „zmienione
 * ręcznie". Liczone z porównania wartości, nie z samej obecności klucza w nadpisaniach:
 * gdy sklep dogoni ręczną poprawkę (klient poprawił dane u siebie), nie ma już czego
 * oznaczać, a oznaczenie pokazywane mimo zgodności byłoby dokładnie tak samo bezużyteczne
 * jak niepokazywane nigdy.
 */
export function polaZmienione(zeSklepu, efektywne, pola) {
  return pola.filter((p) => (tekst(zeSklepu[p]) ?? '') !== (tekst(efektywne[p]) ?? ''));
}

/**
 * Co zapisać po wysłaniu formularza. Przeglądarka odsyła WSZYSTKIE pola, także te, których
 * operator nie tknął, więc to TA funkcja pilnuje polowości nadpisania: klucz powstaje
 * wyłącznie tam, gdzie wartość z formularza różni się od wartości ze sklepu. Pole
 * wyczyszczone daje jawny `null` (patrz zastosuj), a pole puste po obu stronach — nic.
 */
/**
 * Nowa zawartość kolumny nadpisań po zapisie formularza, który **nie musi nieść wszystkich
 * pól**.
 *
 * ⚠️ Zapis nadpisań ZASTĘPUJE całą mapę, a nie dokłada do niej — i to jest dobrze, bo pole
 * zrównane ze sklepem ma przestać być nadpisaniem. Ale przy formularzu, który o jakieś pole
 * w ogóle nie pytał, zastąpienie znaczyłoby skasowanie wartości, której nikt nie tknął.
 * Dlatego pola NIEOBECNE w żądaniu przechodzą ze starej mapy nietknięte, a pola obecne
 * rozstrzyga `roznice` — czyli tak jak dotąd.
 *
 * Zaczęło mieć znaczenie, gdy do danych faktury doszedł e-mail (2026-07-31): każdy zapis
 * z formularza sprzed tej zmiany kasowałby zapisany adres do faktury.
 */
export function nadpisaniaPoZapisie(stare, zeSklepu, zFormularza, pola) {
  const obecne = pola.filter((p) => zFormularza?.[p] !== undefined);
  const zachowane = Object.fromEntries(
    Object.entries(odczytajNadpisania(stare)).filter(([k]) => !obecne.includes(k)),
  );
  return { ...zachowane, ...roznice(zeSklepu, zFormularza, pola) };
}

export function roznice(zeSklepu, zFormularza, pola) {
  const wynik = {};
  for (const pole of pola) {
    // ⚠️ Pole, którego w żądaniu NIE MA, to nie jest pole wyczyszczone — to pole, o które
    // ten formularz w ogóle nie pytał. Rozróżnienie zaczęło mieć znaczenie, gdy do danych
    // faktury doszedł e-mail (2026-07-31): starszy formularz albo urwane żądanie kasowałoby
    // wtedy wartość, której nikt nie tknął. Wyczyszczenie RĘKĄ dalej działa, bo przeglądarka
    // odsyła wtedy klucz z pustą wartością i przez to sito przechodzi.
    if (zFormularza?.[pole] === undefined) continue;
    const nowa = tekst(zFormularza[pole]);
    if ((tekst(zeSklepu[pole]) ?? '') !== (nowa ?? '')) wynik[pole] = nowa;
  }
  return wynik;
}
