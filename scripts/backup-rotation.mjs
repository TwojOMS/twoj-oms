// Rotacja kopii bazy. Wzorzec nazwy jest jedynym kryterium - plik, ktory sie
// w nim nie miesci, nie jest nasza kopia i nie wolno go tknac.
//
// Prefiks rozroznia uslugi: kopie robia dwie (panel indywidualny i OMS), do dwoch
// katalogow. Bez prefiksu w kryterium pomylka sciezki w compose oznaczalaby, ze
// rotacja jednej uslugi kasuje kopie drugiej - po cichu i nieodwracalnie.
const BEZPIECZNY_PREFIKS = /^[a-z0-9-]+$/;

export function wybierzDoSkasowania(nazwy, zachowaj, prefiks = 'panel') {
  if (!Number.isInteger(zachowaj) || zachowaj < 1) {
    throw new Error(`retencja musi byc liczba calkowita >= 1, dostalem: ${zachowaj}`);
  }
  // Prefiks pochodzi ze zmiennej srodowiskowej i trafia do wyrazenia regularnego.
  // Literowka w rodzaju 'p.nel' dalaby wzorzec pasujacy SZERZEJ niz nazwa uslugi.
  if (typeof prefiks !== 'string' || !BEZPIECZNY_PREFIKS.test(prefiks)) {
    throw new Error(`prefiks kopii moze zawierac tylko [a-z0-9-], dostalem: ${JSON.stringify(prefiks)}`);
  }
  const wzorzec = new RegExp(`^${prefiks}-\\d{4}-\\d{2}-\\d{2}\\.sqlite$`);
  const nasze = nazwy.filter((n) => wzorzec.test(n)).sort();
  if (nasze.length <= zachowaj) return [];
  return nasze.slice(0, nasze.length - zachowaj);
}
