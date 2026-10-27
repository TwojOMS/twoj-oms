import { pobierzZamowienie, dopiszLog } from '../../../oms/db/zamowienia.js';
import {
  dodajZwrot, usunZwrot, oznaczPieniadzeOddane, zwrot, odblokujKorekte, zapiszRecznyNumerKorekty,
} from '../../../oms/db/zwroty.js';
import {
  parsujZwrot, powodOdmowyUsunieciaZwrotu, korektaPrzepadla, powodOdmowyOdblokowaniaKorekty,
  parsujNumerKorekty, korektaNieSprawdzona, powodOdmowyKorektyDlaFaktury,
  powodOdmowyRejestracjiZwrotu, wierszeFormularzaZwrotu,
} from '../../../domena/zwrot.js';
import { formularzZwrotu, przygotujKrok2, razemZwrotuZl } from '../../../domena/zwrot-formularz.js';
import { dzienWarszawa } from '../../../domena/format-daty.js';
import { komunikatDlaOperatora } from '../../../domena/bledy.js';
import { adresKartyZamowienia } from '../../../domena/adres-karty-zamowienia.js';
import { bezpiecznyPowrotNaListe } from '../../../domena/filtry-listy.js';
import { ktoKlikal } from '../../zamowienia/wspolne.js';

