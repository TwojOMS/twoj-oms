import { zapiszNumerKsef, zapiszNieudanyOdczytKsef } from '../db/faktury.js';
import { dopiszLog } from '../../../oms/db/zamowienia.js';
import { czyDoczytacKsef } from '../../../domena/ksef-doczytanie.js';
import { idDokumentu, czyDokumentProgramu, numerKsefDokumentu } from '../../../domena/dokument-programu.js';
import { zProgramu } from '../../../integracje/program-fakturowy.ts';

// Doczytanie numeru KSeF dla JEDNEJ faktury, przy otwarciu karty zamowienia.
// Regula „czy w ogole pytac" siedzi w domena/ksef-doczytanie.js — tutaj jest wylacznie I/O.
//
// ⚠️ TA USLUGA NIE RZUCA NIGDY, I TO JEST JEJ GLOWNA WLASNOSC. Wola ja renderowanie karty,
// a karta ma sie otworzyc takze wtedy, gdy inFakt lezy, klucz wygasl albo dysk jest pelny.
// Zwraca `true` WYLACZNIE wtedy, gdy w bazie przybyl numer — czyli gdy wolajacy ma powod
// przeczytac zamowienie jeszcze raz. To jest ta sama umowa, co przy `przesylkiAllegro.odswiez`
// na tej samej karcie: „czy cos sie zmienilo", a nie „czy poszlo gladko".
//
// ⚠️⚠️ TA ŚCIEŻKA NIE MOŻE „TYLKO ZAPISAĆ NUMERU” I NIC DALEJ — to kusi, ale jest BŁĘDEM.
// Zapisanie `ksef_numer` WYCINA fakturę z kolejki czuwacza (jego zapytanie zaczyna się od
// `f.ksef_numer IS NULL`, domena/ksef-oczekiwanie.js). Ścieżka, która nie robi nic dalej, nie
// „powstrzymuje się” od następstwa — ona ZABIERA czuwaczowi robotę, nie wykonując jej, i faktura
// nie idzie do kupującego na Allegro NIGDY. Trafiałoby za KAŻDYM razem, bo naturalna kolejność
// ruchów to „zleć wysyłkę do KSeF w zakładce FAKTURY, potem zajrzyj na kartę”.
//
// Dlatego następstwo zapisu numeru mieszka w JEDNYM miejscu (services/po-numerze-ksef.js)
// i wołają je OBIE drogi. Zapis `ksef_numer` bez tego wywołania jest błędem, nie decyzją.
//
// Czuwacz dalej robi wiecej niz ta sciezka: chodzi po WSZYSTKICH fakturach czekajacych na numer,
// co godzine, i ma wlasna druga petle (weryfikacja pliku w Allegro).

// Numer KSeF czyta PROGRAM FAKTUROWY (`{ program }` albo stary `{ infakt }` przez `zProgramu`).
export function createDoczytanieKsef({
  db, program: programPodany = null, infakt = null, poNumerzeKsef = null, teraz = () => new Date().toISOString(),
}) {
  const program = zProgramu({ program: programPodany, infakt });
  /**
   * @param faktura wiersz z `faktury` (albo `null`)
   * @param zamowienieId potrzebny wylacznie do wpisu w logu
   * @returns `true`, gdy w bazie przybyl numer KSeF
   */
  async function dlaFaktury(faktura, zamowienieId) {
    if (!program) return false;
    if (!czyDoczytacKsef(faktura, Date.now())) return false;
    // Dokument innego programu niż moduł faktur OMS-u — nie pytamy o niego nikogo i nic nie zapisujemy
    // (stempel „pytaliśmy” byłby nieprawdą). Karta otwiera się jak zawsze.
    if (!czyDokumentProgramu(faktura, program)) return false;

    try {
      const dok = idDokumentu(faktura);
      const numer = numerKsefDokumentu(await program.pobierzFakture(dok));
      // ⚠️ ZAPIS TAKZE WTEDY, GDY NUMERU NIE MA. `ksef_sprawdzona_at` to data PYTANIA, nie
      // odpowiedzi — i to na niej stoi dlawik. Bez tego zapisu kazde odswiezenie karty
      // faktury, ktora numeru jeszcze nie ma, bilo do inFaktu od nowa. `zapiszNumerKsef`
      // uzywa COALESCE, wiec pusta odpowiedz nie skasuje numeru zapisanego wczesniej.
      // Z `dokumentId` — wiersz przepięty w trakcie pytania na fakturę zastępczą nie dostaje numeru starej.
      const zapisano = zapiszNumerKsef(db, faktura.id, { ksefNumer: numer, sprawdzonaAt: teraz(), dokumentId: dok });
      if (!numer || !zapisano) return false;
      // Log dopiero po zapisie i tylko przy FAKCIE — inaczej historia zamowienia rosnie
      // proporcjonalnie do liczby odslon karty, a nie do liczby zdarzen.
      dopiszLog(db, zamowienieId, { akcja: 'ksef', wynik: `dokument jest w KSeF (${numer})` });
      // ⚠️⚠️ NASTĘPSTWO ZAPISU NUMERU — BEZ TEGO FAKTURA NIE PÓJDZIE DO ALLEGRO NIGDY.
      // Zapisanie numeru wycina fakturę z kolejki czuwacza (`ksef_numer IS NULL`), a czuwacz
      // wysyła dokument kupującemu tylko dla faktur z tej kolejki — patrz docblock w po-numerze-ksef.js.
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
      // `zapiszLubOdpusc` w moduly/wysylka/services/status-kuriera.js).
      try {
        // Z `dokumentId`: wiersz przepięty w trakcie pytania na zastępczą nie dostaje stempla starej.
        zapiszNieudanyOdczytKsef(db, faktura.id, { sprawdzonaAt: teraz(), dokumentId: idDokumentu(faktura) });
      } catch { /* karta wazniejsza niz slad */ }
      return false;
    }
  }

  return { dlaFaktury };
}
