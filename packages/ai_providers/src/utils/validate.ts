/**
 * validate.ts
 *
 * Tool-call argument validation for the coding harness AI provider layer.
 *
 * Given a Tool whose `parameters` field is a Zod schema and a
 * ToolCall whose `arguments` came back from an LLM, validate (and lightly
 * coerce) those arguments so that downstream tool-execution code can trust the
 * shape it receives.
 *
 * ## Why coercion?
 * LLMs are probabilistic; they sometimes return values that are *almost*
 * correct — e.g. the number `42` stringified as `"42"`, or the boolean `true`
 * sent as the string `"true"`.  A strict schema parse would reject these even
 * though the intent is unambiguous.  Coercion converts those edge cases before
 * the Zod parse so that the validation pass rate is higher without sacrificing
 * safety.
 *
 * ## Architecture
 *
 * 1. **JSON Schema mirror** — `zod-to-json-schema` converts the Zod schema into
 *    a plain JSON Schema object.  All coercion logic operates on that JSON
 *    Schema representation so it remains schema-library-agnostic
 *
 * 2. **Coercion pass** — `coerceWithJsonSchema` walks the value tree in
 *    parallel with the JSON Schema tree and fixes obvious type mismatches at
 *    every level (scalars, objects, arrays, allOf/anyOf/oneOf unions).
 *
 * 3. **Validation pass** — After coercion, `z.safeParse` is used for the
 *    definitive check.  Errors are formatted into a human-readable string that
 *    names the failing field path, which the agent loop can feed back to the
 *    LLM as a correction prompt.
 *
 * 4. **Caching** — Converting a Zod schema to JSON Schema is not free, so the
 *    result is cached in a WeakMap keyed on the Zod schema object reference.
 *    The WeakMap ensures entries are GC'd when the schema is no longer
 *    referenced.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool, ToolCall } from "../types.js";

// ---------------------------------------------------------------------------
// Internal JSON Schema representation
// ---------------------------------------------------------------------------

/**
 * A minimal structural description of a JSON Schema node.
 *
 * We only need the subset of keywords that are relevant to type-coercion
 * (type assertions, compound keywords, and child-schema pointers).  Any
 * keywords we do not list here are simply ignored during coercion.
 */
interface JsonSchemaObject {
  /** JSON Schema primitive type string or an array of them (union shorthand) */
  type?: string | string[];
  /** Named child schemas for object properties */
  properties?: Record<string, JsonSchemaObject>;
  /** Schema for array items — either one schema or a tuple of schemas */
  items?: JsonSchemaObject | JsonSchemaObject[];
  /**
   * Schema applied to object properties not listed in `properties`.
   * When `true`, extra properties are allowed without restriction.
   * When an object, it acts as the schema for each extra property value.
   */
  additionalProperties?: boolean | JsonSchemaObject;
  /** All sub-schemas must match (intersection) */
  allOf?: JsonSchemaObject[];
  /** At least one sub-schema must match (union) */
  anyOf?: JsonSchemaObject[];
  /** Exactly one sub-schema must match */
  oneOf?: JsonSchemaObject[];
}

// ---------------------------------------------------------------------------
// JSON Schema cache
// ---------------------------------------------------------------------------

/**
 * Weak cache: Zod schema object → derived JSON Schema.
 *
 * Using a WeakMap means the cached JSON Schema for a given Zod schema is
 * automatically released from memory when no other reference to that Zod
 * schema exists — avoiding unbounded growth when tools are created and
 * discarded dynamically.
 *
 * The key type is `z.ZodType` because every Zod schema is an object, which
 * satisfies the WeakMap key constraint.
 */
const jsonSchemaCache = new WeakMap<z.ZodType, JsonSchemaObject>();

/**
 * Converts a Zod schema to its JSON Schema representation, using the cache
 * to avoid redundant conversions.
 *
 * `zodToJsonSchema` always wraps the result in a `{ $schema, ..., definitions }` envelope.
 * We cast the inner definition (or the root itself) to `JsonSchemaObject` because
 * we only need the structural portion for coercion, not the meta-keywords.
 *
 * @param schema - The Zod schema to convert.
 * @returns A `JsonSchemaObject` suitable for coercion traversal.
 */
