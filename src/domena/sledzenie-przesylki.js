// KOGO PYTAC O STATUS TEJ PACZKI — jedna czysta regula dla karty zamowienia i dla
// czuwacza przesylek. Do 23.08 wybor byl prosty (`kurierzy[p.kurier]`), a WzA nosilo
// `bezSledzenia: true` i 23 paczki byly slepe.
//
// ZMIERZONE 23.08 sonda na zywym API zdarzen DPD: nasz kanal DPD_INFO odpowiada TAKZE
// dla listow kupionych przez Allegro („Wysylam z Allegro") — wystarczy pytac numerem
// PODWYKONAWCY (`carrierWaybill` z `odpowiedz_surowa`), nie allegrowym `waybill`.
// DPD pozostaje na tej sprawdzonej sciezce. Pozostale WzA pytamy przez API sledzenia
// Allegro, ktore przyjmuje `carrier` i `packages.waybill` z zasobu przesylki.
//
// ⚠️ `null` znaczy „tej paczki nie da sie sledzic" i jest STANEM POPRAWNYM, nie awaria:
// wolajacy sprzata ewentualny osad bledu i wychodzi cicho (dokladnie to, co robila
// galaz `bezSledzenia` w odswiezStatusKuriera — patrz zgloszenie wlasciciela 12.08
// o czterech zamowieniach bez wyjscia).

// Rekurencyjne szukanie PARY carrierId+carrierWaybill w zasobie Allegro. Pola bywaja
// na roznych glebokosciach (tracking/carrierTrackingData), wiec schodzimy w glab — ale
// para musi pochodzic z TEGO SAMEGO obiektu: carrierId z jednego wpisu zszyty z numerem
// z innego moglby wyslac numer InPostu do DPD.
function paraPrzewoznika(obiekt) {
  if (!obiekt || typeof obiekt !== 'object') return null;
  if (obiekt.carrierId && obiekt.carrierWaybill) {
    return { carrierId: String(obiekt.carrierId), carrierWaybill: String(obiekt.carrierWaybill) };
  }
  for (const wartosc of Object.values(obiekt)) {
    const w = paraPrzewoznika(wartosc);
    if (w) return w;
  }
  return null;
}

// Mapa podwykonawcow WzA: identyfikator przewoznika z zasobu Allegro → klucz naszego
// klienta w mapie kurierow. Tylko zmierzony DPD idzie WLASNYM kanalem;
// pozostale WzA przechodza nizej do odczytu Allegro z identyfikatorami jego zasobu.
const PODWYKONAWCY_WZA = { DPD: 'dpd' };

// ⚠️⚠️ DECYDUJE ZADEKLAROWANA FLAGA `bezSledzenia`, NIGDY OBECNOSC METODY. Wnioskowanie
// z braku `statusPrzesylki` uciszyloby regresje u kuriera, ktory sledzenie MIEC POWINIEN
// (`dpd.statusPrzesylki is not a function` zdarzylo sie tu juz dwa razy) — taki klient ma
// przejsc dalej i pasc GLOSNO jako BLAD TECHNICZNY w logu, a nie zniknac po cichu.
// Pilnuje tego test „regresja u kuriera ze sledzeniem NIE jest uciszana".
export function sledzeniePrzesylki(p, kurierzy = {}) {
  const kurier = String(p?.kurier ?? '');
  const klient = kurierzy?.[kurier] ?? null;

  if (kurier === 'allegro_wza') {
    let surowa = null;
    try { surowa = JSON.parse(p?.odpowiedz_surowa); } catch { surowa = null; }
    const para = paraPrzewoznika(surowa);
    const kluczPodwykonawcy = para ? PODWYKONAWCY_WZA[para.carrierId] : null;
    const podwykonawca = kluczPodwykonawcy ? kurierzy?.[kluczPodwykonawcy] ?? null : null;
    if (podwykonawca && para?.carrierWaybill) {
      return { klient: podwykonawca, numer: para.carrierWaybill, podwykonawca: para.carrierId };
    }

    // Dla One, ORLEN i DHL `transportingInfo.carrierId` nie jest identyfikatorem zasobu
    // sledzenia Allegro. Oficjalny kontrakt kaze wziasc `carrier` z korzenia odpowiedzi
    // WzA i `waybill` z TEGO pakietu, ktory zapisano przy przesylce. Zly carrier oddaje
    // HTTP 200 z pusta historia, wiec nigdy nie podstawiamy stalej ani numeru podwykonawcy.
    const allegro = kurierzy?.allegro ?? null;
    const carrier = String(surowa?.carrier ?? '').trim();
    const numer = String(p?.numer_listu ?? '').trim();
    const pakiet = Array.isArray(surowa?.packages)
      ? surowa.packages.find((w) => String(w?.waybill ?? '').trim() === numer)
      : null;
    if (!allegro || !carrier || !numer || !pakiet) return null;
    return { klient: allegro, numer, podwykonawca: null, kontekst: { carrier } };
  }

  // KANAL ALLEGRO — paczka nadana POZA panelem (Allegro Punkt, Allegro One, ogon
  // `allegro_dpd` sprzed 11.08). Do 25.08.2026 `kurier = 'allegro'` nie mial klienta
  // i kazda taka paczka byla slepa na zawsze; sonda na zywym API tego dnia pokazala,
  // ze `GET /order/carriers/{carrierId}/tracking` oddaje ich pelna historie.
  //
  // ⚠️ ROZNICA WOBEC WzA: tam pare przewoznika wydlubujemy z `odpowiedz_surowa` przesylki,
  // ktora SAMI utworzylismy. Tutaj przesylki nie tworzylismy — `carrierId` przychodzi
  // z `GET /order/checkout-forms/{id}/shipments` i lezy w kolumnie `carrier_allegro`.
  //
  // ⚠️ PUSTA KOLUMNA TO ODMOWA, NIE DOMYSLNE 'ALLEGRO'. Zmierzone 25.08 na wszystkich 74
  // identyfikatorach z `GET /order/carriers`: zly przewoznik oddaje HTTP 200
  // z `trackingDetails: null` — odpowiedz NIEODROZNIALNA od paczki swiezo nadanej. Stala
  // dzialalaby na dzisiejszych danych i zamilkla przy pierwszej paczce z innym
  // przewoznikiem. To ta sama rodzina bledu, co „polowa pary" przy WzA wyzej.
  if (kurier === 'allegro') {
    const carrier = String(p?.carrier_allegro ?? '').trim();
    if (!klient || !carrier || !p?.numer_listu) return null;
    return { klient, numer: p.numer_listu, podwykonawca: null, kontekst: { carrier } };
  }

  // Brak klienta w mapie (panel bez sekcji INPOST_*) to TRYB POPRAWNY — paczka po prostu
  // nie jest odpytywana; ta sama zasada, co przy skladaniu mapy w bootstrap.js.
  if (!klient || klient.bezSledzenia) return null;
  if (!p?.numer_listu) return null;
  return { klient, numer: p.numer_listu, podwykonawca: null };
}
