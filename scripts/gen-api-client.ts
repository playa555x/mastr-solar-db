// Liest docs/openapi.yaml und schreibt lib/api-client.ts
// — TypeScript-Typen für Schemas, fetch-Wrapper pro Endpoint mit Path-/Query-/Body-Args.
//
// Aufruf: bun scripts/gen-api-client.ts
// In CI als pre-build step.

import { readFileSync, writeFileSync } from "node:fs";
import yaml from "js-yaml";

const spec = yaml.load(readFileSync("docs/openapi.yaml", "utf-8")) as any;
const paths = (spec.paths ?? {}) as Record<string, any>;
const schemas = ((spec.components ?? {}).schemas ?? {}) as Record<string, any>;

function tsType(schema: any): string {
  if (!schema) return "any";
  if (schema.$ref) {
    return schema.$ref.replace("#/components/schemas/", "");
  }
  if (schema.enum) {
    return schema.enum.map((e: any) => JSON.stringify(e)).join(" | ");
  }
  if (schema.allOf) {
    return schema.allOf.map((s: any) => tsType(s)).join(" & ");
  }
  if (schema.oneOf || schema.anyOf) {
    const arr = schema.oneOf || schema.anyOf;
    return arr.map((s: any) => tsType(s)).join(" | ");
  }
  if (schema.type === "array") return tsType(schema.items) + "[]";
  if (schema.type === "string") return "string";
  if (schema.type === "integer" || schema.type === "number") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "null") return "null";
  if (schema.type === "object" || schema.properties) {
    if (!schema.properties) return "Record<string, any>";
    const required = new Set<string>(schema.required ?? []);
    const props: string[] = [];
    for (const [k, v] of Object.entries(schema.properties as Record<string, any>)) {
      const optional = required.has(k) ? "" : "?";
      const nullable = v?.nullable ? " | null" : "";
      props.push(`  ${JSON.stringify(k)}${optional}: ${tsType(v)}${nullable};`);
    }
    return `{\n${props.join("\n")}\n}`;
  }
  return "any";
}

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+|_+$/g, "");
}
function methodName(method: string, path: string, opSummary?: string): string {
  // Operation-id wenn vorhanden, sonst aus method+path ableiten
  const cleaned = path.replace(/^\/api\//, "").replace(/\{[^}]+\}/g, "by_id").replace(/[^A-Za-z0-9]+/g, "_").replace(/_+$/g, "");
  return safeName((method.toLowerCase() + "_" + cleaned)).slice(0, 80);
}

const out: string[] = [];
out.push("// AUTO-GENERATED — do not edit by hand.");
out.push("// Source: docs/openapi.yaml");
out.push("// Run: bun scripts/gen-api-client.ts");
out.push(`// Spec-Version: ${spec.info?.version || "unknown"}`);
out.push(`// Generated: ${new Date().toISOString()}`);
out.push("");
out.push("export type ApiBaseConfig = {");
out.push("  baseUrl?: string;");
out.push("  token?: string;");
out.push("  locale?: 'de' | 'en' | 'fr';");
out.push("  apiVersion?: string;");
out.push("  fetchImpl?: typeof fetch;");
out.push("};");
out.push("");

// Schemas → Typen
out.push("// ============= Schemas =============");
for (const [name, schema] of Object.entries(schemas)) {
  // Kurze Type-Aliases vs full interfaces; primitive enums werden type, objects werden interface (oder type)
  out.push(`export type ${name} = ${tsType(schema)};`);
  out.push("");
}

// Helper
out.push("// ============= Helpers =============");
out.push(`async function _request(cfg: ApiBaseConfig, method: string, path: string, opts?: { query?: Record<string, any>; body?: any; headers?: Record<string, string> }): Promise<any> {
  const base = cfg.baseUrl || "";
  const f = cfg.fetchImpl || fetch;
  const url = new URL(base + path, base.startsWith("http") ? undefined : "http://x");
  if (opts?.query) for (const [k, v] of Object.entries(opts.query)) {
    if (v == null || v === "") continue;
    if (Array.isArray(v)) for (const x of v) url.searchParams.append(k, String(x));
    else url.searchParams.append(k, String(v));
  }
  const headers: Record<string, string> = { ...(opts?.headers || {}) };
  if (opts?.body !== undefined) headers["Content-Type"] = headers["Content-Type"] || "application/json";
  if (cfg.token) headers["Authorization"] = "Bearer " + cfg.token;
  if (cfg.locale) headers["X-Locale"] = cfg.locale;
  if (cfg.apiVersion) headers["API-Version"] = cfg.apiVersion;
  const r = await f((base.startsWith("http") ? url.toString() : url.pathname + url.search), {
    method,
    headers,
    body: opts?.body !== undefined ? (typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body)) : undefined,
  });
  const ct = r.headers.get("content-type") || "";
  const data = ct.includes("application/json") ? await r.json() : await r.text();
  if (!r.ok) {
    const err: any = new Error((data && (data.error || data.message)) || ("HTTP " + r.status));
    err.status = r.status; err.body = data;
    throw err;
  }
  return data;
}`);
out.push("");

// Endpoints
out.push("// ============= Endpoints =============");
out.push("export interface ApiClient {");
const methodImpls: string[] = [];
for (const [pth, pathItem] of Object.entries(paths)) {
  for (const m of ["get", "post", "put", "patch", "delete"]) {
    const op = pathItem[m];
    if (!op) continue;
    const fn = methodName(m, pth, op.summary);
    // Path-Params
    const pathParams = (op.parameters || []).filter((p: any) => p.in === "path");
    const queryParams = (op.parameters || []).filter((p: any) => p.in === "query");
    const headerParams = (op.parameters || []).filter((p: any) => p.in === "header");
    const argSig: string[] = [];
    for (const p of pathParams) argSig.push(`${safeName(p.name)}: ${tsType(p.schema)}`);
    if (queryParams.length > 0) {
      const props = queryParams.map((p: any) => `${JSON.stringify(p.name)}?: ${tsType(p.schema)}`).join("; ");
      argSig.push(`query?: { ${props} }`);
    }
    if (op.requestBody) {
      const ct = op.requestBody.content && (op.requestBody.content["application/json"] || Object.values(op.requestBody.content)[0]);
      const schema = (ct as any)?.schema;
      argSig.push(`body${op.requestBody.required ? "" : "?"}: ${schema ? tsType(schema) : "any"}`);
    }
    // Response-Typ aus 200-Response ableiten
    const ok = op.responses?.["200"] || op.responses?.["201"] || op.responses?.["default"];
    const respCt = ok?.content && (ok.content["application/json"] || Object.values(ok.content)[0]);
    const respSchema = (respCt as any)?.schema;
    const respType = respSchema ? tsType(respSchema) : "any";
    // Method declaration in interface
    out.push(`  ${fn}(${argSig.join(", ")}): Promise<${respType}>;`);
    // Generate implementation
    const pathConcatParts = pth.replace(/\{([^}]+)\}/g, "\" + encodeURIComponent($1) + \"");
    methodImpls.push(`  ${fn}(${argSig.join(", ")}) {
    return _request(cfg, ${JSON.stringify(m.toUpperCase())}, "${pathConcatParts}"${queryParams.length > 0 || op.requestBody ? `, { ${queryParams.length > 0 ? "query" : ""}${op.requestBody ? (queryParams.length > 0 ? ", body" : "body") : ""} }` : ""});
  }`);
  }
}
out.push("}");
out.push("");
out.push("export function createApiClient(cfg: ApiBaseConfig = {}): ApiClient {");
out.push("  return {");
out.push(methodImpls.join(",\n"));
out.push("  };");
out.push("}");
out.push("");

writeFileSync("lib/api-client.ts", out.join("\n"), "utf-8");
console.log("Generated lib/api-client.ts");
console.log("  Schemas:", Object.keys(schemas).length);
console.log("  Endpoints:", methodImpls.length);
