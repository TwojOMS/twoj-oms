import type { Srodowisko } from './kontrakty.ts';
import { efektywnyTryb } from './tryb.ts';

// PRZ-079/082: co ile minut demo publiczne wraca do stanu początkowego. Jedno źródło dla harmonogramu
// (deploy/demo/reset.mjs, deploy/demo/start.mjs) i dla napisu na ekranie logowania — do PRZ-082 ekran mówił
// „co noc”, choć od PRZ-079 reset szedł co godzinę.
export const MINUTY_RESETU_DOMYSLNIE = 60;

/** Liczba minut od 10 do 1440, dzieląca dobę — inaczej reset nie wypadałby o stałych porach. */
export function sprawdzMinutyResetu(minuty: number): number {
  if (!Number.isInteger(minuty) || minuty < 10 || 1440 % minuty !== 0) {
    throw new Error('DEMO_RESET_CO_MIN: liczba minut od 10 do 1440, dzieląca dobę (np. 30, 60, 120, 1440)');
  }
  return minuty;
}

/** DEMO_RESET_CO_MIN albo domyślna — to samo, co czyta wejście kontenera demo. */
export function minutyResetuDemo(env: Srodowisko): number {
  const z = env.DEMO_RESET_CO_MIN;
  return sprawdzMinutyResetu(z ? Number(z) : MINUTY_RESETU_DOMYSLNIE);
}

const odmiana = (n: number, jeden: string, kilka: string, wiele: string) => {
  if (n === 1) return jeden;
  const j = n % 10, d = n % 100;
  return j >= 2 && j <= 4 && (d < 12 || d > 14) ? kilka : wiele;
};

/** „co godzinę”, „co 30 minut”, „co 2 godziny”, „co noc” (raz na dobę o północy). */
export function opisResetuDemo(minuty: number): string {
  if (minuty === 1440) return 'co noc';
  if (minuty % 60 === 0) {
    const h = minuty / 60;
    return h === 1 ? 'co godzinę' : `co ${h} ${odmiana(h, 'godzinę', 'godziny', 'godzin')}`;
  }
  return `co ${minuty} ${odmiana(minuty, 'minutę', 'minuty', 'minut')}`;
}

// PRZ-075: wspólne konto gościa demo publicznego. Login i hasło są JAWNE — stoją na ekranie logowania —
// więc wolno je mieć wyłącznie w trybie próby. Produkcja z tymi zmiennymi odmawia startu: pomyłka w .env
// nie może wystawić hasła na ekranie logowania firmy. Konto zakłada wejście kontenera demo (deploy/demo/start.mjs).
export function kontoDemo(env: Srodowisko): { login: string; haslo: string; reset: string; resetPlanowy: string | null; resetGodzina: string | null } | null {
  const login = env.OMS_DEMO_LOGIN ?? '';
  const haslo = env.OMS_DEMO_HASLO ?? '';
  if (login === '' && haslo === '') return null;
  if (efektywnyTryb(env) !== 'proba') throw new Error('OMS_DEMO_LOGIN/OMS_DEMO_HASLO wolno ustawić tylko z OMS_TRYB=proba');
  if (login === '') throw new Error('Ustawione OMS_DEMO_HASLO bez OMS_DEMO_LOGIN');
  if (haslo === '') throw new Error('Ustawione OMS_DEMO_LOGIN bez OMS_DEMO_HASLO');
  const resetPlanowy = resetPlanowyDemo(env);
  return { login, haslo, reset: opisResetuDemo(minutyResetuDemo(env)), resetPlanowy,
    resetGodzina: resetPlanowy ? godzinaResetuDemo(resetPlanowy) : null };
}

// PRZ-083: termin najbliższego resetu TEJ instancji panelu. Ustawia go cykl resetu (deploy/demo/cykl.mjs) przed każdym
// złożeniem aplikacji; pasek demo liczy do niego i po jego zmianie na ekranie logowania poznaje, że restart minął.
// Liczony w cyklu, nie w widoku: gdy generator się spóźni, podmiana idzie po terminie, a pasek ma czekać, nie
// odliczać od nowa do następnej godziny.
function resetPlanowyDemo(env: Srodowisko): string | null {
  const z = env.DEMO_RESET_PLANOWY?.trim();
  if (!z) return null;
  const ms = Date.parse(z);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(z) || Number.isNaN(ms)) {
    throw new Error('DEMO_RESET_PLANOWY: chwila w ISO 8601 UTC (np. 2026-10-15T13:00:00.000Z) — ustawia ją deploy/demo/cykl.mjs');
  }
  return new Date(ms).toISOString();
}

/** „15:00” — godzina terminu po polsku, do napisu bez JavaScriptu. */
export function godzinaResetuDemo(iso: string): string {
  return new Date(iso).toLocaleTimeString('pl-PL', { timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit' });
}
