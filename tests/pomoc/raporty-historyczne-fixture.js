import { definicjeKanalowHistoryczne } from './kanaly-historyczne-fixture.js';
import { wczytajKlasyfikacje } from '../../src/moduly/kanaly/klasyfikacja.ts';
export const envRaportowHistorycznyFixture = {
 OMS_KANALY: JSON.stringify(definicjeKanalowHistoryczne),
 OMS_HISTORIA_KLASYFIKACJA: JSON.stringify({konta:[{konto:3,raport:'ALLEGRO_SZKICOWNIA'},{konto:27,raport:'ALLEGRO_AMARKA'},{konto:9,raport:'SZKICOWNIA_PL'},{konto:21,raport:'RECZNE'},{konto:12,raport:'B2B'},{konto:24,raport:'PRESTASHOP_ARCHIWUM'},{konto:15,raport:'WOO_AMARKA'},{konto:6,raport:'ETSY_ARCHIWUM'}],tagDrop:6,tagB2b:3,tagGdd:9,kontaB2b:[12],prefiksyIndywidualne:['28040|']})
};
export const klasyfikacjaHistorycznaFixture = wczytajKlasyfikacje(envRaportowHistorycznyFixture, definicjeKanalowHistoryczne);
export const KANALY = ['DROPSHIPPING','GDD','B2B','RECZNE','INDYWIDUALNE','SZKICOWNIA_PL','ALLEGRO_SZKICOWNIA','ALLEGRO_AMARKA','SZKICOWNIA_PRO','PRESTASHOP_ARCHIWUM','WOO_AMARKA','ETSY_ARCHIWUM'];
