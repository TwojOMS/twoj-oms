import { umowaZbiorcza } from '../../../domena/klient-zbiorczy.js';
import { klientPoNip } from '../../../oms/db/klienci.js';
import { kluczOkresu, okresPrzyjmujeZamowienia, opisOdmowy } from '../../../domena/okres-rozliczeniowy.js';
import { zapewnijOkres, znajdzOkres } from '../../../oms/db/okresy.js';
import { bladOperatora } from '../../../domena/bledy.js';

/**
 * Okres, do ktorego nalezy zamowienie — albo `null`, gdy rozliczane jest pojedynczo.
 *
 * Ten serwis istnieje po to, zeby `oms/db/okresy.js` dostawalo GOTOWY klucz klienta i nic wiecej.
 * Rozstrzygniecie „czy ten NIP jest rozliczany zbiorczo" wymaga zlozenia dwoch warstw:
 * odczytu karty klienta (`oms/db/klienci.js`) i czystej reguly (`domena/klient-zbiorczy.js`).
 * ⚠️ Rozliczenie zbiorcze czyta się z karty klienta, nie ze zmiennej środowiskowej — dlatego
 * sygnatura nie ma `config`.
 *
 * ⚠️ HURT NIE WCHODZI DO OKRESU. Ten sam klient ma dwa rodzaje zamowien: drop do klienta
 * koncowego (faktura zbiorcza na koniec miesiaca) i hurt do wlasnej siedziby (faktura od
 * razu, z terminem). Ten sam adres mailowy może występować w obu rolach.
 * Hurt wrzucony do okresu znaczylby fakture zbiorcza obejmujaca zamowienie, ktore klient
 * juz zaplacil z osobna — czyli podwojne obciazenie.
 *
 * ⚠️ Data to data ZLOZENIA, nie wysylki (patrz naglowek domena/okres-rozliczeniowy.js).
 * Brak daty leci wyjatkiem z `kluczOkresu` i tak ma zostac: podstawienie „dzisiaj" w zastepstwie
 * zgubionej daty wrzucaloby zamowienia z przelomu miesiaca na fakture nie tego miesiaca.
 */
export function przypiszDoOkresu({ db, nip, dataZlozenia, hurt }) {
  if (hurt) return null;

  const klient = umowaZbiorcza(klientPoNip(db, nip));
  if (!klient) return null;

  const { rok, miesiac } = kluczOkresu(dataZlozenia);

  // ⚠️ Sprawdzamy stan PRZED zalozeniem: `zapewnijOkres` zalozylby otwarty okres, gdyby go
  // nie bylo, i pytanie o zamkniecie stracioby sens.
  //
  // ⚠️ ZAMKNIETY OKRES ODMAWIA, a nie przenosi zamowienia po cichu na kolejny miesiac.
  // Ciche przeniesienie postawiloby lipcowa date na sierpniowej fakturze — blad, ktorego
  // nikt nie zauwazy, bo wszystko wyglada poprawnie. Decyzje („korekta faktury czy zmiana
  // daty") podejmuje czlowiek, wiec komunikat idzie do operatora.
  const istniejacy = znajdzOkres(db, { klientKlucz: klient.klucz, rok, miesiac });
  if (istniejacy && !okresPrzyjmujeZamowienia(istniejacy.stan)) {
    throw bladOperatora(opisOdmowy(rok, miesiac));
  }

  return zapewnijOkres(db, { klientKlucz: klient.klucz, rok, miesiac }).id;
}
