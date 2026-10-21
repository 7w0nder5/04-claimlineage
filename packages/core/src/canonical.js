import { fail } from "./errors.js";

function normalize(value, path) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("INVALID_JSON_VALUE", `${path} must be a finite number.`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => normalize(item, `${path}[${index}]`));
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined) fail("INVALID_JSON_VALUE", `${path}.${key} must not be undefined.`);
      Object.defineProperty(result, key, {
        value: normalize(item, `${path}.${key}`),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  }
  fail("INVALID_JSON_VALUE", `${path} is not a supported JSON value.`);
}

export function canonicalize(value) {
  return normalize(value, "$root");
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}
