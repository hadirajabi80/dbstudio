// Public API of the code generators (docs/PLAN-M1.5.md 1.4). Pure TypeScript: no React, Monaco or DOM.
import { generateCSharp } from './lang/csharp';
import { generateGo } from './lang/go';
import { generateJava } from './lang/java';
import { generateJson } from './lang/json';
import { generatePython } from './lang/python';
import { generateSql } from './lang/sql';
import { generateTypeScript } from './lang/typescript';
import type { CgInput, GeneratedFile } from './model';
import { normalizeOptions, type CodegenOptions } from './options';

export * from './model';
export * from './options';
export { attachUserTypes, fromCatalogObject, fromColumnInfos, findCatalogObject, queryObject, userTypesOf, type UserTypes } from './fromCatalog';
export { detectQueryParams, rewriteQuery } from './sqlgen';
export { inferQueryParamTypes, paramTypeOfColumn } from './paramTypes';
export { resolveType, TYPE_TABLES } from './types';

const GENERATORS: Record<CodegenOptions['language'], (input: CgInput, o: CodegenOptions) => GeneratedFile[]> = {
  csharp: generateCSharp,
  go: generateGo,
  typescript: generateTypeScript,
  java: generateJava,
  python: generatePython,
  sql: generateSql,
  json: generateJson,
};

/** Generate code for the objects in `input`. Never throws for unsupported objects; they are skipped. */
export function generate(input: CgInput, options: Partial<CodegenOptions>): GeneratedFile[] {
  const o = normalizeOptions(options);
  if (!input.objects.length) return [];
  return GENERATORS[o.language](input, o);
}

/** All files as one text (snapshot tests, "Copy all"). */
export function joinFiles(files: GeneratedFile[], comment = '//'): string {
  if (files.length === 1) return files[0].content;
  return files.map((f) => `${comment} ==== ${f.path} ====\n${f.content}`).join('\n');
}
