// Mapowanie PO `delivery.method.id`, NIGDY po nazwie — to ta sama regula, co „po
// instance_id, nigdy po tytule" przy WooCommerce. Nazwa metody to tekst, ktory Allegro
// zmieni bez pytania nas o zdanie.
//
// Identyfikatory zmierzone na prawdziwych zamówieniach z Allegro.
const ZNANE = {
  '03f26351-f683-4db2-8895-f2c599280e3c': ['allegro_dpd', 'Allegro Kurier DPD'],
  '13f26351-26fb-48d4-b5dd-f2c599280e3c': ['allegro_dpd', 'Allegro Kurier DPD'], // pobranie
  '2488f7b7-5d1c-4d65-b85c-4cbcf253fd93': ['allegro_paczkomat', 'Allegro Paczkomat InPost'],
  '09164667-daa5-42dc-8087-33d7485790ac': ['allegro_punkt', 'Allegro Automat ORLEN Paczka'],
  '0560b75e-88c3-4b79-bcf7-62331a20b5b2': ['allegro_punkt', 'Allegro Odbiór w Punkcie DHL'],
  '0fe5b4af-9f09-443d-9d49-62331a20b5b2': ['allegro_punkt', 'Allegro Automat DHL BOX 24/7'],
  '0d83955a-4297-4169-adef-9790d53b11ff': ['allegro_kurier', 'Allegro One Kurier'],
  '0b9bed2c-0bc1-4e1f-9694-29bb39ebb483': ['allegro_punkt', 'Allegro One Box'],
  // ⚠️ POBRANIOWY WARIANT PACZKOMATU MA WLASNY IDENTYFIKATOR.
  // Slownik znał początkowo wyłącznie wariant bez pobrania (`2488f7b7-…`), wiec pierwsze
  // takie zamowienie wpadlo do `allegro_inne` — a to znaczy: panel zada wskazania kuriera,
  // przy pobraniu na paczce nr 1 zostawia do wyboru SAM DPD (kurier-nadania.js), czyli
  // jedyna klikalna droga byl kurier pod adres domowy przy dostawie oplaconej jako paczkomat.
  //
  // ⚠️ `allegro_paczkomat`, A NIE WPIS DO `METODY_WZA` — zmierzone, nie przepisane:
  // `GET /shipment-management/delivery-services` oddaje dla tego id `owner: CLIENT`
  // i `credentialsId: null`, czyli Allegro tej etykiety NIE SPRZEDAJE. Paczka jedzie na
  // NASZEJ umowie InPostu, dokladnie tak samo jak wariant bez pobrania.
  'b20ef9e1-faa2-4f25-9032-adbea23e5cb9': ['allegro_paczkomat', 'Allegro Paczkomat InPost pobranie'],
};

// ⚠️ TA LISTA MA BYC ROWNA zbiorowi wartosci wystepujacych w ZNANE (plus `allegro_inne`) I MA
// SIE ZAWIERAC w METODY_WYSYLKI (domena/wysylka.js) — pilnuje tego tests/oms/allegro-dostawa.
// Metoda wpisana do slownika, a nieznana panelowi, wyladowalaby w kolumnie `metoda_wysylki`
// jako wartosc, ktorej nie zna ani filtr listy, ani bramka recznej zmiany metody.
export const METODY_ALLEGRO = ['allegro_dpd', 'allegro_paczkomat', 'allegro_punkt', 'allegro_kurier', 'allegro_inne'];

/**
 * ⚠️ NIEZNANE `id` TO PRZYPADEK NORMALNY, NIE BRZEGOWY: kilka różnych metod trafiło się już w
 * próbce kilkudziesięciu zamówień. Słownik nigdy nie będzie kompletny, więc wpis jest WYGODĄ,
 * a nie warunkiem poprawnosci — i nieznana metoda NIE MA PRAWA niczego blokowac.
 *
 * To odwrotnosc reguly dla sklepow, gdzie „nieznana metoda" MUSI blokowac nadanie. Roznica
 * jest twarda: tam panel nadaje paczke i musi wiedziec czym, tu nie nadaje w ogole.
 *
 * Nazwy u Allegro juz zaczynaja sie od „Allegro", wiec zapasowa etykieta czyta sie tak samo
 * jak reszta kolumny („Allegro Kurier Jutro").
 *
 * ⚠️ `Object.hasOwn`, a nie samo `ZNANE[id]`: dla `id` rownego „constructor" albo „toString"
 * zwykly odczyt oddaje funkcje z prototypu Object — prawde, ktora nie jest tablica — i dalej
 * `znane[0]` byloby `undefined`, czyli metoda BEZ NAZWY wpisana do kolumny NOT NULL.
 */
export function metodaZId(id, nazwa) {
  const znane = typeof id === 'string' && Object.hasOwn(ZNANE, id) ? ZNANE[id] : null;
  if (znane) return { metoda: znane[0], etykieta: znane[1] };
  return { metoda: 'allegro_inne', etykieta: String(nazwa ?? '').trim() || 'Allegro — inna metoda' };
}

/**
 * PELNA NAZWA DOSTAWY OD ALLEGRO, oczyszczona do pokazania czlowiekowi.
 *
 * ⚠️ TO JEST NAZWA DO WYSWIETLENIA, NIGDY DO DECYZJI. Zachowaniem steruje `metoda_wysylki`
 * (kubelek liczony PO `delivery.method.id`) — i tak ma zostac: filtry listy i bramka zmiany
 * metody czytaja kubelek, a slownik rozbity na przewoznikow rozjezdzalby sie z kazda nowa
 * usluga Allegro. Tutaj chodzi wylacznie o to, zeby operator i klient widzieli „Allegro One
 * Box" zamiast „Allegro punkt / automat".
 *
 * ⚠️ ZDEJMUJEMY WYLACZNIE OGONEK „ (AD)" I WYLACZNIE Z KONCA. To znacznik Allegro Delivery
 * doklejany do czesci uslug („Allegro Kurier DPD (AD)") — dla operatora szum, ktory w kolumnie
 * „Dostawa" zjada miejsce. Kazdy INNY nawias niesie tresc („- dostawa jutro", „pobranie"),
 * wiec ogolne kasowanie nawiasow gubiloby informacje; a kasowanie „(AD)" gdziekolwiek
 * potnaloby nazwe, w ktorej ten skrot znaczy co innego.
 *
 * Pusty wynik oddaje `null`, nie pusty napis: wolajacy odrozniaja „nie znamy nazwy"
 * (spadamy na etykiete kubelka) od nazwy zlozonej z zera znakow.
 */
export function oczyscNazweDostawy(nazwa) {
  const czysta = String(nazwa ?? '')
    .trim()
    .replace(/\s*\(AD\)$/, '')
    .trim();
  return czysta || null;
}
