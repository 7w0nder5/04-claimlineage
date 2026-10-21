import { fail } from "../../core/src/index.js";

export function parseTokens(tokens) {
  const positionals = [];
  const flags = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
    if (!name) fail("INVALID_ARGUMENT", "An option name must follow --.");
    if (flags.has(name)) fail("DUPLICATE_OPTION", `--${name} was provided more than once.`);
    let value;
    if (equals !== -1) {
      value = token.slice(equals + 1);
    } else {
      value = tokens[index + 1];
      if (value === undefined || value.startsWith("--")) fail("MISSING_OPTION_VALUE", `--${name} requires a value.`);
      index += 1;
    }
    flags.set(name, value);
  }
  return { positionals, flags };
}

export function takeFlag(flags, name, fallback = undefined) {
  if (!flags.has(name)) return fallback;
  const value = flags.get(name);
  flags.delete(name);
  return value;
}

export function rejectFlags(flags) {
  if (flags.size) fail("UNKNOWN_OPTION", `Unknown option --${flags.keys().next().value}.`);
}

export function expectPositionals(positionals, count, usage) {
  if (positionals.length !== count) fail("INVALID_ARGUMENT", `Expected ${usage}.`);
}
