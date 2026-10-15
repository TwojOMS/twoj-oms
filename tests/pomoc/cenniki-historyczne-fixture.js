// PRZ-060: historyczne cenniki zamrożonych testów (stałe sprzed przeniesienia do OMS_CENNIKI).
// Jawne dane fixture; produkcja nie importuje tego pliku — produkcja właściciela ma tę samą listę w .env.oms.
import * as cennik from '../../src/domena/magazyn-do-zamowienia.js';

export const CENNIKI_HISTORYCZNE = Object.freeze([
  Object.freeze({ kanal: 'szkicownia', nazwa: 'szkicownia.pl' }),
  Object.freeze({ kanal: 'pro', nazwa: 'pro.szkicownia.pl (PRO)' }),
]);
const historyczne = cennik.cenniki({ lista: CENNIKI_HISTORYCZNE });

export const KANALY_CENNIKA = historyczne.kanaly;
export const CENNIK_DOMYSLNY = historyczne.domyslny;
export const NAZWY_CENNIKA = historyczne.nazwy;
export const cennikDlaZamowienia = (zamowienie) => cennik.cennikDlaZamowienia(zamowienie, historyczne);
export const pozycjaZProduktu = (produkt, ilosc, opcje = {}) => cennik.pozycjaZProduktu(produkt, ilosc, { cenniki: historyczne, ...opcje });
export const { nazwaPozycji, rozmiarDoPokazania } = cennik;
