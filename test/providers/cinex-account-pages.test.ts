import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCinexPrices, parseCinexConcessions } from '../../src/providers/cinex/account-pages.js';
import { nth } from '../helpers/assert.js';

const q = { provider: 'cinex' as const, cinema_id: 'TLN', session_id: 's1' };
const url = 'https://www.cinex.com.ve/boletos.php?cinemaid=TLN&sessionid=s1';

test('Cinex ticket quote includes other charges and rejects changed totals', () => {
  const html = '<form id="frmboletos"><div class="row"><div class="col-md-8"><p><span>Adulto</span><br>Precio Boleto: Bs. 800,00<br>Otros Cargos: Bs. 4.800,00</p></div><input id="amount0001" value="5600"></div></form><input value="PRIVATE_PROFILE">';
  const items = parseCinexPrices(html, q, url);
  assert.deepEqual(nth(items, 0).prices, [{ currency: 'VES', amount: 5600, basis: 'provider' }]);
  assert.equal(nth(nth(items, 0).price_components ?? [], 1).amount, 4800);
  assert.ok(!JSON.stringify(items).includes('PRIVATE_PROFILE'));
  assert.throws(() => parseCinexPrices(html.replace('value="5600"', 'value="100"'), q, url));
  assert.throws(() => parseCinexPrices('error al obtener los boletos [listado tickets no disp.]', q, url));
});
test('Cinex candy reads combo overlays, keeps unknown prices empty and does not invent stock', () => {
  const html = '<form id="frmconcesiones"><div class="itemstyle" id="item1"><div id="nombreitem1">Cotufa</div><span id="precioitemref1">Bs. 1.600,00</span><input id="amount1" value="1600"><input id="qty1" max="100000"></div><div class="itemstyle" id="item2"><div id="nombreitem2">Combo</div></div><div id="overlaycombofather2"><input id="amount2" value="2400"></div><div class="itemstyle" id="item3"><div id="nombreitem3">Sin precio</div></div></form>';
  const items = parseCinexConcessions(html, q, url);
  assert.equal(items.length, 3); assert.equal(nth(items, 0).stock, undefined);
  assert.equal(nth(items, 1).options_required, true); assert.equal(nth(nth(items, 1).prices ?? [], 0).amount, 2400);
  assert.deepEqual(nth(items, 2).prices, []);
});

// Markup as cinex.com.ve's boletos page sent it on 2026-11-05 for a VIP room,
// to an account with a Cinexclusivo perk (one free VIP ticket a month).
const cinexRow = (id: string, name: string, base: string, fees: string, amount: string, extra = '', klass = 'row') =>
  `<div class="${klass}"><div class="col-md-8"><p><span style="color:black; font-size:18px;"><img src="" class="seatimgclass">${name}</span><br>Precio Boleto: ${base} <br>Otros Cargos: ${fees}${extra}</p> </div> <div class="col-md-4"><input type="hidden" name="amount${id}" id="amount${id}" value="${amount}" disabled></div></div>`;
test('Cinex VIP prices keep membership tickets, and closed online sales are reported as Cinex words them', () => {
  const q = { provider: 'cinex' as const, cinema_id: 'PCV', session_id: '2097' };
  const html = `<form id="frmboletos">${cinexRow('0130', 'Adulto VIP', 'Bs. 894,89', 'Bs. 21.477,36', '22372.25')}${cinexRow('0163', '1 entrada gratis VIP al mes (Expires 30/11/2026)', 'Bs. 0,00', 'Bs. 0', '0', '<br>Total disponible: 1', 'row beneficiocinexclusivo')}</form>`;
  const items = parseCinexPrices(html, q, 'https://www.cinex.com.ve/boletos.php');
  assert.deepEqual(items.map(i => [i.name, i.prices?.[0]?.amount, i.price_components?.map(c => c.amount), i.redemption_only, i.tickets_available]), [
    ['Adulto VIP', 22372.25, [894.89, 21477.36], undefined, undefined],
    ['1 entrada gratis VIP al mes (Expires 30/11/2026)', 0, [0, 0], true, 1],
  ]);
  // A sum that does not add up still stops the read.
  assert.throws(() => parseCinexPrices(`<form id="frmboletos">${cinexRow('1', 'X', 'Bs. 1,00', 'Bs. 1,00', '5')}</form>`, q, 'https://www.cinex.com.ve/boletos.php'), /suma de tarifas/);
  assert.throws(() => parseCinexPrices('<div>Disculpe, la compra de boletos en este complejo no esta disponible en este momento.</div>', q, 'https://www.cinex.com.ve/boletos.php'), /compra de boletos en línea en esta sede no está disponible/);
  assert.throws(() => parseCinexConcessions('<div>Disculpe, la venta de dulceria web para este complejo no esta disponible en este momento.</div>', q, 'https://www.cinex.com.ve/concesiones.php'), /venta de caramelería en línea en esta sede no está disponible/);
});
