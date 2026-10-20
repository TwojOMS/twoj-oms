import { bladOperatora } from './bledy.js';
import { adresOdbiorcy } from './adres-odbiorcy.js';
import { adresatKlienta } from './adresat-klienta.js';
import { daneFaktury } from './dane-faktury.js';
import { nazwaDostawy, czyPobranie } from './wysylka.js';
import { ETYKIETY_TERMINU } from './termin-platnosci.js';
import { wierszePozycji } from './tabela-pozycji.js';
import { dzienWarszawa } from './format-daty.js';
import { zlotowki } from './kwoty.js';
import { zdaniaDoMaila, naglowekTekstu, tekstyModelu } from './zdania-platnosci.js';

// POTWIERDZENIE PRZYJĘCIA ZAMÓWIENIA — treść maila do klienta (21.08.2026, prośba
// właściciela: „po ręcznym dodaniu zamówienia mogę ręcznie kliknąć przycisk — wyślij
// potwierdzenie zamówienia").
//
// ⚠️ MODUŁ JEST CZYSTY: składa TREŚĆ i nic nie wysyła. Wysyłką zajmuje się usługa
// (services/potwierdzenie.js), a decyzją — człowiek przy karcie. Dzięki temu treść da się
// obejrzeć na ekranie podglądu DOKŁADNIE taką, jaka pójdzie do klienta, i przetestować bez
// serwera poczty.
//
// ⚠️⚠️ POZYCJE BIERZEMY Z `wierszePozycji` — TEJ SAMEJ FUNKCJI, KTÓRA RYSUJE KARTĘ. To jest
// najważniejsza decyzja w tym pliku: mail do klienta i ekran operatora nie mają prawa
// pokazywać innych kwot. Druga, „mailowa" ścieżka liczenia sumy rozjechałaby się z kartą przy
// pierwszej poprawce ceny — a rozjazd zauważyłby dopiero klient, po fakcie.
//
// ⚠️⚠️ MODEL JEDEN, RENDERERY DWA (przebudowa 21.08.2026 wieczorem, zgłoszenie właściciela:
// „popraw maila, wygląda słabo — pozycje jako tabela, dodaj nagłówki"). Do tej pory ten moduł
// oddawał sam PLAIN TEXT, a `renderMailHtml` próbował go rozpoznać wzorcami napisanymi pod
// maile z wyceną (`3x Nazwa - 74,90zł brutto/szt`). Potwierdzenie tych wzorców nie spełniało,
// więc HTML wychodził jako ciąg akapitów — tabeli nie było w nim ani śladu.
//
// Poprawka NIE polega na dopasowaniu tekstu do cudzych wzorców (byłby to układ trzymany
// spacjami, psujący się przy pierwszej dłuższej nazwie), tylko na wyliczeniu MODELU raz
// i wyrenderowaniu go dwa razy: tabelą w HTML-u (src/mail/potwierdzenie-html.js) i tekstem
// tutaj. Mail idzie jako multipart, więc plain text ZOSTAJE — dawna decyzja („klienci pocztowi
// psują układy, potwierdzenie musi być czytelne także w kliencie tekstowym") jest spełniona
// jako część alternatywna, a nie jako jedyna treść.

/**
 * Adres e-mail, na który idzie potwierdzenie.
 *
 * ⚠️ RE-EKSPORT, NIE KOPIA (22.08.2026). Reguła „na jaki adres piszemy do klienta" przeniosła
 * się do `domain/adresat-klienta.js`, bo od tej daty potrzebują jej także proforma, faktura
 * i przypomnienie o płatności. Nazwa zostaje, żeby nie ruszać istniejących importów; funkcja
 * jest DOKŁADNIE tą samą (pilnuje tego test w tests/oms/wiadomosci-domena.test.js).
 */
export { adresatKlienta as adresatPotwierdzenia } from './adresat-klienta.js';

/**
 * Czy wolno wysłać — i dlaczego nie, gdy nie wolno.
 *
 * ⚠️ ANULOWANE ZAMÓWIENIE ODMAWIA. Mail „potwierdzamy przyjęcie" wysłany do zamówienia,
 * które właśnie anulowaliśmy, jest gorszy niż brak maila: klient dostaje potwierdzenie
 * czegoś, czego nie ma, i dzwoni o to, co my już wiemy.
 */
