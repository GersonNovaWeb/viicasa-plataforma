// Multi-currency tariffs belong to the active Firestore adapter, not legacy SQL.
export * from './schemas.js';
import * as base from './schemas.js';
export const currency = base.choice(['MXN','USD','CAD']);
const rates=base.object({USD:base.object({nightly_minor:base.int(1),cleaning_minor:base.int()}),CAD:base.object({nightly_minor:base.int(1),cleaning_minor:base.int()})},[]);
const prices=base.object({USD:base.int(1),CAD:base.int(1)},[]);
const extend=(schema,properties)=>({...schema,properties:{...schema.properties,...properties}});
const propertyImages={...base.images,items:{anyOf:[base.images.items,{enum:['/assets/interior.png','/assets/bedroom.png','/assets/exterior.png','/assets/life.png']}]}};
export const propertyBody=extend(base.propertyBody,{currency,rates,images:propertyImages});
export const variantBody=extend(base.variantBody,{currency,prices});
export const bookingBody=extend(base.bookingBody,{currency});
export const quoteBody=extend(base.quoteBody,{currency});
export const orderBody=extend(base.orderBody,{currency});