import { createWspolne } from './wspolne.js';
export function registerFormularzRoutes(app, { db, korekta = null, definicje, infakt = null }) {
  const { powrotKarty, adresKarty, zamowienieAlbo404, slad, decyzja, pokazKrok1 } = createWspolne({ db, korekta, definicje, infakt });
  app.get('/zamowienia/:id/zwrot', async (req, reply) => {
    let z = zamowienieAlbo404(req, reply);
    if (!z) return reply;
    if (korekta) {
      for (const w of z.zwroty ?? []) {
        // Sekwencyjnie, nie hurtem: zwrotow przy jednym zamowieniu sa najwyzej dwa,
        // a rownolegle wywolania do inFaktu nie maja tu czego przyspieszyc.
        // eslint-disable-next-line no-await-in-loop
        await korekta.doczytaj(z.id, w.id);
      }
      // Ponowny odczyt WYLACZNIE po doczytaniu: `z` powyzej niesie zwroty sprzed petli, wiec
      // numer korekty zapisany przez `doczytaj` w tym samym zadaniu bylby na ekranie niewidoczny
      // az do przeladowania strony. Ta sama pulapka i to samo lekarstwo, co przy numerze KSeF
      // na karcie zamowienia (routes/zamowienia.js: ponowny odczyt po `doczytanieKsef.dlaFaktury`).
      z = pobierzZamowienie(db, z.id);
    }
    return pokazKrok1(req, reply, z);
  });

  /**
   * KROK 2 — „Dalej — sprawdź sumę". NICZEGO NIE ZAPISUJE.
   *
   * ⚠️⚠️ TU KWOTY PODAZAJA ZA ILOSCIA (`przygotujKrok2` w domain/zwrot-formularz.js) — naprawa
   * wady krytycznej z recenzji 2026-08-15. Kwota, ktorej operator nie tknal (rowna propozycji
   * przyniesionej z kroku 1 w polu ukrytym), przelicza sie dla liczby sztuk, ktora wpisal;
   * kwota zmieniona recznie wygrywa, ale wraca stad jako OSTRZEZENIE do pokazania na ekranie.
   *
   * ⚠️ Kwote laczna liczy `przygotujKrok2` (domain/zwrot-formularz.js), a nie operator — i to
   * jest cala przebudowa. Bariera spojnosci w `parsujZwrot` (kwota laczna = suma kwot przy
   * pozycjach) przestaje przez to kogokolwiek odrzucac i zostaje STRAZNIKIEM miedzy krokiem 2
   * a zapisem: pola ukryte kroku 2 nioslyby rozjazd rownie dobrze, gdyby ktos je podmienil.
   *
   * ⚠️ Reguly sa TE SAME, co przy zapisie (`parsujZwrot`) — odmowa ma przyjsc TU, na kroku 2,
   * a nie dopiero po kliknieciu „Zarejestruj zwrot" na ekranie bez pol do poprawienia.
   *
   * ⚠️ BEZ WPISU DO LOGU — i to jest jedyne odstepstwo od zasady „kazda trasa w tym pliku pisze
   * do logu zamowienia" z naglowka pliku. Ta trasa NICZEGO NIE ZMIENIA: nie zapisuje zwrotu,
   * nie dotyka inFaktu, nie zmienia statusu. Wpis przy kazdej literowce zasypywalby log
   * zamowienia szumem i utrudnial odczytanie tego, co zapisano NAPRAWDE — a to jest dokladnie
   * ten log, z ktorego po miesiacu odtwarza sie, ile i kiedy zdjeto z przychodu.
   */
  app.post('/zamowienia/:id/zwrot/podglad', async (req, reply) => {
    const z = zamowienieAlbo404(req, reply);
    if (!z) return reply;
    const dzis = dzienWarszawa(new Date().toISOString());
    // ⚠️⚠️ `try` WOKOL PRZELICZENIA (drobiazg I2, recenzja kontrolna 2026-08-15). Pozycja bez
    // ceny wywraca `wartoscPozycjiGrosze` — a ta trasa nie miala `try`, wiec zamiast zdania po
    // polsku oddawala 500. Z ekranu jest to nieosiagalne (krok 1 blokuje takie zamowienie
    // wczesniej, patrz `pokazKrok1`), ale sciezka POST istnieje i przyjmuje cialo od kogokolwiek.
    // DOMKNIETE Z DWOCH STRON: straznik zera stoi teraz PRZED odczytem ceny
    // (domain/zwrot-formularz.js), a tu lezy siatka na przypadek, w ktorym ceny naprawde
    // potrzeba. Odmowa wraca na KROK 1 tym samym zdaniem, ktore oddalby zapis.
    let cialo;
    let ostrzezenia;
    try {
      ({ cialo, ostrzezenia } = przygotujKrok2(z, req.body));
    } catch (e) {
      return pokazKrok1(req, reply, z, { blad: komunikatDlaOperatora(e), wpisane: req.body, kod: 400 });
    }
    const { zwrot: kandydat, blad } = parsujZwrot(z, cialo, { dzis });
    // Odmowa wraca na KROK 1 z zachowanymi wartosciami — ekran bez pol do poprawienia
    // kazalby operatorowi wpisywac wszystko od nowa.
    //
    // ⚠️ Wracaja wartosci PO PRZELICZENIU (`cialo`), a nie surowe `req.body`. Inaczej kwota,
    // ktora panel wlasnie policzyl dla nowej liczby sztuk, wrocilaby na ekran w starej postaci,
    // przy nastepnym podejsciu wygladalaby jak „wpisana recznie" i przestalaby podazac za
    // iloscia — czyli wada krytyczna wracalaby bocznymi drzwiami przy kazdej odmowie reguly.
    if (blad) return pokazKrok1(req, reply, z, { blad, wpisane: cialo, kod: 400 });
    return reply.view('zwrot-podglad.ejs', {
      title: `Zwrot — zamówienie ${z.numer}`,
      z,
      powrot: powrotKarty(req),
      kandydat,
      // RAZEM liczy DOMENA z wyniku `parsujZwrot` — widok nie sumuje niczego u siebie.
      razemZl: razemZwrotuZl(kandydat),
      // ⚠️ Kwoty wpisane inaczej, niz policzylby panel — zdania gotowe, liczone w domenie.
      // Widok je WYPISUJE, nie osadza: „ostrzezenie, nie odmowa" jest decyzja regulaminowa.
      ostrzezenia,
      // ⚠️ WSZYSTKIE wiersze, TAKZE te z iloscia 0 — pola ukryte kroku 2 sa jedynym nosnikiem
      // wartosci dla „Wstecz — popraw". Pominiecie wierszy, ktore nie wracaja, cofaloby im
      // recznie wyzerowana ilosc do podpowiedzi i gubilo decyzje operatora.
      wiersze: wierszeFormularzaZwrotu(cialo) ?? [],
      kwotaZl: cialo.kwota,
      kwotaDostawyZl: cialo.kwota_dostawy,
      zwrocDostawe: Boolean(req.body?.zwroc_dostawe),
    });
  });

  /**
   * „Wstecz — popraw" z kroku 2. Renderuje krok 1 Z WARTOSCIAMI z pol ukrytych — nic nie ginie.
   *
   * ⚠️ To jest POST, a nie odnosnik do `GET /zwrot`, i inaczej byc nie moze: bez javascriptu
   * w przegladarce jedynym sposobem, zeby przeniesc wpisane liczby z powrotem na formularz,
   * jest odeslanie ich w ciele zadania.
   */
  app.post('/zamowienia/:id/zwrot/popraw', async (req, reply) => {
    const z = zamowienieAlbo404(req, reply);
    if (!z) return reply;
    return pokazKrok1(req, reply, z, { wpisane: req.body });
  });

}
