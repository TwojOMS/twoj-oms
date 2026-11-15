import { regulyKonta } from './cennik-dostaw.js';

// Pola wymagane dodatkowo przez typ kanału konta; Allegro wymaga warunków zwrotów i reklamacji (D15),
// gwarancja jest opcjonalna.
const WYMAGANE_TYPU = {
 allegro: [['zwrotyId','warunki zwrotów'],['reklamacjeId','warunki reklamacji']],
};

// Jedna lista braków dla formularza, zapisu i bramki pętli. `typ` = typ kanału konta.
export function brakiUstawienOfert(ustawienia, typ) {
 const u=ustawienia??{};
 const dodatkowe=Object.hasOwn(WYMAGANE_TYPU,typ??'')?WYMAGANE_TYPU[typ]:[];
 return [
  [u.stalaIlosc==null,'stała liczba sztuk'],
  [u.czasWysylkiDni==null,'czas wysyłki'],
  [!regulyKonta(u).length,'cennik dostaw'],
  [!u.stawkaVat,'stawka VAT'],
  ...dodatkowe.map(([pole,nazwa])=>[!u[pole]?.trim(),nazwa]),
 ].filter(([brak])=>brak).map(([,nazwa])=>nazwa);
}
