type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

type Token =
  | { type: "open" | "close"; name: "dict" | "array" }
  | { type: "empty"; name: "dict" | "array" }
  | { type: "scalar"; name: "key" | "string" | "integer" | "real"; value: string }
  | { type: "boolean"; value: boolean };

function decodeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function tokenize(xml: string): Token[] {
  const tokens: Token[] = [];
  const expression = /<(dict|array)>|<\/(dict|array)>|<(key|string|integer|real)>([\s\S]*?)<\/\3>|<(true|false)\s*\/>|<(dict|array)\s*\/>/g;
  for (const match of xml.matchAll(expression)) {
    if (match[1]) tokens.push({ type: "open", name: match[1] as "dict" | "array" });
    else if (match[2]) tokens.push({ type: "close", name: match[2] as "dict" | "array" });
    else if (match[3]) tokens.push({ type: "scalar", name: match[3] as "key" | "string" | "integer" | "real", value: decodeXml(match[4] ?? "") });
    else if (match[5]) tokens.push({ type: "boolean", value: match[5] === "true" });
    else if (match[6]) tokens.push({ type: "empty", name: match[6] as "dict" | "array" });
  }
  return tokens;
}

export function parsePlist(xml: string): Record<string, PlistValue> {
  const tokens = tokenize(xml);
  let index = 0;

  const parseValue = (): PlistValue => {
    const token = tokens[index++];
    if (!token) throw new Error("Unexpected end of plist");
    if (token.type === "boolean") return token.value;
    if (token.type === "empty") return token.name === "array" ? [] : {};
    if (token.type === "scalar") {
      if (token.name === "integer" || token.name === "real") return Number(token.value);
      return token.value;
    }
    if (token.type === "close") throw new Error(`Unexpected closing ${token.name}`);
    if (token.name === "array") {
      const output: PlistValue[] = [];
      while (true) {
        const next = tokens[index];
        if (!next || (next.type === "close" && next.name === "array")) break;
        output.push(parseValue());
      }
      index += 1;
      return output;
    }
    const output: Record<string, PlistValue> = {};
    while (true) {
      const next = tokens[index];
      if (!next || (next.type === "close" && next.name === "dict")) break;
      const key = tokens[index++];
      if (!key || key.type !== "scalar" || key.name !== "key") throw new Error("Expected plist key");
      output[key.value] = parseValue();
    }
    index += 1;
    return output;
  };

  const root = parseValue();
  if (!root || Array.isArray(root) || typeof root !== "object") throw new Error("Expected plist dictionary root");
  return root;
}
