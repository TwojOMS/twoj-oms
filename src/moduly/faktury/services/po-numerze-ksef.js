import { pobierzZamowienie, dopiszLog } from '../../../oms/db/zamowienia.js';
import { wolnoWyslacDoAllegro } from '../../../domena/allegro-faktura.js';

// CO SIE MA STAC, GDY PRZY FAKTURZE POJAWI SIE NUMER KSeF.
//
// ⚠️⚠️ ISTNIEJE, BO ZAPIS NUMERU MA NASTEPSTWO — A DRUGI PISARZ NUMERU O TYM NIE WIEDZIAL.
// Regresja z produkcji 14.08.2026, zgloszenie wlasciciela: „faktury nie wysylaja sie do
// Allegro". Mechanizm:
//
//   1. czuwacz szuka faktur po warunku `ksef_numer IS NULL` (domain/ksef-oczekiwanie.js);
//   2. po znalezieniu numeru to ON wysylal dokument kupujacemu na Allegro;
//   3. karta zamowienia dostala 12.08.2026 wlasne doczytywanie numeru na zywo
//      (services/ksef-doczytanie.js) — i zapisywala numer NIE ROBIAC NIC DALEJ;
//   4. faktura wypadala z kolejki czuwacza NA ZAWSZE i nie szla do kupujacego NIGDY.
//
// Trafialo za KAZDYM razem, bo naturalna kolejnosc ruchow operatora to dokladnie „zlec wysylke
// do KSeF w zakladce FAKTURY, potem zajrzyj na karte".
//
// ⚠️ DLATEGO TO NIE JEST FUNKCJA CZUWACZA. Jest osobnym modulem, zeby KAZDY, kto zapisuje
// `ksef_numer`, mial jedno oczywiste miejsce do zawolania — i zeby trzeci pisarz numeru nie
// powtorzyl tego bledu. Zapis numeru bez tego wywolania to od teraz blad, a nie decyzja.

export function createPoNumerzeKsef({ db, fakturaAllegro = null }) {
  /**
   * @param zamowienieId zamowienie, przy ktorym numer wlasnie sie pojawil
   */
  async function wyslijDoAllegroJesliWolno(zamowienieId) {
    if (!fakturaAllegro) return;
    const z = pobierzZamowienie(db, zamowienieId);
    // ⚠️ CISZA, GDY NIE WOLNO — i to jest celowe. Odmowa dotyczy tu przypadkow CALKOWICIE
    // NORMALNYCH i czestych: kazdej faktury sklepowej, kazdego zamowienia allegrowego bez
    // zadania faktury, kazdego dokumentu juz wyslanego. Wpis do logu przy kazdej z nich
    // zasypalby karty szumem, a log ma rosnac od ZDARZEN, nie od PRZEBIEGOW.
    if (!wolnoWyslacDoAllegro(z).wolno) return;
    try {
      await fakturaAllegro.wyslij(zamowienieId);
      // ⚠️ SLAD MOWI, ZE TO AUTOMAT. Usluga zapisuje juz swoj wlasny wpis („plik … wyslany
      // do Allegro"), ale nie wie, kto ja zawolal — a po miesiacu pierwszym pytaniem jest
      // „kto wyslal kupujacemu ten dokument".
      dopiszLog(db, zamowienieId, {
        akcja: 'faktura-allegro',
        wynik: 'AUTOMAT: numer KSeF się pojawił, więc panel sam wysłał fakturę do kupującego.',
      });
    } catch (e) {
      dopiszLog(db, zamowienieId, {
        akcja: 'faktura-allegro',
        wynik: `AUTOMAT: nie udało się wysłać faktury do Allegro — ${e.message} `
          + 'Numer KSeF jest zapisany; dokument możesz wysłać przyciskiem na karcie.',
      });
    }
  }

  return { wyslijDoAllegroJesliWolno };
}
