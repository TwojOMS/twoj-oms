export const czystaNazwa = (wartosc) => (typeof wartosc === 'string' ? wartosc.trim().slice(0, 200) : '');

/** Pojedyncza karta pozwala wyczyścić markę lub zastąpić wybór wpisaną nazwą. */
export function markaZFormularza(body, { hurt = false } = {}) {
  const wybor = body && Object.hasOwn(body, 'marka') ? body.marka : undefined;
  const wpis = body && Object.hasOwn(body, 'marka_nowa') ? body.marka_nowa : undefined;
  if (hurt && [wybor, wpis].some((w) => w !== undefined && typeof w !== 'string')) {
    return { blad: 'Pole marki przyszło dwa razy — nie wiem, którą wartość wybrać.' };
  }
  const wybrana = czystaNazwa(wybor);
  const nowa = czystaNazwa(wpis);
  if (hurt && wybrana && nowa) {
    return { blad: 'Wybierz markę z listy albo wpisz nową — nie obie naraz' };
  }
  if (nowa || wybrana) return { marka: nowa || wybrana };
  return { marka: !hurt && typeof wybor === 'string' ? null : undefined };
}
