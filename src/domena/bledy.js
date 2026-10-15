// Rozroznienie dwoch rodzajow bledu, bo maja innego adresata.
//
// „Blad operatora" to komunikat, ktory SAMI napisalismy po polsku dla czlowieka przy
// panelu: „Zamowienie jest anulowane", „Metoda nie jest obslugiwana", „DPD odrzucilo
// paczke: ...". Taki komunikat wolno pokazac na ekranie.
//
// Wszystko inne (TypeError, ENOENT z pelna sciezka serwera, blad sterownika bazy) to
// blad techniczny — niesie szczegoly infrastruktury, wiec idzie WYLACZNIE do logu.
export function bladOperatora(komunikat, dodatki = {}) {
  return Object.assign(new Error(komunikat), { dlaOperatora: true }, dodatki);
}

export function komunikatDlaOperatora(e) {
  return e?.dlaOperatora ? e.message : 'błąd techniczny panelu — szczegóły w logu zamówienia.';
}
