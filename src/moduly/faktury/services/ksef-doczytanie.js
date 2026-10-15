import { zapiszNumerKsef, zapiszNieudanyOdczytKsef } from '../db/faktury.js';
import { dopiszLog } from '../../../oms/db/zamowienia.js';
import { czyDoczytacKsef } from '../../../domena/ksef-doczytanie.js';

// Doczytanie numeru KSeF dla JEDNEJ faktury, przy otwarciu karty zamowienia.
// Regula „czy w ogole pytac" siedzi w domain/ksef-doczytanie.js — tutaj jest wylacznie I/O.
//
// ⚠️ TA USLUGA NIE RZUCA NIGDY, I TO JEST JEJ GLOWNA WLASNOSC. Wola ja renderowanie karty,
// a karta ma sie otworzyc takze wtedy, gdy inFakt lezy, klucz wygasl albo dysk jest pelny.
// Zwraca `true` WYLACZNIE wtedy, gdy w bazie przybyl numer — czyli gdy wolajacy ma powod
// przeczytac zamowienie jeszcze raz. To jest ta sama umowa, co przy `przesylkiAllegro.odswiez`
// na tej samej karcie: „czy cos sie zmienilo", a nie „czy poszlo gladko".
//
// ⚠️⚠️ SPROSTOWANIE 14.08.2026 — TU STALA MOJA WLASNA POMYLKA, ZAPISANA JAKO DECYZJA.
// Stalo tutaj: „ta sciezka odpowiada na jedno pytanie o jeden dokument i NIE URUCHAMIA NICZEGO
// DALEJ — jesli kiedys ma uruchamiac, to swiadomie". Rozumowanie bylo rozwazone i BLEDNE, bo
// pomijalo jeden fakt: zapisanie `ksef_numer` WYCINA fakture z kolejki czuwacza (jego zapytanie
// zaczyna sie od `f.ksef_numer IS NULL`, domain/ksef-oczekiwanie.js). Ta sciezka nie „powstrzymywala
// sie" wiec od nastepstwa — ona ZABIERALA czuwaczowi robote, nie wykonujac jej, i faktura nie
// szla do kupujacego na Allegro NIGDY.
//
// Zgloszenie wlasciciela: „faktury nie wysylaja sie do allegro". Trafialo za KAZDYM razem, bo
// naturalna kolejnosc ruchow to „zlec wysylke do KSeF w zakladce FAKTURY, potem zajrzyj na karte".
//
// Od teraz nastepstwo zapisu numeru mieszka w JEDNYM miejscu (services/po-numerze-ksef.js)
// i wolaja je OBIE drogi. Zapis `ksef_numer` bez tego wywolania jest bledem, nie decyzja.
//
// Czuwacz dalej robi wiecej niz ta sciezka: chodzi po WSZYSTKICH fakturach czekajacych na numer,
// co godzine, i ma wlasna druga petle (weryfikacja pliku w Allegro).

export function createDoczytanieKsef({
  db, infakt, poNumerzeKsef = null, teraz = () => new Date().toISOString(),
}) {
  /**
   * @param faktura wiersz z `faktury` (albo `null`)
   * @param zamowienieId potrzebny wylacznie do wpisu w logu
   * @returns `true`, gdy w bazie przybyl numer KSeF
   */
  async function dlaFaktury(faktura, zamowienieId) {
    if (!infakt) return false;
    if (!czyDoczytacKsef(faktura, Date.now())) return false;

    try {
      const dane = await infakt.pobierzFakture(faktura.infakt_uuid);
      // ⚠️ ZAPIS TAKZE WTEDY, GDY NUMERU NIE MA. `ksef_sprawdzona_at` to data PYTANIA, nie
      // odpowiedzi — i to na niej stoi dlawik. Bez tego zapisu kazde odswiezenie karty
      // faktury, ktora numeru jeszcze nie ma, bilo do inFaktu od nowa. `zapiszNumerKsef`
      // uzywa COALESCE, wiec pusta odpowiedz nie skasuje numeru zapisanego wczesniej.
      zapiszNumerKsef(db, faktura.id, { ksefNumer: dane?.ksefNumer ?? null, sprawdzonaAt: teraz() });
      if (!dane?.ksefNumer) return false;
      // Log dopiero po zapisie i tylko przy FAKCIE — inaczej historia zamowienia rosnie
      // proporcjonalnie do liczby odslon karty, a nie do liczby zdarzen.
      dopiszLog(db, zamowienieId, { akcja: 'ksef', wynik: `dokument jest w KSeF (${dane.ksefNumer})` });
      // ⚠️⚠️ NASTEPSTWO ZAPISU NUMERU — BEZ TEGO FAKTURA NIE POJDZIE DO ALLEGRO NIGDY.
      // Zapisanie numeru wycina fakture z kolejki czuwacza (`ksef_numer IS NULL`), a to
      // czuwacz byl jedynym miejscem, ktore po znalezieniu numeru wysylalo dokument
      // kupujacemu. Regresja z produkcji 14.08.2026 — patrz docblock w po-numerze-ksef.js.
      //
      // Wlasny `try`: awaria nastepstwa nie ma prawa cofnac zapisanego numeru ani wywalic
      // karty. Numer JEST faktem niezaleznym od tego, czy udalo sie z niego skorzystac.
      try {
        await poNumerzeKsef?.wyslijDoAllegroJesliWolno(zamowienieId);
      } catch { /* slad zapisuje samo nastepstwo */ }
      return true;
    } catch (e) {
      // ⚠️ „PYTALISMY" JEST FAKTEM NIEZALEZNYM OD ODPOWIEDZI. Bez tego zapisu faktura
      // z wiecznym bledem odczytu mialaby `ksef_sprawdzona_at` pusty na zawsze — nie do
      // odroznienia od „nigdy nie pytalismy" — a dlawik nie obejmowalby dokladnie tego
      // przypadku, w ktorym boli najbardziej: awaria inFaktu przy kazdym otwarciu karty.
      //
      // Drugi `try` jest tu naprawde potrzebny: ten zapis idzie do bazy w trakcie renderowania
      // karty, a karta ma sie otworzyc takze przy pelnym dysku (ta sama zasada, co przy
      // `zapiszLubOdpusc` w routes/zamowienia.js).
      try {
        zapiszNieudanyOdczytKsef(db, faktura.id, { sprawdzonaAt: teraz() });
      } catch { /* karta wazniejsza niz slad */ }
      return false;
    }
  }

  return { dlaFaktury };
}
