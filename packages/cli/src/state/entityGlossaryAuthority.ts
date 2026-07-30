import fs from "node:fs";

import {
  glossaryCaveatContractFromDocument,
  type GlossaryCaveatContract,
} from "../registries/glossaryCaveatContract.js";
import { loadYamlMapping } from "../core/yaml.js";

interface CacheEntry {
  path: string;
  bytes: Buffer;
  contract: GlossaryCaveatContract;
}

let cache: CacheEntry | undefined;

/** Read every request and reuse one derived contract only for exact matching bytes. */
export function loadEntityGlossaryAuthority(path: string): GlossaryCaveatContract {
  const bytes = fs.readFileSync(path);
  if (cache?.path === path && cache.bytes.equals(bytes)) return cache.contract;
  const contract = glossaryCaveatContractFromDocument(loadYamlMapping(bytes.toString("utf8")));
  cache = { path, bytes, contract };
  return contract;
}
