import { createHash } from 'node:crypto';
import { bezpiecznyPowrotNaListe } from './filtry-listy.js';

const PREFIKS_KLUCZA_POZYCJI = 'oms:pozycja-listy:v1:';

const STANY_KARTY = new Set([
  'wysylka', 'faktura', 'pozycje', 'szczegoly', 'wplata',
]);

function bezpiecznyStan(stan) {
  if (typeof stan !== 'string') return null;
  if (STANY_KARTY.has(stan)) return stan;
  return /^pozycja-[A-Za-z0-9_-]+$/.test(stan) ? stan : null;
}

function bezpiecznaKotwica(kotwica) {
  if (typeof kotwica !== 'string') return null;
  const bezKrzyzyka = kotwica.startsWith('#') ? kotwica.slice(1) : kotwica;
  return /^[A-Za-z0-9_-]+$/.test(bezKrzyzyka) ? bezKrzyzyka : null;
}

export function adresKartyZamowienia(id, { powrot = '/', stan = null, kotwica = null } = {}, definicje) {
  const parametry = new URLSearchParams();
  const bezpiecznyPowrot = bezpiecznyPowrotNaListe(powrot, definicje);
  if (bezpiecznyPowrot !== '/') parametry.set('powrot', bezpiecznyPowrot);
  const stanKarty = bezpiecznyStan(stan);
  if (stanKarty) parametry.set('edytuj', stanKarty);
  const cel = bezpiecznaKotwica(kotwica);
  const query = parametry.toString();
  return `/zamowienia/${encodeURIComponent(String(id))}${query ? `?${query}` : ''}${cel ? `#${cel}` : ''}`;
}

export function adresPowrotuDoWiersza(powrot, id, definicje) {
  return `${bezpiecznyPowrotNaListe(powrot, definicje)}#zamowienie-${encodeURIComponent(String(id))}`;
}

export function kluczPozycjiListy(kanonicznyAdres, definicje) {
  const adres = bezpiecznyPowrotNaListe(kanonicznyAdres, definicje);
  const hash = createHash('sha256').update(adres, 'utf8').digest('hex');
  return `${PREFIKS_KLUCZA_POZYCJI}${hash}`;
}
