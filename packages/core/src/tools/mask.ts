/**
 * Masking credentials before anything is stored: headers, bodies, console lines and addresses.
 * Shared by the network log, the activity recorder script and the dx browser, so every way dx
 * records an app hides the same things.
 */

export const MASK = "•••";

const SECRET_HEADERS = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token|x-dx-token)$/i;
// "authorization" but not "author", "card_number" but not "cards".
const SECRET_KEY = /pass(word)?|passwd|secret|token|api[-_]?key|^auth$|authorization|credential|session[-_]?id|cookie|card[-_]?(number|no)|cvv|cvc|ssn|iban|private[-_]?key/i;
// In an address, also what sign-in callbacks and signed links carry.
const SECRET_PARAM = /^(code|sig|signature|ticket)$/i;

type HeaderBag = Record<string, string | string[] | number | undefined>;

export function maskHeaders(headers: HeaderBag): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    // A cookie being set keeps its name and flags (HttpOnly, Secure, SameSite), so they can be
    // checked; only its value is masked.
    if (/^set-cookie$/i.test(k)) out[k.toLowerCase()] = (Array.isArray(v) ? v : [String(v)]).map(maskSetCookie).join(", ");
    else out[k.toLowerCase()] = SECRET_HEADERS.test(k) ? MASK : Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

/** "sid=abc; Path=/; HttpOnly" → "sid=•••; Path=/; HttpOnly". Anything that isn't a name=value cookie is masked whole. */
export function maskSetCookie(cookie: string): string {
  const m = /^\s*([!#$%&'*+.^_`|~0-9A-Za-z-]{1,100})=[^;]*((?:;\s*[A-Za-z-]+(?:=[^;]*)?)*)\s*$/.exec(cookie);
  if (!m) return MASK;
  // Attribute values are kept only for the flags that matter; Domain and Path can stay, Expires too.
  const attrs = m[2]
    .split(";")
    .map((a) => a.trim())
    .filter((a) => /^(httponly|secure|partitioned)$/i.test(a) || /^(samesite|path|domain|max-age|expires)=/i.test(a));
  return [`${m[1]}=${MASK}`, ...attrs].join("; ");
}

/** Masks the values of keys that look like credentials, in JSON, forms and key=value text. */
export function maskBody(body: string, type: string): string {
  if (/json|graphql/i.test(type)) {
    try {
      return JSON.stringify(maskJson(JSON.parse(body)));
    } catch {
      // cut short or not JSON after all: fall through to the text rules
    }
  }
  if (/x-www-form-urlencoded/i.test(type)) {
    return body
      .split("&")
      .map((pair) => {
        const [k, ...rest] = pair.split("=");
        let key = k ?? "";
        try {
          key = decodeURIComponent(key);
        } catch {
          // not encoded the usual way: the key as it is
        }
        return SECRET_KEY.test(key) && rest.length ? `${k}=${MASK}` : pair;
      })
      .join("&");
  }
  return body.replace(/("?)([\w-]*(?:pass(?:word)?|secret|token|api[-_]?key)[\w-]*)\1(\s*[:=]\s*)("?)[^"&\s,}]+\4/gi, `$1$2$1$3$4${MASK}$4`);
}

function maskJson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(maskJson);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SECRET_KEY.test(k) && (typeof x === "string" || typeof x === "number") ? MASK : maskJson(x)]));
  }
  return v;
}

/** Credentials that end up in a console line or an error message: "token=abc", "Bearer abc". */
export function maskText(s: string): string {
  return maskBody(s, "text/plain").replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 •••");
}

/** An address with the values of credential-looking query parameters (?token=…, ?code=…) masked, and no user:password. */
export function maskUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw, "http://same.origin");
  } catch {
    return maskText(raw);
  }
  const relative = u.origin === "http://same.origin" && !/^[a-z][\w+.-]*:/i.test(raw);
  let changed = false;
  if (u.username || u.password) {
    u.username = "";
    u.password = "";
    changed = true;
  }
  for (const key of [...u.searchParams.keys()]) {
    if ((SECRET_KEY.test(key) || SECRET_PARAM.test(key)) && u.searchParams.get(key)) {
      u.searchParams.set(key, MASK);
      changed = true;
    }
  }
  if (!changed) return raw;
  const out = u.href.replace(/%E2%80%A2%E2%80%A2%E2%80%A2/g, MASK);
  return relative ? out.slice("http://same.origin".length) : out;
}

/** API calls are what matter; pages, scripts, styles and images are kept but listed only on request. */
export function classify(method: string, contentType: string, path: string): "api" | "page" | "asset" {
  if (/text\/html/i.test(contentType)) return "page";
  if (method !== "GET" && method !== "HEAD") return "api";
  if (/json|xml|text\/plain|graphql|x-www-form-urlencoded|event-stream/i.test(contentType)) return "api";
  if (/\/api\/|\/graphql|\/trpc\//i.test(path) && !/javascript|css|image|font/i.test(contentType)) return "api";
  return "asset";
}

/** A body worth keeping as text. */
export function isTextType(type: string): boolean {
  return /json|text\/|xml|graphql|x-www-form-urlencoded|javascript/i.test(type) && !/event-stream/i.test(type);
}
