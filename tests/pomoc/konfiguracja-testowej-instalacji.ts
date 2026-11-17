import { wczytajFaktury } from '../../src/moduly/faktury/modul.ts';
import type { Srodowisko } from '../../src/core/kontrakty.ts';
// Dane wyłącznie zamrożonej fikstury testowej. Produkcja nie importuje tego pliku.
const historia={OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',
  OMS_BANK:'Millennium',OMS_SPRZEDAWCA_BDO:'000123456',OMS_PROFORMY_KATALOG:'/data-oms/proformy'};
/** Uruchamia rzeczywistą konfigurację manifestu, łącznie z walidacją danych. */
export function loadOmsConfig(env:Srodowisko) {
  const e:Srodowisko={...historia,...env};const faktury=wczytajFaktury(e);
  return {proforma:faktury.proforma,infakt:faktury.infakt,
    auth:{user:e.OMS_USER??e.OMS_AUTH_USER,pass:e.OMS_PASS??e.OMS_AUTH_PASS},
    nadawca:{nazwa:e.DPD_NADAWCA_NAZWA,ulica:e.DPD_NADAWCA_ULICA,kod:e.DPD_NADAWCA_KOD,miasto:e.DPD_NADAWCA_MIASTO,kraj:e.DPD_NADAWCA_KRAJ??'PL'},
  };
}
