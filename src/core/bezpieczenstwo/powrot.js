// Bramka na adres powrotu. Uzywaja jej OBA panele: przelacznik motywu w OMS-ie
// i przekierowanie po zalogowaniu w obu uslugach.
//
// ⚠️ TO JEST BRAMKA BEZPIECZENSTWA, nie wygoda. Wartosc przychodzi z pola formularza albo
// z paska adresu, wiec spreparowane zadanie moglo by wyslac operatora na obca strone.

/**
 * Dokad wolno odeslac operatora.
 *
 * ⚠️ TO JEST BRAMKA NA PRZEKIEROWANIE, nie wygoda. Wartosc przychodzi z pola formularza,
 * wiec spreparowane zadanie moglo by wyslac operatora na obca strone — panel stoi za Basic
 * Auth, a przegladarka dokleja zapamietane haslo do kazdego zadania na ten adres, wiec
 * przekierowanie w obce miejsce jest realnym ryzykiem, a nie teoria.
 *
 * Przepuszczamy WYLACZNIE sciezke wzgledna zaczynajaca sie od jednego ukosnika. `//obcy.pl`
 * i `/\obcy.pl` sa adresami ZEWNETRZNYMI mimo poczatkowego ukosnika (przegladarka czyta je
 * jako „ten sam protokol, inny host") — stad jawne odciecie drugiego znaku.
 */
export function bezpiecznyPowrot(surowa) {
  const t = String(surowa ?? '').trim();
  if (!t.startsWith('/')) return '/';
  if (t.startsWith('//') || t.startsWith('/\\')) return '/';
  // Znaki sterujace w naglowku `Location` to droga do rozszczepienia odpowiedzi.
  if (/[\r\n]/.test(t)) return '/';
  return t;
}
