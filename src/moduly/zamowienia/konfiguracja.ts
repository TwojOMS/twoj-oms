import type { Srodowisko } from '../../core/kontrakty.ts';
import { wczytajSprzedawce } from '../../core/sprzedawca.ts';
import { wczytajKlientowWdt } from '../../core/klienci-wdt.ts';
import { skonfigurowanyUrl } from '../../core/konfiguracja-wartosci.ts';
import { parsujCenniki } from '../../domena/magazyn-do-zamowienia.js';
export function konfiguracjaZamowien(env: Srodowisko) {
  skonfigurowanyUrl(env.GUS_URL, 'GUS_URL');
  const klienciWdt = wczytajKlientowWdt(env);
  const sprzedawca = wczytajSprzedawce(env);
  // PRZ-060: cenniki „Dodaj z magazynu"; null = sklepy Woo z OMS_KANALY (kontekst zamówień).
  const cenniki = parsujCenniki(env.OMS_CENNIKI);
  return { klienciWdt, cenniki,
    gus: env.GUS_KLUCZ ? {klucz:env.GUS_KLUCZ,url:env.GUS_URL||'https://wyszukiwarkaregon.stat.gov.pl/wsBIR/UslugaBIRzewnPubl.svc'} : null,
    nadawca: {nazwa:env.DPD_NADAWCA_NAZWA?.trim() ?? '',ulica:env.DPD_NADAWCA_ULICA?.trim() ?? '',kod:env.DPD_NADAWCA_KOD?.trim() ?? '',miasto:env.DPD_NADAWCA_MIASTO?.trim() ?? '',kraj:env.DPD_NADAWCA_KRAJ?.trim() || 'PL'},
    proforma:{nip:sprzedawca.nip,bdo:sprzedawca.bdo},
  };
}
