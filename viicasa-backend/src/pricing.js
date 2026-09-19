import {fail} from './lib.js';

// Independent administrator-set tariffs; never a currency relabel or FX estimate.
export function propertyRate(property, currency = property.currency) {
  if (currency === property.currency) return {currency, nightly_minor:property.nightly_minor, cleaning_minor:property.cleaning_minor};
  const rate = property.rates?.[currency];
  if (!rate) fail(409, `Tarifa no disponible en ${currency}`);
  return {currency, ...rate};
}

export function variantRate(variant, currency = variant.currency) {
  const amount = currency === variant.currency ? variant.price_minor : variant.prices?.[currency];
  if (!Number.isInteger(amount) || amount < 1) fail(409, `Tarifa no disponible en ${currency}`);
  return {currency, price_minor:amount};
}
