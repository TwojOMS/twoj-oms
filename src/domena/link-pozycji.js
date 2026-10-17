import { czyPozycjaPlaceholdera } from './indywidualne.js';
import { czyKanalAllegro } from './wysylka.js';

// Dokad prowadzi POZYCJA zamowienia — jedno pytanie, jedna odpowiedz, jeden plik.
// Regula mieszka tutaj, a nie w widoku — dokladnie tak samo, jak adres miniatury
// (domain/miniatury.js).
//
// ⚠️ NAZWA PLIKU ZMIENILA SIE Z `link-produktu.js` NA `link-pozycji.js` (05.08.2026) razem
// z dolozeniem Allegro. Pozycja z Allegro prowadzi do OFERTY, a nie do produktu w sklepie —
// stara nazwa klamalaby o zawartosci dokladnie tak, jak `status_dpd*` klamalo, gdy kolumny
// zaczely trzymac takze stan przesylek InPostu (db/db.js, zmienNazwyStatusKuriera).
//
// ⚠️ ALLEGRO DOLACZYLO DO TEGO MODULU, A NIE DOSTALO WLASNEGO — i to jest decyzja, nie
// wygoda. Kryterium bylo jedno: co sie stanie przy TRZECIM kanale.
//
//   * Osobny modul znaczy, ze wybor „ktory adres" mieszka w TRASIE (routes/zamowienia.js),
//     jako `if`. Trzeci kanal to wtedy zmiana w kilku miejscach naraz (nowy modul, `if`
//     w trasie karty i w kazdym kolejnym widoku, ktory kiedys pokaze pozycje) oraz kolejna
//     kopia reguly „brak identyfikatora = brak odnosnika". Kopie tej samej reguly rozjezdzaja
//     sie przy pierwszej zmianie po ktorejkolwiek stronie — to w tym repo nie jest teoria.
//   * Jeden modul z tablica wzorcow znaczy, ze trzeci kanal to JEDEN wpis nizej. Trasa pyta
//     o dokladnie to samo, co dzis, i nie musi wiedziec, ze doszedl kanal.
//
// Wzorzec nie jest wymyslony na te okazje — `domain/tracking.js` rozwiazuje DOKLADNIE ten
// sam ksztalt problemu (adres per kurier, `null` przy kurierze bez zmierzonego wzorca)
// i robi to jedna tablica z jednym wejsciem. Dwa rozne ksztalty na to samo pytanie obok
// siebie byly by trzecia rzecza do zapamietania.
//
// ⚠️ WPIS NIESIE TAKZE PODPIS (`tytul`), a nie sam adres. Podpis jest CZESCIA TEJ SAMEJ
// decyzji: „Otworz produkt w sklepie" nad odnosnikiem do oferty Allegro jest drobnym
// klamstwem, a rozbicie tego na druga funkcje dispatchujaca po tym samym kanale odtworzyloby
// dokladnie ten rozjazd, ktoremu ten modul ma zapobiec.

// ---------------------------------------------------------------------------------
// SKLEP (WooCommerce) — bez zmian wobec wersji sprzed Allegro.
//
// ⚠️ ADRES PO IDENTYFIKATORZE, a nie permalink. WordPress rozwiazuje `?post_type=product&p=ID`
// i sam przekierowuje na ladny adres. Alternatywy sa gorsze: permalinku Woo nie przysyla
// w linii zamowienia, zgadywanie go z nazwy produktu jest zgadywaniem, a dopytywanie sklepu
// o kazda pozycje to zapytanie sieciowe na kazdy wiersz karty.
//
// ⚠️ ZAWSZE product_id RODZICA, NIGDY variation_id — adres wariantu po identyfikatorze sie
// nie renderuje. Odnosnik, ktory raz otwiera produkt, a raz pusta strone, jest GORSZY niz
// jego brak: operator przestaje mu ufac i nie klika juz w zaden.
//
// Cztery przypadki bez odnosnika — miniatura zostaje wtedy zwyklym obrazkiem:
//  1. pozycja dopisana recznie — nie ma produktu w sklepie;
//  2. brak identyfikatora produktu — wiersz wysylki, „Razem", albo pozycja sprzed
//     dolozenia kolumny, ktorej przeliczenie nie mialo z czego policzyc;
//  3. sklep nieskonfigurowany w panelu — nie ma adresu, a panel „nie udaje, ze widzi kanal,
//     do ktorego nie ma kluczy" (config.js);
//  4. pozycja z zaslepki panelu indywidualnego — identyfikator wskazuje wtedy produkt-zaslepke
//     (wysylka, realizacja priorytetowa), a nie towar. Zmierzone na zywym sklepie (zamowienie
//     28046): WSZYSTKIE pozycje takiego zamowienia maja TEN SAM product_id zaslepki, wiec
//     bez tego warunku kazda pozycja prowadzilaby do tego samego, ukrytego produktu —
//     odnosnik bylby nie tyle bezuzyteczny, co mylacy.
// ---------------------------------------------------------------------------------
function adresProduktu({ produktId = null, sku = null, reczna = false } = {}, baseUrl = null) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) return null;
  if (reczna) return null;
  if (!Number.isInteger(produktId) || produktId <= 0) return null;
  if (czyPozycjaPlaceholdera(sku)) return null;
  return `${baseUrl.trim().replace(/\/+$/, '')}/?post_type=product&p=${produktId}`;
}

