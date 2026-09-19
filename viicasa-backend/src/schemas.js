export const str = (maxLength = 200, minLength = 1) => ({ type: 'string', minLength, maxLength });
export const int = (minimum = 0, maximum = 99999999) => ({ type: 'integer', minimum, maximum });
export const bool = { type: 'boolean' };
export const uuid = { type: 'string', format: 'uuid' };
export const email = { type: 'string', format: 'email', maxLength: 254 };
export const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
export const choice = values => ({ type: 'string', enum: values });
export const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
export const array = (items, maxItems = 30) => ({ type: 'array', items, maxItems });
export const images = array({ type: 'string', maxLength: 2000, pattern: '^(https://[^\\s]+|/v1/media/[a-f0-9-]+)$' });
export const currency = choice(['MXN', 'USD']);
export const slug = { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', maxLength: 100 };
export const customer = object({ name: str(120, 2), email, phone: str(30, 5), consent: { const: true } });
export const idParams = object({ id: uuid });
export const pagination = object({ limit: int(1, 100), offset: int(0, 100000) }, []);
export const propertyBody = object({ slug, name: str(), description: str(10000), location: str(),
  timezone: str(80), capacity: int(1, 100), bedrooms: int(0, 100), bathrooms: int(0, 100),
  nightly_minor: int(1), cleaning_minor: int(), deposit_percent: int(1, 100), min_nights: int(1, 90),
  currency, images, amenities: array(str(80), 50), policies: str(5000), published: bool });
export const productBody = object({ slug, name: str(), description: str(10000), category: str(80), images, published: bool });
export const variantBody = object({ sku: str(80), name: str(120), price_minor: int(1), currency, stock: int(0, 1000000), active: bool });
export const bookingBody = object({ property_id: uuid, check_in: date, check_out: date, guests: int(1, 100), customer, pay: choice(['full', 'deposit']) });
export const quoteBody = object({ property_id: uuid, check_in: date, check_out: date, guests: int(1, 100) });
export const address = object({street:str(300),city:str(120),state:str(120),postal_code:str(20),country:{type:'string',pattern:'^[A-Z]{2}$'}});
export const orderBody = object({ customer, delivery: choice(['pickup','shipping']), shipping_address:address, note: str(1000, 0) }, ['customer','delivery']);
export const keyHeader = { type: 'object', required: ['idempotency-key'], properties: { 'idempotency-key': { type: 'string', pattern: '^[A-Za-z0-9_-]{8,100}$' } } };
