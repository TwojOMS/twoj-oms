// Kolejność tabelki i lista osobistych ustawień mają jedno źródło.
export const RODZAJE_OSTRZEZEN = Object.freeze([
  { typ: 'integracja', nazwa: 'Awarie integracji', opis: 'Sklep, usługa lub czuwacz nie działa albo od dawna nie kończy przebiegu.' },
  // PRZ-108.08: widzi tylko administrator (reguły edytuje wyłącznie on).
  { typ: 'automatyzacja', nazwa: 'Automatyzacje wstrzymane lub niepewne', opis: 'Reguła wstrzymana bezpiecznikiem albo mail do kupującego, o którym nie wiadomo, czy wyszedł (tylko administrator).', tylkoAdmin: true },
  { typ: 'faktura-ksef', nazwa: 'Faktury niewysłane do KSeF', opis: 'Dokument wystawiony przed dziś nie ma numeru KSeF.' },
  { typ: 'faktura-termin', nazwa: 'Faktury po terminie płatności', opis: 'Pozostała kwota do zapłaty, a termin płatności faktury już minął.' },
  { typ: 'pobranie-korekta', nazwa: 'Pobrania czekające na korektę', opis: 'Paczka za pobraniem wróciła bez gotówki, a faktura czeka na korektę do zera.' },
  { typ: 'zwrot-korekta', nazwa: 'Zwroty czekające na korektę', opis: 'Zwrot zarejestrowany przed dziś ma fakturę, ale nie ma korekty w inFakcie.' },
  { typ: 'przesylka', nazwa: 'Przesyłki bez ruchu', opis: 'Przesyłka od dłuższego czasu nie zmieniła statusu u kuriera.' },
  { typ: 'wiadomosc-allegro', nazwa: 'Wiadomości Allegro bez odpowiedzi', opis: 'Ostatnia wiadomość w wątku jest od kupującego i pochodzi z ostatnich siedmiu dni.' },
].map(r => Object.freeze(r)));

export const KOLEJNOSC = Object.freeze(RODZAJE_OSTRZEZEN.map(r => r.typ));

/** PRZ-108.08: rodzaje, które konto w ogóle może zobaczyć (`tylkoAdmin` — tylko administrator) — lista na ekranie. */
export function rodzajeDlaKonta(konto) {
  return RODZAJE_OSTRZEZEN.filter(r => !r.tylkoAdmin || konto?.admin === true);
}

export function sprawdzUkryteTypy(typy) {
  if (!Array.isArray(typy) || typy.some(typ => !KOLEJNOSC.includes(typ))) {
    throw new Error('Wybierz wyłącznie znane rodzaje ostrzeżeń.');
  }
  return [...new Set(typy)];
}

export function ukrytePrzezWszystkich(ustawieniaKont) {
  return ustawieniaKont.length ? RODZAJE_OSTRZEZEN.filter(r => ustawieniaKont.every(typy => typy.includes(r.typ))) : [];
}