// ---------------------------------------------------------------------------------
// ALLEGRO.
//
// ⚠️ ADRES ZWERYFIKOWANY W PRAWDZIWEJ PRZEGLADARCE na identyfikatorze z zywego
// zamowienia: `https://allegro.pl/oferta/{id}` otwiera dokladnie te oferte („Lampa
// stolowa Mosiadz 30x35cm"). Sprawdzian MUSIAL isc przez przegladarke — WAF
// Allegro oddaje 403 na zadania spoza niej, wiec kod odpowiedzi z `fetch`a nie dowodzi
// NICZEGO. To ta sama pulapka, ktora przy DPD dala „dzialajacy" link bez numeru na stronie
// (patrz komentarz otwierajacy domain/tracking.js).
//
// ⚠️ ZERO WYSYLKI DO ALLEGRO. To jest `href` w HTML-u, a nie wywolanie API — identyfikator
// lezy juz w bazie, przepisany z formularza zakupowego (`lineItems[].offer.id`).
//
// ⚠️ WYLACZNIE CYFRY. Identyfikator przychodzi od Allegro jako NAPIS („1234567890") i taki
// tez lezy w bazie — kolumna jest TEXT wlasnie po to, zeby nikt go po drodze nie przerobil
// na liczbe (uzasadnienie przy `pozycje.oferta_id` w schema.sql). Warunek na same cyfry robi
// tu dwie rzeczy naraz: odsiewa wiersze bez oferty (wysylka, „Razem", doplata Allegro,
// pozycja dopisana recznie) i pilnuje reguly tego repo — „brak linku jest lepszy niz link
// otwierajacy pusta wyszukiwarke" (tracking.js). Przy okazji w adresie nie ma juz czego
// kodowac: wartosc, ktora do niego wchodzi, sklada sie z samych cyfr.
// ---------------------------------------------------------------------------------
const SAME_CYFRY = /^[0-9]+$/;

function adresOferty({ ofertaId = null, reczna = false } = {}) {
  if (reczna) return null;
  const id = String(ofertaId ?? '').trim();
  if (!SAME_CYFRY.test(id)) return null;
  return `https://allegro.pl/oferta/${id}`;
}

// Trzeci kanal = JEDEN wpis w tej tablicy. Nic poza tym plikiem nie musi o nim wiedziec.
const WZORCE = {
  sklep: { adres: adresProduktu, tytul: 'Otwórz produkt w sklepie' },
  allegro: { adres: adresOferty, tytul: 'Otwórz ofertę na Allegro' },
};

// Rodzaj kanalu liczy WSPOLNY predykat `czyKanalAllegro` (domain/wysylka.js), a nie wlasna
// kopia `startsWith('allegro_')`. Kopii tej reguly bylo w repo juz kilka i jedna z nich
// zostala zdjeta 04.08.2026 wlasnie dlatego, ze zaczynala zyc wlasnym zyciem
// (patrz domain/sync-sklep.js).
const rodzajKanalu = (zamowienie) => (czyKanalAllegro(zamowienie) ? 'allegro' : 'sklep');

/**
 * Odnosnik z pozycji zamowienia do jej zrodla — `{ adres, tytul }` albo `null`.
 *
 * `null` znaczy „tej pozycji nie ma dokad prowadzic" i jest STANEM NORMALNYM: wiersz
 * wysylki, wiersz „Razem", pozycja dopisana recznie, doplata Allegro, sklep bez
 * konfiguracji. Widok zostawia wtedy sama tresc, a nie martwe `<a href="">`.
 *
 * @param {{sklep?: string}|null} zamowienie zamowienie, do ktorego nalezy wiersz (dla kanalu)
 * @param {{produktId?: number|null, ofertaId?: string|null, sku?: string|null, reczna?: boolean}} wiersz
 * @param {{baseUrl?: string|null}} opcje korzen sklepu (config.sklepy[<sklep>].baseUrl)
 */
export function odnosnikPozycji(zamowienie, wiersz, { baseUrl = null } = {}) {
  const wzorzec = WZORCE[rodzajKanalu(zamowienie)];
  const adres = wzorzec?.adres(wiersz ?? {}, baseUrl) ?? null;
  return adres ? { adres, tytul: wzorzec.tytul } : null;
}
