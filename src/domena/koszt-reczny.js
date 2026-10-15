import { randomUUID } from 'node:crypto';
import { bladOperatora } from './bledy.js';
import { grosze, zl } from './kwoty.js';

// ⚠️⚠️ DRUGIE (i ostatnie) MIEJSCE STYKU ZE SWIATEM: „to, co wpisal czlowiek" → ksztalt wiersza
// tabeli `koszty`. Pierwszym jest `naWiersz` (domain/koszt-metadane.js, ksztalt odpowiedzi
// KSeF). Oba wychodza TYM SAMYM ksztaltem i oba oddaja kwoty jako NAPISY z dwoma miejscami
// po przecinku — bo kolumny sa TEXT-em, a arytmetyka pieniedzy idzie przez `grosze()`
// (niezmiennik 4.5). Trzeciego mapowania nie ma i miec nie ma.
//
// PO CO TO ISTNIEJE: Facebook, Google, Anthropic, zakupy zagraniczne i paragony NIE MA I NIE
// BEDZIE w KSeF. Do 13.08.2026 bylo to swiadomie poza zakresem (par. 8 specyfikacji) —
// wlasciciel te decyzje zmienil, bo raport zarzadczy („ile zostaje") ma miec JEDNA prawde
// o kosztach, a nie sume z panelu plus arkusz obok.
//
// ⚠️⚠️ TRZY POLA I ANI JEDNEGO WIECEJ (2026-08-13, prosba wlasciciela po obejrzeniu pierwszej
// wersji: „wystarczy tabela z dopisywaniem fv: 1. Firma (pole wyboru np. facebook) 2. data
// 3. kwota — tyle"). Poprzedni formularz mial osiem: date, nazwe sprzedawcy, NIP, numer
// dokumentu, netto, VAT, brutto, walute i kategorie. Cala reszta bierze sie teraz sama:
//   • NAZWA SPRZEDAWCY, KATEGORIA i TYP — ze slownika firm (db/firmy-reczne.js), bo te koszty
//     wracaja co miesiac od tych samych kilku dostawcow;
//   • NIP — zawsze pusty: to sa wystawcy BEZ polskiego NIP-u i wlasnie dlatego ich faktur nie
//     ma w KSeF (gdyby ktorys go mial, jego faktura przyszlaby sama);
//   • NUMER DOKUMENTU — skladany z firmy i daty (`numerRecznego` nizej);
//   • NETTO / VAT / BRUTTO / WALUTA — z jednej kwoty w zlotowkach (patrz nizej).
//
// ⚠️ CZEGO TU NIE MA: sprawdzania, czy taki dokument juz kiedys wpisano. Ten sam Facebook
// wystawia co miesiac dokument o podobnym numerze, a dwa wpisy tej samej faktury poznaje
// czlowiek patrzacy na liste — natomiast automat, ktory „rozpozna dublet" po nazwie i kwocie,
// predzej czy pozniej odmowi zapisania DRUGIEJ, prawdziwej faktury z tego samego dnia.

// ⚠️⚠️ KLUCZ SYNTETYCZNY, BO KLUCZEM GLOWNYM TABELI JEST NUMER KSeF, a reczna faktura go nie ma.
//
// Trzy wymagania, wszystkie spelnione przez ten ksztalt:
//   • NIE KOLIDUJE z prawdziwym numerem KSeF — tamten zaczyna sie od NIP-u wystawcy (cyfry),
//     wiec zaden prawdziwy numer nie zaczyna sie od naszego prefiksu;
//   • JEST STABILNY — powstaje RAZ, przy zapisie, i nie zmienia sie przy zadnej edycji. Klucz
//     liczony z tresci dokumentu (skrot z nazwy i kwoty) zmienialby sie przy poprawianiu
//     literowki w kwocie, czyli poprawka zakladalaby DRUGI wiersz zamiast poprawic pierwszy;
//   • JEST ROZPOZNAWALNY GOLYM OKIEM w bazie i w logu — „skad sie tu wzial dokument bez numeru
//     KSeF" jest pytaniem, ktore pada o trzeciej w nocy.
export const PREFIKS_RECZNEGO = 'RECZNY-';

export const nowyKluczReczny = () => `${PREFIKS_RECZNEGO}${randomUUID()}`;

