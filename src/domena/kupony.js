// Kupony rabatowe ze sklepu. Woo oddaje je przy
// zamówieniu w `coupon_lines` (kod + `discount` netto + `discount_tax`), a panel trzyma
// wyciąg w kolumnie `zamowienia.kupony_json` — bo lista i zakładka /kampania nie mogą
// parsować pełnego `surowe_json` (dziesiątki KB) przy każdym wierszu ekranu.
//
// ⚠️ Rabat wychodzi BRUTTO (netto + VAT) i NAPISEM z dwoma miejscami — jak każda kwota
// w panelu (reguła: pieniądze w groszach). Wszystkie kwoty obok (kwota zamówienia, ceny pozycji)
// są brutto; rabat w innej skali byłby liczbą nie do zestawienia z niczym na ekranie.
//
// ⚠️ Kupon to informacja OPISOWA, nie korekta kwot: ceny pozycji ze sklepu są już PO
// rabacie (mapowanie.js, `total` linii), więc niczego się tu nie odejmuje ani nie dolicza.
//
// Czytają to dwa przebiegi — poller (mapowanie.js) i przeliczenie wstecz
// (oms/db/uzupelnienia-zamowien.js, uzupelnijKupony) — dokładnie ten sam układ, co
// punktOdbioruZeSurowych: jedna reguła, nigdy druga rozjeżdżająca się kopia.

export function kuponyZeSurowych(surowe) {
  const linie = Array.isArray(surowe?.coupon_lines) ? surowe.coupon_lines : [];
  const kupony = [];
  for (const linia of linie) {
    // Kod zostaje DOKLADNIE taki, jaki zapisal sklep (Woo i tak normalizuje do malych
    // liter przy uzyciu) — panel pokazuje prawde sklepu, porownania normalizuja sobie same.
    const kod = String(linia?.code ?? '').trim();
    if (!kod) continue;
    const rabat = (Number(linia.discount ?? 0) || 0) + (Number(linia.discount_tax ?? 0) || 0);
    kupony.push({ kod, rabat: rabat.toFixed(2) });
  }
  return kupony;
}

// Odczyt kolumny `kupony_json`. Uszkodzony JSON jednego wiersza nie ma prawa wywalic
// listy zamowien — ta sama zasada, co przy kazdej kolumnie *_json w tym module.
export function kuponyZWiersza(kuponyJson) {
  if (!kuponyJson) return [];
  let dane = null;
  try { dane = JSON.parse(kuponyJson); } catch { return []; }
  return Array.isArray(dane) ? dane : [];
}
