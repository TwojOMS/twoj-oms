// Imię i nazwisko dzielimy po OSTATNIEJ spacji, żeby „Anna Maria Kowalska” wróciła bez
// zmian (druga reguła podziału dałaby innego odbiorcę niż w panelu).
//
// ⚠️ WSPÓLNY MODUŁ CELOWO. Panel (src/domain/oms-order.js) i ekran „Nowe zamówienie” w
// OMS-ie (src/oms/domain/nowe-zamowienie.js) muszą dzielić DOKŁADNIE tę samą regułę
// podziału: karta panelu i zamówienie w OMS-ie pokazują TEGO SAMEGO odbiorcę. Dwie
// niezależne kopie rozjechałyby się przy pierwszej poprawce jednej z nich, a rozjazd
// wyszedłby dopiero na etykiecie kurierskiej — jako inne nazwisko niż to, które widać
// w panelu.
export function rozbijNazwe(pelna) {
  const t = String(pelna ?? '').trim();
  if (!t) return { first_name: '', last_name: '' };
  const i = t.lastIndexOf(' ');
  if (i === -1) return { first_name: t, last_name: '' };
  return { first_name: t.slice(0, i), last_name: t.slice(i + 1) };
}
