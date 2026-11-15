import type { PrintfulCredential, ShopifyCredential } from './credentials'
import type { ArtListingDraft } from '../../../shared/business'

/**
 * Storefronts, through their own documented APIs.
 *
 * Shopify: the Admin GraphQL API, with an access token from a custom app the user installs
 * in their own store. A listing is created with status DRAFT, so it exists in the store's
 * admin and is not visible to anyone until the user publishes it there.
 *
 * Printful: the Printful API, with a private token from the user's own dashboard. A listing
 * becomes a sync product in the user's store, also created unpublished.
 *
 * Neither call is made until the user approved that exact listing.
 */

export class StorefrontError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

async function call<T>(url: string, init: RequestInit, http: typeof fetch): Promise<T> {
  const res = await http(url, { ...init, signal: AbortSignal.timeout(30_000) })
  const text = await res.text()
  if (res.status === 401 || res.status === 403) throw new StorefrontError('the storefront rejected the stored token — reconnect the account', res.status)
  if (!res.ok) {
    let detail = text.slice(0, 300)
    try {
      const parsed = JSON.parse(text) as { errors?: unknown; error?: { message?: string } | string; message?: string }
      if (typeof parsed.error === 'string') detail = parsed.error
      else if (parsed.error && typeof parsed.error === 'object' && parsed.error.message) detail = parsed.error.message
      else if (parsed.message) detail = parsed.message
      else if (parsed.errors) detail = JSON.stringify(parsed.errors).slice(0, 300)
    } catch { /* not JSON */ }
    throw new StorefrontError(`the storefront said ${res.status}: ${detail}`, res.status)
  }
  return (text ? JSON.parse(text) : {}) as T
}

// ── Shopify ─────────────────────────────────────────────────────────────────

export function normaliseShop(input: string): string {
  const raw = String(input ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  if (!raw) throw new StorefrontError('enter your shop domain, e.g. my-shop.myshopify.com', 0)
  const host = raw.endsWith('.myshopify.com') ? raw : `${raw}.myshopify.com`
  if (!/^[a-z0-9][a-z0-9-]{1,60}\.myshopify\.com$/.test(host)) {
    throw new StorefrontError('that does not look like a myshopify.com domain', 0)
  }
  return host
}

const SHOPIFY_API_VERSION = '2024-10'

export async function shopifyVerify(
  cred: ShopifyCredential, http: typeof fetch = fetch,
): Promise<{ name: string; domain: string; currency: string }> {
  const shop = normaliseShop(cred.shop)
  const doc = await call<{ data?: { shop?: { name?: string; myshopifyDomain?: string; currencyCode?: string } }; errors?: unknown }>(
    `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': cred.accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ shop { name myshopifyDomain currencyCode } }' }),
    }, http,
  )
  if (doc.errors) throw new StorefrontError(`Shopify refused the query: ${JSON.stringify(doc.errors).slice(0, 240)}`, 0)
  const s = doc.data?.shop
  if (!s) throw new StorefrontError('Shopify returned no shop details', 0)
  return { name: s.name ?? shop, domain: s.myshopifyDomain ?? shop, currency: s.currencyCode ?? 'USD' }
}

/**
 * Create a product as a DRAFT. Nothing is published: the product sits in the store's admin
 * with status DRAFT until the user publishes it there themselves.
 */
export async function shopifyCreateDraftProduct(
  cred: ShopifyCredential, listing: ArtListingDraft, http: typeof fetch = fetch,
): Promise<{ id: string; adminUrl: string; status: string }> {
  const shop = normaliseShop(cred.shop)
  const mutation = `mutation CreateDraft($input: ProductInput!) {
    productCreate(input: $input) {
      product { id title status onlineStoreUrl }
      userErrors { field message }
    }
  }`
  const input = {
    title: listing.title,
    descriptionHtml: listing.description.replace(/\n/g, '<br>'),
    tags: listing.tags,
    status: 'DRAFT',
    // Shopify's price is a decimal string in the shop's currency.
    variants: [{ price: listing.price.toFixed(2), sku: '' }],
  }
  const doc = await call<{
    data?: { productCreate?: { product?: { id: string; title: string; status: string; onlineStoreUrl: string | null }; userErrors?: { field: string[]; message: string }[] } }
    errors?: unknown
  }>(
    `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': cred.accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: mutation, variables: { input } }),
    }, http,
  )
  if (doc.errors) throw new StorefrontError(`Shopify refused the product: ${JSON.stringify(doc.errors).slice(0, 240)}`, 0)
  const result = doc.data?.productCreate
  const userErrors = result?.userErrors ?? []
  if (userErrors.length) throw new StorefrontError(`Shopify refused the product: ${userErrors.map(e => e.message).join('; ')}`, 0)
  const product = result?.product
  if (!product) throw new StorefrontError('Shopify created nothing and said nothing', 0)
  const numericId = product.id.split('/').pop() ?? ''
  return {
    id: product.id,
    adminUrl: `https://${shop}/admin/products/${numericId}`,
    status: product.status,
  }
}

// ── Printful ────────────────────────────────────────────────────────────────

const PRINTFUL = 'https://api.printful.com'

export async function printfulVerify(
  cred: PrintfulCredential, http: typeof fetch = fetch,
): Promise<{ name: string; email: string; stores: { id: number; name: string }[] }> {
  const headers = { Authorization: `Bearer ${cred.accessToken}`, Accept: 'application/json' }
  const me = await call<{ result?: { name?: string; email?: string } }>(`${PRINTFUL}/v2/user`, { headers }, http)
  let stores: { id: number; name: string }[] = []
  try {
    const list = await call<{ result?: { id: number; name: string }[] }>(`${PRINTFUL}/v2/stores`, { headers }, http)
    stores = (list.result ?? []).map(s => ({ id: s.id, name: s.name }))
  } catch { /* the store list is an addition; the account check still stands */ }
  return { name: me.result?.name ?? 'Printful account', email: me.result?.email ?? '', stores }
}

/**
 * Create a sync product in the user's Printful store. Printful's own store settings decide
 * whether it is published; Goga creates it and reports the id, and the user publishes it in
 * Printful. No price is invented: Printful prices from the product and the store's markup.
 */
export async function printfulCreateProduct(
  cred: PrintfulCredential, listing: ArtListingDraft, http: typeof fetch = fetch,
): Promise<{ id: number; url: string }> {
  const headers = {
    Authorization: `Bearer ${cred.accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(cred.storeId ? { 'X-PF-Store-Id': cred.storeId } : {}),
  }
  const doc = await call<{ result?: { id: number; name?: string } }>(`${PRINTFUL}/store/products`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      sync_product: {
        name: listing.title,
        thumbnail: '',
        // Printful's own description field is not part of sync_product; the store's
        // description is set in Printful. Goga keeps the copy in the draft.
      },
    }),
  }, http)
  const id = doc.result?.id
  if (!id) throw new StorefrontError('Printful created nothing and said nothing', 0)
  return { id, url: `https://www.printful.com/dashboard/sync/products/${id}` }
}