export function czyWolnoWyslacPotwierdzenie(z) {
  if (z?.anulowane) {
    return { wolno: false, powod: 'Zamówienie jest anulowane — potwierdzenia przyjęcia nie wysyłamy.' };
  }
  if (!adresatKlienta(z)) {
    return {
      wolno: false,
      powod: 'To zamówienie nie ma adresu e-mail. Dopisz go w danych do wysyłki albo w danych do faktury.',
    };
  }
  if (!(z?.pozycje ?? []).length) {
    return { wolno: false, powod: 'Zamówienie nie ma ani jednej pozycji — nie ma czego potwierdzać.' };
  }
  return { wolno: true, powod: null };
}

/**
 * Podpis jest marką skonfigurowaną przez użytkownika, nie nazwą podmiotu na dokumentach.
 * Brak marki daje neutralny podpis; domena nie zna marki firmy wdrażającej OMS.
 */
export const PODPIS = 'Obsługa sklepu';

// PRZ-102.19: „(adres do uzgodnienia)", nagłówki sekcji, „Tak — wystawimy na:", „Nie", „dane do uzgodnienia",
// „do uzgodnienia" przy braku metody płatności, „RAZEM: … brutto", „/szt" i „Pozdrawiamy," — z Ustawień → Szablony
// wiadomości (`m.teksty`, domena/zdania-platnosci.js). Bez zapisu brzmienie domyślne, co do znaku dawne literały stąd.

/**
 * Adres dostawy jako LISTA LINII albo `null`, gdy adresu nie ma.
 *
 * ⚠️ SAMA NAZWA TO NIE JEST ADRES — zweryfikowane na rzeczywistym zamówieniu.
 * Zamówienie telefoniczne bywa zakładane z samym e-mailem klienta, a panel pokazuje wtedy
 * ten e-mail w polu nazwy odbiorcy. Bez tego warunku mail do klienta twierdziłby, że
 * dostawa pójdzie „na podany e-mail" — zdanie brzmiące jak usterka systemu,
 * a będące tylko brakiem danych. Adres pokazujemy dopiero wtedy, gdy JEST adresem:
 * jest ulica albo miejscowość.
 */
function liniaAdresu(z) {
  const a = adresOdbiorcy(z) ?? {};
  const ulica = String(a.ulica ?? '').trim();
  const miejscowosc = [a.kod, a.miasto].map((l) => String(l ?? '').trim()).filter(Boolean).join(' ');
  if (!ulica && !miejscowosc) return null;

  // ⚠️ Ten sam adres, który zobaczy kurier na etykiecie (domain/adres-odbiorcy.js). Gdyby mail
  // składał go u siebie, klient potwierdzałby inny adres, niż ten, pod który paczka pojedzie.
  return [a.company, a.nazwa, ulica, miejscowosc]
    .map((l) => String(l ?? '').trim())
    .filter(Boolean);
}

/**
 * Dane nabywcy jako lista linii — to, co klient ma sprawdzić, ZANIM wystawimy dokument.
 *
 * ⚠️ BEZ E-MAILA. Adres, z którego korespondujemy, jest naszą sprawą; na fakturze go nie ma
 * i w potwierdzeniu też nie musi być — a wypisany kusi, żeby go poprawiać w mailu zwrotnym
 * jako „dane do faktury", czym nie jest.
 */
function liniaFaktury(z) {
  const f = daneFaktury(z) ?? {};
  const miejscowosc = [f.kod, f.miasto].map((l) => String(l ?? '').trim()).filter(Boolean).join(' ');
  return [f.firma, f.nip && `NIP ${f.nip}`, f.ulica, miejscowosc]
    .map((l) => String(l ?? '').trim())
    .filter(Boolean);
}

/**
 * MODEL potwierdzenia — wszystko policzone RAZ, w postaci gotowej do wypisania.
 *
 * Renderery (tekst niżej, HTML w src/mail/potwierdzenie-html.js) mają wyłącznie UŁOŻYĆ te
 * wartości. Żaden z nich nie liczy ani nie formatuje kwot — inaczej tabela w mailu i tekst
 * zapasowy mogłyby kiedyś pokazać co innego, a klient dostaje OBIE naraz, w jednej wiadomości.
 */