export const czyKluczReczny = (klucz) => String(klucz ?? '').startsWith(PREFIKS_RECZNEGO);

// Rodzaj dokumentu z KSeF to 'Vat' | 'Kor' | 'Zal' | 'Roz' | 'Upr'. Wiersz reczny nie jest
// zadnym z nich — bywa paragonem albo faktura zagraniczna — wiec dostaje wlasna wartosc,
// zamiast udawac fakture VAT w polu, ktore czyta widok i (kiedys) raport zarzadczy.
export const RODZAJ_RECZNY = 'Reczny';

// ⚠️⚠️ NUMER DOKUMENTU SKLADANY, BO KOLUMNA GO WYMAGA (`numer_dokumentu NOT NULL`), A OPERATOR
// NIE MA GO WPISYWAC. Ma byc czytelny na liscie („Facebook (Meta) 2026-08-12" mowi wszystko,
// co o tym wierszu trzeba wiedziec) i ma NIE UDAWAC numeru faktury sprzedawcy: gdyby tam stalo
// „FV/08/2026", ktos predzej czy pozniej zaczalby po nim szukac dokumentu u Mety — i nie
// znalazl, bo takiego numeru nikt nigdy nie wystawil.
//
// ⚠️ NIE JEST TO KLUCZ i nie ma byc niepowtarzalny. Dwie faktury od tej samej firmy z tego
// samego dnia dostana ten sam napis i to jest poprawne — tozsamosc wiersza niesie
// `RECZNY-<uuid>`, a rozpoznawania dubletow tu swiadomie nie ma (naglowek wyzej).
export const numerRecznego = (firma, dataWystawienia) => `${firma} ${dataWystawienia}`;

const napis = (v) => String(v ?? '').trim();

// Kwota od CZLOWIEKA, a nie z JSON-a KSeF — i stad jedyna roznica wobec `kwota` w
// koszt-metadane.js: przecinek dziesietny. „123,45" wpisane z polskiej klawiatury przeszloby
// przez `Number()` jako NaN, czyli odmowa przy kwocie CALKOWICIE POPRAWNEJ dla czlowieka.
// Reszta jest ta sama: brak kwoty rzuca (`grosze`), a wynik wychodzi w postaci KANONICZNEJ
// ('100.00'), a nie tak, jak go wklepano — dwie postaci tej samej kwoty w bazie znaczylyby,
// ze porownanie napisow przestaje cokolwiek znaczyc.
function kwotaGr(wartosc) {
  const s = typeof wartosc === 'string' ? wartosc.trim().replace(',', '.') : wartosc;
  return grosze(s, 'kwota faktury kosztowej');
}

const DATA_DNIA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Wiersz tabeli `koszty` z trzech pol formularza (`firma`, `dataWystawienia`, `kwota`) oraz
 * DEFINICJI FIRMY ze slownika (db/firmy-reczne.js: `nazwa`, `sprzedawca`, `kategoria`, `typ`).
 * Rzuca `bladOperatora` na kazdej niezgodnosci — komplet sprawdzen stoi TUTAJ, a nie w trasie:
 * trasa parsuje zadanie, domena rozstrzyga, co jest kosztem.
 */
