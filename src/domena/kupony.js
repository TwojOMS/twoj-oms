// Kupony rabatowe ze sklepu (kampania WRZESIEN30, 2026-08-25). Woo oddaje je przy
// zamowieniu w `coupon_lines` (kod + `discount` netto + `discount_tax`), a panel trzyma
// wyciag w kolumnie `zamowienia.kupony_json` — bo lista i zakladka /kampania nie moga
// parsowac pelnego `surowe_json` (dziesiatki KB) przy kazdym wierszu ekranu.
//
// ⚠️ Rabat wychodzi BRUTTO (netto + VAT) i NAPISEM z dwoma miejscami — jak kazda kwota
// w panelu (przewodnik OMS, 4.5). Wszystkie kwoty obok (kwota zamowienia, ceny pozycji)
// sa brutto; rabat w innej skali bylby liczba nie do zestawienia z niczym na ekranie.
//
// ⚠️ Kupon to informacja OPISOWA, nie korekta kwot: ceny pozycji ze sklepu sa juz PO
// rabacie (mapowanie.js, `total` linii), wiec niczego sie tu nie odejmuje ani nie dolicza.
//
// Czytaja to dwa przebiegi — poller (mapowanie.js) i przeliczenie wstecz (db.js,
// uzupelnijKupony) — dokladnie ten sam uklad, co punktOdbioruZeSurowych: jedna regula,
// nigdy druga rozjezdzajaca sie kopia.

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