function getJsonSchema(schema: z.ZodType): JsonSchemaObject {
  const cached = jsonSchemaCache.get(schema);
  if (cached) {
    return cached;
  }

  // `zodToJsonSchema` accepts any ZodType and returns a full JSON Schema.
  // We tell it to not add the `$schema` URI so the output is leaner.
  // zod-to-json-schema@3 was typed against Zod v3; Zod v4 changed the generic
  // signature of ZodType, causing a TS mismatch at the call site even though
  // the runtime API is compatible.  Casting to `any` is the minimal fix until
  // zod-to-json-schema ships Zod-v4-aware types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const full = zodToJsonSchema(schema as any, { $refStrategy: "none" });

  // The library returns a plain object; cast it to our internal type.
  const jsonSchema = full as JsonSchemaObject;

  jsonSchemaCache.set(schema, jsonSchema);
  return jsonSchema;
}

// ---------------------------------------------------------------------------
// Type-matching helpers (pure predicates, no side-effects)
// ---------------------------------------------------------------------------

/**
 * Extracts the list of JSON Schema type strings from a schema node.
 *
 * Handles both the singular form (`"type": "string"`) and the union shorthand
 * (`"type": ["string", "null"]`).  Returns an empty array when no `type`
 * keyword is present (e.g. on a pure `$ref` or compound keyword node).
 *
 * @param schema - The schema node to inspect.
 * @returns An array of JSON Schema type name strings.
 */
function getSchemaTypes(schema: JsonSchemaObject): string[] {
  if (typeof schema.type === "string") {
    // Single type: return it as a one-element array for uniform downstream handling.
    return [schema.type];
  }
  if (Array.isArray(schema.type)) {
    // Array-form union type: filter out any non-string elements defensively.
    return schema.type.filter((t): t is string => typeof t === "string");
  }
  // No `type` keyword — caller must rely on compound keywords (anyOf, etc.).
  return [];
}

/**
 * Returns `true` when `value` already satisfies the given JSON Schema type
 * string, i.e. no coercion is needed.
 *
 * Implements the JSON Schema type semantics:
 * - `"integer"` is a subset of `"number"` and requires `Number.isInteger`.
 * - `"object"` excludes arrays (arrays are objects in JS, but not in JSON Schema).
 * - `"null"` maps to the JS `null` literal (not `undefined`).
 *
 * @param value - The runtime value to test.
 * @param type  - A JSON Schema type name such as `"string"`, `"number"`, etc.
 * @returns `true` if the value already conforms to this JSON Schema type.
 */
function matchesJsonType(value: unknown, type: string): boolean {
  switch (type) {
    case "number":
      return typeof value === "number";
    case "integer":
      // JSON Schema integer: must be numeric AND have no fractional part.
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "null":
      // JSON null maps specifically to the JS `null` value (not `undefined`).
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      // Must be a non-null, non-array object.
      return (
        typeof value === "object" && value !== null && !Array.isArray(value)
      );
    default:
      // Unknown type keyword — conservatively return false so coercion is attempted.
      return false;
  }
}

// ---------------------------------------------------------------------------
// Scalar coercion
// ---------------------------------------------------------------------------

/**
 * Attempts to coerce a scalar `value` into the given JSON Schema `type`.
 *
 * Only performs "safe" conversions where the intent is clear:
 * - Numeric strings like `"42"` → number `42`.
 * - String `"true"` / `"false"` → boolean.
 * - `null` → zero / empty-string / false (JSON Schema `default`-like behaviour).
 * - Numbers 0 / 1 → boolean `false` / `true`.
 *
 * Returns the *original* value unchanged when no safe coercion applies, so the
 * caller can detect a no-op by comparing `candidate !== value`.
 *
 * @param value - The value to attempt coercion on.
 * @param type  - The target JSON Schema type.
 * @returns The coerced value, or the original value if no coercion was possible.
 */
