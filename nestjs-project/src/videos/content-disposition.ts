/**
 * `Content-Disposition: attachment` of the download of the original (RFC 6266), signed in the URL
 * as `ResponseContentDisposition` (TD-14):
 * - `filename*` carries the exact `original_filename` in UTF-8, percent-encoded (RFC 8187);
 * - `filename` comes first, as RFC 6266 §4.3 recommends, with an ASCII fallback for clients
 *   without RFC 8187.
 *
 * The header stays ASCII, so the storage can echo it as it was signed. `original_filename` comes
 * from the database already well-formed: the driver writes UTF-8, so no lone surrogate reaches
 * `encodeURIComponent`.
 */
export function attachmentDisposition(filename: string): string {
  return `attachment; filename="${asciiFallback(filename)}"; filename*=UTF-8''${encodeExtValue(filename)}`;
}

/**
 * Without diacritics; any other code point outside printable ASCII becomes `_`, as do `"` and `\`
 * (they would end the quoted string) and `%` (some clients percent-decode `filename`).
 */
function asciiFallback(filename: string): string {
  return filename
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\x20-\x7e]|["\\%]/gu, '_');
}

/**
 * `value-chars` of RFC 8187: `encodeURIComponent` keeps `'`, `(`, `)` and `*` unencoded, but they
 * are not `attr-char`.
 */
function encodeExtValue(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
