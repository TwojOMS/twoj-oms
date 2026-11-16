import {
  wartoscPozycjiGrosze, kwotaOczekiwanaGrosze, wysylkaBruttoGrosze, zl,
} from './suma-pozycji.js';
import { daneFaktury, chceFakture } from './dane-faktury.js';
import { dzienWarszawa } from './format-daty.js';
import { nazwaDostawy, metodaWysylki, czyPobranie } from './wysylka.js';
import { ikonaPlatnosci } from './lista-ikony.js';
import { czyPozycjaPlaceholdera } from './indywidualne.js';
import { nettoZamowieniaGrosze } from './netto-zamowienia.js';
// ⚠️ Import z domeny PANELU — ten sam katalog `domena/z-panelu/`, z ktorego
// `domena/nowe-zamowienie.js` bierze `rozbijNazwe` (nazwa-osoby.js). Znacznik powstaje tam i tam ma zostac jego jedyna definicja.
import { UWAGA_Z_KARTY } from './z-panelu/oms-order.js';

// Dane "Specyfikacji zamowienia" - kartki wkladanej do kazdej paczki. Przy zamowieniach
// firmowych zastepuje wydruk faktury (ta i tak dociera przez KSeF), przy indywidualnych
// idzie obok paragonu z kasy fiskalnej. TEN MODUL NIE RYSUJE (rysuje
// moduly/zamowienia/pdf/specyfikacja-pdf.js) I NIE LICZY WLASNYCH KWOT.
//
// ⚠️ WSZYSTKIE KWOTY IDA PRZEZ `wartoscPozycjiGrosze` / `kwotaOczekiwanaGrosze` /
// `wysylkaBruttoGrosze` - te same funkcje, ktore licza karte zamowienia, pozycje faktury
// i bariere arytmetyczna. Drugie liczenie na potrzeby wydruku rozjechaloby sie z faktura
// przy PIERWSZEJ pozycji dopisanej recznie, a klient mialby w paczce kartke niezgodna
// z faktura, ktora dostal.

// Stan platnosci SLOWAMI DOKUMENTU.
//
// ⚠️ REGULE — ktory z trzech stanow — rozstrzyga `ikonaPlatnosci` (domena/lista-ikony.js),
// czyli TA SAMA funkcja, ktora rzadzi ikona w wierszu listy i ktorej trzyma sie karta:
// POBRANIE WYGRYWA nad oplacone/nieoplacone, bo przy pobraniu brak wplaty jest stanem
// NORMALNYM (kurier zainkasuje przy doreczeniu), a nie niedoplata. Tutaj zmienia sie
// WYLACZNIE brzmienie: kartka idzie do KLIENTA, wiec mowi mu, co ma zrobic, a nie jak
// nazywa sie stan w panelu. Zadnego liczenia salda od nowa — ta regula juz istnieje.
const STAN_PLATNOSCI = {
  pobranie: 'do zapłaty kurierowi przy odbiorze',
  oplacone: 'opłacone',
  nieoplacone: 'nieopłacone',
};

/**
 * Metoda platnosci RAZEM ZE STANEM — „Przelew — opłacone", „Za pobraniem — do zapłaty
 * kurierowi przy odbiorze". Sama metoda nie wystarcza: klient dostałby w paczce napis
 * „Płatność: Za pobraniem” bez ani jednego słowa o tym, czy pieniądze już wpłynęły,
 * czy odbierze je kurier.
 *
 * Brak metody (zamowienie reczne, kanal bez tej kolumny) daje SAM stan, a nie „ — opłacone"
 * z wiszacym mysnikiem.
 */
function platnoscZeStanem(z) {
  const stan = STAN_PLATNOSCI[ikonaPlatnosci(z).stan] ?? null;
  const metoda = String(z?.metoda_platnosci ?? '').trim();
  if (!metoda) return stan;
  return stan ? `${metoda} — ${stan}` : metoda;
}

/**
 * Uwagi, ktore NAPRAWDE napisal klient — albo `null`.
 *
 * ⚠️ Rozpoznanie idzie po stalej `UWAGA_Z_KARTY` (z-panelu/oms-order.js), ktora jest KOPIA
 * formatu z panelu indywidualnego (osobne repo panelu).
 * Zmiana brzmienia w panelu bez zmiany stalej = po cichu wydrukowany klientowi wewnetrzny
 * identyfikator karty; pilnuje tego test z dosłownym tekstem panelu w
 * tests/moduly/zamowienia/specyfikacja.test.js.
 */
