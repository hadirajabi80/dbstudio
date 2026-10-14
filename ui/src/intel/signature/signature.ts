// Signature help (PLAN 4.9): built-in functions, user routines, package members, T-SQL EXEC.
import type { SignatureHelpInfo, SignatureInfo } from '../types';
import type { DialectSpec } from '../dialect/spec';
import type { CatalogIndex } from '../catalog/index';
import type { FunctionCallContext } from '../context/context';
import { routineParams } from '../complete/completer';

function paramLabel(p: [string, string, string, number], spec: DialectSpec): string {
  const dir = p[2] === 'in' ? (spec.id === 'plsql' ? ' IN' : '') : p[2] === 'out' ? (spec.id === 'plsql' ? ' OUT' : ' OUTPUT') : p[2] === 'inout' ? ' IN OUT' : '';
  const base = spec.id === 'plsql' ? `${p[0]}${dir} ${p[1]}` : `${p[0]} ${p[1]}${dir}`;
  return (p[3] ? `[${base.trim()}]` : base.trim());
}

export function signatureHelp(call: FunctionCallContext, spec: DialectSpec, index: CatalogIndex): SignatureHelpInfo | null {
  const sigs: SignatureInfo[] = [];
  const paramNames: string[][] = [];
  const parts = call.parts;
  const name = parts.map((p) => p.text).join('.');
  // user routines / package members first (they shadow built-ins with the same name)
  const lists = routineParams(parts, { index });
  for (const list of lists) {
    const params = list.filter((p) => p[2] !== 'return');
    const ret = list.find((p) => p[2] === 'return');
    const labels = params.map((p) => paramLabel(p, spec));
    const head = call.exec ? `${name} ` : `${name.toUpperCase() === name ? name : name}(`;
    const label = call.exec ? head + labels.join(', ') : head + labels.join(', ') + ')' + (ret ? (spec.id === 'plsql' ? ' RETURN ' : ' → ') + ret[1] : '');
    sigs.push({ label, parameters: labels.map((l) => ({ label: l })) });
    paramNames.push(params.map((p) => p[0].toUpperCase()));
  }
  if (!sigs.length && parts.length === 1) {
    const f = spec.functionMap.get(parts[0].text.toUpperCase());
    if (f) {
      for (const s of f.signatures) {
        const label = `${f.name}(${s.params.join(', ')})${s.returns ?? f.returns ? ' → ' + (s.returns ?? f.returns) : ''}`;
        sigs.push({ label, documentation: s.doc ? `${s.doc}\n\n${f.doc}` : f.doc, parameters: s.params.map((p) => ({ label: p })) });
        paramNames.push(s.params.map((p) => p.replace(/^\[/, '').split(/\s+/)[0].toUpperCase()));
      }
    }
  }
  if (!sigs.length) return null;
  let activeParameter = call.argIndex;
  let activeSignature = 0;
  if (call.argName) {
    const an = call.argName.toUpperCase();
    for (let i = 0; i < paramNames.length; i++) {
      const k = paramNames[i].indexOf(an);
      if (k >= 0) { activeSignature = i; activeParameter = k; break; }
    }
  } else {
    // first overload that accepts that many arguments (variadic `...` accepts any)
    const fit = sigs.findIndex((s) => s.parameters.length > call.argIndex || s.parameters.some((p) => p.label.includes('...')));
    if (fit >= 0) activeSignature = fit;
    const sp = sigs[activeSignature].parameters;
    if (activeParameter >= sp.length && sp.some((p) => p.label.includes('...'))) activeParameter = sp.length - 1;
  }
  return { signatures: sigs, activeSignature, activeParameter };
}
