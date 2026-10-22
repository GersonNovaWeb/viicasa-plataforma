// Illustrative gallery supplements for the four known sample products only.
// Real products and admin-supplied replacement imagery remain unchanged.
export const sampleGalleryAssets={
  'sample-terra-vase':'/assets/viishop-terra-gallery.png',
  'sample-linen-throw':'/assets/viishop-linen-gallery.png',
  'sample-wood-sculpture':'/assets/viishop-wood-gallery.png',
  'sample-home-ritual':'/assets/viishop-ritual-gallery.png'
};
export const sampleGalleryDetails=Object.fromEntries(Object.entries(sampleGalleryAssets).map(([slug,src])=>[slug,src.replace('-gallery.png','-detail.png')]));
export function sampleProductGallery(product,images,demo){
  const extra=demo&&sampleGalleryAssets[product.slug];
  // Supplement the original generic sample assets, never an edited/replaced gallery.
  if(!extra||!images.length||!images.every(src=>/^\/assets\/(objects|shop)\.png$/.test(src)))return images;
  return [extra,sampleGalleryDetails[product.slug]];
}