export function naWierszReczny(dane = {}, firma = null) {
  // ⚠️ FIRMA WYBRANA Z LISTY, NIE WPISANA. Odmowa jest tu konieczna, mimo `<select>` na
  // ekranie: zadanie da sie zlozyc z reki, a firma spoza slownika nie niesie ani nazwy
  // sprzedawcy, ani kategorii — wiersz wszedlby do sumy miesiaca jako koszt niczyj.
  if (!firma?.sprzedawca) {
    throw bladOperatora(
      `Panel nie zna firmy „${napis(dane.firma)}" — wybierz ją z listy albo dopisz do niej `
      + 'nową. Za pozycją listy stoi nazwa sprzedawcy i kategoria kosztu, więc bez niej '
      + 'panel nie wie, czyj to koszt ani na co poszedł.',
    );
  }

  // ⚠️ DATA WYSTAWIENIA W POSTACI DNIA, TWARDO. Miesiac kosztow liczy sie po tej kolumnie,
  // a zapytanie idzie ZAKRESEM po napisie (`kosztyMiesiaca` w db/koszty.js) — data w innym
  // formacie ('5.08.2026') wypadlaby z KAZDEGO miesiaca. Dokument bylby w bazie i nie byloby
  // go w zadnej sumie: dokladnie ten rodzaj cichej dziury, przed ktorym broni caly ten modul.
  const dataWystawienia = napis(dane.dataWystawienia);
  if (!DATA_DNIA.test(dataWystawienia)) {
    throw bladOperatora(
      `„${dataWystawienia}" to nie jest data wystawienia w formacie RRRR-MM-DD. `
      + 'Po tej dacie liczy się miesiąc kosztów, więc panel nie zapisze jej „jakkolwiek".',
    );
  }

  // ⚠️⚠️ JEDNA KWOTA, W ZLOTOWKACH, ZAPISYWANA JAKO NETTO **ORAZ** BRUTTO, Z ZEROWYM VAT-em.
  //
  // To sa zakupy ZAGRANICZNE rozliczane jako IMPORT USLUG: VAT idzie odwrotnym obciazeniem
  // (podatek nalicza i odlicza nabywca, czyli my), wiec sprzedawca zadnego VAT-u na dokumencie
  // nie nalicza, a do kosztu w KPiR wchodzi kwota NETTO. Rozbijanie jej na netto/VAT/brutto
  // bylo wiec pytaniem o liczby, ktorych na dokumencie NIE MA — a operator ma pod reka
  // dokladnie jedna: te z rozliczenia karty albo z wyciagu bankowego.
  //
  // BRUTTO DOSTAJE TE SAMA WARTOSC, a nie NULL: kolumna jest `NOT NULL`, a suma miesiaca
  // pokazuje trzy liczby obok siebie. Przy odwrotnym obciazeniu netto RZECZYWISCIE rowna sie
  // brutto na dokumencie sprzedawcy, wiec to nie jest wypelniacz, tylko prawda o tym zakupie.
  //
  // ⚠️ WALUTA TO PLN I DLATEGO NIE MA JEJ NA FORMULARZU. Dokument w obcej walucie stoi POZA
  // suma miesiaca (domain/lista-kosztow.js: kursu nie zmyslamy) — czyli koszty, dla ktorych
  // ta funkcja powstala, ladowaly poza suma, ktora mieli zasilic. Operator wpisuje kwote juz
  // przeliczona przez bank i wiersz wchodzi do sumy normalnie.
  //
  // ⚠️ STRAZNIKA „netto + VAT = brutto" TU NIE MA I NIE MA CZEGO PILNOWAC: przy jednej kwocie
  // te trzy liczby nie moga sie rozjechac, bo pochodza z jednej. Byl on sensowny przy trzech
  // polach — teraz sprawdzalby wylacznie, czy panel poprawnie przepisal liczbe sam sobie.
  const kwotaGrosze = kwotaGr(dane.kwota);
  const kwota = zl(kwotaGrosze);

  return {
    numerDokumentu: numerRecznego(firma.nazwa, dataWystawienia),
    // ⚠️ ZAWSZE NULL I TO JEST SEDNO: Google, Meta ani Anthropic nie maja polskiego NIP-u,
    // a to wlasnie ich faktur nie ma w KSeF. Sprzedawca, ktory NIP ma, trafia do panelu sam,
    // przez czuwacza — nie ma powodu wpisywac go reka, wiec nie ma tez pola na NIP.
    sprzedawcaNip: null,
    sprzedawcaNazwa: firma.sprzedawca,
    dataWystawienia,
    netto: kwota,
    vat: zl(0),
    brutto: kwota,
    waluta: 'PLN',
    // ⚠️ KATEGORIA WPROST NA DOKUMENCIE — jedyna droga dla sprzedawcy BEZ polskiego NIP-u.
    // Mapa kategorii jest kluczowana NIP-em (db/kategorie-kosztow.js), wiec Google czy Meta
    // nie maja jak do niej trafic. Wartosc idzie ze slownika firm, a nie z formularza:
    // kategoria wpisywana przy kazdym koszcie od nowa rozpadala by sie po kwartale na
    // „Reklama" i „Marketing" — dwie grupy w rozbiciu, po cichu, z jednego kosztu.
    kategoriaDokumentu: firma.kategoria,
    typDokumentu: firma.typ,
  };
}
