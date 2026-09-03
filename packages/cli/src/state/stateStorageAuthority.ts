import fs from "node:fs";
import path from "node:path";

import { loadYamlMapping } from "../core/yaml.js";

const AUTHORITY_RELATIVE_PATH = path.join("references", "artifacts", "state-storage-authority.yaml");

interface CacheEntry {
  authorityPath: string;
  bytes: Buffer;
  document: Record<string, unknown>;
  revision: symbol;
}

let cache: CacheEntry | undefined;

function immutableGraph<T extends object>(root: T): T {
  const proxies = new WeakMap<object, object>();
  const immutable = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value;
    const existing = proxies.get(value);
    if (existing) return existing;
    const proxy = new Proxy(value, {
      get: (target, property, receiver) => immutable(Reflect.get(target, property, receiver)),
      getOwnPropertyDescriptor: (target, property) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        return descriptor && "value" in descriptor ? { ...descriptor, value: immutable(descriptor.value) } : descriptor;
      },
      set: () => {
        throw new TypeError("state storage authority is immutable");
      },
      defineProperty: () => {
        throw new TypeError("state storage authority is immutable");
      },
      deleteProperty: () => {
        throw new TypeError("state storage authority is immutable");
      },
      preventExtensions: () => {
        throw new TypeError("state storage authority is immutable");
      },
      setPrototypeOf: () => {
        throw new TypeError("state storage authority is immutable");
      },
    });
    proxies.set(value, proxy);
    return proxy;
  };
  return immutable(root) as T;
}

export interface StateStorageAuthority {
  authorityPath: string;
  document: Record<string, unknown>;
  revision: symbol;
}

/**
 * Read the state-storage authority on every call and reuse its immutable parsed
 * graph only while the canonical path and exact file bytes remain unchanged.
 */
export function loadStateStorageAuthority(sourceRoot: string): StateStorageAuthority {
  const authorityPath = path.resolve(sourceRoot, AUTHORITY_RELATIVE_PATH);
  const bytes = fs.readFileSync(authorityPath);
  if (cache?.authorityPath === authorityPath && cache.bytes.equals(bytes)) {
    return { authorityPath, document: cache.document, revision: cache.revision };
  }

  const document = immutableGraph(loadYamlMapping(bytes.toString("utf8")));
  const revision = Symbol(authorityPath);
  cache = { authorityPath, bytes, document, revision };
  return { authorityPath, document, revision };
}
