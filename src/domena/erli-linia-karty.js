import { kwotaDziesietna } from './cena-kanalu.js';
import { STAWKI_ERLI } from './erli-produkt.js';
import { zlotowki } from './kwoty.js';

const ETYKIETY_VAT = new Map(
  Object.entries(STAWKI_ERLI).map(([stawka, kod]) => [kod, stawka === 'zw' ? stawka : `${stawka}%`]),
);

export function etykietaVatErli(kod) {
  return ETYKIETY_VAT.get(kod) ?? kod;
}

export function dniRobocze(dni) {
  if (dni === 1) return '1 dzień roboczy';
  const jednosci = dni % 10;
  const dwieOstatnie = dni % 100;
  const robocze = jednosci >= 2 && jednosci <= 4 && (dwieOstatnie < 12 || dwieOstatnie > 14);
  return `${dni} ${robocze ? 'dni robocze' : 'dni roboczych'}`;
}

/** Cena w groszach, zdjęcia jako liczba zdjęć. */
export function liniaDanychKartyErli({ cena, ilosc, czasWysylkiDni, vat, zdjecia }) {
  const pola = [];
  if (cena != null) pola.push(`Cena: ${zlotowki(kwotaDziesietna(cena))}`);
  if (ilosc != null) pola.push(`Ilość: ${ilosc}`);
  if (czasWysylkiDni != null) pola.push(`Czas wysyłki: ${dniRobocze(czasWysylkiDni)}`);
  if (vat != null) pola.push(`VAT ${etykietaVatErli(vat)}`);
  if (zdjecia != null) pola.push(`Zdjęcia: ${zdjecia}`);
  return pola.join(' · ');
}
