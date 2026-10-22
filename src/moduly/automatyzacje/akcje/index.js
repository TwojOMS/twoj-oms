// PRZ-108.07 (zmiana B planu automatyzacji): rejestr akcji.
// PRZ-108.08 (zmiana C1): „Wyślij mail do kupującego”. Akcja potrzebuje usługi wiadomości, więc rejestr składa się
// funkcją przy budowie modułu (`utworzAkcje`), nie stałą.
//
// Kontrakt wpisu: { klucz, etykieta, wymagaPoczty (bool), szablon (bool — parametr akcji to szablon wiadomości),
//   zgoda?({ db, regula, wykonanie }) → { ok, adresat? } | { ok: false, kod, powod }   (przed rezerwacją; odmowa = pominięcie),
//   wykonaj({ db, regula, wykonanie }) → { adresat? }      (po rezerwacji; wyjątek z `code` poczty decyduje o ponowieniu,
//                                                           wyjątek z `przedWysylka` = pewny brak wysyłki → błąd),
//   podglad?({ zamowienie_id, szablon }) → { do, temat, tekst } (podgląd „Sprawdź na 30 dniach”) }.
import { akcjaMailKupujacy } from './mail-kupujacy.js';

/** @param {{ wiadomosci: () => any }} zaleznosci */
export function utworzAkcje({ wiadomosci }) {
  return Object.freeze([akcjaMailKupujacy({ wiadomosci })]);
}
