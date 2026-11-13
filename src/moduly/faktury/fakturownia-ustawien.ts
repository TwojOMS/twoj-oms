// PRZ-119.05 — klient Fakturowni z Ustawień (Ustawienia → Integracje → Fakturownia). Wzór: infakt-ustawien.ts.
//
// Pośrednik o tych samych metodach co createFakturowniaClient. Każde wywołanie czyta BIEŻĄCY zapis z bazy; nowy klient
// powstaje tylko, gdy zmieniły się opcje (domena albo token) — zmiana działa od następnego żądania, bez restartu.
// Brak zapisu = odmowa dla operatora z adresem ekranu, zanim cokolwiek pójdzie do Fakturowni.
// Usługi faktur moduł składa przy starcie — pierwsze podłączenie Fakturowni wymaga restartu (ekran to mówi).
import { METODY_FAKTUROWNI } from '../../oms/fakturownia/client.js';
import { opcjeKlientaFakturowni, EKRAN_FAKTUROWNI } from '../../domena/konfiguracja-fakturownia.js';
import { bladOperatora } from '../../domena/bledy.js';

type ZapisFakturowni = { ustawienia: Record<string, unknown>; sekrety: Record<string, unknown> };
type KlientFakturowni = Record<string, (...a: any[]) => Promise<any>>;

export function fakturowniaZUstawien({ wczytaj, fabryka }: {
  wczytaj: () => ZapisFakturowni | null; fabryka: (o: ReturnType<typeof opcjeKlientaFakturowni>) => KlientFakturowni;
}): KlientFakturowni {
  let klucz: string | null = null;
  let klient: KlientFakturowni | null = null;
  const biezacy = (): KlientFakturowni => {
    const zapis = wczytaj();
    const opcje = zapis ? opcjeKlientaFakturowni(zapis) : null;
    // `status: 400` celowo (jak w infakt-ustawien.ts): usługi faktur rozpoznają jednoznaczną odmowę po 4xx
    // i zwalniają rezerwację. `bezProgramu: true` — to nie jest odpowiedź Fakturowni o dokumencie.
    if (!opcje?.token || !opcje.domena) {
      throw bladOperatora(`Fakturownia nie jest skonfigurowana — wpisz domenę konta i token API w Ustawienia → Integracje → Fakturownia (${EKRAN_FAKTUROWNI}). Nic nie poszło do Fakturowni.`, { status: 400, bezProgramu: true });
    }
    const nowy = JSON.stringify(opcje);
    if (nowy !== klucz || !klient) { klient = fabryka(opcje); klucz = nowy; }
    return klient;
  };
  return Object.fromEntries(METODY_FAKTUROWNI.map((m: string) => [m, async (...a: unknown[]) => biezacy()[m](...a)]));
}

/** Piaskownica bez atrapy: token wpisany na :3005 / demo nie wychodzi do Fakturowni — każda metoda odmawia (4xx). */
export function odmowaFakturowniWProbie(): KlientFakturowni {
  const odmowa = async () => {
    throw bladOperatora('Piaskownica: prawdziwa Fakturownia jest tu wyłączona — nic nie poszło do Fakturowni ani KSeF.', { status: 400, bezProgramu: true });
  };
  return Object.fromEntries(METODY_FAKTUROWNI.map((m: string) => [m, odmowa]));
}