function coercePrimitiveByType(value: unknown, type: string): unknown {
  switch (type) {
    case "number": {
      // null → 0
      if (value === null) return 0;
      // Numeric string → number (e.g. LLM returning "3.14" instead of 3.14)
      if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
      }
      // Boolean → 0 or 1 (rare but seen in some model outputs)
      if (typeof value === "boolean") return value ? 1 : 0;
      return value;
    }

    case "integer": {
      // null → 0
      if (value === null) return 0;
      // Integer string → integer (only accept if the parsed value is already integral)
      if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        if (Number.isInteger(parsed)) return parsed;
      }
      // Boolean → 0 or 1
      if (typeof value === "boolean") return value ? 1 : 0;
      return value;
    }

    case "boolean": {
      // null → false
      if (value === null) return false;
      // String "true" / "false" → boolean (case-sensitive, matching JSON)
      if (typeof value === "string") {
        if (value === "true") return true;
        if (value === "false") return false;
      }
      // Numeric 0 / 1 → boolean (common from some providers)
      if (typeof value === "number") {
        if (value === 1) return true;
        if (value === 0) return false;
      }
      return value;
    }

    case "string": {
      // null → ""
      if (value === null) return "";
      // Numbers and booleans → their string representation
      if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
      }
      return value;
    }

    case "null": {
      // Empty-ish falsy primitives → null
      // Covers cases where the model returns "" or 0 where null is expected.
      if (value === "" || value === 0 || value === false) return null;
      return value;
    }

    default:
      // "array" and "object" are not scalar types; coercion is handled separately.
      return value;
  }
}

// ---------------------------------------------------------------------------
// Structural coercion (objects and arrays)
// ---------------------------------------------------------------------------

/**
 * Recursively coerces the values inside a plain object according to the
 * `properties` and `additionalProperties` keywords of a JSON Schema object node.
 *
 * Mutates `value` in-place for efficiency (the caller has already made a deep
 * clone via `structuredClone` before this point).
 *
 * @param value  - The object whose properties should be coerced.
 * @param schema - The JSON Schema object node (must describe an `"object"` type).
 */
function applySchemaObjectCoercion(
  value: Record<string, unknown>,
  schema: JsonSchemaObject,
): void {
  const properties = schema.properties;

  // Track which keys have an explicit property schema so we can differentiate
  // them from `additionalProperties` keys below.
  const definedKeys = new Set<string>(
    properties ? Object.keys(properties) : [],
  );

  // Coerce each explicitly-declared property that is present in the value.
  // Properties absent from the value are skipped (the schema may still mark them
  // optional, but their absence is fine — that is a validation concern, not a
  // coercion concern).
  if (properties) {
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!(key in value)) continue; // property is missing — skip
      value[key] = coerceWithJsonSchema(value[key], propertySchema);
    }
  }

  // Coerce extra (non-declared) properties when `additionalProperties` is a schema.
  // When `additionalProperties` is `true` or absent, extra props are allowed as-is.
  if (
    schema.additionalProperties &&
    typeof schema.additionalProperties === "object"
  ) {
    for (const [key, propValue] of Object.entries(value)) {
      if (definedKeys.has(key)) continue; // already handled above
      value[key] = coerceWithJsonSchema(propValue, schema.additionalProperties);
    }
  }
}

/**
 * Recursively coerces each element of an array according to the `items` keyword
 * of a JSON Schema array node.
 *
 * Supports two JSON Schema `items` forms:
 * 1. **Tuple form** (`items` is an array): each index has its own schema.
 * 2. **Uniform form** (`items` is a single schema): all elements share one schema.
 *
 * Mutates `value` in-place (same clone rationale as `applySchemaObjectCoercion`).
 *
 * @param value  - The array whose elements should be coerced.
 * @param schema - The JSON Schema array node (must describe an `"array"` type).
 */
