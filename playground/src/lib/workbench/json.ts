export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

const objectOrder = new WeakMap<object, string[]>();
const MAX_JSON_DEPTH = 100;

class JsonReader {
  private offset = 0;

  constructor(private readonly source: string) {}

  parse(): JsonValue {
    this.skipWhitespace();
    const value = this.readValue(0);
    this.skipWhitespace();
    if (this.offset !== this.source.length) this.fail("Unexpected content after JSON value");
    return value;
  }

  private readValue(depth: number): JsonValue {
    if (depth > MAX_JSON_DEPTH) this.fail(`JSON nesting exceeds ${MAX_JSON_DEPTH} levels`);
    this.skipWhitespace();
    const token = this.source[this.offset];
    if (token === '"') return this.readString();
    if (token === "{") return this.readObject(depth + 1);
    if (token === "[") return this.readArray(depth + 1);
    if (token === "t") return this.readLiteral("true", true);
    if (token === "f") return this.readLiteral("false", false);
    if (token === "n") return this.readLiteral("null", null);
    return this.readNumber();
  }

  private readObject(depth: number): JsonObject {
    this.offset += 1;
    this.skipWhitespace();
    const entries: [string, JsonValue][] = [];
    const seen = new Set<string>();
    if (this.source[this.offset] === "}") {
      this.offset += 1;
      return orderedObject(entries);
    }

    while (this.offset < this.source.length) {
      this.skipWhitespace();
      if (this.source[this.offset] !== '"') this.fail("Object keys must be strings");
      const key = this.readString();
      if (seen.has(key)) this.fail(`Duplicate object key ${JSON.stringify(key)}`);
      seen.add(key);
      this.skipWhitespace();
      if (this.source[this.offset] !== ":") this.fail("Expected ':' after object key");
      this.offset += 1;
      entries.push([key, this.readValue(depth)]);
      this.skipWhitespace();
      const separator = this.source[this.offset];
      if (separator === "}") {
        this.offset += 1;
        return orderedObject(entries);
      }
      if (separator !== ",") this.fail("Expected ',' or '}' in object");
      this.offset += 1;
    }
    this.fail("Unterminated object");
  }

  private readArray(depth: number): JsonValue[] {
    this.offset += 1;
    this.skipWhitespace();
    const values: JsonValue[] = [];
    if (this.source[this.offset] === "]") {
      this.offset += 1;
      return values;
    }
    while (this.offset < this.source.length) {
      values.push(this.readValue(depth));
      this.skipWhitespace();
      const separator = this.source[this.offset];
      if (separator === "]") {
        this.offset += 1;
        return values;
      }
      if (separator !== ",") this.fail("Expected ',' or ']' in array");
      this.offset += 1;
    }
    this.fail("Unterminated array");
  }

  private readString(): string {
    const start = this.offset;
    this.offset += 1;
    while (this.offset < this.source.length) {
      const character = this.source[this.offset];
      if (character === '"') {
        this.offset += 1;
        try {
          return JSON.parse(this.source.slice(start, this.offset)) as string;
        } catch {
          this.fail("Invalid string escape");
        }
      }
      if (character === "\\") {
        this.offset += 2;
        continue;
      }
      if (character.charCodeAt(0) < 0x20) this.fail("Control characters must be escaped in strings");
      this.offset += 1;
    }
    this.fail("Unterminated string");
  }

  private readNumber(): number {
    const numberPattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    numberPattern.lastIndex = this.offset;
    const match = numberPattern.exec(this.source);
    if (!match) this.fail("Expected a JSON value");
    this.offset = numberPattern.lastIndex;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.fail("JSON numbers must be finite");
    return value;
  }

  private readLiteral<T extends JsonValue>(literal: string, value: T): T {
    if (this.source.slice(this.offset, this.offset + literal.length) !== literal) {
      this.fail("Expected a JSON value");
    }
    this.offset += literal.length;
    return value;
  }

  private skipWhitespace() {
    while ([" ", "\n", "\r", "\t"].includes(this.source[this.offset] ?? "")) this.offset += 1;
  }

  private fail(message: string): never {
    throw new Error(`${message} at character ${this.offset + 1}`);
  }
}

export function parseJson(source: string): JsonValue {
  return new JsonReader(source).parse();
}

export function parseJsonObject(source: string): JsonObject {
  const value = parseJson(source);
  if (!isJsonObject(value)) throw new Error("Expected a JSON object");
  return value;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function orderedObject(entries: Iterable<readonly [string, JsonValue]>): JsonObject {
  const object = Object.create(null) as JsonObject;
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const [key, value] of entries) {
    if (seen.has(key)) throw new Error(`Duplicate object key ${JSON.stringify(key)}`);
    Object.defineProperty(object, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    keys.push(key);
    seen.add(key);
  }
  objectOrder.set(object, keys);
  return object;
}

export function orderedKeys(value: JsonObject): string[] {
  const stored = objectOrder.get(value);
  if (!stored) return Object.keys(value);
  return stored.filter((key) => Object.prototype.hasOwnProperty.call(value, key));
}

export function orderedEntries(value: JsonObject): [string, JsonValue][] {
  return orderedKeys(value).map((key) => [key, value[key]]);
}

export function setOrdered(value: JsonObject, key: string, next: JsonValue): JsonObject {
  const entries = orderedEntries(value);
  const index = entries.findIndex(([current]) => current === key);
  if (index === -1) entries.push([key, next]);
  else entries[index] = [key, next];
  return orderedObject(entries);
}

export function deleteOrdered(value: JsonObject, key: string): JsonObject {
  return orderedObject(orderedEntries(value).filter(([current]) => current !== key));
}

export function cloneJson<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneJson(item)) as T;
  if (isJsonObject(value)) {
    return orderedObject(orderedEntries(value).map(([key, item]) => [key, cloneJson(item)])) as T;
  }
  return value;
}

export function stringifyJson(value: JsonValue, indent = 0): string {
  const spacing = typeof indent === "number" ? " ".repeat(Math.max(0, Math.min(indent, 10))) : "";

  function encode(item: JsonValue, depth: number): string {
    if (item === null || typeof item === "boolean" || typeof item === "string") {
      return JSON.stringify(item);
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new Error("JSON numbers must be finite");
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) {
      if (item.length === 0) return "[]";
      const values = item.map((child) => encode(child, depth + 1));
      if (!spacing) return `[${values.join(",")}]`;
      const pad = spacing.repeat(depth + 1);
      return `[\n${pad}${values.join(`,\n${pad}`)}\n${spacing.repeat(depth)}]`;
    }
    if (!isJsonObject(item)) throw new Error("Unsupported JSON value");
    const entries = orderedEntries(item);
    if (entries.length === 0) return "{}";
    const values = entries.map(([key, child]) => `${JSON.stringify(key)}:${spacing ? " " : ""}${encode(child, depth + 1)}`);
    if (!spacing) return `{${values.join(",")}}`;
    const pad = spacing.repeat(depth + 1);
    return `{\n${pad}${values.join(`,\n${pad}`)}\n${spacing.repeat(depth)}}`;
  }

  return encode(value, 0);
}
