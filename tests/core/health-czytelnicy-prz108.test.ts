import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { zbudujOms } from '../../src/oms/bootstrap.ts';

let a: Awaited<ReturnType<typeof zbudujOms>>;
beforeAll(async () => {
  a = await zbudujOms({ env: {
    OMS_SPRZEDAWCA_NIP: '1234563218', OMS_USER: 'fixture', OMS_PASS: 'fixture', OMS_KANALY: '[]',
    OMS_PROFORMY_KATALOG: 'tests/fixture-proformy', OMS_ETYKIETY_KATALOG: 'tests/fixture-etykiety',
  }, log: () => {} });
});
afterAll(async () => { if (a) { await a.app.close(); a.db.close(); } });

// Inwentaryzacja czytelników (21.10.2026). Bez zmiany /health: czujka monitoring
// jest poza repo, a modul.ts dokumentuje zależność od pełnej treści i kolejności pól.
describe('otwarty /health — kontrakty narzędzi bez poświadczeń', () => {
  it.each([
    ['deploy/nas/oms-release-remote.sh (także deploy/wydaj.ps1)', ['ok']],
    ['deploy/nas/prz042/02-odczyt-stanu.sh', ['ok', 'alarmy', 'uwagi']],
    ['deploy/nas/prz042/06-odbior.sh', []],
    ['deploy/klient/compose.yaml', []],
    ['deploy/klient/diagnostyka.sh', ['ok', 'alarmy', 'uwagi']],
    ['deploy/klient/aktualizuj.sh: zdrowy_kontener / zdrowie', ['alarmy', 'pelna']],
    ['deploy/proba/proba.ps1: Start-Procesu', ['proces']],
    ['deploy/demo/demo.ps1: Wersja-Publiczna / pomiar przerwy', ['proces']],
    ['deploy/demo/sonda.mjs + konfiguracja.mjs: dowolna odpowiedź = przeciek', []],
    ['scripts/instalacja-proba.mjs', []],
    ['scripts/uruchom-lokalnie.mjs', []],
    ['tests/pomoc/odbior-bootstrap-030.ts', ['ok']],
    ['monitoring (zewnętrzny) + testy domeny/modułów', ['pelna']],
  ] as const)('%s', async (_czytelnik, pola) => {
    const r = await a.app.inject('/health');
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const j = r.json();
    for (const pole of pola) {
      if (pole === 'ok') expect(j.ok).toBe(true);
      if (pole === 'alarmy') expect(j.alarmy).toEqual([]);
      if (pole === 'uwagi') expect(j.uwagi).toEqual(expect.arrayContaining([expect.any(String)]));
      if (pole === 'proces') expect(Number.isFinite(Date.parse(j.proces.startAt))).toBe(true);
      if (pole === 'pelna') {
        // Trasa nie może odciąć stanu integracji ani zmienić kolejności kluczy.
        const pelna = a.usluga<() => object>('zdrowie', 'zdrowie')();
        expect(Object.keys(j)).toEqual(Object.keys(pelna));
        expect(j).toMatchObject({ poller: expect.any(Object), kanaly: expect.any(Array), czuwaczKosztow: expect.any(Object) });
      }
    }
    // Aktualizator toleruje brak wersji (stare obrazy), a jeśli jest — wymaga tekstu.
    expect(j.wersja === undefined || typeof j.wersja === 'string').toBe(true);
  });
});