function applySchemaArrayCoercion(
  value: unknown[],
  schema: JsonSchemaObject,
): void {
  if (Array.isArray(schema.items)) {
    // Tuple form: each position maps to a specific schema.
    for (let i = 0; i < value.length; i++) {
      const itemSchema = schema.items[i];
      if (!itemSchema) continue; // no schema for this index (beyond tuple length) — leave as-is
      value[i] = coerceWithJsonSchema(value[i], itemSchema);
    }
    return;
  }

  // Uniform form: all elements share the same schema.
  if (schema.items && typeof schema.items === "object") {
    for (let i = 0; i < value.length; i++) {
      value[i] = coerceWithJsonSchema(value[i], schema.items);
    }
  }
}

// ---------------------------------------------------------------------------
// Union coercion
// ---------------------------------------------------------------------------

/**
 * Attempts to coerce `value` into one of the given sub-schemas (anyOf / oneOf).
 *
 * Strategy: for each candidate schema, make a deep clone of the current value,
 * run `coerceWithJsonSchema` on it, and check whether the result now validates.
 * Return the first clone that passes validation.  If none pass, return the
 * original value unchanged — the outer validation pass will then report the
 * error with a proper message.
 *
 * The deep clone ensures that failed coercion attempts on one branch don't
 * contaminate the value passed to subsequent branches.
 *
 * @param value   - The value to attempt union coercion on.
 * @param schemas - The sub-schemas from `anyOf` or `oneOf`.
 * @returns The coerced value that matched a sub-schema, or the original `value`.
 */
function coerceWithUnionSchema(
  value: unknown,
  schemas: JsonSchemaObject[],
): unknown {
  for (const schema of schemas) {
    // Make an independent clone for this branch so mutations don't bleed over.
    const candidate = structuredClone(value);
    const coerced = coerceWithJsonSchema(candidate, schema);

    // Use Zod's JSON Schema approach: try to build a quick inline validator.
    // Since we are operating on the raw JSON Schema here (not a Zod schema),
    // we rely on a simple structural check via getSubSchemaValidator.
    const isValid = checkWithJsonSchema(coerced, schema);
    if (isValid) return coerced;
  }

  // No branch matched — return the original so the caller gets a proper Zod error.
  return value;
}

/**
 * Performs a lightweight structural check of `value` against a raw JSON Schema
 * node, used only to pick the winning branch in union coercion.
 *
 * This is intentionally *not* a full JSON Schema validator; it only checks the
 * `type` keyword at the top level.  Full validation is done later by Zod.
 *
 * @param value  - The value to check.
 * @param schema - The JSON Schema node.
 * @returns `true` when the value's type matches the schema's `type` declaration.
 */
function checkWithJsonSchema(
  value: unknown,
  schema: JsonSchemaObject,
): boolean {
  const types = getSchemaTypes(schema);
  if (types.length === 0) {
    // No type constraint — conservatively accept it (compound-only schemas).
    return true;
  }
  return types.some((t) => matchesJsonType(value, t));
}

// ---------------------------------------------------------------------------
// Main coercion entry point
// ---------------------------------------------------------------------------

/**
 * Recursively coerces `value` to match `schema` as closely as possible without
 * modifying semantics.
 *
 * Processing order (mirrors pi's `coerceWithJsonSchema`):
 * 1. `allOf`  — recursively coerce through each sub-schema in sequence.
 * 2. `anyOf`  — try each branch; keep the first that now validates.
 * 3. `oneOf`  — same as `anyOf` from a coercion standpoint.
 * 4. Scalar   — if the value doesn't already satisfy the declared type(s),
 *               try each type's coercion function until one produces a change.
 * 5. Object   — if the schema says `"object"` and the value is now an object,
 *               recurse into its properties.
 * 6. Array    — if the schema says `"array"` and the value is now an array,
 *               recurse into its elements.
 *
 * This function is **pure** with respect to its caller: it may mutate the
 * contents of `value` when it is an object or array (see applySchemaObject/
 * ArrayCoercion), but always returns the final value to assign at the call site.
 *
 * @param value  - The runtime value to coerce (may be mutated if it is a container).
 * @param schema - The JSON Schema node that describes the expected shape.
 * @returns The coerced value (possibly the same reference as `value`).
 */
