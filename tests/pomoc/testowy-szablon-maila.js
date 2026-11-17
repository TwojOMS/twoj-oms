import * as real from '../../src/core/poczta/mail-html.js';
import { MARKA_HISTORYCZNA as m } from './marka-poczty-fixture.js';
export * from '../../src/core/poczta/mail-html.js';
export const kopertaMaila = (o = {}) => real.kopertaMaila({ ...m, ...o });
export const renderMailHtml = (o = {}) => real.renderMailHtml({ ...m, ...o });
