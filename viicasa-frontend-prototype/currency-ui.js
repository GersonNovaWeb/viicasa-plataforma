export const currencies=['USD','CAD'];
// The main price always owns its currency. Mirror it, rather than let an admin
// enter a second conflicting price that the server would intentionally ignore.
export function bindPrimaryCurrency(form,fixedCurrency){
  const primary=form.elements.currency;
  const sync=()=>{const currency=primary?.value||fixedCurrency;for(const c of currencies){
    for(const [prefix,source] of [['rate_','nightly'],['clean_','cleaning'],['price_','price']]){
      const input=form.elements[prefix+c];if(!input)continue;
      input.disabled=c===currency;
      if(input.disabled&&form.elements[source])input.value=form.elements[source].value;
    }
  }};
  primary?.addEventListener('change',sync);
  for(const name of ['nightly','cleaning','price'])form.elements[name]?.addEventListener('input',sync);
  sync();
}
export function selectedProperty(p,currency){
  const rate=currency===p.currency?{nightly_minor:p.nightly_minor,cleaning_minor:p.cleaning_minor}:p.rates?.[currency];
  return {...p,currency,nightly_minor:rate?.nightly_minor??null,cleaning_minor:rate?.cleaning_minor??null,price_available:!!rate};
}
export function selectedVariant(v,currency){
  const price=currency===v.currency?v.price_minor:v.prices?.[currency];
  return {...v,currency,price_minor:price??null,price_available:Number.isInteger(price)&&price>0};
}
export function rateFields(p,L){
  return `<fieldset class="currency-rates"><legend>${L('Tarifas independientes USD / CAD','Independent USD / CAD rates')}</legend><p class="quiet">${L('Sin conversión automática. Deja una moneda vacía para no ofrecerla. La tarifa de la moneda principal se edita arriba.','No automatic conversion. Leave a currency blank to not offer it. Edit the primary currency rate above.')}</p>${currencies.map(c=>{
    const r=p.rates?.[c];return `<div class="form-pair"><label>${c} · ${L('Por noche','Per night')}<input name="rate_${c}" type="number" min="0.01" max="999999.99" step="0.01" value="${r?.nightly_minor?r.nightly_minor/100:''}"></label><label>${c} · ${L('Limpieza','Cleaning')}<input name="clean_${c}" type="number" min="0" max="999999.99" step="0.01" value="${r?r.cleaning_minor/100:''}"></label></div>`;
  }).join('')}</fieldset>`;
}
export function priceFields(v,L){return `<fieldset class="currency-rates"><legend>${L('Precios adicionales por moneda','Additional currency prices')}</legend>${currencies.map(c=>`<label>${c}<input name="price_${c}" type="number" min="0.01" max="999999.99" step="0.01" value="${v.prices?.[c]?v.prices[c]/100:''}"></label>`).join('')}<p class="quiet">${L('No se convierte automáticamente. La moneda principal usa el precio indicado arriba.','No automatic conversion. The primary currency uses the price entered above.')}</p></fieldset>`;}
export function readRates(d){const rates={};for(const c of currencies){if(d['rate_'+c])rates[c]={nightly_minor:Math.round(Number(d['rate_'+c])*100),cleaning_minor:Math.round(Number(d['clean_'+c]||0)*100)};}return rates;}
export function readPrices(d){const prices={};for(const c of currencies)if(d['price_'+c])prices[c]=Math.round(Number(d['price_'+c])*100);return prices;}