function coerceWithJsonSchema(
  value: unknown,
  schema: JsonSchemaObject,
): unknown {
  let nextValue = value;

  // --- Step 1: allOf — apply each sub-schema's coercions in sequence ----------
  // allOf is an intersection: the value must satisfy ALL sub-schemas.
  // We chain the coercions so each pass builds on the last.
  if (Array.isArray(schema.allOf)) {
    for (const nested of schema.allOf) {
      nextValue = coerceWithJsonSchema(nextValue, nested);
    }
  }

  // --- Step 2: anyOf — pick the first branch whose coercion validates ----------
  if (Array.isArray(schema.anyOf)) {
    nextValue = coerceWithUnionSchema(nextValue, schema.anyOf);
  }

  // --- Step 3: oneOf — same strategy as anyOf for coercion purposes -----------
  if (Array.isArray(schema.oneOf)) {
    nextValue = coerceWithUnionSchema(nextValue, schema.oneOf);
  }

  // --- Step 4: scalar coercion ------------------------------------------------
  const schemaTypes = getSchemaTypes(schema);

  if (schemaTypes.length > 0) {
    // When the schema declares a type union (e.g. ["string", "null"]), check
    // whether the value already matches *any* declared type.  If it does,
    // skip coercion — the value is already acceptable for one of the types.
    const matchesAnyDeclaredType =
      schemaTypes.length > 1 &&
      schemaTypes.some((t) => matchesJsonType(nextValue, t));

    if (!matchesAnyDeclaredType) {
      // Try each type in declaration order; apply the first that produces a
      // different (i.e. actually coerced) value.
      for (const schemaType of schemaTypes) {
        const candidate = coercePrimitiveByType(nextValue, schemaType);
        if (candidate !== nextValue) {
          nextValue = candidate;
          break; // one successful coercion is enough
        }
      }
    }
  }

  // --- Step 5: object — recurse into properties ------------------------------
  if (
    schemaTypes.includes("object") &&
    typeof nextValue === "object" &&
    nextValue !== null &&
    !Array.isArray(nextValue)
  ) {
    applySchemaObjectCoercion(nextValue as Record<string, unknown>, schema);
  }

  // --- Step 6: array — recurse into elements ---------------------------------
  if (schemaTypes.includes("array") && Array.isArray(nextValue)) {
    applySchemaArrayCoercion(nextValue, schema);
  }

  return nextValue;
}

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

/**
 * Formats a Zod validation issue into a human-readable "path: message" string.
 *
 * Zod reports issue paths as arrays of string/number segments (e.g.
 * `["params", "command", 0]`).  We join them with dots (arrays use index
 * numbers: `params.command.0`) and fall back to `"root"` when the path is
 * empty (top-level failure).
 *
 * pi's equivalent (`formatValidationPath`) operated on AJV-style error objects;
 * this version maps the Zod `ZodIssue` structure instead.
 *
 * @param issue - A single Zod validation issue.
 * @returns A formatted path string such as `"params.flags.0"` or `"root"`.
 */
