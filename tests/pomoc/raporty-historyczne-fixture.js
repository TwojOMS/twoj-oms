import { definicjeKanalowHistoryczne } from './kanaly-historyczne-fixture.js';
import { wczytajKlasyfikacje } from '../../src/moduly/kanaly/klasyfikacja.ts';
export const envRaportowHistorycznyFixture = {
 OMS_KANALY: JSON.stringify(definicjeKanalowHistoryczne),
 OMS_HISTORIA_KLASYFIKACJA: JSON.stringify({konta:[{konto:3,raport:'ALLEGRO_SWIETLIK'},{konto:27,raport:'ALLEGRO_POLCIEN2'},{konto:9,raport:'SWIETLIK_PL'},{konto:21,raport:'RECZNE'},{konto:12,raport:'B2B'},{konto:24,raport:'PRESTASHOP_ARCHIWUM'},{konto:15,raport:'WOO_POLCIEN2'},{konto:6,raport:'ETSY_ARCHIWUM'}],tagDrop:6,tagB2b:3,tagGdd:9,kontaB2b:[12],prefiksyIndywidualne:['28040|']})
};
export const klasyfikacjaHistorycznaFixture = wczytajKlasyfikacje(envRaportowHistorycznyFixture, definicjeKanalowHistoryczne);
export const KANALY = ['DROPSHIPPING','GDD','B2B','RECZNE','INDYWIDUALNE','SWIETLIK_PL','ALLEGRO_SWIETLIK','ALLEGRO_POLCIEN2','SWIETLIK_PRO','PRESTASHOP_ARCHIWUM','WOO_POLCIEN2','ETSY_ARCHIWUM'];