export function modelPotwierdzenia(z, { podpis = PODPIS, zdania = null } = {}) {
  const zgoda = czyWolnoWyslacPotwierdzenie(z);
  if (!zgoda.wolno) throw bladOperatora(zgoda.powod);
  return modelZamowienia(z, { podpis, zdania });
}

/**
 * Ten sam model BEZ bramki zgody — dla szablonów własnych (PRZ-101.03), które bloki `{pozycje}`, `{wysylka}`,
 * `{dane_do_faktury}` składają z tych samych wartości co potwierdzenie, ale nie są potwierdzeniem
 * (np. „Opóźnienie wysyłki" może pójść do zamówienia, którego pozycje operator jeszcze uzupełnia).
 */
// PRZ-102.19: `zdania` — teksty z Ustawień → Szablony wiadomości (zdaniaPlatnosciTeraz w usłudze, czytane przy każdym
// mailu). Brak = domyślne. W modelu ląduje komplet (`teksty`), renderery czytają go przez `tekstyModelu`.
export function modelZamowienia(z, { podpis = PODPIS, zdania = null } = {}) {
  const t = zdaniaDoMaila(zdania ?? {});
  const wiersze = wierszePozycji(z);
  const razem = wiersze.find((w) => w.podsumowanie);

  const pobranie = czyPobranie(z);
  const platnosc = String(z?.metoda_platnosci ?? '').trim();
  // ⚠️ TERMIN DOPISUJEMY WYŁĄCZNIE POZA POBRANIEM (21.08.2026, scenariusz właściciela:
  // „FV przelew 14 dni"). Przy pobraniu klient płaci kurierowi w chwili odbioru, więc
  // „termin 14 dni" obok kwoty do zainkasowania byłby zdaniem sprzecznym samym w sobie —
  // i to sprzecznym o pieniądze, bo klient mógłby uznać, że kurierowi nie płaci.
  const terminSlowami = ETYKIETY_TERMINU[String(z?.termin_platnosci ?? '').trim()] ?? null;

  return {
    numer: String(z?.numer ?? ''),
    dzien: dzienWarszawa(z?.utworzone_at ?? ''),
    pozycje: wiersze.filter((w) => !w.podsumowanie).map((w) => ({
      nazwa: w.nazwa,
      ilosc: w.ilosc == null ? '' : String(w.ilosc),
      cena: zlotowki(w.cenaBrutto),
      suma: zlotowki(w.suma),
    })),
    razem: zlotowki(razem?.suma),
    platnosc: pobranie
      // ⚠️ PRZY POBRANIU PODAJEMY KWOTĘ DO ZAPŁATY KURIEROWI — to jedyna liczba, którą klient
      // musi mieć przygotowaną, i jedyna, o którą dzwoni, gdy jej nie zna.
      ? `Za pobraniem — kurier pobierze ${zlotowki(z?.kwota_pobrania ?? razem?.suma)}`
      : [platnosc || t.platnosc_do_uzgodnienia, terminSlowami].filter(Boolean).join(', '),
    wysylka: {
      metoda: nazwaDostawy(z),
      adres: liniaAdresu(z),
    },
    // ⚠️ SEKCJA FAKTURY POKAZUJE SIĘ ZAWSZE — także z odpowiedzią „Nie" (zgłoszenie
    // właściciela 21.08.2026: „FAKTURA: tak, dane do faktury: …"). Wcześniej znikała, gdy
    // klient faktury nie chciał, więc jedyny moment, w którym da się to bezkosztowo
    // sprostować, przechodził bez śladu. Mail i tak kończy się zdaniem „jeśli coś się nie
    // zgadza, wystarczy odpowiedzieć" — a to jest dokładnie rzecz, która się nie zgadza
    // najczęściej.
    faktura: {
      chce: Boolean(z?.chce_fakture),
      linie: Boolean(z?.chce_fakture) ? liniaFaktury(z) : [],
    },
    sprzedawca: String(podpis ?? '').trim() || PODPIS,
    teksty: t,
  };
}