function formatZodIssuePath(issue: z.ZodIssue): string {
  if (issue.path.length === 0) {
    return "root";
  }
  // Join path segments with "." — numeric array indices become e.g. "items.0".
  return issue.path.join(".");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Looks up a tool by name from the provided array and validates the tool call
 * arguments against that tool's Zod schema.
 *
 * This is the top-level entry point for the agent loop.  It delegates to
 * `validateToolArguments` after the tool lookup.
 *
 * @param tools    - The full list of tools registered with the agent.
 * @param toolCall - The tool call object produced by the LLM (name + arguments).
 * @returns The validated (and potentially coerced) arguments object.
 * @throws {Error} If the named tool is not found in `tools`.
 * @throws {Error} If the arguments do not satisfy the tool's Zod schema after
 *                 coercion, with a detailed human-readable error message.
 */
export function validateToolCall(
  tools: Tool[],
  toolCall: ToolCall,
): Record<string, unknown> {
  // Find the tool whose name matches the call.
  const tool = tools.find((t) => t.name === toolCall.name);
  if (!tool) {
    throw new Error(`Tool "${toolCall.name}" not found`);
  }
  return validateToolArguments(tool, toolCall);
}

/**
 * Validates and coerces the arguments of a single tool call against the tool's
 * Zod schema.
 *
 * ## Process
 *
 * 1. **Deep clone** — `structuredClone` ensures the original `toolCall.arguments`
 *    is never mutated.  The clone is what we coerce and validate.
 *
 * 2. **Convert to JSON Schema** — The tool's Zod schema is converted to a plain
 *    JSON Schema object (cached).  All coercion logic operates on this JSON Schema
 *    representation so it is decoupled from the Zod API.
 *
 * 3. **Coerce** — `coerceWithJsonSchema` walks the value tree and attempts type
 *    coercions at every level.  When coercion produces a *different* top-level
 *    value (rare for object roots, but possible for scalar tools), we use the
 *    coerced value.  When it's an object, we merge coerced properties back in-place.
 *
 * 4. **Validate** — `schema.safeParse` runs the full Zod validation.  On success,
 *    the parsed data (which may include Zod-level transforms / defaults) is returned.
 *    On failure, each issue is formatted and assembled into a structured error
 *    message that includes the original raw arguments — useful for LLM retry prompts.
 *
 * @param tool     - The tool definition, including its `parameters` Zod schema.
 * @param toolCall - The tool call from the LLM, containing `name` and `arguments`.
 * @returns The validated arguments object (type-narrowed by Zod's parse output).
 * @throws {Error} With a detailed message listing all failing fields and the
 *                 raw arguments JSON if Zod validation fails after coercion.
 */
export function validateToolArguments(
  tool: Tool,
  toolCall: ToolCall,
): Record<string, unknown> {
  // --- Step 1: deep clone to protect the original ---------------------------
  // `structuredClone` is available in Node 17+ and all modern browsers.
  // We will mutate this clone during coercion.
  const args = structuredClone(toolCall.arguments) as unknown;

  // --- Step 2: derive JSON Schema from the Zod schema (cached) --------------
  const jsonSchema = getJsonSchema(tool.parameters);

  // --- Step 3: coerce the cloned arguments ----------------------------------
  // `coerceWithJsonSchema` may mutate container values in-place and also
  // returns the (possibly new) top-level value.
  const coerced = coerceWithJsonSchema(args, jsonSchema);

  // Reconcile: if coercion produced a *different* top-level object reference,
  // we need to merge the new properties back into `args` so that the single
  // `args` variable represents the final coerced value.
  //
  // This matters when the top-level schema type is `"object"`: coercion
  // returns the *same* object reference (mutated in-place via
  // applySchemaObjectCoercion), so `coerced === args` holds.  For scalar
  // schemas (unusual for tool parameters, but possible), `coerced !== args`.
  let finalArgs: unknown = coerced;
  if (
    coerced !== args &&
    typeof args === "object" &&
    args !== null &&
    typeof coerced === "object" &&
    coerced !== null
  ) {
    // Merge coerced object properties back into the original clone reference.
    const argsObj = args as Record<string, unknown>;
    const coercedObj = coerced as Record<string, unknown>;
    for (const key of Object.keys(argsObj)) {
      delete argsObj[key];
    }
    Object.assign(argsObj, coercedObj);
    finalArgs = argsObj;
  }

  // --- Step 4: validate with Zod --------------------------------------------
  // `safeParse` never throws; it returns a discriminated union result.
  const result = tool.parameters.safeParse(finalArgs);

  if (result.success) {
    // Return the Zod-parsed data — this includes any default values and
    // Zod-level transforms the schema author defined.
    return result.data as Record<string, unknown>;
  }

  // --- Step 5: format and throw a descriptive error -------------------------
  // Collect all Zod issues into a bulleted list.
  const issueLines = result.error.issues
    .map((issue) => `  - ${formatZodIssuePath(issue)}: ${issue.message}`)
    .join("\n");

  const errorMessage =
    `Validation failed for tool "${toolCall.name}":\n` +
    `${issueLines || "Unknown validation error"}\n\n` +
    `Received arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`;

  throw new Error(errorMessage);
}
