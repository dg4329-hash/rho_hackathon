/**
 * JSON-Schema helpers shared by mcp-import.ts (validating incoming `tool` requests)
 * and local-server.ts (pre-validating ask_teammate args, rendering describe_capability usage).
 */
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";

const ajv = new Ajv({ allErrors: true, strict: false });
const cache = new WeakMap<object, ValidateFunction | Error>();

/** Compile once per schema object (WeakMap keyed by identity). Returns an Error if the schema itself is invalid. */
export function compileSchema(schema: object): ValidateFunction | Error {
  const hit = cache.get(schema);
  if (hit) return hit;
  let out: ValidateFunction | Error;
  try {
    out = ajv.compile(schema);
  } catch (e) {
    out = e instanceof Error ? e : new Error(String(e));
  }
  cache.set(schema, out);
  return out;
}

/** One readable line, e.g. `args invalid: /query must be string; missing required 'project_id'`. */
export function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return "args invalid";
  const parts = errors.map((e) => {
    if (e.keyword === "required") {
      const missing = (e.params as { missingProperty?: string }).missingProperty;
      return `missing required '${missing}'`;
    }
    if (e.keyword === "additionalProperties") {
      const extra = (e.params as { additionalProperty?: string }).additionalProperty;
      return `unexpected property '${extra}'`;
    }
    const where = e.instancePath || "/";
    return `${where} ${e.message ?? e.keyword}`;
  });
  return `args invalid: ${Array.from(new Set(parts)).join("; ")}`;
}

/** null when args satisfy schema, else a readable error string. A missing/invalid schema accepts anything. */
export function validateAgainstSchema(schema: object | undefined, args: Record<string, unknown>): string | null {
  if (!schema) return null;
  const fn = compileSchema(schema);
  if (fn instanceof Error) return null; // unparseable schema: let the remote server decide
  return fn(args) ? null : formatAjvErrors(fn.errors);
}

// ---------- usage example rendering (describe_capability) ----------

type JsonSchema = Record<string, unknown>;

function placeholderFor(schema: JsonSchema | undefined, depth = 0): unknown {
  if (!schema || depth > 3) return "<value>";
  if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0];
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;
  const variants = (schema.oneOf ?? schema.anyOf) as JsonSchema[] | undefined;
  if (Array.isArray(variants) && variants.length > 0) return placeholderFor(variants[0], depth + 1);
  const type = Array.isArray(schema.type) ? (schema.type as string[])[0] : (schema.type as string | undefined);
  switch (type) {
    case "string":
      return schema.format ? `<${schema.format}>` : "<string>";
    case "number":
    case "integer":
      return typeof schema.minimum === "number" ? schema.minimum : 0;
    case "boolean":
      return true;
    case "null":
      return null;
    case "array":
      return [placeholderFor(schema.items as JsonSchema | undefined, depth + 1)];
    case "object":
      return exampleArgs(schema, depth + 1);
    default:
      if (schema.properties) return exampleArgs(schema, depth + 1);
      return "<value>";
  }
}

/** Example args object: all required props plus up to 3 optional ones, values from examples/default/enum/type. */
export function exampleArgs(schema: JsonSchema | undefined, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!schema) return out;
  const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((schema.required as string[] | undefined) ?? []);
  for (const key of required) out[key] = placeholderFor(props[key], depth);
  let optional = 0;
  for (const key of Object.keys(props)) {
    if (required.has(key)) continue;
    if (optional >= 3) break;
    out[key] = placeholderFor(props[key], depth);
    optional++;
  }
  return out;
}
