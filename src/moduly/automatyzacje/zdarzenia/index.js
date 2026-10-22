// PRZ-108.07 (zmiana B planu automatyzacji): rejestr zdarzeń, które silnik umie wykryć.
// PRZ-108.08 (zmiana C1): „Paczka nadana” i „Status zamówienia zmienił się na”. PRZ-108.09 (C2): „Kurier odebrał
// paczkę”. Dalej: D kolejne (plan, sekcja 8).
//
// Kontrakt wpisu: { klucz, etykieta, opis, pomoc? (zdanie pod opisem w kreatorze), grupa ('przesylka' | 'zamowienie' | 'dokumenty'),
//   kandydaci(db, { granica, od, po, parametr, limit, kanaly, regula_id })
//     → [{ id, zamowienie_id, sklep, zdarzenie_at, przesylka_id?, przedmiot? }],
//   symulacja(db, od, { parametr }) → te same wiersze bez granicy (podgląd „30 dni”, ZERO zapisów),
//   opcjeParametru?(db) → [{ klucz, etykieta, dostepny, wlasny? }]   (zdarzenie z parametrem, np. status),
//   bladParametru?(db, parametr) → zdanie | null                    (parametr martwy, np. usunięty status własny) }.
// • `granica` = { at, zamowienia, przesylki, faktury, proformy } (migawka MAX(id) z chwili włączenia) — detektor sam
//   odcina zdarzenia sprzed granicy.
// • `od` (ISO) = kursor − 5 min zakładki, nigdy sprzed granicy: tylko `zdarzenie_at >= od`.
// • `po` = null albo { at, id } — kontynuacja po obciętej liście: tylko wiersze ŚCIŚLE po (at, id), czyli
//   `zdarzenie_at > po.at OR (zdarzenie_at = po.at AND id > po.id)` (PRZ-108.07, recenzja 07, usterka 3).
// • Wiersze POSORTOWANE rosnąco po (zdarzenie_at, id), najwyżej `limit` — silnik bierze ostatni wiersz za kursor.
// • `id` = jednoznaczny klucz sortowania w obrębie zdarzenia (id zamówienia albo przesyłki); bez niego silnik bierze
//   `zamowienie_id`.
// • `zdarzenie_at` = ISO 8601 z `Z` (`toISOString()`), bo silnik porównuje je jako tekst i liczy z nich termin.
// • `sklep` jest obowiązkowy: bez niego biała lista kanałów nic nie przepuści.
// • `kanaly` = biała lista reguły (detektor C1 filtruje już w SQL, silnik drugi raz); `regula_id` — dla detektorów
//   bez znacznika chwili zmiany (paczka nadana pomija paczki, które reguła już ma).
import { zdarzeniePaczkaNadana } from './paczka-nadana.js';
import { zdarzenieStatusZmieniony } from './status-zmieniony.js';
import { zdarzeniePaczkaOdebrana } from './paczka-odebrana.js';

export const ZDARZENIA = Object.freeze([zdarzeniePaczkaNadana, zdarzeniePaczkaOdebrana, zdarzenieStatusZmieniony]);
