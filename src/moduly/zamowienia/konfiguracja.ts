import type { Srodowisko } from '../../core/kontrakty.ts';
import { wczytajSprzedawce } from '../../core/sprzedawca.ts';
import { wczytajKlientowWdt } from '../../core/klienci-wdt.ts';
import { skonfigurowanyUrl } from '../../core/konfiguracja-wartosci.ts';
import { parsujCenniki } from '../../domena/magazyn-do-zamowienia.js';
import { kanalIndywidualnyWlaczony } from '../kanaly/klasyfikacja.ts';
import { adresFirmyZEnv } from '../../core/adres-firmy.ts';
export function konfiguracjaZamowien(env: Srodowisko) {
  skonfigurowanyUrl(env.GUS_URL, 'GUS_URL');
  const klienciWdt = wczytajKlientowWdt(env);
  const sprzedawca = wczytajSprzedawce(env);
  // PRZ-060: cenniki „Dodaj z magazynu"; null = sklepy Woo z OMS_KANALY (kontekst zamówień).
  const cenniki = parsujCenniki(env.OMS_CENNIKI);
  return { klienciWdt, cenniki, kanalIndywidualny: kanalIndywidualnyWlaczony(env),
    gus: env.GUS_KLUCZ ? {klucz:env.GUS_KLUCZ,url:env.GUS_URL||'https://wyszukiwarkaregon.stat.gov.pl/wsBIR/UslugaBIRzewnPubl.svc'} : null,
    // PRZ-093.08: adres z pliku; adres z Ustawień dokłada zbuduj modułu (config.adresFirmy).
    nadawca: adresFirmyZEnv(env),
    proforma:{nip:sprzedawca.nip,bdo:sprzedawca.bdo},
  };
}
