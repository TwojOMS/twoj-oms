import * as real from '../../src/domena/potwierdzenie-zamowienia.js';
import { MARKA_HISTORYCZNA as m } from './marka-poczty-fixture.js';
export * from '../../src/domena/potwierdzenie-zamowienia.js';
export const PODPIS = m.podpis;
export const modelPotwierdzenia = (z, o = {}) => real.modelPotwierdzenia(z, { podpis: m.podpis, ...o });
export const trescPotwierdzenia = (z, o = {}) => real.trescPotwierdzenia(z, { podpis: m.podpis, ...o });
