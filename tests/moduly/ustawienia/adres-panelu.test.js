import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { adresPaneluZEnv } from '../../../src/moduly/ustawienia/adres-panelu.ts';
import { modulUstawienia } from '../../../src/moduly/ustawienia/modul.ts';

describe('PRZ-069 OMS_ADRES_PANELU', () => {
  it('pusty albo brak = brak adresu; sam schemat i host przechodzą jako origin', () => {
    expect(adresPaneluZEnv(undefined)).toBeNull();
    expect(adresPaneluZEnv('')).toBeNull();
    expect(adresPaneluZEnv('https://panel.example.test')).toBe('https://panel.example.test');
    expect(adresPaneluZEnv('https://panel.example.test/')).toBe('https://panel.example.test');
    expect(adresPaneluZEnv('http://192.168.0.10:3001')).toBe('http://192.168.0.10:3001');
  });
  it.each(['https://panel.example.test/oms', 'https://panel.example.test/?a=1', 'https://panel.example.test/#x', 'ftp://panel.example.test', ' https://panel.example.test', 'https://u:p@panel.example.test', 'panel.example.test'])('odmawia %s z nazwą zmiennej', (w) => {
    expect(() => adresPaneluZEnv(w)).toThrow('OMS_ADRES_PANELU');
  });
  it('konfiguracja modułu ustawienia niesie adres', () => {
    expect(modulUstawienia.konfiguracja({ OMS_ADRES_PANELU: 'https://panel.example.test' })).toEqual({ adresPanelu: 'https://panel.example.test' });
    expect(modulUstawienia.konfiguracja({})).toEqual({ adresPanelu: null });
  });
  it('strażnik konfiguracji zna zmienną, właściciel ustawienia; .env.example ma zakomentowaną linię', () => {
    const r = spawnSync(process.execPath, ['scripts/straznik-konfiguracji.mjs'], { encoding: 'utf8' });
    expect(r.status, r.stdout.slice(-2000)).toBe(0);
    const m = JSON.parse(readFileSync('docs/konfiguracja.json', 'utf8'));
    expect(m.zmienne.find((z) => z.nazwa === 'OMS_ADRES_PANELU')).toMatchObject({ wlasciciel: 'ustawienia', wymagalnosc: 'opcjonalna' });
    expect(readFileSync('.env.example', 'utf8')).toMatch(/^# OMS_ADRES_PANELU=/m);
    expect(readFileSync('docs/konfiguracja.md', 'utf8')).toContain('`OMS_ADRES_PANELU`');
  });
});
