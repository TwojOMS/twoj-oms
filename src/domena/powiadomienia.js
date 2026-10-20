// Kolejność tabelki i lista osobistych ustawień mają jedno źródło.
export const RODZAJE_OSTRZEZEN = Object.freeze([
  { typ: 'integracja', nazwa: 'Awarie integracji', opis: 'Sklep, usługa lub czuwacz nie działa albo od dawna nie kończy przebiegu.' },
  { typ: 'faktura-ksef', nazwa: 'Faktury niewysłane do KSeF', opis: 'Dokument wystawiony przed dziś nie ma numeru KSeF.' },
  { typ: 'faktura-termin', nazwa: 'Faktury po terminie płatności', opis: 'Pozostała kwota do zapłaty, a termin płatności faktury już minął.' },
  { typ: 'pobranie-korekta', nazwa: 'Pobrania czekające na korektę', opis: 'Paczka za pobraniem wróciła bez gotówki, a faktura czeka na korektę do zera.' },
  { typ: 'zwrot-korekta', nazwa: 'Zwroty czekające na korektę', opis: 'Zwrot zarejestrowany przed dziś ma fakturę, ale nie ma korekty w inFakcie.' },
  { typ: 'przesylka', nazwa: 'Przesyłki bez ruchu', opis: 'Przesyłka od dłuższego czasu nie zmieniła statusu u kuriera.' },
  { typ: 'wiadomosc-allegro', nazwa: 'Wiadomości Allegro bez odpowiedzi', opis: 'Ostatnia wiadomość w wątku jest od kupującego i pochodzi z ostatnich siedmiu dni.' },
].map(r => Object.freeze(r)));

export const KOLEJNOSC = Object.freeze(RODZAJE_OSTRZEZEN.map(r => r.typ));

export function sprawdzUkryteTypy(typy) {
  if (!Array.isArray(typy) || typy.some(typ => !KOLEJNOSC.includes(typ))) {
    throw new Error('Wybierz wyłącznie znane rodzaje ostrzeżeń.');
  }
  return [...new Set(typy)];
}

export function ukrytePrzezWszystkich(ustawieniaKont) {
  return ustawieniaKont.length ? RODZAJE_OSTRZEZEN.filter(r => ustawieniaKont.every(typy => typy.includes(r.typ))) : [];
}
