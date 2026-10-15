import { createWiadomosci as real } from '../../src/moduly/wiadomosci/services/wiadomosci.js';
import { MARKA_HISTORYCZNA as m } from './marka-poczty-fixture.js';
export const createWiadomosci = o => real({ ...o, config: {
  ...o.config, oprawaPoczty: { ...m, ...o.config?.oprawaPoczty },
} });
