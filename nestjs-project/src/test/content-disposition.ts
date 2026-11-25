/** A `Content-Disposition` header as a client reads it, with `filename*` decoded (RFC 8187). */
export interface ParsedContentDisposition {
  type: string;
  /** The quoted `filename`, unescaped. */
  filename?: string;
  /** `filename*=UTF-8''…`, percent-decoded. */
  filenameStar?: string;
}

/** Parses the header of a download, for the assertions of the specs. */
export function parseContentDisposition(
  header: string | undefined,
): ParsedContentDisposition {
  const value = header ?? '';
  const type = value.split(';', 1)[0].trim();
  const quoted = /;\s*filename="((?:[^"\\]|\\.)*)"/.exec(value);
  const extended = /;\s*filename\*=UTF-8''([^;\s]*)/i.exec(value);
  return {
    type,
    filename: quoted ? quoted[1].replace(/\\(.)/g, '$1') : undefined,
    filenameStar: extended ? decodeURIComponent(extended[1]) : undefined,
  };
}
