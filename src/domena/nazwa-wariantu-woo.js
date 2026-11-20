// Nazwa wariantu WooCommerce do pokazania operatorowi.
//
// `name` wariantu z `/products/<rodzic>/variations` to zwykle sam opis atrybutów („70 x 100 cm”),
// więc kilka wariantów różnych produktów wygląda w tabeli identycznie. Dopisujemy nazwę rodzica.
// Część sklepów składa tytuł wariantu z nazwy rodzica i atrybutów — wtedy bierzemy go tak, jak jest.

const napis = (x) => (typeof x === 'string' ? x.trim() : '');

/**
 * @param {string | undefined} rodzic nazwa rodzica ze świeżego odczytu sklepu
 * @param {string | undefined} wariant `name` wariantu ze świeżego odczytu sklepu
 * @param {string | undefined} lustro nazwa z lustra, gdy odczyt rodzica nie przyszedł
 */
export function nazwaWariantuWoo(rodzic, wariant, lustro) {
  const nazwaRodzica = napis(rodzic) || napis(lustro);
  const nazwaWariantu = napis(wariant);
  if (!nazwaWariantu) return nazwaRodzica;
  if (!nazwaRodzica || nazwaWariantu.startsWith(nazwaRodzica)) return nazwaWariantu;
  return `${nazwaRodzica} — ${nazwaWariantu}`;
}