function uwagiOdKlienta(surowe) {
  const tekst = String(surowe ?? '').trim();
  if (!tekst) return null;
  return tekst.startsWith(UWAGA_Z_KARTY.trim()) ? null : tekst;
}

/**
 * @param {object} z - zamowienie (wiersz `zLinii`, z nalozonymi nadpisaniami)
 * @param {{ sprzedawca: object, dzis?: string }} opts - `sprzedawca` sklada wolajacy
 *   (nazwa, adres, nip, bdo); `dzis` to fallback daty, gdy zamowienie jej nie niesie
 *   (domyslnie dzisiejszy dzien w czasie warszawskim).
 */
export function daneSpecyfikacji(z, { sprzedawca, dzis = dzienWarszawa(new Date().toISOString()), klienciWdt = new Set() } = {}) {
  const nabywca = daneFaktury(z);
  const pozycje = (z?.pozycje ?? []).map((p) => ({
    nazwa: p?.nazwa ?? '',
    // ⚠️ PUSTY NAPIS, NIGDY symbol zgadywany z nazwy. Allegro potrafi oddac `sku: null`
    // (domena/allegro-mapowanie.js), a dokument ma sie wtedy wygenerowac - wymog GPSR
    // spelnia to, co naprawde wiemy, a nie to, co brzmi wiarygodnie.
    //
    // ⚠️ SKU ZASLEPKI LICZY SIE JAK BRAK SKU. Pozycja zastepcza (`SKU_PLACEHOLDERA`,
    // domena/indywidualne.js) to ukryty produkt techniczny wtyczki panelu zamowien indywidualnych, nie symbol wzoru - a te kartke czyta
    // KLIENT. Ta sama zasada, co na karcie zamowienia (domena/tabela-pozycji.js).
    symbol: czyPozycjaPlaceholdera(p?.sku) ? '' : (p?.sku ?? ''),
    ilosc: Number(p?.ilosc ?? 0),
    // ⚠️ CENA JEDNOSTKOWA IDZIE WPROST, BEZ PRZELICZANIA. `cena_brutto` jest juz napisem
    // w zlotowkach ('50.00'), a `Number(x) * 100` na pieniadzach to float: '19.99' daje
    // 1998.9999999999998. Jedynym dozwolonym przeliczeniem w tym module jest `zl()`.
    cenaZl: p?.cena_brutto ?? null,
    wartoscZl: zl(wartoscPozycjiGrosze(p)),
  }));
  return {
    numer: z?.numer ?? '',
    dataZamowienia: dzienWarszawa(z?.utworzone_at ?? '') || dzis,
    sprzedawca,
    // ⚠️ Dane nabywcy WYLACZNIE przez `daneFaktury(z)`, nigdy wprost z `z.klient`/`z.nip`.
    // Operator poprawia je na karcie, bo klient podal zle - czytanie prosto ze sklepu
    // robiloby z tej edycji edycje pozorna.
    nabywca,
    pozycje,
    // Koszt dostawy TA SAMA funkcja, ktora liczy go na fakturze i na karcie.
    dostawaZl: zl(wysylkaBruttoGrosze(z)),
    razemZl: zl(kwotaOczekiwanaGrosze(z)),
    // ⚠️ NETTO TA SAMA REGULA, CO RAPORT SPRZEDAZY (`nettoZamowieniaGrosze`), a nie wlasne
    // dzielenie przez 1,23. Klient zagraniczny z WDT ma stawkę 0%, więc dzielenie „bo zawsze
    // 23%” dałoby mu w paczce kartkę z netto zaniżonym o 23% — względem faktury i względem
    // raportu, z którego firma czyta sprzedaż.
    //
    // ⚠️ Mail bierzemy z KLIENTA zamowienia, nie z danych faktury: raport klasyfikuje WDT
    // wlasnie tym polem, a `daneFaktury().email` jest NIEOBOWIAZKOWY i bywa inny (faktury
    // czesto ida na osobny adres do ksiegowosci).
    nettoZl: zl(nettoZamowieniaGrosze(kwotaOczekiwanaGrosze(z), z?.klient?.email, klienciWdt)),
    platnosc: platnoscZeStanem(z),
    // ⚠️ DATA PLATNOSCI TYLKO WTEDY, GDY PLATNOSC BYLA.
    // `oplacone_at` jest FAKTEM WYLICZANYM z listy wplat (domena/platnosci.js), nie kolumna
    // do przepisania — czytamy go wprost, tak samo jak ikona na liscie i karta.
    //
    // ⚠️ Przy pobraniu tej daty NIE MA i mieć nie może: pieniadze odbiera kurier przy
    // doreczeniu, wiec kazda data wydrukowana tutaj bylaby zmyslona. Brak daty to `null`,
    // a nie „—”: o tym, czy linie w ogole rysowac, rozstrzyga warstwa PDF.
    dataPlatnosci: z?.oplacone_at ? dzienWarszawa(z.oplacone_at) : null,
    // ⚠️ PARAGON — informacja dla klienta, który NIE prosił o fakturę. Przy fakturze kartka
    // ma linię „Faktura VAT nr … — doręczona przez KSeF”; bez tego pola przy sprzedaży
    // paragonowej nie mówiłaby ani słowa o dokumencie sprzedaży.
    //
    // ⚠️ `chceFakture` (a nie kolumna `chce_fakture`) — reczna poprawka na karcie wygrywa.
    // Operator zmienia to pole wlasnie wtedy, gdy klient rozmyslil sie po zlozeniu zamowienia,
    // a kartka ma mowic o stanie PO poprawce.
    //
    // Faktura wystawiona BEZ prośby klienta (opcja firmy „faktura dla każdego”)
    // też jest dokumentem sprzedaży — wtedy nie „paragon”. Bez faktury z numerem: jak dotąd.
    paragon: !chceFakture(z) && !z?.faktura?.numer,
    // Wybor faktury to fakt niezalezny od jej numeru: specyfikacja czesto powstaje
    // przed wystawieniem, a klient musi widziec wybrany rodzaj dokumentu.
    fakturaWybrana: chceFakture(z) || Boolean(z?.faktura?.numer),
    // ⚠️ UWAGI KLIENTA WRACAJA DO KLIENTA. Zrodlo to
    // `customer_note` ze sklepu albo `messageToSeller` z Allegro (kolumna `zamowienia.uwagi`)
    // — czyli zdanie, ktore klient sam napisal. Wydrukowane na kartce jest potwierdzeniem,
    // ze ktos je przeczytal; bez tego pola prośba o „proszę zapakować na prezent”
    // istniałaby wyłącznie na ekranie panelu.
    //
    // ⚠️⚠️ ALE TA KOLUMNA NIESIE TEZ ZNACZNIK TECHNICZNY, i to na KAZDYM zamowieniu z panelu
    // indywidualnego: „Zamówienie indywidualne — karta <uuid> <odnośnik>" (`UWAGA_Z_KARTY`).
    // Często to jedyna treść uwag, a nie słowa klienta. Wydrukowany trafiłby do paczki
    // jako „Uwagi klienta" — bez sensu dla czytajacego i z wewnetrznym adresem karty w srodku.
    uwagiKlienta: uwagiOdKlienta(z?.uwagi),
    // ⚠️ NAZWA DLA CZLOWIEKA, nie wewnetrzny kod metody. Surowe `z.metoda_wysylki` dałoby
    // na kartce DO KLIENTA napisy `dpd`, `inpost_paczkomat`, `odbior_osobisty`, a w najgorszym
    // razie „Sposób dostawy: nieznana” — usterka, którą klient zgłasza. `nazwaDostawy` woła
    // `etykietaWysylki` (domena/wysylka.js), TĘ SAMĄ funkcję, której używa lista, karta
    // i ekran nadania, i dokleja informacje o pobraniu:
    // kartka i panel maja mowic o tej samej przesylce tak samo.
    //
    // Wartosci EFEKTYWNE (`metodaWysylki`/`czyPobranie` czytaja nadpisanie reczne, a dopiero
    // w jego braku kolumne sklepu) — reczna korekta metody na karcie ma trafic na dokument,
    // inaczej poprawka i tresc kartki rozjechalyby sie po cichu.
    dostawa: nazwaDostawy(z),
    // `null`, a nie pusty napis: dokument powstaje czesto PRZED faktura i to nie jest blad -
    // kolejnosci "najpierw faktury, potem wydruki" nie wymuszamy.
    faktura: z?.faktura?.numer ? { numer: z.faktura.numer } : null,
  };
}