/**
 * Treść potwierdzenia: temat, tekst i model dla renderera HTML.
 *
 * ⚠️ TEKST ZOSTAJE i nie jest ozdobnikiem: mail idzie jako multipart, więc to on trafia do
 * klienta pocztowego bez HTML-a, do podglądu na zegarku i do archiwum. Jest jednak od dziś
 * częścią ALTERNATYWNĄ, a nie jedyną treścią — układ, który klient zobaczy, robi tabela.
 */
export function trescPotwierdzenia(z, { podpis = PODPIS, zdania = null } = {}) {
  const model = modelPotwierdzenia(z, { podpis, zdania });
  return {
    do: adresatKlienta(z),
    temat: `Potwierdzenie przyjęcia zamówienia nr ${model.numer}`,
    tekst: jakoTekst(model),
    model,
  };
}

/** Sekcja tekstu: NAGŁÓWEK + wcięte linie. Pusta lista nie tworzy sekcji. */
function sekcja(naglowek, linie) {
  const tresc = linie.filter((l) => l !== null && l !== undefined && l !== '');
  return tresc.length ? ['', naglowek, ...tresc.map((l) => `  ${l}`)] : [];
}

/**
 * Cztery sekcje potwierdzenia w wersji tekstowej, każda z pustą linią na początku. JEDNO miejsce dla bloków
 * szablonu i dla `jakoTekst` (do PRZ-102.19 dwie kopie znak w znak). Teksty z `tekstyModelu`; nagłówki wielkimi
 * literami (`naglowekTekstu`), jak w HTML-u, gdzie robi to styl.
 */
function sekcjeTekstu(m) {
  const t = tekstyModelu(m);
  return {
    pozycje: sekcja(naglowekTekstu(t.naglowek_zamowienie), [
      ...m.pozycje.map((p) => `${p.ilosc} × ${p.nazwa} — ${p.cena}/${t.jednostka} = ${p.suma}`),
      `${naglowekTekstu(t.etykieta_razem)}: ${m.razem} ${t.dopisek_brutto}`,
    ]),
    sposob_platnosci: sekcja(naglowekTekstu(t.naglowek_platnosc), [m.platnosc]),
    wysylka: sekcja(naglowekTekstu(t.naglowek_wysylka), [m.wysylka.metoda, ...(m.wysylka.adres ?? [`(${t.adres_do_uzgodnienia})`])]),
    dane_do_faktury: sekcja(naglowekTekstu(t.naglowek_faktura), m.faktura.chce
      ? [t.faktura_tak, ...(m.faktura.linie.length ? m.faktura.linie : [t.faktura_bez_danych])]
      : [t.faktura_nie]),
  };
}

/**
 * Sekcje potwierdzenia jako BLOKI szablonu (PRZ-101.03): te same linie, które składa `jakoTekst` niżej,
 * bez pustej linii na początku (odstępy między blokami stawia szablon). Zgodność z mailem bez szablonu pilnuje
 * tests/moduly/wiadomosci/szablony-rownosc.test.js, a bajt w bajt — zdania-platnosci-rownosc-prz102-17.test.js.
 */
export function blokiTekstuPotwierdzenia(m) {
  const s = sekcjeTekstu(m);
  return Object.fromEntries(Object.entries(s).map(([nazwa, linie]) => [nazwa, linie.slice(1)]));
}

/**
 * Zapasowa postać tekstowa — TE SAME dane, ten sam podział na sekcje.
 *
 * ⚠️ ŻADNEGO UKŁADU TRZYMANEGO SPACJAMI. Kolumny wyrównywane spacjami rozjeżdżają się przy
 * pierwszej dłuższej nazwie i w każdej czcionce proporcjonalnej — a klient pocztowy bez HTML-a
 * bywa właśnie taki. Jedna pozycja to jedna linia, kwoty na końcu.
 */
export function jakoTekst(m) {
  const s = sekcjeTekstu(m);
  return [
    'Dzień dobry,',
    '',
    `potwierdzamy przyjęcie zamówienia nr ${m.numer} z dnia ${m.dzien}.`,
    ...s.pozycje,
    ...s.sposob_platnosci,
    ...s.wysylka,
    ...s.dane_do_faktury,
    '',
    'Jeśli coś się nie zgadza, wystarczy odpowiedzieć na tego maila.',
    '',
    tekstyModelu(m).pozdrowienie,
    m.sprzedawca,
  ].join('\n');
}

